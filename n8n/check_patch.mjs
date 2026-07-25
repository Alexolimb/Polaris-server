// Самопроверка патча boevogo воркфлоу polaris-api ДО заливки на сервер.
// Достаёт код Code-ноды прямо из JSON, отрезает обвязку n8n и прогоняет
// движок на граничных датах. Запуск:
//   node check_patch.mjs <файл-воркфлоу.json>
import { readFileSync } from 'node:fs';

const wf = JSON.parse(readFileSync(process.argv[2], 'utf8').replace(/^﻿/, ''));
const node = wf.nodes.find((n) => n.name === 'Code polaris/v1/dividends');
if (!node) throw new Error('нет ноды Code polaris/v1/dividends');

// Последние 4 строки — обвязка n8n ($input / return), она нам не нужна.
const lines = node.parameters.jsCode.split('\n');
const body = lines.slice(0, -4).join('\n');
const engine = new Function(
  `${body}\nreturn { dividendsFor, candlesFor, mktOpen, quoteFor, priceAt };`,
)();
const { dividendsFor, candlesFor, mktOpen } = engine;

const T = Date.UTC(2026, 6, 25, 9, 0, 0); // сб 25.07.2026, 09:00 UTC
let bad = 0;
const fail = (msg) => {
  console.log('  ПЛОХО: ' + msg);
  bad++;
};

console.log('--- дивиденды (якорный календарь) ---');
for (const sym of ['AAPL', 'MSFT', 'KO', 'JNJ', 'PG', 'XOM', 'CVX', 'VOO']) {
  const d = dividendsFor(sym, T);
  const past = d.filter((x) => Date.parse(x.exDate) <= T);
  const future = d.filter((x) => Date.parse(x.exDate) > T);
  const payOk = d.every((x) => Date.parse(x.payDate) > Date.parse(x.exDate));
  // через 7 часов ответ обязан быть тем же — иначе календарь снова «от сейчас»
  const stable =
    JSON.stringify(dividendsFor(sym, T + 7 * 3600e3)) === JSON.stringify(d);
  const ok = past.length >= 1 && future.length >= 1 && payOk && stable;
  if (!ok) fail(`${sym}: past=${past.length} future=${future.length} pay>ex=${payOk} stable=${stable}`);
  console.log(
    `  ${sym.padEnd(6)} ${ok ? 'ok' : '!!'}  ${d.map((x) => x.exDate).join('  ')}`,
  );
}
if (dividendsFor('NVDA', T).length !== 0) fail('NVDA не дивидендная, а выплаты есть');

console.log('--- range (регистр) ---');
const lens = {};
for (const r of ['1d', '1w', '1m', '1y', '1D', '1W', '1M', '1Y', 'мусор']) {
  lens[r] = candlesFor('AAPL', r, T).length;
}
console.log('  ' + Object.entries(lens).map(([k, v]) => `${k}:${v}`).join('  '));
if (lens['1M'] !== lens['1m']) fail('1M != 1m');
if (lens['1Y'] !== lens['1y']) fail('1Y != 1y');
if (lens['1W'] !== 28) fail('1W должно быть 28 свечей');
if (lens['мусор'] !== 24) fail('неизвестный range должен падать в 1d (24)');

console.log('--- часы биржи (Нью-Йорк) ---');
const cases = [
  ['зима 14:00 UTC = 09:00 NY', Date.UTC(2027, 0, 15, 14, 0), false],
  ['зима 15:00 UTC = 10:00 NY', Date.UTC(2027, 0, 15, 15, 0), true],
  ['зима 21:30 UTC = 16:30 NY', Date.UTC(2027, 0, 15, 21, 30), false],
  ['лето 13:45 UTC = 09:45 NY', Date.UTC(2026, 6, 15, 13, 45), true],
  ['лето 20:30 UTC = 16:30 NY', Date.UTC(2026, 6, 15, 20, 30), false],
  ['суббота', Date.UTC(2026, 6, 18, 15, 0), false],
];
for (const [label, t, want] of cases) {
  const got = mktOpen('AAPL', t);
  console.log(`  ${got === want ? 'ok' : '!!'}  ${label}: ${got} (жду ${want})`);
  if (got !== want) fail(label);
}
if (mktOpen('BTC', Date.UTC(2027, 0, 15, 3, 0)) !== true) fail('крипта должна быть открыта всегда');

console.log(bad === 0 ? '\nИТОГ: патч корректен, можно заливать' : `\nИТОГ: ПРОБЛЕМ ${bad} — НЕ ЗАЛИВАТЬ`);
process.exit(bad === 0 ? 0 : 1);
