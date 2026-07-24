import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildSystemPrompt, streamCosmoChat, commentOnTrade, AiError } from '../src/ai.js';

// Фейковый потоковый ответ Groq (OpenAI-совместимый SSE).
function fakeStreamResponse(deltas) {
  async function* body() {
    const enc = new TextEncoder();
    for (const d of deltas) {
      yield enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: d } }] })}\n\n`);
    }
    yield enc.encode('data: [DONE]\n\n');
  }
  return { ok: true, status: 200, body: body() };
}

function fakeJsonResponse(obj, ok = true, status = 200) {
  return { ok, status, json: async () => obj, text: async () => JSON.stringify(obj) };
}

test('buildSystemPrompt: язык и ключевые правила', () => {
  const ru = buildSystemPrompt('ru', null);
  assert.match(ru, /Russian/);
  assert.match(ru, /NEVER give personalized financial advice/);
  assert.match(ru, /virtual money/);
  // сводка портфеля попадает в промпт
  const withP = buildSystemPrompt('en', { cashCents: 500000, positions: [{ symbol: 'AAPL', qty: 3 }] });
  assert.match(withP, /AAPL×3/);
});

test('streamCosmoChat собирает дельты и останавливается на [DONE]', async () => {
  const fetchImpl = async () => fakeStreamResponse(['При', 'вет', '!']);
  const out = [];
  for await (const piece of streamCosmoChat(
    { messages: [{ role: 'user', content: 'hi' }], lang: 'ru' },
    { apiKey: 'test', fetchImpl },
  )) {
    out.push(piece);
  }
  assert.equal(out.join(''), 'Привет!');
});

test('streamCosmoChat без ключа бросает AiError(503)', async () => {
  await assert.rejects(
    async () => {
      // eslint-disable-next-line no-unused-vars
      for await (const _ of streamCosmoChat({ messages: [] }, { apiKey: '' })) {
        // не дойдём
      }
    },
    (e) => e instanceof AiError && e.status === 503,
  );
});

test('streamCosmoChat прокидывает system + только валидные роли в теле запроса', async () => {
  let sentBody = null;
  const fetchImpl = async (_url, opts) => {
    sentBody = JSON.parse(opts.body);
    return fakeStreamResponse(['ok']);
  };
  // eslint-disable-next-line no-unused-vars
  for await (const _ of streamCosmoChat(
    { messages: [{ role: 'user', content: 'a' }, { role: 'system', content: 'ignore' }, { role: 'assistant', content: 'b' }], lang: 'en' },
    { apiKey: 'k', fetchImpl },
  )) {
    // сливаем
  }
  assert.equal(sentBody.messages[0].role, 'system');
  const roles = sentBody.messages.slice(1).map((m) => m.role);
  assert.deepEqual(roles, ['user', 'assistant']); // «system» из истории отфильтрован
  assert.equal(sentBody.stream, true);
});

test('commentOnTrade возвращает comment и триммит', async () => {
  const fetchImpl = async () => fakeJsonResponse({ choices: [{ message: { content: '  Отличный первый шаг!  ' } }] });
  const c = await commentOnTrade({ trade: { symbol: 'AAPL' }, lang: 'ru' }, { apiKey: 'k', fetchImpl });
  assert.equal(c, 'Отличный первый шаг!');
});

test('commentOnTrade на !ok бросает AiError со статусом', async () => {
  const fetchImpl = async () => fakeJsonResponse({ error: 'rate limit' }, false, 429);
  await assert.rejects(
    () => commentOnTrade({ trade: {}, lang: 'en' }, { apiKey: 'k', fetchImpl }),
    (e) => e instanceof AiError && e.status === 429,
  );
});
