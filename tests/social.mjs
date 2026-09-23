import { chromium } from 'playwright';
import fs from 'node:fs';
const OUT = process.env.OUT || '/tmp';
const BASE = process.env.BASE || 'http://127.0.0.1:8199';
const browser = await chromium.launch();
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 }, permissions: ['clipboard-read', 'clipboard-write'] });
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
await page.fill('#login-nick', 'Миша');
await page.fill('#login-pin', '1234');
await page.click('#login-btn');
await page.waitForSelector('#screen-menu.active');

const ME = await page.evaluate(() => localStorage.getItem('bb_userId'));

// Готовим историю: 3 матча с Дэном (2 победы, 1 поражение) и 1 с Костей
await page.evaluate(({ me }) => {
  const mk = (t, res, myPts, hisPts, foeId, foeNick, place, foePlace) => ({
    time: t, name: 'Матч ' + t, goalType: 'individual', shotMode: 'simple',
    result: res, myHits: myPts, myMisses: 3, myPoints: myPts, myBest: 2,
    winnerNickname: res === 'win' ? 'Миша' : foeNick,
    roster: [
      { userId: me, nickname: 'Миша', hits: myPts, misses: 3, points: myPts, place: place || null, left: false },
      { userId: foeId, nickname: foeNick, avatar: '🔥', color: '#45d6ff', hits: hisPts, misses: 4, points: hisPts, place: foePlace || null, left: false }
    ],
    events: [{ action: 'hit', text: 'Миша попал', time: t }]
  });
  return db.ref('history/' + me).set({
    m1: mk(1000, 'win',  10, 6, 'u2', 'Дэн'),
    m2: mk(2000, 'win',  8,  5, 'u2', 'Дэн'),
    m3: mk(3000, 'lose', 4,  9, 'u2', 'Дэн'),
    m4: mk(4000, 'win',  7,  2, 'u3', 'Костя')
  });
}, { me: ME });
await page.evaluate(() => Promise.all([
  db.ref('users/u2').set({ nickname: 'Дэн', online: true, avatar: '🔥', color: '#45d6ff', stats: { matches: 3, hits: 20, misses: 12, wins: 1 } }),
  db.ref('users/u3').set({ nickname: 'Костя', online: false, avatar: '🦁', color: '#2fe08a', stats: { matches: 1, hits: 2, misses: 5, wins: 0 } })
]));

console.log('ИСТОРИЯ И ФИЛЬТР');
await step('история показывает все матчи', async () => {
  await page.click('#history-btn');
  await page.waitForSelector('#screen-history.active');
  await page.waitForTimeout(400);
  const n = await page.evaluate(() => document.querySelectorAll('.history-card').length);
  if (n !== 4) throw new Error('карточек: ' + n);
});

await step('фильтр «Победы» оставляет три матча', async () => {
  await page.click('#seg-history .seg-btn[data-hfilter="win"]');
  await page.waitForTimeout(200);
  const n = await page.evaluate(() => document.querySelectorAll('.history-card').length);
  if (n !== 3) throw new Error('карточек: ' + n);
});

await step('фильтр «Поражения» оставляет один', async () => {
  await page.click('#seg-history .seg-btn[data-hfilter="lose"]');
  await page.waitForTimeout(200);
  const n = await page.evaluate(() => document.querySelectorAll('.history-card').length);
  if (n !== 1) throw new Error('карточек: ' + n);
});

console.log('\nЛИЧНЫЕ ВСТРЕЧИ');
await step('счёт против каждого соперника', async () => {
  await page.click('#h2h-btn');
  await page.waitForSelector('#screen-h2h.active');
  await page.waitForTimeout(300);
  const rows = await page.evaluate(() => [...document.querySelectorAll('.h2h-row')].map(r => ({
    name: r.querySelector('.rate-name').textContent.trim(),
    sub: r.querySelector('.rate-sub').textContent.trim(),
    score: [...r.querySelectorAll('.h2h-score b')].map(b => b.textContent).join(':'),
    cls: r.className
  })));
  if (rows.length !== 2) throw new Error('строк: ' + rows.length);
  const den = rows.find(r => r.name === 'Дэн');
  if (!den) throw new Error('нет Дэна: ' + JSON.stringify(rows));
  if (den.score !== '2:1') throw new Error('счёт с Дэном: ' + den.score);
  if (!/good/.test(den.cls)) throw new Error('не отмечен перевес: ' + den.cls);
  if (!/3 встречи/.test(den.sub)) throw new Error('склонение: ' + den.sub);
  if (!/очки 22:20/.test(den.sub)) throw new Error('сумма очков: ' + den.sub);
  const kostya = rows.find(r => r.name === 'Костя');
  if (kostya.score !== '1:0') throw new Error('счёт с Костей: ' + kostya.score);
  if (!/1 встреча/.test(kostya.sub)) throw new Error('склонение: ' + kostya.sub);
});

await step('кнопка «назад» возвращает в историю', async () => {
  await page.click('#screen-h2h [data-nav="history"]');
  await page.waitForSelector('#screen-history.active');
});

console.log('\nНЕДАВНИЕ СОПЕРНИКИ');
await step('чипы подставляются из истории', async () => {
  await page.evaluate(() => goMenu());
  await page.waitForTimeout(200);
  await page.click('#create-btn');
  await page.waitForTimeout(600);
  const chips = await page.evaluate(() => {
    const w = document.getElementById('recent-wrap');
    return { hidden: w.hidden, names: [...document.querySelectorAll('.recent-chip span')].map(s => s.textContent) };
  });
  if (chips.hidden) throw new Error('блок скрыт');
  if (chips.names.length !== 2) throw new Error('чипов: ' + JSON.stringify(chips.names));
});

await step('клик по чипу выбирает игрока', async () => {
  await page.click('[data-goto="2"]');
  await page.click('[data-goal="individual"]');
  await page.click('[data-goto="3"]');
  await page.waitForTimeout(300);
  await page.click('.recent-chip');
  await page.waitForTimeout(200);
  const sel = await page.evaluate(() => Object.keys(state.wizard.selected));
  if (sel.length !== 1) throw new Error('выбрано: ' + sel.length);
  const selChip = await page.evaluate(() => document.querySelectorAll('.recent-chip.sel').length);
  if (selChip !== 1) throw new Error('подсвечено чипов: ' + selChip);
  const selRow = await page.evaluate(() => document.querySelectorAll('.user-row.selected').length);
  if (selRow !== 1) throw new Error('строк в списке подсвечено: ' + selRow);
});

console.log('\nССЫЛКА-ПРИГЛАШЕНИЕ');
let link = null;
await step('ссылка копируется из лобби', async () => {
  await page.click('#send-invites-btn');
  await page.waitForSelector('#screen-lobby.active');
  await page.click('#lobby-link-btn');
  await page.waitForTimeout(400);
  link = await page.evaluate(() => navigator.clipboard.readText());
  if (!/\?join=/.test(link || '')) throw new Error('в буфере: ' + link);
});

await step('второй игрок заходит по ссылке', async () => {
  // Второй игрок — в своём контексте: вкладки одного контекста делят
  // localStorage, и «Гость» просто вошёл бы под аккаунтом Миши.
  const ctx2 = await browser.newContext({ viewport: { width: 420, height: 900 } });
  ctx2.setDefaultTimeout(4000);
  await ctx2.route('**://www.gstatic.com/**', r => r.fulfill({ status: 200, body: '' }));
  await ctx2.route('**://fonts.googleapis.com/**', r => r.fulfill({ status: 200, body: '' }));
  await ctx2.route('**://fonts.gstatic.com/**', r => r.abort());
  const page2 = await ctx2.newPage();
  await page2.addInitScript(fs.readFileSync(new URL('./fake-firebase.js', import.meta.url), 'utf8'));
  page2.on('pageerror', e => errors.push('PAGE2ERROR: ' + e.message));
  // Отдельная вкладка = отдельная память заглушки, поэтому переносим базу целиком.
  // Сеем до загрузки страницы: приложение вычищает ?join= из адреса на старте,
  // так что перезагружать вкладку уже нельзя — ссылка потеряется.
  const dump = await page.evaluate(() => JSON.stringify(window.__DB));
  await page2.addInitScript(d => { Object.assign(window.__DB, JSON.parse(d)); }, dump);
  await page2.goto(link, { waitUntil: 'load' });
  await page2.waitForTimeout(300);

  await page2.click('.auth-tab[data-mode="register"]');
  await page2.fill('#login-nick', 'Гость');
  await page2.fill('#login-pin', '9999');
  await page2.click('#login-btn');
  await page2.waitForSelector('#screen-lobby.active', { timeout: 5000 });

  const inLobby = await page2.evaluate(() => {
    const id = localStorage.getItem('bb_activeMatch');
    const m = window.__DB.matches[id];
    const uid = localStorage.getItem('bb_userId');
    return { joined: m.players[uid] && m.players[uid].status, indexed: !!(window.__DB.userMatches || {})[uid] };
  });
  if (inLobby.joined !== 'joined') throw new Error('статус в матче: ' + inLobby.joined);
  if (!inLobby.indexed) throw new Error('матч не попал в индекс «Мои матчи»');
  await page2.close();
  await ctx2.close();
});

await step('ссылка на завершённый матч объясняет отказ', async () => {
  const ctx3 = await browser.newContext({ viewport: { width: 420, height: 900 } });
  ctx3.setDefaultTimeout(4000);
  await ctx3.route('**://www.gstatic.com/**', r => r.fulfill({ status: 200, body: '' }));
  await ctx3.route('**://fonts.googleapis.com/**', r => r.fulfill({ status: 200, body: '' }));
  await ctx3.route('**://fonts.gstatic.com/**', r => r.abort());
  const page3 = await ctx3.newPage();
  await page3.addInitScript(fs.readFileSync(new URL('./fake-firebase.js', import.meta.url), 'utf8'));
  await page3.goto(BASE + '/index.html?join=нет-такого', { waitUntil: 'load' });
  await page3.waitForTimeout(300);
  await page3.click('.auth-tab[data-mode="register"]');
  await page3.fill('#login-nick', 'Мимо');
  await page3.fill('#login-pin', '1111');
  await page3.click('#login-btn');
  await page3.waitForSelector('#modal-backdrop:not([hidden])', { timeout: 5000 });
  const txt = await page3.textContent('#modal-text');
  if (!/не найден/i.test(txt)) throw new Error('текст ошибки: ' + txt);
  await page3.click('#modal-ok');
  await page3.waitForSelector('#screen-menu.active', { timeout: 5000 });
  await page3.close();
  await ctx3.close();
});

console.log('\n--- ОШИБКИ ---');
console.log(errors.length ? errors.join('\n') : 'нет');
await browser.close();
process.exit(errors.length ? 1 : 0);
