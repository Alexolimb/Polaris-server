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
//
// Неизвестный тикер во всех рыночных эндпоинтах — 404, а НЕ выдуманная цена
// (см. quotes.js). Эндпоинты Cosmo прикрыты лимитом частоты по IP, CORS —
// по списку разрешённых origin. Подробности и что осталось сделать для
// настоящей авторизации — в server/SECURITY.md.

import http from 'node:http';

import { ASSETS, THEMES, MARKET_BASE_VERSION, isKnownSymbol } from './catalog.js';
import {
  quotesFor,
  candlesFor,
  dividendsFor,
  unknownSymbols,
  UnknownSymbolError,
} from './quotes.js';
import { streamCosmoChat, commentOnTrade, AiError } from './ai.js';
import { RateLimiter, clientIp } from './ratelimit.js';

// Origin, которым разрешён доступ из браузера. Мобильное приложение Origin не
// шлёт вовсе — ему CORS не нужен и он не затронут. Раньше здесь стояла
// звёздочка, то есть ЛЮБОЙ сайт мог дёргать наш AI-эндпоинт из браузера
// пользователя. Список задаётся через POLARIS_ALLOWED_ORIGINS (через запятую).
const DEFAULT_ALLOWED_ORIGINS = ['http://localhost:3000', 'http://127.0.0.1:3000'];

function parseOrigins(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return DEFAULT_ALLOWED_ORIGINS;
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

// Заголовки CORS для конкретного запроса. Нет Origin (мобильный клиент, curl)
// — заголовки не нужны; чужой Origin — не выдаём разрешение, и браузер сам
// заблокирует ответ.
function corsHeaders(req, allowedOrigins) {
  const origin = req.headers.origin;
  if (!origin) return {};
  if (!allowedOrigins.includes(origin)) return { vary: 'Origin' };
  return {
    'access-control-allow-origin': origin,
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin',
  };
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
    version: MARKET_BASE_VERSION,
  };
}

export function createServer(config = {}) {
  const {
    groqApiKey = process.env.GROQ_API_KEY,
    model,
    fetchImpl,
    allowedOrigins = parseOrigins(process.env.POLARIS_ALLOWED_ORIGINS),
    trustProxy = process.env.TRUST_PROXY === '1',
    // Лимиты можно ослабить/ужесточить из окружения, не трогая код.
    aiLimit = Number(process.env.POLARIS_AI_LIMIT) || 20,
    aiWindowMs = Number(process.env.POLARIS_AI_WINDOW_MS) || 5 * 60 * 1000,
    marketLimit = Number(process.env.POLARIS_MARKET_LIMIT) || 300,
    marketWindowMs = Number(process.env.POLARIS_MARKET_WINDOW_MS) || 60 * 1000,
    now,
  } = config;
  const aiOpts = { apiKey: groqApiKey, model, fetchImpl };

  // Два разных крана: дорогой AI — узкий, дешёвые котировки — широкий
  // (приложение опрашивает их по таймеру, лимит не должен мешать игроку).
  const aiLimiter = new RateLimiter({ limit: aiLimit, windowMs: aiWindowMs, now });
  const marketLimiter = new RateLimiter({ limit: marketLimit, windowMs: marketWindowMs, now });

  return http.createServer(async (req, res) => {
    const cors = corsHeaders(req, allowedOrigins);

    const sendJson = (status, obj, extraHeaders = {}) => {
      const body = JSON.stringify(obj);
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        ...cors,
        ...extraHeaders,
      });
      res.end(body);
    };

    // Общий заслон: возвращает true, если запрос отбит лимитом.
    const rateLimited = (limiter, bucket) => {
      const ip = clientIp(req, { trustProxy });
      const verdict = limiter.take(`${bucket}:${ip}`);
      if (verdict.allowed) return false;
      sendJson(
        429,
        { error: 'too many requests', retryAfterSec: verdict.retryAfterSec },
        { 'retry-after': String(verdict.retryAfterSec) },
      );
      return true;
    };

    try {
      const url = new URL(req.url, 'http://localhost');
      const path = url.pathname;

      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }

      if (req.method === 'GET' && path === '/health') {
        return sendJson(200, {
          ok: true,
          ai: Boolean(groqApiKey),
          marketBaseVersion: MARKET_BASE_VERSION,
        });
      }

      // ---- Рыночные данные (GET) ----
      if (req.method === 'GET' && path === '/v1/assets') {
        if (rateLimited(marketLimiter, 'mkt')) return;
        return sendJson(200, assetsPayload());
      }
      if (req.method === 'GET' && path === '/v1/quotes') {
        if (rateLimited(marketLimiter, 'mkt')) return;
        const symbols = (url.searchParams.get('symbols') || '')
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        const unknown = unknownSymbols(symbols);
        // Все символы неизвестны — это ошибка запроса (опечатка в тикере),
        // отвечаем 404. Если известен хоть один — отдаём его, а про остальные
        // честно пишем в поле `unknown`, вместо того чтобы придумывать цену.
        if (symbols.length > 0 && unknown.length === symbols.length) {
          return sendJson(404, { error: 'unknown symbol', unknown });
        }
        return sendJson(200, { quotes: quotesFor(symbols), unknown });
      }
      if (req.method === 'GET' && path === '/v1/candles') {
        if (rateLimited(marketLimiter, 'mkt')) return;
        const symbol = url.searchParams.get('symbol');
        const range = url.searchParams.get('range') || '1d';
        if (!symbol) return sendJson(400, { error: 'symbol required' });
        if (!isKnownSymbol(symbol)) {
          return sendJson(404, { error: 'unknown symbol', symbol });
        }
        return sendJson(200, { candles: candlesFor(symbol, range) });
      }
      if (req.method === 'GET' && path === '/v1/dividends') {
        if (rateLimited(marketLimiter, 'mkt')) return;
        const symbol = url.searchParams.get('symbol');
        if (!symbol) return sendJson(400, { error: 'symbol required' });
        if (!isKnownSymbol(symbol)) {
          return sendJson(404, { error: 'unknown symbol', symbol });
        }
        return sendJson(200, { dividends: dividendsFor(symbol) });
      }

      // ---- AI Cosmo (POST) ----
      if (req.method === 'POST' && path === '/v1/ai/chat') {
        if (rateLimited(aiLimiter, 'ai')) return;
        const payload = await readJsonBody(req);
        return streamChat(res, payload, aiOpts, cors, sendJson);
      }
      if (req.method === 'POST' && path === '/v1/ai/trade-comment') {
        if (rateLimited(aiLimiter, 'ai')) return;
        const payload = await readJsonBody(req);
        try {
          const comment = await commentOnTrade(payload, aiOpts);
          return sendJson(200, { comment });
        } catch (e) {
          const status = e instanceof AiError ? e.status : 500;
          return sendJson(status, { error: e.message });
        }
      }

      return sendJson(404, { error: 'not found' });
    } catch (e) {
      // UnknownSymbolError может прилететь из глубины движка — это 404,
      // а не 400: запрошен несуществующий ресурс.
      const status = e instanceof UnknownSymbolError ? 404 : 400;
      if (!res.headersSent) sendJson(status, { error: e.message });
      else try { res.end(); } catch {}
    }
  });
}

// SSE-стрим ответа Cosmo в формате, который ждёт клиент (ai.dart):
//   data: {"delta":"..."}\n\n  ...  data: [DONE]\n\n
async function streamChat(res, payload, aiOpts, cors, sendJson) {
  const iterator = streamCosmoChat(payload, aiOpts)[Symbol.asyncIterator]();

  // Первый next() может бросить (нет ключа / отказ Groq) ДО отправки заголовков —
  // тогда отвечаем честным HTTP-статусом (клиент покажет «нет связи с Cosmo»).
  let first;
  try {
    first = await iterator.next();
  } catch (e) {
    const status = e instanceof AiError ? e.status : 502;
    return sendJson(status, { error: e.message });
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    ...cors,
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
