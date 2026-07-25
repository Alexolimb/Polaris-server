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

test('candlesFor: регистр диапазона не важен (1M == 1m, а не молча суточный)', () => {
  // Регресс: раньше RANGE_PARAMS искался по точному ключу, поэтому '1M'
  // проваливался в фолбэк '1d' и годовой график молча показывал сутки.
  assert.equal(candlesFor('AAPL', '1M', T).length, candlesFor('AAPL', '1m', T).length);
  assert.equal(candlesFor('AAPL', '1Y', T).length, candlesFor('AAPL', '1y', T).length);
  assert.equal(candlesFor('AAPL', '1W', T).length, 28);
});

test('dividendsFor: календарь якорный — отдаёт прошедшую и следующую выплату', () => {
  // Регресс на баг ночи 25.07.2026: раньше ex-date считалась как now+5..40
  // дней при КАЖДОМ запросе, поэтому отсечка вечно убегала вперёд и в
  // приложении (условие exDate <= now) дивиденды не начислялись НИ РАЗУ.
  const d = dividendsFor('AAPL', T);
  assert.ok(d.length >= 1);
  assert.equal(d[0].symbol, 'AAPL');
  assert.ok(Number.isInteger(d[0].perShareCents) && d[0].perShareCents > 0);
  assert.match(d[0].exDate, /^\d{4}-\d{2}-\d{2}$/);
  // Хотя бы одна отсечка должна быть УЖЕ в прошлом — иначе начислять нечего.
  const past = d.filter((x) => Date.parse(x.exDate) <= T);
  assert.ok(past.length >= 1, 'нет ни одной прошедшей отсечки');
  // payDate всегда позже exDate.
  for (const x of d) assert.ok(Date.parse(x.payDate) > Date.parse(x.exDate));
  assert.deepEqual(dividendsFor('NVDA', T), []);
});

test('dividendsFor: даты не зависят от момента запроса (якорь, а не «сейчас»)', () => {
  const morning = dividendsFor('AAPL', Date.UTC(2026, 6, 24, 6, 0, 0));
  const evening = dividendsFor('AAPL', Date.UTC(2026, 6, 24, 22, 0, 0));
  assert.deepEqual(
    morning.map((x) => x.exDate),
    evening.map((x) => x.exDate),
  );
});

test('isMarketOpen: сессия считается по Нью-Йорку и ЗИМОЙ тоже', () => {
  // Регресс: часы были зашиты как 13:30-20:00 UTC — это верно только для
  // летнего EDT. Зимой (EST) сессия идёт 14:30-21:00 UTC, и полгода индикатор
  // «рынок открыт» врал на час.
  // Зима: 15 января 2027 (чт). 14:00 UTC = 09:00 NY — ещё закрыто.
  assert.equal(isMarketOpen('AAPL', Date.UTC(2027, 0, 15, 14, 0, 0)), false);
  // 15:00 UTC = 10:00 NY — открыто.
  assert.equal(isMarketOpen('AAPL', Date.UTC(2027, 0, 15, 15, 0, 0)), true);
  // 21:30 UTC = 16:30 NY — уже закрыто.
  assert.equal(isMarketOpen('AAPL', Date.UTC(2027, 0, 15, 21, 30, 0)), false);
  // Лето: 15 июля 2026 (ср). 13:45 UTC = 09:45 NY — открыто.
  assert.equal(isMarketOpen('AAPL', Date.UTC(2026, 6, 15, 13, 45, 0)), true);
  // 20:30 UTC = 16:30 NY — закрыто.
  assert.equal(isMarketOpen('AAPL', Date.UTC(2026, 6, 15, 20, 30, 0)), false);
  // Крипта — круглосуточно, в любой сезон.
  assert.equal(isMarketOpen('BTC', Date.UTC(2027, 0, 15, 3, 0, 0)), true);
});

test('isMarketOpen: крипта всегда открыта, акции — не в выходные', () => {
  const saturday = Date.UTC(2026, 6, 25, 15, 0, 0);
  assert.equal(isMarketOpen('BTC', saturday), true);
  assert.equal(isMarketOpen('AAPL', saturday), false);
  assert.equal(isMarketOpen('AAPL', T), true); // пятница днём
});
