// Каталог активов и тем для Polaris (эндпоинт GET /v1/assets).
//
// Это курируемый статический список — публичный продукт-симулятор не обязан
// торговать всем рынком, ему нужен понятный набор узнаваемых бумаг, разбитых
// по темам-подборкам (чипы на экране «Рынок»). Цены/свечи к этим символам
// выдаёт quotes.js (синтетический движок либо реальный провайдер).
//
// Формат ответа сервера (см. app/lib/services/api.dart, fetchCatalog):
//   { "assets": [{symbol,name,type,currency,themes[],sector,freshness}],
//     "themes": [{id,title}] }

export const THEMES = [
  { id: 'bigtech', title: 'Большие технологии' },
  { id: 'ai', title: 'Искусственный интеллект' },
  { id: 'dividends', title: 'Дивидендные гиганты' },
  { id: 'etf', title: 'Фонды (ETF)' },
  { id: 'energy', title: 'Энергетика' },
  { id: 'crypto', title: 'Криптовалюты' },
];

// freshness: 'realtime' | 'delayed' | 'demo' — честная метка происхождения цены.
// На синтетическом движке ставим 'demo'; при реальном провайдере quotes.js
// переопределит на 'delayed'/'realtime'. type: 'stock' | 'etf' | 'crypto'.
export const ASSETS = [
  { symbol: 'AAPL', name: 'Apple Inc.',            type: 'stock', currency: 'USD', themes: ['bigtech', 'dividends'], sector: 'Technology' },
  { symbol: 'MSFT', name: 'Microsoft Corp.',       type: 'stock', currency: 'USD', themes: ['bigtech', 'ai', 'dividends'], sector: 'Technology' },
  { symbol: 'GOOGL', name: 'Alphabet Inc.',        type: 'stock', currency: 'USD', themes: ['bigtech', 'ai'], sector: 'Communication' },
  { symbol: 'AMZN', name: 'Amazon.com Inc.',       type: 'stock', currency: 'USD', themes: ['bigtech'], sector: 'Consumer' },
  { symbol: 'NVDA', name: 'NVIDIA Corp.',          type: 'stock', currency: 'USD', themes: ['bigtech', 'ai'], sector: 'Technology' },
  { symbol: 'META', name: 'Meta Platforms Inc.',   type: 'stock', currency: 'USD', themes: ['bigtech', 'ai'], sector: 'Communication' },
  { symbol: 'TSLA', name: 'Tesla Inc.',            type: 'stock', currency: 'USD', themes: ['bigtech', 'energy'], sector: 'Automotive' },
  { symbol: 'AMD',  name: 'Advanced Micro Devices', type: 'stock', currency: 'USD', themes: ['ai'], sector: 'Technology' },
  { symbol: 'KO',   name: 'The Coca-Cola Company', type: 'stock', currency: 'USD', themes: ['dividends'], sector: 'Consumer' },
  { symbol: 'JNJ',  name: 'Johnson & Johnson',     type: 'stock', currency: 'USD', themes: ['dividends'], sector: 'Healthcare' },
  { symbol: 'PG',   name: 'Procter & Gamble',      type: 'stock', currency: 'USD', themes: ['dividends'], sector: 'Consumer' },
  { symbol: 'XOM',  name: 'Exxon Mobil Corp.',     type: 'stock', currency: 'USD', themes: ['energy', 'dividends'], sector: 'Energy' },
  { symbol: 'CVX',  name: 'Chevron Corp.',         type: 'stock', currency: 'USD', themes: ['energy', 'dividends'], sector: 'Energy' },
  { symbol: 'SPY',  name: 'S&P 500 ETF',           type: 'etf',   currency: 'USD', themes: ['etf'], sector: 'Index' },
  { symbol: 'QQQ',  name: 'Nasdaq-100 ETF',        type: 'etf',   currency: 'USD', themes: ['etf', 'bigtech'], sector: 'Index' },
  { symbol: 'VOO',  name: 'Vanguard S&P 500 ETF',  type: 'etf',   currency: 'USD', themes: ['etf', 'dividends'], sector: 'Index' },
  { symbol: 'BTC',  name: 'Bitcoin',               type: 'crypto', currency: 'USD', themes: ['crypto'], sector: 'Crypto' },
  { symbol: 'ETH',  name: 'Ethereum',              type: 'crypto', currency: 'USD', themes: ['crypto'], sector: 'Crypto' },
];

// Быстрый доступ по символу — используется quotes.js для базовой цены.
export const ASSET_BY_SYMBOL = Object.fromEntries(ASSETS.map((a) => [a.symbol, a]));

// Базовая «якорная» цена в центах на символ — вокруг неё синтетический движок
// строит блуждание. Реальные порядки величин, чтобы графики выглядели живыми.
export const BASE_PRICE_CENTS = {
  AAPL: 23400, MSFT: 42600, GOOGL: 18200, AMZN: 19500, NVDA: 12800,
  META: 52000, TSLA: 24800, AMD: 16400, KO: 6300, JNJ: 15600,
  PG: 16900, XOM: 11400, CVX: 15800, SPY: 56000, QQQ: 49000,
  VOO: 51500, BTC: 6800000, ETH: 380000,
};

// Бумаги, по которым отдаём ближайшую синтетическую дивидендную выплату.
export const DIVIDEND_SYMBOLS = new Set(['AAPL', 'MSFT', 'KO', 'JNJ', 'PG', 'XOM', 'CVX', 'VOO']);
