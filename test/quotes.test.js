import { test } from 'node:test';
import assert from 'node:assert/strict';

import { priceCentsAt, quoteFor, candlesFor, dividendsFor, isMarketOpen } from '../src/quotes.js';

const T = Date.UTC(2026, 6, 24, 15, 0, 0); // пт 24.07.2026 15:00 UTC (рынок открыт)

test('priceCentsAt детерминирован и даёт положительный int', () => {
  const a = priceCentsAt('AAPL', T);
  const b = priceCentsAt('AAPL', T);
  assert.equal(a, b);
  assert.ok(Number.isInteger(a) && a > 0);
  // другой символ — другая цена
  assert.notEqual(priceCentsAt('AAPL', T), priceCentsAt('BTC', T));
});

test('quoteFor: поля на месте, prevClose берётся из -24ч', () => {
  const q = quoteFor('MSFT', T);
  assert.equal(q.symbol, 'MSFT');
  assert.ok(Number.isInteger(q.priceCents) && q.priceCents > 0);
  assert.equal(q.prevCloseCents, priceCentsAt('MSFT', T - 24 * 3600 * 1000));
  assert.equal(typeof q.marketOpen, 'boolean');
  assert.ok(!Number.isNaN(Date.parse(q.ts)));
});

test('candlesFor: правильное число свечей, отсортированы, h/l корректны', () => {
  for (const [range, count] of [['1d', 24], ['1w', 28], ['1m', 30], ['1y', 52]]) {
    const c = candlesFor('AAPL', range, T);
    assert.equal(c.length, count, `range ${range}`);
    for (let i = 0; i < c.length; i++) {
      const k = c[i];
      assert.ok([k.o, k.h, k.l, k.c].every((v) => Number.isInteger(v) && v > 0));
      assert.ok(k.h >= Math.max(k.o, k.c));
      assert.ok(k.l <= Math.min(k.o, k.c));
      if (i > 0) assert.ok(c[i].t > c[i - 1].t, 'по возрастанию t');
    }
  }
});

test('candlesFor неизвестного диапазона падает на 1d (24)', () => {
  assert.equal(candlesFor('AAPL', 'zzz', T).length, 24);
});

test('dividendsFor: дивидендная бумага → 1 событие, недивидендная → пусто', () => {
  const d = dividendsFor('AAPL', T);
  assert.equal(d.length, 1);
  assert.equal(d[0].symbol, 'AAPL');
  assert.ok(Number.isInteger(d[0].perShareCents) && d[0].perShareCents > 0);
  assert.match(d[0].exDate, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(dividendsFor('NVDA', T), []);
});

test('isMarketOpen: крипта всегда открыта, акции — не в выходные', () => {
  const saturday = Date.UTC(2026, 6, 25, 15, 0, 0);
  assert.equal(isMarketOpen('BTC', saturday), true);
  assert.equal(isMarketOpen('AAPL', saturday), false);
  assert.equal(isMarketOpen('AAPL', T), true); // пятница днём
});
