// Каталог активов и тем для Polaris (эндпоинт GET /v1/assets).
//
// Это курируемый статический список — публичный продукт-симулятор не обязан
// торговать всем рынком, ему нужен понятный набор узнаваемых бумаг, разбитых
// по темам-подборкам (чипы на экране «Рынок»). Цены/свечи к этим символам
// выдаёт quotes.js (синтетический движок либо реальный провайдер).
//
// ВАЖНО (аудит 25.07.2026): сам список и цены здесь БОЛЬШЕ НЕ ЗАШИТЫ. Они
// читаются из data/market_base.json — единственного источника правды, из
// которого генерируется и офлайн-набор приложения (app/lib/services/
// market_base.g.dart). Раньше таблицы жили в двух местах и разъехались:
// у сервера BTC стоил $68 000, у приложения $118 420, а SOL/NFLX/ADA сервер
// вообще не знал и подставлял им дефолтные $100 — портфель прыгал на десятки
// процентов при переключении онлайн↔офлайн. Для учебного продукта, который
// учит доверять цифрам, это было недопустимо.
//
// Формат ответа сервера (см. app/lib/services/api.dart, fetchCatalog):
//   { "assets": [{symbol,name,type,currency,themes[],sector,freshness}],
//     "themes": [{id,title}] }

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// Путь считаем от файла модуля, а не от cwd: сервер запускают и из корня
// репозитория, и из systemd с любым рабочим каталогом.
const BASE_PATH = fileURLToPath(new URL('../data/market_base.json', import.meta.url));

/** Разобранный канонический файл. Читается один раз при загрузке модуля. */
const BASE = JSON.parse(readFileSync(BASE_PATH, 'utf8'));

/** Версия канонических данных — попадает в /health, чтобы было видно,
 *  что именно раздаёт живой сервер (и совпадает ли с приложением). */
export const MARKET_BASE_VERSION = BASE.version;

export const THEMES = BASE.themes.map((t) => ({ id: t.id, title: t.title }));

// freshness: 'realtime' | 'endOfDay' | 'demo' — честная метка происхождения
// цены. Значения совпадают с именами enum QuoteFreshness в приложении
// (models.dart разбирает их по имени). На синтетическом движке server.js
// переопределяет всё на 'demo'; при реальном провайдере пойдёт значение
// из канона. type: 'stock' | 'etf' | 'bondEtf' | 'crypto' | 'fiat'.
export const ASSETS = BASE.assets.map((a) => ({
  symbol: a.symbol,
  name: a.name,
  type: a.type,
  currency: a.currency ?? 'USD',
  themes: a.themes ?? [],
  ...(a.sector ? { sector: a.sector } : {}),
  freshness: a.freshness ?? 'realtime',
}));

// Быстрый доступ по символу — используется quotes.js для базовой цены.
export const ASSET_BY_SYMBOL = Object.fromEntries(ASSETS.map((a) => [a.symbol, a]));

// Базовая «якорная» цена в центах на символ — вокруг неё синтетический движок
// строит блуждание. Те же числа, что видит игрок офлайн.
export const BASE_PRICE_CENTS = Object.fromEntries(
  BASE.assets.map((a) => [a.symbol, a.priceCents]),
);

// Дивиденд на акцию в центах — тоже из канона, а не «0.4% от цены наугад»:
// иначе офлайн и онлайн начисляли РАЗНЫЕ суммы за одну и ту же выплату.
export const DIVIDEND_PER_SHARE_CENTS = Object.fromEntries(
  BASE.assets
    .filter((a) => Number.isInteger(a.dividendPerShareCents) && a.dividendPerShareCents > 0)
    .map((a) => [a.symbol, a.dividendPerShareCents]),
);

// Бумаги, по которым отдаём ближайшую синтетическую дивидендную выплату.
export const DIVIDEND_SYMBOLS = new Set(Object.keys(DIVIDEND_PER_SHARE_CENTS));

/** Знаем ли мы такой символ. Единая проверка для всех эндпоинтов: неизвестный
 *  тикер должен получать честную 404, а не выдуманную цену (см. quotes.js). */
export function isKnownSymbol(symbol) {
  return typeof symbol === 'string' && Object.hasOwn(ASSET_BY_SYMBOL, symbol);
}
