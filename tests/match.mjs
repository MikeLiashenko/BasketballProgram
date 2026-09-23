import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = process.env.OUT || '/tmp';
const BASE = process.env.BASE || 'http://127.0.0.1:8199';
const fake = fs.readFileSync(new URL('./fake-firebase.js', import.meta.url), 'utf8');

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
// Блокируем внешние CDN: Firebase подменяем заглушкой, шрифты не нужны
await ctx.route('**://www.gstatic.com/**', r => r.fulfill({ status: 200, body: '' }));
await ctx.route('**://fonts.googleapis.com/**', r => r.fulfill({ status: 200, body: '' }));
await ctx.route('**://fonts.gstatic.com/**', r => r.abort());
ctx.setDefaultTimeout(4000);   // быстрый провал вместо 30-секундного ожидания
const page = await ctx.newPage();
await page.addInitScript(fake);

const errors = [];
page.on('console', m => { if (m.type() === 'error' && !/ERR_|favicon/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));

await page.goto(BASE + '/index.html', { waitUntil: 'load' });
await page.waitForTimeout(400);

const step = async (name, fn) => {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); errors.push('STEP ' + name + ': ' + e.message); }
};

console.log('РЕГИСТРАЦИЯ');
await step('вкладка регистрации', async () => {
  await page.click('.auth-tab[data-mode="register"]');
  await page.fill('#login-nick', 'Тестер');
  await page.fill('#login-pin', '1234');
  await page.click('#login-btn');
  await page.waitForSelector('#screen-menu.active', { timeout: 3000 });
});

// Второй игрок — прямо в базу
await page.evaluate(() => db.ref('users/u2').set({ nickname: 'Соперник', pin: 'p0', online: true,
  avatar: '🔥', color: '#45d6ff', stats: { matches: 3, hits: 30, misses: 10, wins: 2, losses: 1, points: 30, best: 4 } }));

console.log('\nМАСТЕР: ПРОДВИНУТЫЙ + НА ЦЕЛЬ');
await step('создание матча с зонами', async () => {
  await page.click('#create-btn');
  await page.click('#type-advanced');
  await page.click('[data-goto="2"]');
  await page.click('[data-goal="common"]');
  const lbl = await page.textContent('#target-label');
  if (!/очков/.test(lbl)) throw new Error('подпись цели не сменилась на очки: ' + lbl);
  await page.click('[data-target="1"]'); // цель 11
  await page.click('[data-goto="3"]');
  await page.fill('#match-name', 'Тест зоны');
  await page.click('.user-row');
  await page.click('#send-invites-btn');
  await page.waitForSelector('#screen-lobby.active', { timeout: 3000 });
});

await step('зоны и цель записаны в матч', async () => {
  const m = await page.evaluate(() => Object.values(window.__DB.matches)[0]);
  if (m.shotMode !== 'zones') throw new Error('shotMode=' + m.shotMode);
  if (m.targetHits !== 11) throw new Error('targetHits=' + m.targetHits);
});

await step('старт матча после входа соперника', async () => {
  await page.evaluate(() => {
    const id = Object.keys(window.__DB.matches)[0];
    return db.ref('matches/' + id + '/players/u2').update({ status: 'joined', joinedAt: Date.now() });
  });
  await page.waitForTimeout(1200);           // тик refreshStartBtn
  await page.click('#start-btn');
  await page.waitForSelector('#screen-match.active', { timeout: 3000 });
});

console.log('\nМАТЧ: ЗОНЫ, ОТМЕНА, РЕАКЦИИ');
await step('панель зон видна, «Попал» скрыта', async () => {
  if (await page.isHidden('#zones-bar')) throw new Error('zones-bar скрыт');
  if (await page.isVisible('#btn-hit')) throw new Error('btn-hit виден в режиме зон');
  const head = await page.textContent('#match-score-head');
  if (head !== 'ОЧКИ') throw new Error('заголовок колонки: ' + head);
});

await step('бросок +3 даёт 3 очка и 1 попадание', async () => {
  await page.click('#zones-bar .z3');
  await page.waitForTimeout(300);
  const p = await page.evaluate(() => {
    const m = Object.values(window.__DB.matches)[0];
    return m.players[m.creatorId];
  });
  if (p.points !== 3) throw new Error('points=' + p.points);
  if (p.hits !== 1) throw new Error('hits=' + p.hits);
  if (p.streak !== 1) throw new Error('streak=' + p.streak);
  if (!p.zoneHits || p.zoneHits.z3 !== 1) throw new Error('разбивка по зонам: ' + JSON.stringify(p.zoneHits));
  if (p.zoneHits.z1 || p.zoneHits.z2) throw new Error('засчитано в чужую зону: ' + JSON.stringify(p.zoneHits));
});

await step('кнопка отмены появилась', async () => {
  if (await page.isHidden('#undo-btn')) throw new Error('undo-btn скрыт');
});

await step('отмена возвращает счёт', async () => {
  await page.click('#undo-btn');
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => {
    const m = Object.values(window.__DB.matches)[0];
    const p = m.players[m.creatorId];
    return { pts: p.points, hits: p.hits, streak: p.streak, last: m.lastShot || null,
             zones: p.zoneHits || null,
             evs: Object.values(m.events || {}).map(e => e.action) };
  });
  if (st.pts !== 0 || st.hits !== 0) throw new Error('счёт не откатился: ' + JSON.stringify(st));
  if (st.zones && st.zones.z3 !== 0) throw new Error('зона не откатилась: ' + JSON.stringify(st.zones));
  if (st.last) throw new Error('lastShot не очищен');
  if (st.evs.includes('hit')) throw new Error('событие броска осталось: ' + st.evs);
  if (!st.evs.includes('undo')) throw new Error('нет события отмены');
});

await step('промах передаёт ход', async () => {
  await page.click('#btn-miss');
  await page.waitForTimeout(300);
  const m = await page.evaluate(() => Object.values(window.__DB.matches)[0]);
  if (m.currentTurnIndex !== 1) throw new Error('ход не перешёл: ' + m.currentTurnIndex);
  if (m.players[m.creatorId].misses !== 1) throw new Error('промах не записан');
});

await step('кнопки заблокированы в чужой ход', async () => {
  if (!(await page.isDisabled('#btn-miss'))) throw new Error('btn-miss активна в чужой ход');
});

await step('реакция улетает на экран', async () => {
  await page.click('.rx-btn');
  await page.waitForTimeout(400);
  const n = await page.evaluate(() => document.querySelectorAll('.reaction-layer .rx').length);
  if (n < 1) throw new Error('реакция не отрисовалась');
});

console.log('\nЗАВЕРШЕНИЕ, РЕЗУЛЬТАТЫ, РЕВАНШ');
await step('цель закрывается и матч завершается', async () => {
  await page.evaluate(() => {
    const id = Object.keys(window.__DB.matches)[0];
    const m = window.__DB.matches[id];
    return db.ref('matches/' + id).update({
      currentTurnIndex: 0,
      ['players/' + m.creatorId + '/points']: 10,
      ['players/' + m.creatorId + '/hits']: 10,
      'players/u2/left': true       // соперник ушёл — матч закроется на победном броске
    });
  });
  await page.waitForTimeout(300);
  await page.click('#zones-bar .z1');
  await page.waitForSelector('#screen-results.active', { timeout: 3000 });
});

await step('победитель и очки на экране итогов', async () => {
  const t = await page.textContent('#results-winner');
  if (!/Тестер/.test(t)) throw new Error('победитель не показан: ' + t);
  if (!/очков/.test(t)) throw new Error('нет подписи очков: ' + t);
});

await step('статистика начислена', async () => {
  const st = await page.evaluate(() => window.__DB.users[localStorage.getItem('bb_userId')].stats);
  if (st.wins !== 1) throw new Error('wins=' + st.wins);
  if (st.points !== 11) throw new Error('points=' + st.points);
  if (!st.best) throw new Error('best серия не записана');
});

await step('история записана с очками', async () => {
  const h = await page.evaluate(() => Object.values(window.__DB.history[localStorage.getItem('bb_userId')])[0]);
  if (h.myPoints !== 11) throw new Error('myPoints=' + h.myPoints);
  if (h.shotMode !== 'zones') throw new Error('shotMode=' + h.shotMode);
  if (!h.roster[0].userId) throw new Error('в составе нет userId');
});

await step('реванш создаёт новый матч с теми же настройками', async () => {
  await page.click('#results-rematch-btn');
  await page.click('#modal-ok');
  await page.waitForSelector('#screen-lobby.active', { timeout: 3000 });
  const ms = await page.evaluate(() => Object.values(window.__DB.matches));
  const rm = ms.find(m => m.rematchOf);
  if (!rm) throw new Error('матч-реванш не создан');
  if (rm.shotMode !== 'zones' || rm.targetHits !== 11) throw new Error('настройки не перенесены');
  if (rm.players[Object.keys(rm.players).find(k => k !== rm.creatorId)].points !== 0) throw new Error('счёт не обнулён');
});

console.log('\nРЕЙТИНГ И ПРОФИЛЬ');
await step('экран рейтинга строится', async () => {
  await page.evaluate(() => goMenu());
  await page.click('#rating-btn');
  await page.waitForSelector('#screen-rating.active', { timeout: 3000 });
  await page.waitForTimeout(400);
  const n = await page.evaluate(() => document.querySelectorAll('.rate-row').length);
  if (n < 2) throw new Error('в рейтинге строк: ' + n);
});

await step('сортировка по точности отсекает новичков', async () => {
  await page.click('#seg-rating .seg-btn[data-sort="acc"]');
  await page.waitForTimeout(200);
  const txt = await page.textContent('#rating-list');
  if (!/Соперник/.test(txt)) throw new Error('игрок с 30 бросками отсутствует');
  if (/Тестер/.test(txt)) throw new Error('игрок с 11 бросками попал в точность');
});

await step('профиль показывает статистику и достижения', async () => {
  await page.evaluate(() => goMenu());
  await page.waitForTimeout(300);
  await page.click('#menu-avatar');
  await page.waitForTimeout(200);
  const stats = await page.evaluate(() => document.querySelectorAll('.pstat').length);
  const got = await page.evaluate(() => document.querySelectorAll('.ach.got').length);
  if (stats !== 10) throw new Error('плиток статистики: ' + stats);
  if (got < 2) throw new Error('зажглось достижений: ' + got);
  await page.screenshot({ path: OUT + '/profile.png' });
});
await page.click('#profile-cancel');
await page.waitForTimeout(200);

console.log('\nСМЕНА НИКА');
await step('ник нельзя занять чужой', async () => {
  await page.click('#menu-avatar');
  await page.waitForTimeout(200);
  await page.fill('#profile-nick-input', 'Соперник');
  await page.click('#profile-save');
  await page.waitForTimeout(400);
  const err = await page.textContent('#profile-error');
  if (!/занят/.test(err)) throw new Error('ошибка не показана: ' + err);
});

await step('короткий ник отклоняется', async () => {
  await page.fill('#profile-nick-input', 'ab');
  await page.click('#profile-save');
  await page.waitForTimeout(200);
  const err = await page.textContent('#profile-error');
  if (!/3–16/.test(err)) throw new Error('ошибка не показана: ' + err);
});

await step('свободный ник сохраняется', async () => {
  await page.fill('#profile-nick-input', 'Тестер2');
  await page.click('#profile-save');
  await page.waitForTimeout(500);
  await page.click('#modal-ok');
  await page.waitForTimeout(300);
  const st = await page.evaluate(() => ({
    db: window.__DB.users[localStorage.getItem('bb_userId')].nickname,
    ls: localStorage.getItem('bb_nickname'),
    head: document.getElementById('menu-nick').textContent
  }));
  if (st.db !== 'Тестер2' || st.ls !== 'Тестер2' || st.head !== 'Тестер2') throw new Error(JSON.stringify(st));
});

console.log('\nТРЕНИРОВКА В ОДИНОЧКУ');
await step('тренировка стартует сразу', async () => {
  await page.click('#solo-btn');
  await page.waitForTimeout(200);
  await page.click('#modal-cancel');              // без зон
  await page.waitForSelector('#screen-match.active');
  const m = await page.evaluate(() => window.__DB.matches[localStorage.getItem('bb_activeMatch')]);
  if (!m.solo) throw new Error('матч не помечен как тренировка');
  if (m.status !== 'active') throw new Error('статус: ' + m.status);
  if (m.shotMode !== 'simple') throw new Error('режим: ' + m.shotMode);
});

await step('броски в тренировке засчитываются', async () => {
  await page.click('#btn-hit');
  await page.waitForTimeout(250);
  await page.click('#btn-hit');
  await page.waitForTimeout(250);
  await page.click('#btn-miss');
  await page.waitForTimeout(250);
  const p = await page.evaluate(() => {
    const m = window.__DB.matches[localStorage.getItem('bb_activeMatch')];
    return m.players[m.creatorId];
  });
  if (p.hits !== 2 || p.misses !== 1) throw new Error(JSON.stringify(p));
});

let beforeSolo = null;
await step('итоги тренировки без победителя', async () => {
  beforeSolo = await page.evaluate(() => window.__DB.users[localStorage.getItem('bb_userId')].stats);
  await page.click('#finish-btn');
  await page.waitForTimeout(200);
  await page.click('#modal-ok');
  await page.waitForSelector('#screen-results.active');
  const title = await page.textContent('#results-title');
  if (!/тренировк/i.test(title)) throw new Error('заголовок: ' + title);
  const banner = await page.textContent('#results-winner');
  if (/🏆/.test(banner)) throw new Error('показан кубок победителя');
  if (await page.isVisible('#results-rematch-btn')) throw new Error('предложен реванш');
});

await step('тренировка не даёт побед, но копит броски', async () => {
  await page.waitForTimeout(400);
  const after = await page.evaluate(() => window.__DB.users[localStorage.getItem('bb_userId')].stats);
  if (after.wins !== beforeSolo.wins) throw new Error('победы изменились: ' + beforeSolo.wins + ' → ' + after.wins);
  if (after.losses !== beforeSolo.losses) throw new Error('поражения изменились');
  if (after.hits !== beforeSolo.hits + 2) throw new Error('попадания: ' + after.hits);
  if (after.matches !== beforeSolo.matches + 1) throw new Error('матчи не выросли');
});

await page.evaluate(() => goMenu());
await page.waitForTimeout(300);

console.log('\nМАТЧ НА ВРЕМЯ');
await step('часы идут и матч закрывается по истечении времени', async () => {
  await page.click('#create-btn');
  await page.click('[data-goto="2"]');
  await page.click('[data-goal="timed"]');
  if (await page.isHidden('#duration-wrap')) throw new Error('блок длительности скрыт');
  await page.click('[data-goto="3"]');
  await page.click('.user-row');
  await page.click('#send-invites-btn');
  await page.waitForSelector('#screen-lobby.active', { timeout: 3000 });
  await page.evaluate(() => {
    const id = localStorage.getItem('bb_activeMatch');
    return db.ref('matches/' + id + '/players/u2').update({ status: 'joined', joinedAt: Date.now() });
  });
  await page.waitForTimeout(1200);
  await page.click('#start-btn');
  await page.waitForSelector('#screen-match.active', { timeout: 3000 });
  if (await page.isHidden('#match-clock')) throw new Error('часы матча скрыты');
  // Подкручиваем конец матча на секунду вперёд
  await page.evaluate(() => {
    const id = localStorage.getItem('bb_activeMatch');
    return db.ref('matches/' + id + '/endsAt').set(Date.now() + 700);
  });
  await page.waitForSelector('#screen-results.active', { timeout: 6000 });
});

console.log('\n--- ОШИБКИ ---');
console.log(errors.length ? errors.join('\n') : 'нет');
await browser.close();
process.exit(errors.length ? 1 : 0);
