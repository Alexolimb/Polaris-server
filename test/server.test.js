import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';

import { createServer } from '../src/server.js';

// Мок Groq: по флагу stream в теле отдаёт либо SSE-поток, либо JSON.
function makeFetchMock() {
  return async (_url, opts) => {
    const body = JSON.parse(opts.body);
    if (body.stream) {
      async function* stream() {
        const enc = new TextEncoder();
        yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'Hi ' } }] })}\n\n`);
        yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: 'there' } }] })}\n\n`);
        yield enc.encode('data: [DONE]\n\n');
      }
      return { ok: true, status: 200, body: stream() };
    }
    return { ok: true, status: 200, json: async () => ({ choices: [{ message: { content: 'Nice trade!' } }] }) };
  };
}

let base;
let server;

before(async () => {
  server = createServer({ groqApiKey: 'test-key', fetchImpl: makeFetchMock() });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});

after(() => new Promise((r) => server.close(r)));

test('GET /health', async () => {
  const r = await fetch(`${base}/health`);
  const j = await r.json();
  assert.equal(r.status, 200);
  assert.equal(j.ok, true);
  assert.equal(j.ai, true);
});

test('GET /v1/assets — непустой каталог, freshness demo', async () => {
  const r = await fetch(`${base}/v1/assets`);
  const j = await r.json();
  assert.ok(Array.isArray(j.assets) && j.assets.length > 5);
  assert.ok(Array.isArray(j.themes) && j.themes.length > 0);
  assert.equal(j.assets[0].freshness, 'demo');
});

test('GET /v1/quotes?symbols=AAPL,MSFT — две котировки в центах', async () => {
  const r = await fetch(`${base}/v1/quotes?symbols=AAPL,MSFT`);
  const j = await r.json();
  assert.equal(j.quotes.length, 2);
  assert.ok(Number.isInteger(j.quotes[0].priceCents));
});

test('GET /v1/candles?range=1m — 30 свечей', async () => {
  const r = await fetch(`${base}/v1/candles?symbol=AAPL&range=1m`);
  const j = await r.json();
  assert.equal(j.candles.length, 30);
});

test('GET /v1/candles без symbol → 400', async () => {
  const r = await fetch(`${base}/v1/candles`);
  assert.equal(r.status, 400);
});

test('GET /v1/dividends: AAPL → есть прошедшая выплата, NVDA → 0', async () => {
  const a = await (await fetch(`${base}/v1/dividends?symbol=AAPL`)).json();
  const n = await (await fetch(`${base}/v1/dividends?symbol=NVDA`)).json();
  // Календарь якорный: отдаём последнюю прошедшую отсечку (её приложение
  // начислит) и следующую (для календаря). Раньше была только будущая —
  // из-за этого дивиденды не начислялись никогда.
  assert.ok(a.dividends.length >= 1);
  const now = Date.now();
  assert.ok(
    a.dividends.some((d) => Date.parse(d.exDate) <= now),
    'нет ни одной прошедшей отсечки',
  );
  assert.equal(n.dividends.length, 0);
});

test('POST /v1/ai/chat — SSE с дельтами и [DONE]', async () => {
  const r = await fetch(`${base}/v1/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }], lang: 'en' }),
  });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/event-stream/);
  const text = await r.text();
  assert.match(text, /"delta":"Hi "/);
  assert.match(text, /"delta":"there"/);
  assert.match(text, /data: \[DONE\]/);
});

test('POST /v1/ai/trade-comment — {comment}', async () => {
  const r = await fetch(`${base}/v1/ai/trade-comment`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ trade: { symbol: 'AAPL', side: 'buy' }, lang: 'en' }),
  });
  const j = await r.json();
  assert.equal(j.comment, 'Nice trade!');
});

test('POST /v1/ai/chat без ключа → 503 (заголовки не 200)', async () => {
  const noKey = createServer({ groqApiKey: '', fetchImpl: makeFetchMock() });
  await new Promise((r) => noKey.listen(0, r));
  const b = `http://localhost:${noKey.address().port}`;
  const r = await fetch(`${b}/v1/ai/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ messages: [{ role: 'user', content: 'hi' }] }),
  });
  assert.equal(r.status, 503);
  await new Promise((res) => noKey.close(res));
});

test('неизвестный путь → 404', async () => {
  const r = await fetch(`${base}/nope`);
  assert.equal(r.status, 404);
});
