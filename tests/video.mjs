/* Видео матча: подготовка данных для ролика и вшитый кусок трека.
   Саму запись через MediaRecorder headless-браузер не проверяет — здесь
   проверяется всё, что решает, какие цифры попадут в кадр. */
import { chromium } from 'playwright';
import fs from 'node:fs';
const BASE = process.env.BASE || 'http://127.0.0.1:8199';

const browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });
const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
ctx.setDefaultTimeout(8000);
await ctx.route('**://www.gstatic.com/**', r => r.fulfill({ status: 200, body: '' }));
await ctx.route('**://fonts.googleapis.com/**', r => r.fulfill({ status: 200, body: '' }));
await ctx.route('**://fonts.gstatic.com/**', r => r.abort());
const page = await ctx.newPage();
await page.addInitScript(fs.readFileSync(new URL('./fake-firebase.js', import.meta.url), 'utf8'));

const errors = [];
page.on('pageerror', e => errors.push('PAGEERROR: ' + e.message));
const step = async (name, fn) => {
  try { await fn(); console.log('  ✓ ' + name); }
  catch (e) { console.log('  ✗ ' + name + ' → ' + e.message); errors.push('STEP ' + name + ': ' + e.message); }
};

await page.goto(BASE + '/index.html', { waitUntil: 'load' });
await page.waitForTimeout(300);

// Матч с зонами: у Ани 1+3+2 = 6 очков за 3 попадания, у Бори 2 очка за 1
const ZONES_MATCH = {
  name: 'Зоны', shotMode: 'zones', goalType: 'common', targetHits: 6, status: 'finished',
  creatorId: 'a', winnerId: 'a', finishedAt: 1000, turnOrder: ['a', 'b'], currentTurnIndex: 0,
  players: {
    a: { nickname: 'Аня', color: '#ff6a2b', hits: 3, misses: 1, points: 6, best: 2 },
    b: { nickname: 'Боря', color: '#45d6ff', hits: 1, misses: 2, points: 2, best: 1 }
  },
  events: {
    e1: { time: 1, userId: 'a', action: 'hit',  points: 1, text: 'Аня попал (+1)' },
    e2: { time: 2, userId: 'a', action: 'hit',  points: 3, text: 'Аня попал (+3)' },
    e3: { time: 3, userId: 'a', action: 'miss', text: 'Аня промахнулся' },
    e4: { time: 4, userId: 'b', action: 'hit',  points: 2, text: 'Боря попал (+2)' },
    e5: { time: 5, userId: 'b', action: 'miss', text: 'Боря промахнулся' },
    e6: { time: 6, userId: 'b', action: 'miss', text: 'Боря промахнулся' },
    e7: { time: 7, userId: 'a', action: 'hit',  points: 2, text: 'Аня попал (+2)' }
  }
};

console.log('ДАННЫЕ РОЛИКА ИЗ ЖИВОГО МАТЧА');
await step('очки и зоны попадают в ролик', async () => {
  const d = await page.evaluate(m => {
    const r = MatchVideo.fromMatch(m);
    return { zones: r.zones, label: r.scoreLabel, winner: r.winner.nickname,
             players: r.players.map(p => [p.nickname, p.points, p.hits, p.best]),
             pts: r.shots.map(s => s.pts) };
  }, ZONES_MATCH);
  if (!d.zones) throw new Error('режим зон не распознан');
  if (d.label !== 'ОЧКИ') throw new Error('подпись колонки: ' + d.label);
  if (d.winner !== 'Аня') throw new Error('победитель: ' + d.winner);
  if (JSON.stringify(d.pts) !== JSON.stringify([1, 3, 0, 2, 0, 0, 2])) throw new Error('очки за броски: ' + d.pts);
  const anya = d.players[0];
  if (anya[0] !== 'Аня' || anya[1] !== 6) throw new Error('первый в таблице: ' + JSON.stringify(anya));
  // Сумма очков по броскам должна сойтись с итогом игрока
  const sum = d.pts.slice(0, 3).concat(d.pts[6]).reduce((x, y) => x + y, 0);
  if (sum !== 6) throw new Error('сумма по броскам Ани: ' + sum);
});

await step('простой матч считает попадания, а не очки', async () => {
  const d = await page.evaluate(() => {
    const m = { name: 'Обычный', goalType: 'individual', status: 'finished', creatorId: 'a', winnerId: 'a',
      turnOrder: ['a'], players: { a: { nickname: 'Аня', hits: 4, misses: 2 } },
      events: { e1: { time: 1, userId: 'a', action: 'hit', text: 'Аня попал' } } };
    const r = MatchVideo.fromMatch(m);
    return { zones: r.zones, label: r.scoreLabel, points: r.players[0].points, pts: r.shots.map(s => s.pts) };
  });
  if (d.zones) throw new Error('обычный матч принят за зоны');
  if (d.label !== 'ПОПАЛ') throw new Error('подпись колонки: ' + d.label);
  if (d.points !== 4) throw new Error('очки без зон должны равняться попаданиям: ' + d.points);
  if (d.pts[0] !== 1) throw new Error('бросок без зон должен стоить 1: ' + d.pts);
});

console.log('\nДАННЫЕ РОЛИКА ИЗ ИСТОРИИ');
await step('запись истории даёт те же цифры', async () => {
  const d = await page.evaluate(() => {
    const h = {
      name: 'Зоны', shotMode: 'zones', goalType: 'common', targetHits: 6, time: 1000,
      winnerNickname: 'Аня', result: 'win',
      roster: [
        { userId: 'a', nickname: 'Аня', hits: 3, misses: 1, points: 6, best: 2 },
        { userId: 'b', nickname: 'Боря', hits: 1, misses: 2, points: 2, best: 1 }
      ],
      events: [
        { action: 'hit', points: 1, text: 'Аня попал (+1)', time: 1 },
        { action: 'hit', points: 3, text: 'Аня попал (+3)', time: 2 },
        { action: 'hit', points: 2, text: 'Боря попал (+2)', time: 3 }
      ]
    };
    const r = MatchVideo.fromHistory(h);
    return { zones: r.zones, winner: r.winner.nickname, pts: r.shots.map(s => s.pts),
             owners: r.shots.map(s => (r.players.find(p => p.id === s.userId) || {}).nickname) };
  });
  if (!d.zones) throw new Error('режим зон потерян');
  if (d.winner !== 'Аня') throw new Error('победитель: ' + d.winner);
  if (JSON.stringify(d.pts) !== JSON.stringify([1, 3, 2])) throw new Error('очки за броски: ' + d.pts);
  if (JSON.stringify(d.owners) !== JSON.stringify(['Аня', 'Аня', 'Боря'])) throw new Error('авторы бросков: ' + d.owners);
});

await step('старая запись без очков не ломается', async () => {
  const d = await page.evaluate(() => {
    const h = { name: 'Старый', goalType: 'individual', time: 1, winnerNickname: 'Аня',
      roster: [{ nickname: 'Аня', hits: 5, misses: 2 }, { nickname: 'Боря', hits: 3, misses: 4 }],
      events: [{ action: 'hit', text: 'Аня попал', time: 1 }, { action: 'miss', text: 'Боря промахнулся', time: 2 }] };
    const r = MatchVideo.fromHistory(h);
    return { zones: !!r.zones, points: r.players.map(p => p.points), pts: r.shots.map(s => s.pts) };
  });
  if (d.zones) throw new Error('старая запись принята за зоны');
  if (JSON.stringify(d.points) !== JSON.stringify([5, 3])) throw new Error('очки: ' + d.points);
  if (JSON.stringify(d.pts) !== JSON.stringify([1, 0])) throw new Error('очки за броски: ' + d.pts);
});

console.log('\nМУЗЫКА РОЛИКА');
await step('вшитый кусок трека грузится и декодируется', async () => {
  const r = await page.evaluate(async () => {
    await new Promise((res, rej) => {
      const sc = document.createElement('script');
      sc.src = 'audio-clip.js';
      sc.onload = res;
      sc.onerror = () => rej(new Error('audio-clip.js не загрузился'));
      document.head.appendChild(sc);
    });
    if (typeof VIDEO_AUDIO_CLIP === 'undefined') throw new Error('VIDEO_AUDIO_CLIP не определён');
    const AC = new (window.AudioContext || window.webkitAudioContext)();
    const buf = await AC.decodeAudioData(await (await fetch(VIDEO_AUDIO_CLIP)).arrayBuffer());
    return { seconds: +buf.duration.toFixed(2), channels: buf.numberOfChannels, rate: buf.sampleRate };
  });
  // Ролик длится 18 секунд — клип не должен обрываться раньше
  if (r.seconds < 17.5 || r.seconds > 18.5) throw new Error('длина клипа: ' + r.seconds + ' с');
  if (r.channels !== 2) throw new Error('каналов: ' + r.channels);
});

await step('клип не тянется до открытия видео', async () => {
  const p2 = await ctx.newPage();
  await p2.addInitScript(fs.readFileSync(new URL('./fake-firebase.js', import.meta.url), 'utf8'));
  const asked = [];
  p2.on('request', r => { if (/audio-clip/.test(r.url())) asked.push(r.url()); });
  await p2.goto(BASE + '/index.html', { waitUntil: 'load' });
  await p2.waitForTimeout(700);
  if (asked.length) throw new Error('клип запрошен при обычной загрузке страницы');
  await p2.close();
});

console.log('\n--- ОШИБКИ ---');
console.log(errors.length ? errors.join('\n') : 'нет');
await browser.close();
process.exit(errors.length ? 1 : 0);
