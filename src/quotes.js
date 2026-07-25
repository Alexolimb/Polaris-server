// Синтетический движок котировок Polaris — чистый, детерминированный, тестируемый.
//
// Зачем синтетика: бэкенд должен подниматься и работать БЕЗ платного биржевого
// фида (правило Алекса — только бесплатное). Движок строит правдоподобные, но
// честно помеченные (`freshness: 'demo'`) цены и свечи из сид-шума по символу и
// реальному времени. Цены детерминированы: один и тот же символ+время всегда
// дают одно и то же значение (важно и для тестов, и чтобы у всех пользователей
// график совпадал). Позже сюда же можно вставить реальный провайдер (см. низ файла).
//
// Всё в ЦЕНТАХ (int) — как во всём контракте v1 и в моделях приложения.

import { BASE_PRICE_CENTS, ASSET_BY_SYMBOL, DIVIDEND_SYMBOLS } from './catalog.js';

// --- Детерминированный шум -------------------------------------------------

// Хэш строки в 32-битное беззнаковое (FNV-1a) — сид на символ.
function hashSymbol(symbol) {
  let h = 0x811c9dc5;
  for (let i = 0; i < symbol.length; i++) {
    h ^= symbol.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// Псевдослучайное [0,1) из целого сида (mulberry32) — чистая функция.
function rand01(seed) {
  let t = (seed + 0x6d2b79f5) >>> 0;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// Значение-шум в [-1,1] в целочисленной точке n для данного символа.
function noiseAt(symbolSeed, n) {
  return rand01(symbolSeed + Math.imul(n >>> 0, 0x9e3779b1)) * 2 - 1;
}

// Плавный (интерполированный) шум в дробной точке x — smoothstep между целыми.
function smoothNoise(symbolSeed, x) {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f); // smoothstep
  return noiseAt(symbolSeed, i) * (1 - u) + noiseAt(symbolSeed, i + 1) * u;
}

// Многооктавный шум в [-1,1] — придаёт графику и крупные волны, и мелкую рябь.
function layeredNoise(symbolSeed, x) {
  let sum = 0;
  let amp = 1;
  let freq = 1;
  let norm = 0;
  for (let o = 0; o < 4; o++) {
    sum += smoothNoise(symbolSeed + o * 1013, x * freq) * amp;
    norm += amp;
    amp *= 0.5;
    freq *= 2.13;
  }
  return sum / norm;
}

// --- Цена во времени -------------------------------------------------------

const HOUR_MS = 3600 * 1000;

// Волатильность (доля от базовой цены) на класс актива.
function amplitudeFor(symbol) {
  const a = ASSET_BY_SYMBOL[symbol];
  if (a && a.type === 'crypto') return 0.28;
  if (a && a.type === 'etf') return 0.06;
  return 0.12; // акции
}

function basePrice(symbol) {
  return BASE_PRICE_CENTS[symbol] ?? 10000; // дефолт $100 для неизвестных
}

// Цена символа в момент timeMs (в центах, int, всегда > 0).
// Ось времени шума — часы; медленный дрейф + октавы дают живой, но стабильный ряд.
export function priceCentsAt(symbol, timeMs) {
  const seed = hashSymbol(symbol);
  const x = timeMs / HOUR_MS / 24; // одна единица шума ≈ сутки
  const drift = layeredNoise(seed, x);
  const base = basePrice(symbol);
  const price = base * (1 + amplitudeFor(symbol) * drift);
  return Math.max(1, Math.round(price));
}

// --- Публичные функции эндпоинтов -----------------------------------------

// Нью-йоркское время (день недели + минуты от полуночи) без сторонних
// библиотек. Раньше часы биржи были зашиты как 13:30–20:00 UTC — это верно
// только для ЛЕТНЕГО EDT, а зимой (EST) сессия идёт 14:30–21:00 UTC, то есть
// полгода индикатор «рынок открыт» врал на час. Intl знает правила перехода
// на летнее время и входит в стандартную библиотеку — зависимостей не добавляет.
const DAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

function newYorkParts(now) {
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    });
    const p = {};
    for (const { type, value } of fmt.formatToParts(new Date(now))) {
      p[type] = value;
    }
    const day = DAY_INDEX[p.weekday];
    // hour12:false в некоторых движках отдаёт «24» для полуночи.
    const hour = Number(p.hour) % 24;
    const minute = Number(p.minute);
    if (day === undefined || !Number.isFinite(hour) || !Number.isFinite(minute)) {
      return null;
    }
    return { day, mins: hour * 60 + minute };
  } catch {
    return null; // сборка Node без данных о часовых поясах
  }
}

// Рынок открыт? Крипта — всегда; акции/ETF/валюты — будни, 09:30–16:00
// по Нью-Йорку. Праздники биржи не учитываем (данные всё равно учебные).
export function isMarketOpen(symbol, now) {
  const a = ASSET_BY_SYMBOL[symbol];
  if (a && a.type === 'crypto') return true;
  const ny = newYorkParts(now);
  if (ny) {
    if (ny.day === 0 || ny.day === 6) return false;
    return ny.mins >= 9 * 60 + 30 && ny.mins < 16 * 60;
  }
  // Фолбэк без Intl: считаем летнее время по правилу США (2-е воскресенье
  // марта — 1-е воскресенье ноября) и смещаем окно UTC на час.
  const d = new Date(now);
  const day = d.getUTCDay();
  if (day === 0 || day === 6) return false;
  const openUtcMins = (isUsDstApprox(d) ? 13 : 14) * 60 + 30;
  const mins = d.getUTCHours() * 60 + d.getUTCMinutes();
  return mins >= openUtcMins && mins < openUtcMins + 6 * 60 + 30;
}

// Грубая проверка летнего времени США — только для фолбэка выше.
function isUsDstApprox(d) {
  const y = d.getUTCFullYear();
  const secondSundayOfMarch = nthSundayUtc(y, 2, 2);
  const firstSundayOfNovember = nthSundayUtc(y, 10, 1);
  return d >= secondSundayOfMarch && d < firstSundayOfNovember;
}

function nthSundayUtc(year, monthIndex, n) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const shift = (7 - first.getUTCDay()) % 7; // до первого воскресенья
  return new Date(Date.UTC(year, monthIndex, 1 + shift + (n - 1) * 7, 7));
}

// Котировка: текущая цена + вчерашнее закрытие (для %-изменения на карточке).
export function quoteFor(symbol, now = Date.now()) {
  const priceCents = priceCentsAt(symbol, now);
  const prevCloseCents = priceCentsAt(symbol, now - 24 * HOUR_MS);
  return {
    symbol,
    priceCents,
    prevCloseCents,
    ts: new Date(now).toISOString(),
    marketOpen: isMarketOpen(symbol, now),
  };
}

export function quotesFor(symbols, now = Date.now()) {
  return symbols.map((s) => quoteFor(s, now));
}

// Параметры свечей на диапазон: сколько точек и шаг между ними.
const RANGE_PARAMS = {
  '1d': { count: 24, stepMs: HOUR_MS },
  '1w': { count: 28, stepMs: 6 * HOUR_MS },
  '1m': { count: 30, stepMs: 24 * HOUR_MS },
  '1y': { count: 52, stepMs: 7 * 24 * HOUR_MS },
};

// Свечи для символа на диапазоне. Каждая свеча строится из цены на её конце и
// начале, с небольшими тенями из под-шума. Всё в центах (int). Отсортированы по t.
export function candlesFor(symbol, range, now = Date.now()) {
  // Регистр приводим сами: приложение шлёт '1d', но любой другой клиент
  // (или ручной запрос) легко пришлёт '1D' — и раньше это МОЛЧА отдавало
  // суточный график под видом годового. Проверено на живом бэкенде:
  // ?range=1Y возвращал те же 24 часовые свечи, что и ?range=1d.
  const key = typeof range === 'string' ? range.toLowerCase() : '';
  const p = RANGE_PARAMS[key] ?? RANGE_PARAMS['1d'];
  const seed = hashSymbol(symbol);
  const out = [];
  for (let i = p.count - 1; i >= 0; i--) {
    const tClose = now - i * p.stepMs;
    const tOpen = tClose - p.stepMs;
    const c = priceCentsAt(symbol, tClose);
    const o = priceCentsAt(symbol, tOpen);
    // Тени: доля волатильности от свечного диапазона, детерминированно по (символ, бакет).
    const bucket = Math.floor(tClose / p.stepMs);
    const wickUp = Math.abs(noiseAt(seed + 7, bucket)) * 0.006;
    const wickDn = Math.abs(noiseAt(seed + 13, bucket)) * 0.006;
    const hi = Math.round(Math.max(o, c) * (1 + wickUp));
    const lo = Math.round(Math.min(o, c) * (1 - wickDn));
    out.push({ t: tClose, o, h: Math.max(hi, o, c), l: Math.min(lo, o, c), c });
  }
  return out;
}

// Дивидендный календарь — ЯКОРНЫЙ, а не «от сейчас».
//
// Так было раньше: exDate = now + (5..40 дней), и дата пересчитывалась при
// КАЖДОМ запросе. То есть отсечка вечно убегала вперёд и не наступала никогда,
// а приложение начисляет выплату только когда `exDate <= now`
// (portfolio_state.applyDueDividends). Итог: дивиденды — заявленная фича
// продукта — не начислялись НИ РАЗУ, тумблер уведомления был мёртвым, а целый
// раздел движка работал только в юнит-тестах.
//
// Теперь сетка привязана к фиксированной эпохе: у каждого символа свой
// стабильный сдвиг внутри квартала, даты не зависят от момента запроса.
// Отдаём и ПРОШЕДШУЮ выплату (её можно начислить), и следующую (её можно
// показать в календаре).
const DIVIDEND_EPOCH_MS = Date.UTC(2026, 0, 1); // 1 января 2026, якорь сетки
const QUARTER_DAYS = 91;

export function dividendsFor(symbol, now = Date.now()) {
  if (!DIVIDEND_SYMBOLS.has(symbol)) return [];
  const seed = hashSymbol(symbol);
  // Сдвиг символа внутри квартала — стабильный, из сида.
  const offsetDays = Math.floor(rand01(seed + 101) * QUARTER_DAYS);
  const stepMs = QUARTER_DAYS * 24 * HOUR_MS;
  const anchorMs = DIVIDEND_EPOCH_MS + offsetDays * 24 * HOUR_MS;
  // Номер последней отсечки, которая уже наступила.
  const k = Math.floor((now - anchorMs) / stepMs);
  const perShareCents = Math.max(
    1,
    Math.round(basePrice(symbol) * 0.004 * (0.6 + rand01(seed + 202))),
  );
  const make = (i) => {
    const ex = new Date(anchorMs + i * stepMs);
    const pay = new Date(ex.getTime() + 7 * 24 * HOUR_MS);
    return {
      symbol,
      exDate: ex.toISOString().slice(0, 10),
      payDate: pay.toISOString().slice(0, 10),
      perShareCents,
    };
  };
  const out = [];
  if (k >= 0) out.push(make(k)); // последняя прошедшая — её начислят
  out.push(make(k + 1)); // следующая — для календаря
  return out;
}

// --- Точка расширения на реальный провайдер --------------------------------
// Когда появится бесплатный биржевой ключ (например Finnhub free), здесь можно
// реализовать fetch реальных котировок и вернуть freshness:'delayed'/'realtime'.
// Контракт функций (quoteFor/candlesFor/dividendsFor) менять НЕ нужно — сервер
// зовёт их же; достаточно подменить тело при заданном process.env.QUOTE_PROVIDER.
