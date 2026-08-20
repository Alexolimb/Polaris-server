// Ядро общего склада Polaris — то же самое, что крутится в воркфлоу n8n
// `polaris-sync`. Здесь оно живёт отдельным модулем, чтобы его можно было
// проверить обычными тестами (`npm test` в папке server), а не «на живом
// сервере»: склад ошибается ТИХО — портфель просто начинает отличаться на
// телефоне и ноутбуке, и никакой ошибки в логе при этом нет.
//
// ⚠️ Кусок между маркерами ЯДРО обязан быть БАЙТ В БАЙТ таким же, как
// в `server/n8n/n8n_polaris_sync.js`. За этим следит тест `sync_merge.test.js`:
// без него две копии разъехались бы, и мы чинили бы одну, а на сервере
// работала бы другая.

/* ==== ЯДРО СЛИЯНИЯ (копия в server/n8n/n8n_polaris_sync.js) ==== */
/** Служебное время в миллисекундах. Мусор и пустое считаем «очень давно». */
function kogda(s) {
  const t = Date.parse(s || '');
  return Number.isNaN(t) ? 0 : t;
}

/** Список из слепка, если это правда список. */
function spisok(v) {
  return Array.isArray(v) ? v : [];
}

/**
 * Сложить то, что лежало на складе, с тем, что прислало устройство.
 *
 * Четыре правила, которые нельзя нарушать:
 * 1. Складываем по ГЛОБАЛЬНОМУ номеру (`id`). Местный счётчик устройства
 *    («сделка №1») сюда не приезжает вовсе: на разных устройствах он
 *    означает разные сделки, и слияние по нему потеряло бы половину.
 * 2. Спор двух копий решает время ИЗМЕНЕНИЯ (`changedAt`), а не время
 *    отправки: у присылающего оно всегда «сейчас», и побеждал бы не тот,
 *    кто изменил последним, а тот, кто последним включил приложение.
 * 3. Удаление — событие, а не пропажа. Сделки СКЛАДЫВАЮТСЯ, поэтому
 *    отсутствие сделки в списке не значит ничего: стёртый на телефоне
 *    портфель приезжал бы обратно с ноутбука. Стирание едет отдельным
 *    списком `deleted` — надгробием {id, at}.
 * 4. Ключ, которого устройство не прислало, мы не трогаем вообще.
 */
function slit(saved, incoming) {
  // ── Надгробия: складываем по id, у каждого своё время (правило 3).
  const mogily = {};
  for (const list of [spisok(saved.deleted), spisok(incoming.deleted)]) {
    for (const e of list) {
      if (!e || !e.id) continue;
      const id = String(e.id);
      // Из двух надгробий одной записи оставляем ПОЗДНЕЕ.
      if (!mogily[id] || kogda(e.at) > kogda(mogily[id].at)) {
        mogily[id] = { id, at: e.at || new Date().toISOString() };
      }
    }
  }

  /** Сложить один список записей по глобальному номеру (правила 1 и 2). */
  const slozhit = (kluch) => {
    const vse = {};
    for (const list of [spisok(saved[kluch]), spisok(incoming[kluch])]) {
      for (const e of list) {
        if (!e || !e.id) continue;
        const id = String(e.id);
        const bylo = vse[id];
        // Строго больше: при равенстве остаётся тот, кто уже лежал на складе.
        // Иначе повторная отправка одного и того же дёргала бы всех соседей.
        if (!bylo || kogda(e.changedAt) > kogda(bylo.changedAt)) vse[id] = e;
      }
    }
    // Надгробие побеждает запись, если стёрли ПОЗЖЕ, чем правили. Ровное
    // равенство — в пользу удаления: устройство, ещё не знающее про стирание,
    // присылает свою старую копию с прежним changedAt и не должно её воскрешать.
    const zhivye = [];
    for (const e of Object.values(vse)) {
      const m = mogily[String(e.id)];
      if (m && kogda(m.at) >= kogda(e.changedAt)) continue;
      zhivye.push(e);
    }
    zhivye.sort((a, b) => String(a.id).localeCompare(String(b.id)));
    return zhivye;
  };

  // ── Прогресс обучения — ОДНА запись, а не список. Спорит по тому же правилу.
  // Устройство не прислало ключ — оставляем то, что лежало (правило 4).
  let ucheba = saved.learn ?? null;
  if (incoming.learn && typeof incoming.learn === 'object') {
    if (!ucheba || kogda(incoming.learn.changedAt) >= kogda(ucheba.changedAt)) {
      ucheba = incoming.learn;
    }
  }

  // Надгробия не копятся бесконечно: держим последние три тысячи ПО ВРЕМЕНИ,
  // а не по порядку появления, — иначе обрезка могла бы выбросить свежее
  // надгробие и воскресить стёртую сделку.
  const nadgrobiya = Object.values(mogily)
    .sort((a, b) => kogda(a.at) - kogda(b.at))
    .slice(-3000);

  return {
    trades: slozhit('trades'),
    dividends: slozhit('dividends'),
    deleted: nadgrobiya,
    learn: ucheba,
  };
}
/* ==== КОНЕЦ ЯДРА ==== */

export { slit, kogda, spisok };
