// Проверка общего склада Polaris (воркфлоу n8n `polaris-sync`).
//
// Склад ошибается ТИХО: портфель просто начинает отличаться на телефоне и на
// ноутбуке, и никакой ошибки в логе при этом нет. Поэтому проверяем его
// обычными тестами, а не «на живом сервере».
//
// Что здесь ловится (всё — беды из прошлого опыта, не выдуманные):
//  • слияние по местному номеру записи: «сделка №1» с телефона и «сделка №1»
//    с ноутбука — это РАЗНЫЕ сделки, и склеивать их нельзя (Dayo);
//  • спор двух копий, решённый временем ОТПРАВКИ вместо времени ПРАВКИ:
//    телефон из кармана затирает свежую правку с ноутбука — молча (Nutri);
//  • стирание как «пропажа записи»: «начать заново» на телефоне отменялось бы
//    первым же обменом с ноутбуком (Tycha);
//  • разъехавшиеся копии кода: на сервере работает одна логика, а тесты
//    проверяют другую.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { slit } from '../src/sync_merge.js';

const zdes = path.dirname(fileURLToPath(import.meta.url));
const pusto = () => ({ trades: [], dividends: [], deleted: [], learn: null });

const sdelka = (id, changedAt, dop = {}) => ({
  id,
  symbol: 'AAPL',
  side: 'buy',
  qty: 1,
  priceCents: 10000,
  totalCents: 10000,
  ts: '2026-08-01T10:00:00.000Z',
  changedAt,
  ...dop,
});

test('две сделки с РАЗНЫХ устройств складываются, а не склеиваются', () => {
  const itog = slit(
    { ...pusto(), trades: [sdelka('tr_noutbuk_1', '2026-08-09T10:00:00.000Z')] },
    { trades: [sdelka('tr_telefon_1', '2026-08-09T11:00:00.000Z')] },
  );
  assert.equal(itog.trades.length, 2);
  assert.deepEqual(
    itog.trades.map((t) => t.id).sort(),
    ['tr_noutbuk_1', 'tr_telefon_1'],
  );
});

test('одна и та же сделка не задваивается при повторной отправке', () => {
  const odna = sdelka('tr_a_1', '2026-08-09T10:00:00.000Z');
  const itog = slit({ ...pusto(), trades: [odna] }, { trades: [odna] });
  assert.equal(itog.trades.length, 1);
});

test('спор решает время ПРАВКИ, а не время отправки', () => {
  // На складе лежит свежая правка (10-го). Устройство присылает СВОЮ старую
  // копию (2-го) — просто потому, что его наконец включили.
  const itog = slit(
    {
      ...pusto(),
      trades: [sdelka('tr_a_1', '2026-08-10T10:00:00.000Z', { totalCents: 10000 })],
    },
    {
      trades: [sdelka('tr_a_1', '2026-08-02T10:00:00.000Z', { totalCents: 55555 })],
    },
  );
  assert.equal(itog.trades.length, 1);
  assert.equal(itog.trades[0].totalCents, 10000, 'победила свежая правка');
});

test('один дивиденд с двух устройств — одна запись, деньги не удваиваются', () => {
  // Номер выплаты нарочно device-независимый: dv_БУМАГА_ДАТА.
  const v = (changedAt) => ({
    id: 'dv_AAPL_2026-08-08',
    symbol: 'AAPL',
    perShareCents: 50,
    qtyAtRecord: 10,
    totalCents: 500,
    ts: '2026-08-10T00:00:00.000Z',
    exDay: '2026-08-08',
    changedAt,
  });
  const itog = slit(
    { ...pusto(), dividends: [v('2026-08-10T09:00:00.000Z')] },
    { dividends: [v('2026-08-10T09:30:00.000Z')] },
  );
  assert.equal(itog.dividends.length, 1);
  assert.equal(itog.dividends[0].totalCents, 500);
});

test('«начать заново» переживает обмен: надгробие бьёт сделку', () => {
  const itog = slit(
    { ...pusto(), trades: [sdelka('tr_a_1', '2026-08-09T10:00:00.000Z')] },
    { deleted: [{ id: 'tr_a_1', at: '2026-08-09T12:00:00.000Z' }] },
  );
  assert.equal(itog.trades.length, 0, 'стёртая сделка не должна оставаться');
  assert.equal(itog.deleted.length, 1);
});

test('сделка, изменённая ПОСЛЕ стирания, возвращается', () => {
  const itog = slit(
    { ...pusto(), deleted: [{ id: 'tr_a_1', at: '2026-08-09T10:00:00.000Z' }] },
    { trades: [sdelka('tr_a_1', '2026-08-09T18:00:00.000Z')] },
  );
  assert.equal(itog.trades.length, 1);
});

test('старая копия стёртой сделки НЕ воскрешает её', () => {
  // Устройство, ещё не знающее про стирание, присылает свою прежнюю копию.
  const itog = slit(
    { ...pusto(), deleted: [{ id: 'tr_a_1', at: '2026-08-09T10:00:00.000Z' }] },
    { trades: [sdelka('tr_a_1', '2026-08-09T10:00:00.000Z')] },
  );
  assert.equal(itog.trades.length, 0, 'равенство — в пользу удаления');
});

test('ключ, которого устройство не прислало, не трогаем', () => {
  const bylo = {
    ...pusto(),
    trades: [sdelka('tr_a_1', '2026-08-09T10:00:00.000Z')],
    learn: { completed: ['l1'], changedAt: '2026-08-09T10:00:00.000Z' },
  };
  // Устройство прислало ТОЛЬКО дивиденды — сделки и учёба обязаны уцелеть.
  const itog = slit(bylo, { dividends: [] });
  assert.equal(itog.trades.length, 1);
  assert.deepEqual(itog.learn.completed, ['l1']);
});

test('мусор вместо списка не роняет склад', () => {
  const itog = slit(
    { trades: 'ой', dividends: null, deleted: 42, learn: 'нет' },
    { trades: [null, {}, sdelka('tr_a_1', '2026-08-09T10:00:00.000Z')] },
  );
  assert.equal(itog.trades.length, 1);
  assert.deepEqual(itog.dividends, []);
});

test('прогресс обучения: побеждает тот, кто занимался позже', () => {
  const itog = slit(
    { ...pusto(), learn: { completed: ['l1', 'l2'], changedAt: '2026-08-09T10:00:00.000Z' } },
    { learn: { completed: ['l1'], changedAt: '2026-08-02T10:00:00.000Z' } },
  );
  assert.deepEqual(itog.learn.completed, ['l1', 'l2']);
});

test('ядро на сервере и ядро в тестах — один и тот же текст', () => {
  const vyrezat = (file) => {
    const s = fs.readFileSync(path.join(zdes, '..', file), 'utf8');
    const a = s.indexOf('/* ==== ЯДРО СЛИЯНИЯ');
    const b = s.indexOf('/* ==== КОНЕЦ ЯДРА ==== */');
    assert.ok(a >= 0 && b > a, `маркеры ядра не найдены в ${file}`);
    return s.slice(a, b);
  };
  // Без этой проверки две копии тихо разъедутся: чинили бы одну, а на сервере
  // работала бы другая — и понять это было бы невозможно.
  assert.equal(
    vyrezat('src/sync_merge.js').replace(/\r\n/g, '\n'),
    vyrezat('n8n/n8n_polaris_sync.js').replace(/\r\n/g, '\n'),
  );
});
