/* Лобби: кто в сети, удаление приглашённого, полный лог матча. */
import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = process.env.OUT || '/tmp';
const BASE = process.env.BASE || 'http://127.0.0.1:8199';

const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
ctx.setDefaultTimeout(4000);
await ctx.route('**://www.gstatic.com/**', r => r.fulfill({ status: 200, body: '' }));
await ctx.route('**://fonts.googleapis.com/**', r => r.fulfill({ status: 200, body: '' }));
await ctx.route('**://fonts.gstatic.com/**', r => r.abort());
const page = await ctx.newPage();
await page.addInitScript(fs.readFileSync(new URL('./fake-firebase.js', import.meta.url), 'utf8'));

const errors = [];
page.on('console', m => { if (m.type() === 'error' && !/ERR_|favicon/.test(m.text())) errors.push('CONSOLE: ' + m.text()); });
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); errors.push('STEP ' + name + ': ' + e.message); }
};

await page.goto(BASE + '/index.html', { waitUntil: 'load' });
await page.waitForTimeout(300);
await page.click('.auth-tab[data-mode="register"]');
await page.fill('#login-nick', 'Хозяин');
await page.fill('#login-pin', '1234');
await page.click('#login-btn');
await page.waitForSelector('#screen-menu.active');

await page.evaluate(() => Promise.all([
  db.ref('users/u2').set({ nickname: 'Дэн', online: true, avatar: '🔥', color: '#45d6ff', stats: {} }),
  db.ref('users/u3').set({ nickname: 'Костя', online: false, avatar: '🦁', color: '#2fe08a', stats: {} })
]));

console.log('ЛОББИ');
await step('матч создаётся с двумя приглашёнными', async () => {
  await page.click('#create-btn');
  await page.click('[data-goto="2"]');
  await page.click('[data-goal="individual"]');
  await page.click('[data-goto="3"]');
  await page.waitForTimeout(400);
  // Список перерисовывается после каждого выбора, поэтому ищем заново по нику
  await page.click('.user-row:has(.u-name:text-is("Дэн"))');
  await page.waitForTimeout(150);
  await page.click('.user-row:has(.u-name:text-is("Костя"))');
  await page.waitForTimeout(150);
  await page.click('#send-invites-btn');
  await page.waitForSelector('#screen-lobby.active');
  const n = await page.evaluate(() => document.querySelectorAll('.lobby-row').length);
  if (n !== 3) throw new Error('строк в лобби: ' + n);
});

await step('индикатор «в сети» отражает состояние игроков', async () => {
  await page.waitForTimeout(400);
  const dots = await page.evaluate(() => [...document.querySelectorAll('.lobby-row')].map(r => ({
    uid: r.dataset.uid, on: r.querySelector('.status-dot').classList.contains('online')
  })));
  const den = dots.find(d => d.uid === 'u2');
  const kostya = dots.find(d => d.uid === 'u3');
  if (!den.on) throw new Error('Дэн должен быть в сети');
  if (kostya.on) throw new Error('Костя не в сети, а горит');
});

await step('индикатор обновляется на лету', async () => {
  await page.evaluate(() => db.ref('users/u3/online').set(true));
  await page.waitForTimeout(400);
  const on = await page.evaluate(() =>
    document.querySelector('.lobby-row[data-uid="u3"] .status-dot').classList.contains('online'));
  if (!on) throw new Error('статус не обновился');
});

await step('создатель убирает не зашедшего игрока', async () => {
  const before = await page.evaluate(() => document.querySelectorAll('.lobby-kick').length);
  if (before !== 2) throw new Error('кнопок удаления: ' + before);
  await page.click('.lobby-row[data-uid="u3"] .lobby-kick');
  await page.waitForTimeout(200);
  await page.click('#modal-ok');
  await page.waitForTimeout(500);
  const st = await page.evaluate(() => {
    const id = localStorage.getItem('bb_activeMatch');
    const m = window.__DB.matches[id];
    return { players: Object.keys(m.players), invite: !!((window.__DB.invites || {}).u3 || {})[id],
             rows: document.querySelectorAll('.lobby-row').length };
  });
  if (st.players.includes('u3')) throw new Error('игрок остался в матче');
  if (st.invite) throw new Error('приглашение не удалено');
  if (st.rows !== 2) throw new Error('строк в лобби: ' + st.rows);
});

await step('зашедшего игрока убрать уже нельзя', async () => {
  await page.evaluate(() => {
    const id = localStorage.getItem('bb_activeMatch');
    return db.ref('matches/' + id + '/players/u2').update({ status: 'joined', joinedAt: Date.now() });
  });
  await page.waitForTimeout(400);
  const n = await page.evaluate(() => document.querySelectorAll('.lobby-kick').length);
  if (n !== 0) throw new Error('кнопка удаления осталась: ' + n);
});

console.log('\nПОЛНЫЙ ЛОГ МАТЧА');
await step('лента показывает последние события, лог — все', async () => {
  await page.waitForTimeout(900);
  await page.click('#start-btn');
  await page.waitForSelector('#screen-match.active');

  // Делаем больше бросков, чем помещается в ленту (она держит 10 событий)
  for (let i = 0; i < 7; i++) {
    await page.click('#btn-hit');
    await page.waitForTimeout(160);
  }
  await page.click('#btn-miss');
  await page.waitForTimeout(300);

  const feed = await page.evaluate(() => document.querySelectorAll('#match-events-feed .event-item').length);
  if (feed > 10) throw new Error('в ленте больше десяти: ' + feed);

  await page.click('#match-log-btn');
  await page.waitForTimeout(300);
  const log = await page.evaluate(() => ({
    open: !document.getElementById('log-backdrop').hidden,
    items: document.querySelectorAll('#log-feed .event-item').length,
    video: !document.getElementById('log-video-btn').hidden
  }));
  if (!log.open) throw new Error('лог не открылся');
  if (log.items < 9) throw new Error('в логе событий: ' + log.items);
  if (log.video) throw new Error('в идущем матче предложена сборка видео');
  await page.click('#log-close');
});

await step('счёт вырос ровно на число попаданий', async () => {
  const p = await page.evaluate(() => {
    const m = window.__DB.matches[localStorage.getItem('bb_activeMatch')];
    return m.players[m.creatorId];
  });
  if (p.hits !== 7) throw new Error('попаданий: ' + p.hits);
  if (p.misses !== 1) throw new Error('промахов: ' + p.misses);
  if (p.best !== 7) throw new Error('лучшая серия: ' + p.best);
});

console.log('\n--- ОШИБКИ ---');
console.log(errors.length ? errors.join('\n') : 'нет');
await browser.close();
process.exit(errors.length ? 1 : 0);
