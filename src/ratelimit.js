// Простое ограничение частоты запросов по IP — в памяти процесса.
//
// Зачем (аудит 25.07.2026): эндпоинты Cosmo (/v1/ai/*) ходят в платящий
// токенами Groq и были открыты всему интернету без ключа и без лимита, а URL
// сервера лежит в APK открытым текстом. Один скрипт мог за ночь сжечь всю
// бесплатную квоту Алекса и оставить продукт без наставника.
//
// Сознательные ограничения (это НЕ авторизация, а первый заслон):
// - счётчики живут в памяти одного процесса: при рестарте обнуляются, между
//   несколькими инстансами не делятся. Для одного узла на Hetzner — достаточно;
// - IP за NAT общий на всех, поэтому лимиты заведомо щедрые;
// - IP подделывается заголовком X-Forwarded-For, поэтому ему верим ТОЛЬКО
//   когда сервер явно объявлен стоящим за прокси (TRUST_PROXY=1).
//
// Полноценная защита (ключ устройства, квоты на аккаунт) — отдельное решение,
// см. server/SECURITY.md.

/** Скользящее окно фиксированной длины: [count, windowStartMs] на ключ. */
export class RateLimiter {
  /**
   * @param {object} o
   * @param {number} o.limit  сколько запросов разрешено за окно
   * @param {number} o.windowMs длина окна в миллисекундах
   * @param {() => number} [o.now] источник времени (тесты)
   */
  constructor({ limit, windowMs, now = Date.now }) {
    this.limit = limit;
    this.windowMs = windowMs;
    this._now = now;
    /** @type {Map<string, {count: number, start: number}>} */
    this._hits = new Map();
  }

  /**
   * Учесть запрос от ключа. Возвращает {allowed, retryAfterSec, remaining}.
   */
  take(key) {
    const now = this._now();
    // Подчистка: без неё Map растёт на каждый новый IP и течёт памятью.
    // Делаем её здесь же, а не по таймеру, чтобы не держать процесс живым.
    if (this._hits.size > 5000) this._sweep(now);

    const cur = this._hits.get(key);
    if (!cur || now - cur.start >= this.windowMs) {
      this._hits.set(key, { count: 1, start: now });
      return { allowed: true, retryAfterSec: 0, remaining: this.limit - 1 };
    }
    cur.count += 1;
    if (cur.count > this.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((cur.start + this.windowMs - now) / 1000));
      return { allowed: false, retryAfterSec, remaining: 0 };
    }
    return { allowed: true, retryAfterSec: 0, remaining: this.limit - cur.count };
  }

  _sweep(now) {
    for (const [k, v] of this._hits) {
      if (now - v.start >= this.windowMs) this._hits.delete(k);
    }
  }

  /** Для тестов: забыть всё. */
  reset() {
    this._hits.clear();
  }
}

/**
 * IP клиента. X-Forwarded-For принимаем только при trustProxy — иначе любой
 * желающий обходил бы лимит одним лишним заголовком.
 */
export function clientIp(req, { trustProxy = false } = {}) {
  if (trustProxy) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd.trim()) {
      // Первый адрес в цепочке — исходный клиент.
      return fwd.split(',')[0].trim();
    }
  }
  return req.socket?.remoteAddress ?? 'unknown';
}
