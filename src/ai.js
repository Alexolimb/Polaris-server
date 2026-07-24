// AI-наставник Cosmo — клиент бесплатной модели Groq (Llama 3.3 70B).
//
// Решение Алекса (24.07.2026): Cosmo крутится на БЕСПЛАТНОЙ Groq. Cosmo — обычный
// чат-наставник без инструментов (tool-use), поэтому ограничение «Groq не годится
// для агентов-с-инструментами» здесь не мешает. Ключ — ТОЛЬКО из окружения
// (GROQ_API_KEY), в коде секретов нет.
//
// Экспортирует две операции, которые дёргает server.js:
//   streamCosmoChat(...)  -> async-генератор строк-дельт (для SSE /v1/ai/chat)
//   commentOnTrade(...)   -> Promise<string> (короткий комментарий к сделке)
//
// fetch подменяется (fetchImpl) — тесты идут без сети и без ключа.

export const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
export const DEFAULT_MODEL = 'llama-3.3-70b-versatile';

// --- Личность и правила Cosmo ---------------------------------------------

function langName(lang) {
  return lang === 'ru' ? 'Russian' : lang === 'es' ? 'Spanish' : 'English';
}

// Компактная сводка портфеля в промпт — чтобы Cosmo мог ссылаться на позиции.
function portfolioSummary(portfolio) {
  if (!portfolio || typeof portfolio !== 'object') return '';
  const parts = [];
  if (portfolio.cashCents != null) {
    parts.push(`cash $${(portfolio.cashCents / 100).toFixed(2)}`);
  }
  const positions = portfolio.positions;
  if (Array.isArray(positions) && positions.length) {
    // filter: тело запроса — произвольный JSON, элемент может быть null.
    const items = positions
      .filter((p) => p && typeof p === 'object')
      .slice(0, 12)
      .map((p) => `${p.symbol ?? '?'}×${p.qty ?? 0}`)
      .join(', ');
    if (items) parts.push(`holdings: ${items}`);
  }
  return parts.length ? `\nUser's virtual portfolio — ${parts.join('; ')}.` : '';
}

// Системный промпт: educational, дружелюбный, на языке пользователя,
// НИКОГДА не даёт персональных инвестсоветов и не обещает доходность.
export function buildSystemPrompt(lang, portfolio) {
  return (
    `You are Cosmo, a friendly space-mascot tutor inside "Polaris" — an investing ` +
    `SIMULATOR where the user trades with virtual money ($10,000 to start). Your job ` +
    `is to teach investing concepts clearly and encouragingly.\n` +
    `Rules:\n` +
    `- Always reply in ${langName(lang)}.\n` +
    `- Be concise (2–5 sentences unless asked for more), warm, and beginner-friendly.\n` +
    `- Explain concepts; you may discuss general principles, risks, and how things work.\n` +
    `- NEVER give personalized financial advice, never tell the user to buy/sell a ` +
    `specific asset, and never promise or predict returns. If asked "what should I buy", ` +
    `redirect to how to think about it and remind them this is practice with virtual money.\n` +
    `- No hype, no financial guarantees. It's okay to say you don't know.` +
    portfolioSummary(portfolio)
  );
}

// --- Разбор OpenAI-совместимого SSE от Groq --------------------------------

// Достаёт content-дельту из одного SSE-события Groq (или null / '[DONE]').
function parseGroqEvent(rawEvent) {
  for (const line of rawEvent.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) continue;
    const payload = trimmed.slice(5).trim();
    if (!payload) continue;
    if (payload === '[DONE]') return '[DONE]';
    try {
      const obj = JSON.parse(payload);
      const delta = obj?.choices?.[0]?.delta?.content;
      if (typeof delta === 'string') return delta;
    } catch {
      // битый чанк — пропускаем, ждём следующий
    }
  }
  return null;
}

// --- Публичные операции ----------------------------------------------------

class AiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function requireKey(apiKey) {
  if (!apiKey) throw new AiError(503, 'GROQ_API_KEY не задан — Cosmo офлайн');
}

// Стримит ответ Cosmo кусками текста (async-генератор). Транспорт — fetchImpl.
export async function* streamCosmoChat(
  { messages, lang = 'en', portfolio } = {},
  { apiKey, model = DEFAULT_MODEL, fetchImpl = fetch } = {},
) {
  requireKey(apiKey);
  const history = Array.isArray(messages)
    ? messages
        .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
        .map((m) => ({ role: m.role, content: m.content }))
    : [];

  const body = JSON.stringify({
    model,
    stream: true,
    temperature: 0.6,
    messages: [{ role: 'system', content: buildSystemPrompt(lang, portfolio) }, ...history],
  });

  const res = await fetchImpl(GROQ_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body,
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new AiError(res.status, `Groq ответил ${res.status}: ${text.slice(0, 200)}`);
  }

  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of res.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const piece = parseGroqEvent(rawEvent);
      if (piece === '[DONE]') return;
      if (piece) yield piece;
    }
  }
  // хвост без завершающего разделителя
  const tail = parseGroqEvent(buffer);
  if (tail && tail !== '[DONE]') yield tail;
}

// Короткий (не потоковый) комментарий Cosmo к совершённой сделке.
export async function commentOnTrade(
  { trade, portfolio, lang = 'en' } = {},
  { apiKey, model = DEFAULT_MODEL, fetchImpl = fetch } = {},
) {
  requireKey(apiKey);
  const userMsg =
    `The user just made this simulated trade: ${JSON.stringify(trade)}.\n` +
    `React in ONE short, encouraging sentence in ${langName(lang)} — a teaching nudge, ` +
    `not advice. Do not predict returns.`;

  const body = JSON.stringify({
    model,
    stream: false,
    temperature: 0.7,
    max_tokens: 120,
    messages: [
      { role: 'system', content: buildSystemPrompt(lang, portfolio) },
      { role: 'user', content: userMsg },
    ],
  });

  const res = await fetchImpl(GROQ_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body,
  });
  if (!res.ok) {
    const text = await safeText(res);
    throw new AiError(res.status, `Groq ответил ${res.status}: ${text.slice(0, 200)}`);
  }
  const data = await res.json();
  const comment = data?.choices?.[0]?.message?.content;
  if (typeof comment !== 'string' || !comment.trim()) {
    throw new AiError(502, 'Пустой ответ от Groq');
  }
  return comment.trim();
}

async function safeText(res) {
  try {
    return await res.text();
  } catch {
    return '';
  }
}

export { AiError };
