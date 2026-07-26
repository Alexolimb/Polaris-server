// Тесты на находки аудита 25.07.2026: неизвестный тикер и ограничение частоты.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { RateLimiter, clientIp } from '../src/ratelimit.js';
import { quotesFor, unknownSymbols, priceCentsAt, UnknownSymbolError } from '../src/quotes.js';

const T = Date.UTC(2026, 6, 24, 15, 0, 0);

test('неизвестный тикер не получает выдуманную цену', () => {
  // Регресс: раньше basePrice возвращал дефолт 10000 для ЛЮБОЙ строки, и
  // проверенный вживую запрос ?symbol=NOTAREALTICKER123 отдавал $101.24 —
  // опечатка выглядела как настоящая бумага в продукте про деньги.
  assert.throws(() => priceCentsAt('NOTAREALTICKER123', T), UnknownSymbolError);
  assert.throws(() => priceCentsAt('', T), UnknownSymbolError);
  // известный — по-прежнему считается
  assert.ok(priceCentsAt('AAPL', T) > 0);
});

test('пачка котировок: известные отдаём, неизвестные — в отдельное поле', () => {
  const syms = ['AAPL', 'NOPE1', 'MSFT'];
  const quotes = quotesFor(syms, T);
  assert.deepEqual(quotes.map((q) => q.symbol), ['AAPL', 'MSFT']);
  assert.deepEqual(unknownSymbols(syms), ['NOPE1']);
  // один опечатанный тикер не должен ронять весь экран «Рынки»
  assert.equal(quotes.length, 2);
});

test('ограничение частоты: пропускает до лимита, потом отказывает', () => {
  let now = 1_000_000;
  const rl = new RateLimiter({ limit: 3, windowMs: 60_000, now: () => now });
  for (let i = 0; i < 3; i++) {
    assert.equal(rl.take('ip1').allowed, true, `запрос ${i + 1} должен пройти`);
  }
  const denied = rl.take('ip1');
  assert.equal(denied.allowed, false);
  assert.ok(denied.retryAfterSec >= 1, 'должен сказать, через сколько повторить');

  // другой клиент не страдает от соседа
  assert.equal(rl.take('ip2').allowed, true);

  // окно прошло — счётчик обнулился
  now += 60_001;
  assert.equal(rl.take('ip1').allowed, true);
});

test('IP клиента: заголовку прокси верим ТОЛЬКО когда это явно разрешено', () => {
  const req = {
    headers: { 'x-forwarded-for': '1.2.3.4, 5.6.7.8' },
    socket: { remoteAddress: '10.0.0.1' },
  };
  // по умолчанию заголовок подделываем кто угодно — не верим
  assert.equal(clientIp(req), '10.0.0.1');
  // за прокси берём ПЕРВЫЙ адрес из цепочки
  assert.equal(clientIp(req, { trustProxy: true }), '1.2.3.4');
  // без заголовка — сокет в любом режиме
  const bare = { headers: {}, socket: { remoteAddress: '10.0.0.2' } };
  assert.equal(clientIp(bare, { trustProxy: true }), '10.0.0.2');
});
