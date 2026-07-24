// HTTP-сервер Polaris — контракт v1 (см. app/lib/services/api.dart и ai.dart).
// Чистый node:http, ноль внешних зависимостей. Экспортирует createServer(config)
// — так тесты поднимают сервер на случайном порту с подменённым fetch.
//
// Эндпоинты:
//   GET  /health
//   GET  /v1/assets
//   GET  /v1/quotes?symbols=AAPL,MSFT
//   GET  /v1/candles?symbol=AAPL&range=1d|1w|1m|1y
//   GET  /v1/dividends?symbol=AAPL
//   POST /v1/ai/chat            (SSE: data:{"delta":…}\n\n … data:[DONE]\n\n)
//   POST /v1/ai/trade-comment   (JSON: {comment})

import http from 'node:http';

import { ASSETS, THEMES } from './catalog.js';
import { quotesFor, candlesFor, dividendsFor } from './quotes.js';
import { streamCosmoChat, commentOnTrade, AiError } from './ai.js';

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET,POST,OPTIONS',
  'access-control-allow-headers': 'content-type,authorization',
};

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...CORS });
  res.end(body);
}

function readJsonBody(req, limitBytes = 256 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limitBytes) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(new Error('invalid json'));
      }
    });
    req.on('error', reject);
  });
}

// freshness всех синтетических данных — честная метка 'demo'.
function assetsPayload() {
  return {
    assets: ASSETS.map((a) => ({ ...a, freshness: 'demo' })),
    themes: THEMES,
  };
}

export function createServer(config = {}) {
  const { groqApiKey = process.env.GROQ_API_KEY, model, fetchImpl } = config;
  const aiOpts = { apiKey: groqApiKey, model, fetchImpl };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      if (req.method === 'OPTIONS') {
        res.writeHead(204, CORS);
        return res.end();
      }

      if (req.method === 'GET' && path === '/health') {
        return sendJson(res, 200, { ok: true, ai: Boolean(groqApiKey) });
      }

      // ---- Рыночные данные (GET) ----
      if (req.method === 'GET' && path === '/v1/assets') {
        return sendJson(res, 200, assetsPayload());
      }
      if (req.method === 'GET' && path === '/v1/quotes') {
        const symbols = (url.searchParams.get('symbols') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        return sendJson(res, 200, { quotes: quotesFor(symbols) });
      }
      if (req.method === 'GET' && path === '/v1/candles') {
        const symbol = url.searchParams.get('symbol');
        const range = url.searchParams.get('range') || '1d';
        if (!symbol) return sendJson(res, 400, { error: 'symbol required' });
        return sendJson(res, 200, { candles: candlesFor(symbol, range) });
      }
      if (req.method === 'GET' && path === '/v1/dividends') {
        const symbol = url.searchParams.get('symbol');
        if (!symbol) return sendJson(res, 400, { error: 'symbol required' });
        return sendJson(res, 200, { dividends: dividendsFor(symbol) });
      }

      // ---- AI Cosmo (POST) ----
      if (req.method === 'POST' && path === '/v1/ai/chat') {
        const payload = await readJsonBody(req);
        return streamChat(res, payload, aiOpts);
      }
      if (req.method === 'POST' && path === '/v1/ai/trade-comment') {
        const payload = await readJsonBody(req);
        try {
          const comment = await commentOnTrade(payload, aiOpts);
          return sendJson(res, 200, { comment });
        } catch (e) {
          const status = e instanceof AiError ? e.status : 500;
          return sendJson(res, status, { error: e.message });
        }
      }

      return sendJson(res, 404, { error: 'not found' });
    } catch (e) {
      if (!res.headersSent) sendJson(res, 400, { error: e.message });
      else try { res.end(); } catch {}
    }
  });
}

// SSE-стрим ответа Cosmo в формате, который ждёт клиент (ai.dart):
//   data: {"delta":"..."}\n\n  ...  data: [DONE]\n\n
async function streamChat(res, payload, aiOpts) {
  const iterator = streamCosmoChat(payload, aiOpts)[Symbol.asyncIterator]();

  // Первый next() может бросить (нет ключа / отказ Groq) ДО отправки заголовков —
  // тогда отвечаем честным HTTP-статусом (клиент покажет «нет связи с Cosmo»).
  let first;
  try {
    first = await iterator.next();
  } catch (e) {
    const status = e instanceof AiError ? e.status : 502;
    return sendJson(res, status, { error: e.message });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...CORS,
  });

  const write = (delta) => res.write(`data: ${JSON.stringify({ delta })}\n\n`);

  try {
    if (!first.done && first.value) write(first.value);
    while (true) {
      const { value, done } = await iterator.next();
      if (done) break;
      if (value) write(value);
    }
  } catch {
    // Обрыв в середине потока: клиент дорисует то, что успел получить.
    // Просто завершаем — заголовки уже 200, статус не поменять.
  }
  res.write('data: [DONE]\n\n');
  res.end();
}
