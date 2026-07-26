// Генератор офлайн-набора приложения из канонического файла.
//
//   node tools/sync_market_base.mjs [путь-к-app]
//
// Читает data/market_base.json (единственный источник правды по каталогу,
// ценам и дивидендам) и переписывает app/lib/services/market_base.g.dart.
// Запускать ВСЕГДА после правки канона — иначе цифры на сервере и в офлайне
// разъедутся снова, а именно из-за этого портфель игрока прыгал на десятки
// процентов при переключении онлайн↔офлайн (аудит 25.07.2026).
//
// Файл-результат закоммичен в репозиторий приложения: приложению нужны
// КОМПИЛЬНЫЕ константы (офлайн-режим не может ничего дочитывать), поэтому
// генерация ручная, а тесты с обеих сторон стерегут расхождение.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const BASE_PATH = fileURLToPath(new URL('../data/market_base.json', import.meta.url));
const DEFAULT_APP_DIR = fileURLToPath(new URL('../../app', import.meta.url));

// Экранируем строку для одинарных кавычек Dart (имена активов приходят из
// канона и содержат апострофы: "Apple Inc." безопасно, но "Moody's" — нет).
function dartString(s) {
  return `'${String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\$/g, '\\\$')}'`;
}

function dartThemes(ids) {
  if (!ids || ids.length === 0) return '';
  return `, themeIds: [${ids.map(dartString).join(', ')}]`;
}

function generate(base) {
  const lines = [];
  lines.push('// СГЕНЕРИРОВАНО — РУКАМИ НЕ ПРАВИТЬ.');
  lines.push('//');
  lines.push('// Источник: server/data/market_base.json (версия ' + base.version + ').');
  lines.push('// Перегенерировать: node server/tools/sync_market_base.mjs');
  lines.push('//');
  lines.push('// Это офлайн-набор приложения: те же активы, те же базовые цены и те же');
  lines.push('// дивиденды, что раздаёт сервер. Раньше таблицы жили в двух местах и');
  lines.push('// разъехались (BTC $118 420 против $68 000, SOL/NFLX/ADA сервер не знал');
  lines.push('// вовсе и подставлял $100) — портфель игрока прыгал при переключении');
  lines.push('// онлайн↔офлайн. Для учебного продукта про деньги это подрывало доверие');
  lines.push('// ко всем цифрам сразу.');
  lines.push('library;');
  lines.push('');
  lines.push("import '../models/models.dart';");
  lines.push("import 'api.dart' show MarketTheme;");
  lines.push('');
  lines.push('/// Версия канонических данных — сверяется с сервером в тестах.');
  lines.push(`const String marketBaseVersion = ${dartString(base.version)};`);
  lines.push('');
  lines.push('/// Темы-подборки (фолбэк, если сервер тем не прислал). Идентификаторы');
  lines.push('/// совпадают с assets/content/themes.*.json — по ним же работают ссылки');
  lines.push('/// «попробовать в симуляторе» из уроков.');
  lines.push('const List<MarketTheme> fixtureThemes = [');
  for (const t of base.themes) {
    lines.push(`  MarketTheme(id: ${dartString(t.id)}, title: ${dartString(t.title)}),`);
  }
  lines.push('];');
  lines.push('');
  lines.push('/// Каталог активов офлайн-режима.');
  lines.push('const List<Asset> fixtureAssets = [');
  for (const a of base.assets) {
    const sector = a.sector ? `, sector: ${dartString(a.sector)}` : '';
    const freshness =
      a.freshness && a.freshness !== 'realtime'
        ? `, freshness: QuoteFreshness.${a.freshness}`
        : '';
    lines.push(
      `  Asset(symbol: ${dartString(a.symbol)}, name: ${dartString(a.name)}, ` +
        `type: AssetType.${a.type}${sector}${dartThemes(a.themes)}${freshness}),`,
    );
  }
  lines.push('];');
  lines.push('');
  lines.push('/// Цены офлайн-режима: (текущая, вчерашнее закрытие), в центах.');
  lines.push('const Map<String, ({int price, int prev})> fixturePrices = {');
  for (const a of base.assets) {
    lines.push(
      `  ${dartString(a.symbol)}: (price: ${a.priceCents}, prev: ${a.prevCloseCents}),`,
    );
  }
  lines.push('};');
  lines.push('');
  lines.push('/// Дивиденд на акцию, центы. Символов без выплат здесь нет.');
  lines.push('const Map<String, int> fixtureDividendPerShare = {');
  for (const a of base.assets) {
    if (Number.isInteger(a.dividendPerShareCents) && a.dividendPerShareCents > 0) {
      lines.push(`  ${dartString(a.symbol)}: ${a.dividendPerShareCents},`);
    }
  }
  lines.push('};');
  lines.push('');
  return lines.join('\n');
}

const appDir = process.argv[2] ? path.resolve(process.argv[2]) : DEFAULT_APP_DIR;
const outPath = path.join(appDir, 'lib', 'services', 'market_base.g.dart');
const base = JSON.parse(readFileSync(BASE_PATH, 'utf8'));
writeFileSync(outPath, generate(base), 'utf8');
console.log(
  `market_base.g.dart обновлён: ${base.assets.length} активов, ` +
    `${base.themes.length} тем, версия ${base.version}\n  -> ${outPath}`,
);
