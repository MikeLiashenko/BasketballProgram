/* ================================================================
   🏀 Баскетбол — матчи онлайн
   Vanilla JS + Firebase Realtime Database
   ================================================================ */

/* ---------- Firebase config (RTDB-only, без Auth) ---------- */
const firebaseConfig = {
  databaseURL: "https://mywebsite-b903b-default-rtdb.europe-west1.firebasedatabase.app/",
  projectId: "mywebsite-b903b"
};
firebase.initializeApp(firebaseConfig);
const db = firebase.database();
const TS = firebase.database.ServerValue.TIMESTAMP;

// Смещение серверных часов. Все метки времени в матче (события, старт хода,
// finishedAt) считаем через serverNow() — иначе у игрока со сбитыми часами лента
// событий перемешивается, а таймер хода врёт.
let serverOffset = 0;
db.ref('.info/serverTimeOffset').on('value', s => { serverOffset = s.val() || 0; });
function serverNow() { return Date.now() + serverOffset; }

// Состояние клиентского таймера хода
const timerState = { startedAt: null, intervalId: null, firedAt: null };

/* ---------- Глобальное состояние ---------- */
const state = {
  userId: null,
  nickname: null,
  avatar: null,
  color: null,
  photo: null,
  stats: null,
  currentMatchId: null,
  wizard: { goalType: null, targetHits: 10, selected: {} } // selected: { userId: {nickname, avatar, color} }
};
let authMode = 'login'; // 'login' | 'register'

// Активные слушатели (для отписки)
let userWatchRef = null;
let invitesWatchRef = null;
let matchWatchRef = null;
let usersOnceCache = {}; // кэш пользователей для шага выбора
let lastEventTime = null; // для анимаций попал/промах (не проигрывать старые события)
let confettiFor = null;   // matchId, для которого уже запущено конфетти
let modalResolve = null;  // резолвер кастомной модалки
let prevMatchStatus = null; // для свистка на старте матча
let prevInviteCount = 0;    // для звука нового приглашения
let lobbyMatch = null;      // последнее состояние матча в лобби (для отсчёта до старта)
let lobbyIntervalId = null; // тик обратного отсчёта в лобби
let editingMatchId = null;  // id матча, открытого в модалке редактирования
let lastRenderedMatch = null; // последнее состояние матча, показанное на экране (для проверки хода в момент клика)
let presenceRefs = {};        // слушатели «в сети» по игрокам лобби
let presenceOnline = {};      // их последнее состояние
let pendingJoin = null;       // matchId из ссылки ?join=, ждёт входа в аккаунт
let recentOpponents = [];     // недавние соперники для быстрого выбора в мастере
let historyCache = [];        // выгруженная история — по ней строятся фильтр и личные встречи
let historyFilter = 'all';    // 'all' | 'win' | 'lose'
let logVideoSource = null;    // запись истории, открытая в модалке лога (для кнопки «Сгенерировать видео»)
let clockIntervalId = null;   // тик обратного отсчёта в матче «на время»
let lastReactionTime = null;  // чтобы не проигрывать реакции, прилетевшие до входа
let prevTurnUid = null;       // чей был ход в прошлом рендере (для сигнала «твоя очередь»)
let ratingSort = 'wins';      // текущая сортировка на экране рейтинга
let ratingUsers = [];         // выгруженные для рейтинга игроки
let lastFinishedMatch = null; // матч на экране результатов — для реванша и «поделиться»
let deferredInstall = null;   // отложенное событие установки PWA

/* ================================================================
   УТИЛИТЫ
   ================================================================ */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Ключи localStorage. Сессию чистим точечно — настройки (звук, тема) переживают выход.
const LS = {
  userId: 'bb_userId', nickname: 'bb_nickname', activeMatch: 'bb_activeMatch',
  muted: 'bb_muted', theme: 'bb_theme', notify: 'bb_notify', haptics: 'bb_haptics'
};
function clearSession() {
  [LS.userId, LS.nickname, LS.activeMatch].forEach(k => localStorage.removeItem(k));
}

function uuid() {
  if (crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
}

// Простой (не криптостойкий) хэш PIN — чтобы не хранить в открытом виде.
function hashPin(pin) {
  let h = 5381;
  for (let i = 0; i < pin.length; i++) h = (((h << 5) + h) ^ pin.charCodeAt(i)) >>> 0;
  return 'p' + h.toString(16);
}

/* ---------- Аватары / цвета ---------- */
const AVATARS = ['🏀','🔥','⚡','🐉','🦁','🦅','🐺','🦈','👑','⭐','💪','🎯','🚀','🐻','🦊','😎','👽','🤖','🐸','🦖','🍀','🌟',
                 '🦄','🐯','🦍','🐙','🦂','🌪️','💎','🎸','🥷','🧊','☄️','🍕','🐔','🦔','🎲','🧨'];
const COLORS  = ['#ff6a2b','#ff556a','#ffd257','#2fe08a','#45d6ff','#9d8bff','#ff8ac2','#5bd1c4','#a3e635','#f97316','#38bdf8','#c084fc',
                 '#f43f5e','#14b8a6','#eab308','#8b5cf6','#22c55e','#0ea5e9','#fb7185','#facc15'];

let regAvatar = AVATARS[0];
let regColor  = COLORS[0];
let regPhoto  = null;         // фото при регистрации
let profAvatar = AVATARS[0];
let profColor  = COLORS[0];
let profPhoto  = null;        // фото в профиле

function hashStr(s) { let h = 0; for (let i = 0; i < (s || '').length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function colorFromString(s) { return COLORS[hashStr(s) % COLORS.length]; }
function avatarFromString(s) { return AVATARS[hashStr(s) % AVATARS.length]; }

// Осветлить/затемнить hex-цвет на pct (%): >0 светлее, <0 темнее
function shade(hex, pct) {
  const n = parseInt((hex || '#888888').slice(1), 16);
  let r = (n >> 16) & 255, g = (n >> 8) & 255, b = n & 255;
  const f = pct / 100;
  r = Math.round(f < 0 ? r * (1 + f) : r + (255 - r) * f);
  g = Math.round(f < 0 ? g * (1 + f) : g + (255 - g) * f);
  b = Math.round(f < 0 ? b * (1 + f) : b + (255 - b) * f);
  return '#' + ((1 << 24) + (r << 16) + (g << 8) + b).toString(16).slice(1);
}

// obj — user или player-запись (может иметь avatar/color/nickname)
function colorOf(obj) { return (obj && obj.color) || colorFromString((obj && obj.nickname) || ''); }
function faceOf(obj) {
  if (obj && obj.photo) return `<img class="ava-img" src="${escapeHtml(obj.photo)}" alt="">`;
  return escapeHtml((obj && obj.avatar) || ((obj && obj.nickname) ? obj.nickname.charAt(0) : '?'));
}

// Сжатие фото до квадрата 128×128 — чтобы аватар весил килобайты, а не мегабайты.
const PHOTO_MAX_BYTES = 10 * 1024 * 1024;  // больше 10 МБ даже не читаем
const PHOTO_SIDE = 128;

function compressImage(file, callback) {
  if (!file) return;
  if (!file.type || !file.type.startsWith('image/')) { showAlert('Это не картинка', '🖼️'); return; }
  if (file.size > PHOTO_MAX_BYTES) { showAlert('Фото слишком большое — до 10 МБ', '🖼️'); return; }

  const reader = new FileReader();
  reader.onerror = () => showAlert('Не удалось прочитать файл', '⚠️');
  reader.onload = e => {
    const img = new Image();
    img.onerror = () => showAlert('Не удалось открыть картинку', '⚠️');
    img.onload = () => {
      // Кадрируем по центру в квадрат — аватар везде круглый, растягивать нельзя
      const side = Math.min(img.width, img.height);
      const sx = (img.width - side) / 2, sy = (img.height - side) / 2;
      const cvs = document.createElement('canvas');
      cvs.width = cvs.height = PHOTO_SIDE;
      const ctx = cvs.getContext('2d');
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(img, sx, sy, side, side, 0, 0, PHOTO_SIDE, PHOTO_SIDE);
      let out = cvs.toDataURL('image/jpeg', 0.82);
      // Firebase не любит гигантские строки в каждом узле игрока — дожимаем при нужде
      if (out.length > 40000) out = cvs.toDataURL('image/jpeg', 0.6);
      callback(out);
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
function avatarBg(color) { const c = color || '#888'; return `background:linear-gradient(135deg, ${c}, ${shade(c, -30)});`; }
function hexA(hex, a) {
  let h = String(hex || '').trim();
  if (!/^#[0-9a-f]{6}$/i.test(h)) h = '#888888';
  const n = parseInt(h.slice(1), 16);
  return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`;
}

// Готовый HTML мини-аватара для списков
function miniAvatar(obj, small) {
  return `<div class="mini-av${small ? ' sm' : ''}" style="${avatarBg(colorOf(obj))}">${faceOf(obj)}</div>`;
}

// Построить сетку эмодзи/цветов с выбором
function buildEmojiGrid(container, currentGetter, onPick) {
  container.innerHTML = '';
  AVATARS.forEach(em => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'emoji-opt' + (em === currentGetter() ? ' sel' : '');
    b.textContent = em;
    b.addEventListener('click', () => {
      onPick(em);
      [...container.children].forEach(c => c.classList.remove('sel'));
      b.classList.add('sel');
    });
    container.appendChild(b);
  });
}
function buildColorGrid(container, currentGetter, onPick) {
  container.innerHTML = '';
  COLORS.forEach(col => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'color-opt' + (col === currentGetter() ? ' sel' : '');
    b.style.background = col;
    b.addEventListener('click', () => {
      onPick(col);
      [...container.children].forEach(c => c.classList.remove('sel'));
      b.classList.add('sel');
    });
    container.appendChild(b);
  });
}

function showScreen(id) {
  $$('.screen').forEach(s => s.classList.remove('active'));
  $('#' + id).classList.add('active');
}

function accuracy(hits, misses) {
  const total = (hits || 0) + (misses || 0);
  return total ? Math.round((hits / total) * 100) : 0;
}

/* ---------- Очки и ранжирование ---------- */
/* В простом режиме одно попадание = одно очко, в продвинутом бросок стоит 1/2/3
   в зависимости от зоны. У матчей, сыгранных до появления зон, поля points нет —
   для них очками считаем попадания. */
function ptsOf(p)  { return p && p.points != null ? p.points : ((p && p.hits) || 0); }
function isZones(m) { return (m && m.shotMode) === 'zones'; }

// Кто выше по ходу матча: очки ↓, попадания ↓, промахи ↑
function cmpPlayers(a, b) {
  return ptsOf(b) - ptsOf(a) || ((b.hits || 0) - (a.hits || 0)) || ((a.misses || 0) - (b.misses || 0));
}
// То же, но занятое место важнее счёта: кто добежал до цели раньше — тот выше
function cmpFinal(a, b) {
  if (a.place && b.place) return a.place - b.place;
  if (a.place) return -1;
  if (b.place) return 1;
  return cmpPlayers(a, b);
}

/* ---------- Вибрация ---------- */
/* Короткие отклики на бросок и на переход хода. На десктопе navigator.vibrate
   отсутствует — тогда модуль просто молчит. */
const Haptics = (() => {
  let on = localStorage.getItem(LS.haptics) !== '0';   // по умолчанию включена
  const buzz = pattern => {
    if (!on || !navigator.vibrate) return;
    try { navigator.vibrate(pattern); } catch (e) {}
  };
  return {
    isOn()   { return on; },
    set(v)   { on = !!v; localStorage.setItem(LS.haptics, on ? '1' : '0'); },
    tap()    { buzz(10); },
    hit()    { buzz([0, 24, 36, 18]); },
    miss()   { buzz(80); },
    turn()   { buzz([0, 36, 80, 36]); },
    win()    { buzz([0, 60, 60, 60, 60, 160]); }
  };
})();

/* ---------- Уведомления о своём ходе ---------- */
/* Когда вкладка свёрнута, игрок не видит, что очередь дошла до него.
   Мигаем заголовком вкладки, а если разрешено — шлём системное уведомление. */
const Notify = (() => {
  let on = localStorage.getItem(LS.notify) === '1';
  const BASE_TITLE = document.title;
  let titleTimer = null;
  const supported = 'Notification' in window;

  function flashTitle(text) {
    stopTitle();
    let alt = false;
    document.title = text;
    titleTimer = setInterval(() => { alt = !alt; document.title = alt ? BASE_TITLE : text; }, 1100);
  }
  function stopTitle() {
    if (titleTimer) { clearInterval(titleTimer); titleTimer = null; }
    document.title = BASE_TITLE;
  }
  return {
    isOn()      { return on && supported && Notification.permission === 'granted'; },
    supported() { return supported; },
    stopTitle,
    // Просим разрешение только по явному переключателю в профиле
    async set(v) {
      if (!v || !supported) { on = false; localStorage.setItem(LS.notify, '0'); return false; }
      let perm = Notification.permission;
      if (perm === 'default') { try { perm = await Notification.requestPermission(); } catch (e) { perm = 'denied'; } }
      on = perm === 'granted';
      localStorage.setItem(LS.notify, on ? '1' : '0');
      return on;
    },
    // Позвали в матч, пока вкладка свёрнута
    invite(fromNick) {
      if (!document.hidden || !this.isOn()) return;
      try {
        const n = new Notification('🏀 Тебя зовут в матч', {
          body: fromNick ? fromNick + ' ждёт тебя' : 'Пришло новое приглашение',
          tag: 'bb-invite', renotify: true, icon: 'icon.svg'
        });
        n.onclick = () => { window.focus(); n.close(); };
      } catch (e) {}
    },
    // Вкладка активна — пользователь и так всё видит, не мешаем
    turn(matchName) {
      if (!document.hidden) return;
      flashTitle('🏀 Твой бросок!');
      if (!this.isOn()) return;
      try {
        const n = new Notification('🏀 Твой бросок', {
          body: matchName ? 'Матч «' + matchName + '» ждёт тебя' : 'Очередь дошла до тебя',
          tag: 'bb-turn', renotify: true, icon: 'icon.svg'
        });
        n.onclick = () => { window.focus(); n.close(); };
      } catch (e) {}
    }
  };
})();
document.addEventListener('visibilitychange', () => { if (!document.hidden) Notify.stopTitle(); });

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- Кастомные модалки (вместо alert / confirm) ---------- */
function openModal(text, icon, withCancel, okLabel) {
  $('#modal-text').textContent = text;
  $('#modal-icon').textContent = icon;
  $('#modal-ok').textContent = okLabel;
  $('#modal-cancel').style.display = withCancel ? '' : 'none';
  $('#modal-backdrop').hidden = false;
  return new Promise(res => { modalResolve = res; });
}
function closeModal(val) {
  $('#modal-backdrop').hidden = true;
  if (modalResolve) { modalResolve(val); modalResolve = null; }
}
function showAlert(text, icon = 'ℹ️')          { return openModal(text, icon, false, 'ОК'); }
function showConfirm(text, okLabel = 'Да', icon = '🤔') { return openModal(text, icon, true, okLabel); }

/* ---------- Кольцо: сетка, полёт мяча, всплывашки ---------- */
function ensureNet() {
  const g = $('#hoop-net');
  if (!g || g.childElementCount) return;
  const N = 12, cx = 200, tY = 152, tRx = 62, tRy = 15, bY = 214, bRx = 26, bRy = 6, top = [], bot = [];
  for (let i = 0; i < N; i++) {
    const a = (i / N) * Math.PI * 2 - Math.PI / 2;
    top.push([cx + Math.cos(a) * tRx, tY + Math.sin(a) * tRy]);
    bot.push([cx + Math.cos(a) * bRx, bY + Math.sin(a) * bRy]);
  }
  const L = (x1, y1, x2, y2) => {
    const l = document.createElementNS('http://www.w3.org/2000/svg', 'line');
    l.setAttribute('x1', x1.toFixed(1)); l.setAttribute('y1', y1.toFixed(1));
    l.setAttribute('x2', x2.toFixed(1)); l.setAttribute('y2', y2.toFixed(1));
    g.appendChild(l);
  };
  for (let i = 0; i < N; i++) {
    L(top[i][0], top[i][1], bot[i][0], bot[i][1]);
    L(top[i][0], top[i][1], bot[(i + 1) % N][0], bot[(i + 1) % N][1]);
  }
}

function triggerShotFeedback(ev) {
  if (ev.action === 'hit')         { Sound.hit();  Haptics.hit();  animateShot(true, ev.userId, ev.points); }
  else if (ev.action === 'miss')   { Sound.miss(); Haptics.miss(); animateShot(false, ev.userId); }
  else if (ev.action === 'finish') { Sound.finish(); }
  else if (ev.action === 'undo')   { popMatch('Отменено', 'warn'); }
}

function popMatch(text, cls) {
  const pop = $('#match-pop');
  if (!pop) return;
  pop.textContent = text;
  pop.className = 'pop ' + cls + ' go';
  setTimeout(() => { pop.className = 'pop'; }, 1000);
}
function netSwish() {
  const n = $('#hoop-net');
  if (!n) return;
  n.classList.remove('swish'); n.getBoundingClientRect(); n.classList.add('swish');
  setTimeout(() => n.classList.remove('swish'), 650);
}
function bumpScore(uid) {
  const el = document.getElementById('mh-' + uid);
  if (el) { el.classList.remove('bump'); void el.offsetWidth; el.classList.add('bump'); }
}

function animateShot(make, scorerUid, points) {
  const scr = $('#screen-match'), ball = $('#match-ball'), hoop = $('#hoop-svg');
  if (!scr || !ball || !hoop) return;
  const reduce = matchMedia('(prefers-reduced-motion:reduce)').matches;
  const label = make ? '+' + (points || 1) : 'МИМО';
  if (reduce) { if (make) { netSwish(); bumpScore(scorerUid); } popMatch(label, make ? 'make' : 'miss'); return; }
  const pr = scr.getBoundingClientRect(), hs = hoop.getBoundingClientRect();
  const startX = pr.width / 2 - 22, startY = pr.height - 150;
  const endX = (hs.left - pr.left) + hs.width / 2 - 22, endY = (hs.top - pr.top) + hs.height * 0.5 - 22;
  const missX = endX + (Math.random() < .5 ? -52 : 52);
  ball.style.opacity = 1;
  const tx = make ? endX : missX, ty = endY, dur = 540, t0 = performance.now(), arc = Math.min(240, startY - ty + 120);
  (function fr(now) {
    let p = (now - t0) / dur; if (p > 1) p = 1;
    const x = startX + (tx - startX) * p, y = startY + (ty - startY) * p - Math.sin(p * Math.PI) * arc;
    ball.style.transform = `translate(${x}px,${y}px) rotate(${p * (make ? 420 : 300)}deg)`;
    if (p < 1) requestAnimationFrame(fr);
    else make ? ballDrop(x, y, scorerUid, label) : ballDeflect(x, y);
  })(t0);
}
function ballDrop(x, y, scorerUid, label) {
  const ball = $('#match-ball'); netSwish();
  const t0 = performance.now();
  (function f(now) {
    let p = (now - t0) / 220; if (p > 1) p = 1;
    ball.style.transform = `translate(${x}px,${y + p * 70}px) scale(${1 - p * .55})`;
    ball.style.opacity = 1 - p;
    if (p < 1) requestAnimationFrame(f);
    else { ball.style.opacity = 0; popMatch(label || '+1', 'make'); bumpScore(scorerUid); }
  })(t0);
}
function ballDeflect(x, y) {
  const ball = $('#match-ball'), scr = $('#screen-match');
  const dir = x < scr.getBoundingClientRect().width / 2 ? -1 : 1;
  scr.classList.add('m-shake');
  const t0 = performance.now();
  (function b(now) {
    let p = (now - t0) / 340; if (p > 1) p = 1;
    ball.style.transform = `translate(${x + dir * 90 * p}px,${y + p * 150}px) rotate(${p * 400 * dir}deg) scale(${1 - p * .2})`;
    ball.style.opacity = 1 - p * .9;
    if (p < 1) requestAnimationFrame(b);
    else { ball.style.opacity = 0; scr.classList.remove('m-shake'); popMatch('МИМО', 'miss'); }
  })(t0);
}
function launchConfetti() {
  const c = $('#confetti');
  if (!c) return;
  c.innerHTML = '';
  const colors = ['#ff6a2b', '#ffd257', '#2fe08a', '#9d8bff', '#ff556a', '#ff9143', '#45d6ff'];
  for (let i = 0; i < 70; i++) {
    const p = document.createElement('i');
    const size = 6 + Math.random() * 9;
    p.style.cssText =
      `left:${Math.random() * 100}%;` +
      `width:${size}px;height:${size * 0.5}px;` +
      `background:${colors[Math.floor(Math.random() * colors.length)]};` +
      `animation-delay:${(Math.random() * 0.7).toFixed(2)}s;` +
      `animation-duration:${(2.1 + Math.random() * 1.8).toFixed(2)}s;`;
    c.appendChild(p);
  }
}

/* ================================================================
   ЗВУК — синтез через Web Audio API (без файлов, работает офлайн)
   ================================================================ */
const Sound = (() => {
  let ctx = null;
  let muted = localStorage.getItem(LS.muted) === '1';

  function ac() {
    if (!ctx) { try { ctx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  }
  // Одна нота с огибающей громкости; glideTo — плавное изменение частоты.
  function tone(freq, t0, dur, type, vol, glideTo) {
    const c = ac(); if (!c) return;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type || 'sine';
    const start = c.currentTime + t0;
    o.frequency.setValueAtTime(freq, start);
    if (glideTo) o.frequency.exponentialRampToValueAtTime(glideTo, start + dur);
    g.gain.setValueAtTime(0.0001, start);
    g.gain.exponentialRampToValueAtTime(vol, start + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, start + dur);
    o.connect(g).connect(c.destination);
    o.start(start); o.stop(start + dur + 0.03);
  }
  const chord = (freqs, step, dur, type, vol) => freqs.forEach((f, i) => tone(f, i * step, dur, type, vol));

  return {
    resume() { ac(); },
    isMuted() { return muted; },
    toggle() { muted = !muted; localStorage.setItem(LS.muted, muted ? '1' : '0'); return muted; },
    click()  { if (!muted) tone(330, 0, 0.05, 'square', 0.05, 240); },
    tick()   { if (!muted) { tone(1400, 0, 0.07, 'square', 0.07); tone(1400, 0.14, 0.07, 'square', 0.07); } },
    hit()    { if (!muted) { tone(660, 0, 0.12, 'sine', 0.16, 990); tone(990, 0.05, 0.16, 'sine', 0.12, 1320); } },
    miss()   { if (!muted) tone(220, 0, 0.22, 'sawtooth', 0.14, 90); },
    finish() { if (!muted) chord([523, 659, 784, 1047], 0.07, 0.2, 'triangle', 0.14); },
    win()    { if (!muted) { chord([523, 659, 784, 1047, 1319], 0.11, 0.28, 'triangle', 0.16); tone(1047, 0.62, 0.5, 'sine', 0.1); } },
    lose()   { if (!muted) { tone(440, 0, 0.2, 'triangle', 0.12, 330); tone(330, 0.18, 0.3, 'triangle', 0.1, 247); } },
    start()  { if (!muted) { tone(1900, 0, 0.16, 'sine', 0.1, 2200); tone(2200, 0.14, 0.14, 'sine', 0.09, 2000); } },
    notify() { if (!muted) { tone(880, 0, 0.1, 'sine', 0.13); tone(1175, 0.09, 0.15, 'sine', 0.11); } }
  };
})();

/* ---------- Дата для истории ---------- */
const MONTHS = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
function formatDate(ts) {
  const d = new Date(ts || Date.now());
  const p = n => String(n).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()]}, ${p(d.getHours())}:${p(d.getMinutes())}`;
}
// Время суток HH:MM
function fmtClock(ts) {
  const d = new Date(ts);
  const p = n => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}
// Обратный отсчёт: «45с», «12:30», «2ч 5м»
function fmtCountdown(sec) {
  sec = Math.max(0, sec);
  if (sec < 60) return sec + 'с';
  const m = Math.floor(sec / 60), s = sec % 60;
  if (m < 60) return `${m}:${String(s).padStart(2, '0')}`;
  const h = Math.floor(m / 60);
  return `${h}ч ${m % 60}м`;
}

/* ================================================================
   PWA — установка на телефон и офлайн-оболочка
   ================================================================ */
function setupPWA() {
  // Service worker живёт только на http(s): при открытии файла с диска его нет
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  // Chrome даёт событие заранее — придерживаем его и показываем свою кнопку
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredInstall = e;
    const btn = $('#install-btn');
    if (btn) btn.hidden = false;
  });

  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    const btn = $('#install-btn');
    if (btn) btn.hidden = true;
  });
}

async function promptInstall() {
  const btn = $('#install-btn');
  if (!deferredInstall) {
    // Safari на iOS не поддерживает beforeinstallprompt — объясняем руками
    showAlert('Открой меню браузера и выбери «На экран „Домой“»', '📲');
    return;
  }
  deferredInstall.prompt();
  try { await deferredInstall.userChoice; } catch (e) {}
  deferredInstall = null;
  if (btn) btn.hidden = true;
}

/* ================================================================
   ИНИЦИАЛИЗАЦИЯ
   ================================================================ */
document.addEventListener('DOMContentLoaded', init);

function init() {
  bindEvents();
  setupPWA();

  // Ссылку-приглашение читаем один раз и сразу убираем из адреса,
  // иначе обновление страницы снова потащит в тот же матч.
  const joinId = new URLSearchParams(location.search).get('join');
  if (joinId) {
    pendingJoin = joinId;
    try { history.replaceState(null, '', location.pathname); } catch (e) {}
  }
  updateSoundIcon();
  setupRegPickers();
  const uid = localStorage.getItem(LS.userId);
  const nick = localStorage.getItem(LS.nickname);
  if (uid && nick) {
    state.userId = uid;
    state.nickname = nick;
    resumeUser().then(resumeOrMenu).catch(e => {
      // Аккаунт пропал или БД недоступна — не оставляем пользователя на пустом экране
      if (e && e.message === 'account-missing') return;
      console.error(e);
      showScreen('screen-login');
      $('#login-error').textContent = 'Нет связи с базой — попробуй ещё раз';
    });
  } else {
    showScreen('screen-login');
    $('#login-nick').focus();
  }
}

async function resumeUser() {
  const snap = await db.ref('users/' + state.userId).get();
  if (!snap.exists()) {
    // Аккаунт удалён из БД — вернём на экран входа (настройки при этом сохраняем)
    clearSession();
    state.userId = null; state.nickname = null;
    showScreen('screen-login');
    throw new Error('account-missing');
  }
  const u = snap.val();
  state.avatar = u.avatar || avatarFromString(state.userId);
  state.color  = u.color  || colorFromString(u.nickname || state.nickname);
  state.photo  = u.photo || null;
  if (!u.avatar || !u.color) db.ref('users/' + state.userId).update({ avatar: state.avatar, color: state.color });
  setupPresence();
}

// Если был активный матч — вернуться в него, иначе меню
async function resumeOrMenu() {
  // Приглашение по ссылке важнее незакрытого матча — человек шёл именно сюда
  if (pendingJoin) {
    const id = pendingJoin; pendingJoin = null;
    if (await joinByLink(id)) return;
  }
  const activeId = localStorage.getItem(LS.activeMatch);
  if (activeId) {
    const snap = await db.ref('matches/' + activeId).get();
    const m = snap.val();
    const me = m && m.players && m.players[state.userId];
    if (m && m.status !== 'finished' && me && me.status === 'joined' && !me.left) {
      enterMatch(activeId);
      return;
    }
    localStorage.removeItem(LS.activeMatch);
  }
  goMenu();
}

function setupPresence() {
  const ref = db.ref('users/' + state.userId + '/online');
  ref.onDisconnect().set(false);
  ref.set(true);
}

/* ================================================================
   ПРИВЯЗКА СОБЫТИЙ
   ================================================================ */
function bindEvents() {
  // --- Вход / регистрация ---
  $$('.auth-tab').forEach(t => t.addEventListener('click', () => setAuthMode(t.dataset.mode)));
  $('#login-btn').addEventListener('click', doAuth);
  $('#login-pin').addEventListener('keydown', e => { if (e.key === 'Enter') doAuth(); });
  $('#login-nick').addEventListener('keydown', e => { if (e.key === 'Enter') $('#login-pin').focus(); });

  // --- Меню ---
  $('#create-btn').addEventListener('click', openWizard);
  $('#solo-btn').addEventListener('click', startSolo);
  $('#logout-btn').addEventListener('click', logout);
  $('#history-btn').addEventListener('click', openHistory);
  $('#h2h-btn').addEventListener('click', openH2H);

  // --- История: фильтр ---
  $$('#seg-history .seg-btn').forEach(b => b.addEventListener('click', () => {
    $$('#seg-history .seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    historyFilter = b.dataset.hfilter;
    renderHistory();
  }));
  $('#mymatches-btn').addEventListener('click', openMyMatches);
  $('#rating-btn').addEventListener('click', openRating);
  $('#sound-btn').addEventListener('click', toggleSound);
  $('#install-btn').addEventListener('click', promptInstall);

  // --- Рейтинг: переключение сортировки ---
  $$('#seg-rating .seg-btn').forEach(b => b.addEventListener('click', () => {
    $$('#seg-rating .seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    ratingSort = b.dataset.sort;
    renderRating();
  }));
  $('#rating-search').addEventListener('input', renderRating);

  // --- Звук клика на любых кнопках (везде) ---
  document.addEventListener('pointerdown', e => {
    Sound.resume();
    if (e.target.closest('.btn, .btn-icon, .choice-card, .user-row, .auth-tab')) Sound.click();
  });

  // --- Навигация «назад» ---
  const NAV = { menu: goMenu, history: openHistory };
  $$('[data-nav]').forEach(b => b.addEventListener('click', () => {
    const go = NAV[b.dataset.nav];
    if (go) go();
  }));

  // --- Мастер: переходы между шагами ---
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => {
    const target = +b.dataset.goto;
    // Блокируем только переход на шаг 3 (выбор игроков), если цель еще не выбрана на шаге 2
    if (target === 3 && !state.wizard.goalType) { 
      flash(b, 'Выбери цель'); 
      return; 
    }
    goToStep(target);
  }));

  // --- Загрузка фото (регистрация и профиль) ---
  const regBtn = $('#reg-photo-btn');
  if (regBtn) regBtn.addEventListener('click', () => $('#reg-photo-file').click());
  
  const regFile = $('#reg-photo-file');
  if (regFile) {
    regFile.addEventListener('change', e => {
      compressImage(e.target.files[0], base64 => { 
        regPhoto = base64; 
        updateRegPreview(); 
      });
    });
  }

  const profBtn = $('#prof-photo-btn');
  if (profBtn) profBtn.addEventListener('click', () => $('#prof-photo-file').click());
  
  const profFile = $('#prof-photo-file');
  if (profFile) {
    profFile.addEventListener('change', e => {
      compressImage(e.target.files[0], base64 => { 
        profPhoto = base64; 
        $('#profile-preview').innerHTML = `<img src="${base64}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`; 
      });
    });
  }

  // --- Шаг 1: простой режим или зоны ---
  [['#type-normal', 'simple'], ['#type-advanced', 'zones']].forEach(([sel, mode]) => {
    const card = $(sel);
    if (!card) return;
    card.addEventListener('click', () => {
      $('#type-normal').classList.toggle('selected', mode === 'simple');
      $('#type-advanced').classList.toggle('selected', mode === 'zones');
      state.wizard.shotMode = mode;
      syncTargetLabel();
    });
  });

  // --- Шаг 2: выбор цели ---
  $$('[data-goal]').forEach(card => card.addEventListener('click', () => {
    $$('[data-goal]').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    const goal = card.dataset.goal;
    state.wizard.goalType = goal;
    $('#target-wrap').hidden = (goal !== 'common');
    $('#duration-wrap').hidden = (goal !== 'timed');
  }));

  // --- Шаг 2: степпер длительности матча «на время» ---
  $$('[data-duration]').forEach(b => b.addEventListener('click', () => {
    const inp = $('#duration-input');
    let v = (parseInt(inp.value, 10) || 1) + (+b.dataset.duration);
    v = Math.max(1, Math.min(120, v));
    inp.value = v; state.wizard.durationMin = v;
  }));
  const durInput = $('#duration-input');
  if (durInput) {
    durInput.addEventListener('input', e => {
      const val = parseInt(e.target.value, 10);
      if (!isNaN(val)) state.wizard.durationMin = Math.max(1, Math.min(120, val));
    });
    durInput.addEventListener('blur', e => { e.target.value = state.wizard.durationMin; });
  }

  // --- Шаг 2: степпер цели ---
  $$('[data-target]').forEach(b => b.addEventListener('click', () => {
    const inp = $('#target-input');
    let v = (parseInt(inp.value, 10) || 1) + (+b.dataset.target);
    v = Math.max(1, Math.min(99, v));
    inp.value = v; state.wizard.targetHits = v;
  }));
  
  const targetInput = $('#target-input');
  if (targetInput) {
    targetInput.addEventListener('input', e => {
      const val = parseInt(e.target.value, 10);
      // Обновляем стейт только если введено реальное число
      if (!isNaN(val)) state.wizard.targetHits = Math.max(1, Math.min(99, val));
    });
    
    // Возвращаем корректное значение в поле, если юзер стер всё и кликнул в другое место
    targetInput.addEventListener('blur', e => {
      e.target.value = state.wizard.targetHits;
    });
  }

  // --- Шаг 2: кто отмечает броски / таймер на ход ---
  $$('#seg-scorer .seg-btn').forEach(b => b.addEventListener('click', () => {
    $$('#seg-scorer .seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.wizard.scorer = b.dataset.scorer;
  }));
  $$('#seg-timer .seg-btn').forEach(b => b.addEventListener('click', () => {
    $$('#seg-timer .seg-btn').forEach(x => x.classList.remove('active'));
    b.classList.add('active');
    state.wizard.turnSeconds = +b.dataset.secs;
  }));

  // --- Шаг 3: поиск / отправка ---
  $('#user-search').addEventListener('input', renderUserList);
  $('#send-invites-btn').addEventListener('click', createMatch);

  // --- Лобби ---
  $('#start-btn').addEventListener('click', startMatch);
  $('#lobby-leave-btn').addEventListener('click', leaveLobby);
  $('#lobby-link-btn').addEventListener('click', shareMatchLink);

  // --- Матч ---
  $('#btn-hit').addEventListener('click', () => recordShot('hit', 1));
  $('#btn-miss').addEventListener('click', () => recordShot('miss'));
  $('#finish-btn').addEventListener('click', finishMatch);
  $('#leave-btn').addEventListener('click', leaveMatch);
  $('#match-log-btn').addEventListener('click', () => {
    // Из идущего матча ролик ещё не собрать — открываем только текст
    const m = lastRenderedMatch;
    openMatchLog(m && m.events ? Object.values(m.events) : [], null);
  });
  $('#undo-btn').addEventListener('click', undoShot);
  $('#pause-btn').addEventListener('click', togglePause);
  $$('#zones-bar .zone').forEach(b => b.addEventListener('click', () => recordShot('hit', +b.dataset.pts)));

  // --- Матч: горячие клавиши на десктопе ---
  document.addEventListener('keydown', e => {
    if (!$('#screen-match').classList.contains('active')) return;
    if (e.target.matches('input, textarea')) return;
    if (e.key === '1' || e.key === '2' || e.key === '3') {
      const zone = $(`#zones-bar .zone[data-pts="${e.key}"]`);
      if (!$('#zones-bar').hidden && zone && !zone.disabled) { zone.click(); return; }
      if (e.key === '1' && !$('#btn-hit').disabled) $('#btn-hit').click();
    } else if (e.key === ' ' || e.key.toLowerCase() === 'd') {
      if (!$('#btn-hit').hidden && !$('#btn-hit').disabled) { e.preventDefault(); $('#btn-hit').click(); }
    } else if (e.key.toLowerCase() === 'x' || e.key.toLowerCase() === 'ч') {
      if (!$('#btn-miss').disabled) $('#btn-miss').click();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
      if (!$('#undo-btn').hidden) { e.preventDefault(); $('#undo-btn').click(); }
    }
  });

  // --- Результаты ---
  $('#results-menu-btn').addEventListener('click', goMenu);
  $('#results-rematch-btn').addEventListener('click', startRematch);
  $('#results-share-btn').addEventListener('click', shareResults);

  // --- Модалка ---
  $('#modal-ok').addEventListener('click', () => closeModal(true));
  $('#modal-cancel').addEventListener('click', () => closeModal(false));
  $('#modal-backdrop').addEventListener('click', e => { if (e.target.id === 'modal-backdrop') closeModal(false); });

  // --- Профиль (аватар/цвет) ---
  $('#menu-avatar').addEventListener('click', openProfile);
  $('#profile-save').addEventListener('click', saveProfile);
  $('#profile-delete').addEventListener('click', deleteAccount);
  $('#opt-haptics').addEventListener('change', e => { Haptics.set(e.target.checked); if (e.target.checked) Haptics.tap(); });
  $('#opt-notify').addEventListener('change', async e => {
    const ok = await Notify.set(e.target.checked);
    e.target.checked = ok;
    // Разрешение можно отозвать только в настройках браузера — честно скажем об этом
    if (!ok && e.target.checked !== false && Notification.permission === 'denied') {
      showAlert('Уведомления запрещены в настройках браузера', '🔕');
    }
  });
  $('#profile-cancel').addEventListener('click', () => { $('#profile-backdrop').hidden = true; });
  $('#profile-backdrop').addEventListener('click', e => { if (e.target.id === 'profile-backdrop') $('#profile-backdrop').hidden = true; });

  // --- Модалка «Ход матча» (полный лог из истории) ---
  $('#log-close').addEventListener('click', () => { $('#log-backdrop').hidden = true; });
  $('#log-backdrop').addEventListener('click', e => { if (e.target.id === 'log-backdrop') $('#log-backdrop').hidden = true; });

  // --- Видео матча ---
  MatchVideo.bind();
  $('#log-video-btn').addEventListener('click', () => {
    if (!logVideoSource) return;
    MatchVideo.open(MatchVideo.fromHistory(logVideoSource), 'Видео матча');
  });

  // --- Модалка редактирования матча ---
  $('#edit-save').addEventListener('click', saveEditMatch);
  $('#edit-cancel').addEventListener('click', () => { $('#edit-backdrop').hidden = true; editingMatchId = null; });
  $('#edit-backdrop').addEventListener('click', e => { if (e.target.id === 'edit-backdrop') { $('#edit-backdrop').hidden = true; editingMatchId = null; } });
}

/* Открыть полный лог хода матча (из карточки истории) */
function openMatchLog(events, hist) {
  logVideoSource = hist || null;                    // из чего собирать ролик
  $('#log-video-btn').hidden = !logVideoSource;
  const feed = $('#log-feed');
  feed.innerHTML = '';
  const list = (events || []).slice().sort((a, b) => (a.time || 0) - (b.time || 0));
  if (!list.length) {
    feed.innerHTML = '<div class="empty" style="padding:24px 0">Событий не записано</div>';
  } else {
    list.forEach(ev => {
      const el = document.createElement('div');
      el.className = 'event-item ' + (ev.action || '');
      el.textContent = ev.text || '';
      feed.appendChild(el);
    });
  }
  $('#log-backdrop').hidden = false;
  feed.scrollTop = 0;
}

function flash(el, msg) {
  const old = el.textContent;
  el.textContent = msg;
  setTimeout(() => { el.textContent = old; }, 1200);
}

/* ================================================================
   ЭКРАН 1 — ВХОД / РЕГИСТРАЦИЯ
   ================================================================ */
const NICK_RE = /^[A-Za-zА-Яа-яЁё0-9]{3,16}$/;
const PIN_RE  = /^\d{4,6}$/;

function setAuthMode(mode) {
  authMode = mode;
  $$('.auth-tab').forEach(t => t.classList.toggle('active', t.dataset.mode === mode));
  $('.auth-tabs').classList.toggle('reg', mode === 'register');
  $('#login-btn').textContent = mode === 'login' ? 'Войти' : 'Создать аккаунт';
  $('#login-error').textContent = '';
  const isReg = mode === 'register';
  $('#reg-preview').hidden = !isReg;
  $('#reg-picker').hidden = !isReg;
}

// Сетки выбора аватара/цвета при регистрации
function setupRegPickers() {
  buildEmojiGrid($('#emoji-grid'), () => regAvatar, em => { regAvatar = em; updateRegPreview(); });
  buildColorGrid($('#color-grid'), () => regColor,  col => { regColor = col; updateRegPreview(); });
  updateRegPreview();
}
function updateRegPreview() {
  const el = $('#avatar-preview');
  if (regPhoto) {
    el.innerHTML = `<img src="${regPhoto}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`;
  } else {
    el.textContent = regAvatar;
  }
  el.style.background = `linear-gradient(135deg, ${regColor}, ${shade(regColor, -30)})`;
}

/* ---------- Модалка профиля ---------- */
function openProfile() {
  if (!state.userId) return;
  profAvatar = state.avatar || AVATARS[0];
  profColor  = state.color  || COLORS[0];
  profPhoto  = state.photo  || null;
  const upd = () => {
    const el = $('#profile-preview');
    if (profPhoto) el.innerHTML = `<img src="${profPhoto}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;">`;
    else el.textContent = profAvatar;
    el.style.background = `linear-gradient(135deg, ${profColor}, ${shade(profColor, -30)})`;
  };
  buildEmojiGrid($('#profile-emoji'), () => profAvatar, em => { profAvatar = em; profPhoto = null; upd(); });
  buildColorGrid($('#profile-color'), () => profColor,  col => { profColor = col; upd(); });
  upd();

  $('#profile-nick').textContent = state.nickname || 'Профиль';
  $('#profile-nick-input').value = state.nickname || '';
  $('#profile-error').textContent = '';
  renderProfileStats(state.stats);
  // Переключатели читаются из localStorage, а не из БД: это настройки устройства
  $('#opt-haptics').checked = Haptics.isOn();
  const notifyBox = $('#opt-notify');
  notifyBox.checked = Notify.isOn();
  notifyBox.disabled = !Notify.supported();
  $('#profile-backdrop').hidden = false;
}

async function saveProfile() {
  const err = $('#profile-error');
  err.textContent = '';
  const nick = ($('#profile-nick-input').value || '').trim();
  const changed = nick.toLowerCase() !== (state.nickname || '').toLowerCase();

  if (!NICK_RE.test(nick)) { err.textContent = 'Ник: 3–16 символов, буквы и цифры'; return; }

  const btn = $('#profile-save');
  btn.disabled = true;
  try {
    if (changed) {
      const snap = await db.ref('users').get();
      const taken = Object.entries(snap.val() || {})
        .some(([uid, u]) => uid !== state.userId && (u.nickname || '').toLowerCase() === nick.toLowerCase());
      if (taken) { err.textContent = 'Этот ник уже занят'; return; }
    }

    await db.ref('users/' + state.userId).update({
      nickname: nick, avatar: profAvatar, color: profColor, photo: profPhoto
    });
    state.avatar = profAvatar;
    state.color = profColor;
    state.photo = profPhoto;
    state.nickname = nick;
    localStorage.setItem(LS.nickname, nick);
    $('#profile-backdrop').hidden = true;
    // В уже сыгранных матчах и в истории лежат копии старого ника — там он
    // так и останется, это снимок момента игры.
    if (changed) showAlert('Ник изменён. В прошлых матчах останется прежний', '✏️');
  } catch (e) {
    err.textContent = 'Не удалось сохранить — проверь связь';
  } finally {
    btn.disabled = false;
  }
}

async function doAuth() {
  const err = $('#login-error');
  err.textContent = '';
  const nick = $('#login-nick').value.trim();
  const pin  = $('#login-pin').value.trim();

  if (!NICK_RE.test(nick)) { err.textContent = 'Ник: 3–16 символов, буквы и цифры'; return; }
  if (!PIN_RE.test(pin))   { err.textContent = 'PIN: 4–6 цифр'; return; }

  $('#login-btn').disabled = true;
  try {
    const snap = await db.ref('users').get();
    const users = snap.val() || {};
    const found = Object.entries(users)
      .find(([, u]) => (u.nickname || '').toLowerCase() === nick.toLowerCase());

    if (authMode === 'register') {
      if (found) { err.textContent = 'Этот ник уже занят'; return; }
      const userId = uuid();
      await db.ref('users/' + userId).set({
        nickname: nick, pin: hashPin(pin), online: true,
        avatar: regAvatar, color: regColor, photo: regPhoto || null,
        stats: { matches: 0, hits: 0, misses: 0 }
      });
      state.avatar = regAvatar; state.color = regColor; state.photo = regPhoto || null;
      loginLocal(userId, nick);
} else {
      if (!found) { err.textContent = 'Аккаунт не найден — зарегистрируйся'; return; }
      const [uid, u] = found;
      
      if (!u.pin) {
        // Запрещаем захват старых аккаунтов без пароля
        err.textContent = 'Аккаунт устарел (без PIN). Зарегистрируйте новый.';
        return;
      } else if (u.pin !== hashPin(pin)) {
        err.textContent = 'Неверный PIN-код'; 
        return;
      }

      // Аватар/цвет: берём из аккаунта, легаси без них — авто-назначаем
      state.avatar = u.avatar || avatarFromString(uid);
      state.color  = u.color  || colorFromString(u.nickname);
      state.photo  = u.photo || null;
      if (!u.avatar || !u.color) db.ref('users/' + uid).update({ avatar: state.avatar, color: state.color });
      loginLocal(uid, u.nickname);
    }
  } catch (e) {
    err.textContent = 'Ошибка соединения с БД';
    console.error(e);
  } finally {
    $('#login-btn').disabled = false;
  }
}

function loginLocal(userId, nick) {
  localStorage.setItem(LS.userId, userId);
  localStorage.setItem(LS.nickname, nick);
  state.userId = userId;
  state.nickname = nick;
  setupPresence();
  $('#login-pin').value = '';
  if (pendingJoin) {
    const id = pendingJoin; pendingJoin = null;
    joinByLink(id).then(ok => { if (!ok) goMenu(); });
    return;
  }
  goMenu();
}

async function logout() {
  if (!await showConfirm('Выйти из аккаунта?', 'Выйти', '⎋')) return;
  try { await db.ref('users/' + state.userId + '/online').set(false); } catch (e) {}
  stopMenuWatch();
  stopMatchWatch();
  stopTurnTimer();
  stopLobbyTimer();
  clearSession();
  state.userId = null; state.nickname = null; state.currentMatchId = null;
  setAuthMode('login');
  $('#login-nick').value = ''; $('#login-pin').value = '';
  showScreen('screen-login');
}

/* ---------- Удаление аккаунта ---------- */
/* Сносим то, что принадлежит человеку: сам аккаунт, его историю, приглашения
   и индекс матчей. Записи в уже сыгранных матчах остаются — это снимок игры,
   и без них у соперников развалились бы их собственные итоги. */
async function deleteAccount() {
  if (!state.userId) return;
  if (!await showConfirm('Удалить аккаунт? Статистика и история пропадут навсегда.', 'Удалить', '⚠️')) return;
  if (!await showConfirm('Точно? Это нельзя отменить.', 'Да, удалить', '🗑️')) return;

  const uid = state.userId;
  try {
    // Из своих незавершённых матчей выходим, чтобы никого не заморозить на своём ходу
    const idxSnap = await db.ref('userMatches/' + uid).get();
    const ids = Object.keys(idxSnap.val() || {});
    for (const id of ids) {
      await db.ref('matches/' + id).transaction(m => {
        if (!m || !m.players || !m.players[uid] || m.status === 'finished') return m;
        m.players[uid].left = true;
        m.players[uid].status = 'left';
        if (m.status === 'active') {
          const order = m.turnOrder || [];
          const playing = order.filter(u => m.players[u] && !m.players[u].finished && !m.players[u].left).length;
          if (playing <= 1) return closeMatch(m, serverNow());
          if (order[m.currentTurnIndex] === uid) {
            const next = findNextTurn(m, m.currentTurnIndex);
            if (next !== -1) { m.currentTurnIndex = next; m.turnStartedAt = serverNow(); }
          }
        }
        return m;
      });
    }

    await db.ref().update({
      ['users/' + uid]: null,
      ['history/' + uid]: null,
      ['invites/' + uid]: null,
      ['userMatches/' + uid]: null
    });
  } catch (e) {
    showAlert('Не удалось удалить — проверь связь', '⚠️');
    return;
  }

  $('#profile-backdrop').hidden = true;
  stopMenuWatch();
  stopMatchWatch();
  stopTurnTimer();
  stopLobbyTimer();
  clearSession();
  state.userId = null; state.nickname = null; state.currentMatchId = null; state.stats = null;
  setAuthMode('login');
  $('#login-nick').value = ''; $('#login-pin').value = '';
  showScreen('screen-login');
  showAlert('Аккаунт удалён', '👋');
}

/* ---------- Звук: переключатель ---------- */
function updateSoundIcon() {
  $('#sound-btn').textContent = Sound.isMuted() ? '🔇' : '🔊';
}
function toggleSound() {
  const muted = Sound.toggle();
  updateSoundIcon();
  if (!muted) Sound.notify(); // короткий сигнал, что звук снова включён
}

/* ================================================================
   ЭКРАН 2 — ГЛАВНОЕ МЕНЮ
   ================================================================ */
function goMenu() {
  stopMatchWatch();
  stopTurnTimer();
  stopLobbyTimer();
  stopMatchClock();
  Notify.stopTitle();
  state.currentMatchId = null;
  localStorage.removeItem(LS.activeMatch);
  prevInviteCount = -1; // сброс базовой линии, чтобы не пикать на первом снимке
  showScreen('screen-menu');
  watchMenu();
}

function watchMenu() {
  stopMenuWatch();
  userWatchRef = db.ref('users/' + state.userId);
  userWatchRef.on('value', s => renderHeader(s.val()));
  invitesWatchRef = db.ref('invites/' + state.userId);
  invitesWatchRef.on('value', s => renderInvites(s.val()));
}

function stopMenuWatch() {
  if (userWatchRef)    { userWatchRef.off();    userWatchRef = null; }
  if (invitesWatchRef) { invitesWatchRef.off(); invitesWatchRef = null; }
}

function renderHeader(u) {
  if (!u) return;
  $('#menu-nick').textContent = u.nickname || state.nickname;
  const av = $('#menu-avatar');
  av.innerHTML = faceOf(u);
  av.style.background = `linear-gradient(135deg, ${colorOf(u)}, ${shade(colorOf(u), -30)})`;
  const st = u.stats || {};
  state.stats = st;   // профиль берёт её отсюда, без отдельного запроса
  $('#menu-stat-matches').textContent = st.matches || 0;
  $('#menu-stat-acc').textContent = accuracy(st.hits, st.misses) + '%';
  $('#menu-stat-wins').textContent = st.wins || 0;
}

function renderInvites(obj) {
  const list = $('#invites-list');
  const empty = $('#invites-empty');
  list.innerHTML = '';
  const entries = obj ? Object.entries(obj) : [];
  empty.style.display = entries.length ? 'none' : 'block';

  // Звук и уведомление при появлении нового приглашения
  if (prevInviteCount >= 0 && entries.length > prevInviteCount) {
    Sound.notify();
    Haptics.turn();
    const newest = entries.map(([, inv]) => inv).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0))[0];
    Notify.invite(newest && newest.creatorNickname);
  }
  prevInviteCount = entries.length;

  entries.forEach(([matchId, inv]) => {
    const typeLabel = inv.goalType === 'common' ? 'Общая цель' : 'Обычный матч';
    const creator = { nickname: inv.creatorNickname, avatar: inv.creatorAvatar, color: inv.creatorColor, photo: inv.creatorPhoto };
    const card = document.createElement('div');
    card.className = 'invite-card';
    card.innerHTML = `
      <div class="avatar" style="${avatarBg(colorOf(creator))}">${faceOf(creator)}</div>
      <div class="info">
        <div class="who">${escapeHtml(inv.name || ('Матч ' + (inv.creatorNickname || '')))}</div>
        <div class="sub">${escapeHtml(inv.creatorNickname || '—')} · ${typeLabel}${inv.startAt ? ' · 🕐 ' + fmtClock(inv.startAt) : ''}</div>
      </div>
      <div class="invite-actions">
        <button class="btn btn-accent accept">Принять</button>
        <button class="btn btn-ghost decline">✕</button>
      </div>`;
    card.querySelector('.accept').addEventListener('click', () => acceptInvite(matchId));
    card.querySelector('.decline').addEventListener('click', () => declineInvite(matchId));
    list.appendChild(card);
  });
}

async function acceptInvite(matchId) {
  const snap = await db.ref('matches/' + matchId).get();
  const m = snap.val();
  await db.ref('invites/' + state.userId + '/' + matchId).remove();
  db.ref('userMatches/' + state.userId + '/' + matchId).set(true);

  if (!m || m.status === 'finished') { showAlert('Матч уже завершён', '⚠️'); return; }

  if (m.status === 'lobby') {
    // Обычный вход в лобби
    await db.ref('matches/' + matchId + '/players/' + state.userId)
      .update({ status: 'joined', joinedAt: TS, avatar: state.avatar || null, color: state.color || null, photo: state.photo || null });
    enterMatch(matchId);
    return;
  }

  // Матч уже идёт — присоединяемся на ходу (поздний вход)
  const now = serverNow();
  await db.ref('matches/' + matchId).transaction(mm => {
    if (!mm || mm.status !== 'active') return mm;
    if (!mm.players) mm.players = {};
    const p = mm.players[state.userId] || {};
    p.nickname = state.nickname;
    p.avatar = state.avatar || null;
    p.color  = state.color  || null;
    p.photo  = state.photo  || null;
    p.status = 'joined';
    p.joinedAt = now;
    p.left = false;
    p.finished = false;
    p.hits = p.hits || 0;
    p.misses = p.misses || 0;
    p.streak = 0;
    mm.players[state.userId] = p;

    mm.turnOrder = mm.turnOrder || [];
    if (mm.turnOrder.indexOf(state.userId) === -1) mm.turnOrder.push(state.userId);

    if (!mm.events) mm.events = {};
    const k = db.ref().push().key;
    mm.events[k] = { time: now, userId: state.userId, action: 'join', text: `${state.nickname} присоединился` };
    return mm;
  });
  enterMatch(matchId);
}

async function declineInvite(matchId) {
  await db.ref('invites/' + state.userId + '/' + matchId).remove();
  const snap = await db.ref('matches/' + matchId).get();
  if (snap.exists()) db.ref('matches/' + matchId + '/players/' + state.userId + '/status').set('declined');
}

/* ================================================================
   ЭКРАН 3 — МАСТЕР СОЗДАНИЯ
   ================================================================ */
function openWizard() {
  state.wizard = { goalType: null, shotMode: 'simple', targetHits: 10, durationMin: 10,
                   scorer: 'shooter', turnSeconds: 0, name: '', selected: {} };
  // Выбираем визуально «Обычный» тип по умолчанию
  $('#type-normal').classList.add('selected');
  $('#type-advanced').classList.remove('selected');
  $$('[data-goal]').forEach(c => c.classList.remove('selected'));
  $('#target-wrap').hidden = true;
  $('#duration-wrap').hidden = true;
  $('#target-input').value = 10;
  $('#duration-input').value = 10;
  syncTargetLabel();
  $('#match-name').value = '';
  $('#user-search').value = '';
  // Предзаполняем дату/время текущими — пустые нативные поля выглядят некрасиво.
  // Оставленное «сейчас» время окажется в прошлом к старту → расписание не назначается.
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  $('#match-date').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $('#match-time').value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  // Сброс сегментов к дефолтам (первый вариант активен)
  $$('#seg-scorer .seg-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  $$('#seg-timer .seg-btn').forEach((b, i) => b.classList.toggle('active', i === 0));
  goToStep(1);
  showScreen('screen-create');
  loadUsersForWizard();
  loadRecentOpponents();
}

// В продвинутом режиме цель считается в очках, а не в попаданиях
function syncTargetLabel() {
  const lbl = $('#target-label');
  if (lbl) lbl.textContent = state.wizard.shotMode === 'zones'
    ? 'Сколько очков нужно набрать каждому?'
    : 'Сколько попаданий нужно каждому?';
}

function goToStep(n) {
  $$('.wstep').forEach(s => s.classList.toggle('active', +s.dataset.wstep === n));
  $$('.steps-indicator .dot').forEach(d => d.classList.toggle('active', +d.dataset.step === n));
}

function loadUsersForWizard() {
  db.ref('users').get().then(snap => {
    usersOnceCache = snap.val() || {};
    renderUserList();
  });
}

/* Недавние соперники: быстрый выбор тех, с кем уже играл, без поиска по нику. */
async function loadRecentOpponents() {
  const wrap = $('#recent-wrap');
  if (!wrap) return;
  wrap.hidden = true;
  try {
    if (!historyCache.length) {
      const snap = await db.ref('history/' + state.userId).get();
      historyCache = Object.entries(snap.val() || {}).map(([_k, h]) => ({ ...h, _k }))
        .sort((a, b) => (b.time || 0) - (a.time || 0));
    }
  } catch (e) { return; }

  const seen = {};
  historyCache.forEach(h => {
    (h.roster || []).forEach(r => {
      // Без userId позвать не получится — такие записи пропускаем
      if (!r.userId || r.userId === state.userId || seen[r.userId]) return;
      seen[r.userId] = { nickname: r.nickname, avatar: r.avatar || null, color: r.color || null, photo: r.photo || null };
    });
  });
  recentOpponents = Object.entries(seen).slice(0, 8).map(([uid, u]) => ({ uid, ...u }));
  renderRecentChips();
}

function renderRecentChips() {
  const wrap = $('#recent-wrap'), box = $('#recent-chips');
  if (!wrap || !box) return;
  // Показываем только тех, кто ещё есть в базе — удалённые аккаунты звать некуда
  const avail = recentOpponents.filter(o => usersOnceCache[o.uid]);
  wrap.hidden = !avail.length;
  box.innerHTML = '';
  avail.forEach(o => {
    const on = !!state.wizard.selected[o.uid];
    const chip = document.createElement('button');
    chip.type = 'button';
    chip.className = 'recent-chip' + (on ? ' sel' : '');
    chip.innerHTML = `${miniAvatar(o, true)}<span>${escapeHtml(o.nickname)}</span>`;
    chip.addEventListener('click', () => {
      if (state.wizard.selected[o.uid]) delete state.wizard.selected[o.uid];
      else state.wizard.selected[o.uid] = { nickname: o.nickname, avatar: o.avatar, color: o.color, photo: o.photo };
      renderUserList();
    });
    box.appendChild(chip);
  });
}

function renderUserList() {
  const q = $('#user-search').value.trim().toLowerCase();
  const list = $('#user-list');
  list.innerHTML = '';

  const rows = Object.entries(usersOnceCache)
    .filter(([uid]) => uid !== state.userId)
    .filter(([, u]) => (u.nickname || '').toLowerCase().includes(q))
    .sort((a, b) => (b[1].online ? 1 : 0) - (a[1].online ? 1 : 0));

  rows.forEach(([uid, u]) => {
    const selected = !!state.wizard.selected[uid];
    const row = document.createElement('div');
    row.className = 'user-row' + (selected ? ' selected' : '');
    row.innerHTML = `
      ${miniAvatar(u)}
      <span class="status-dot ${u.online ? 'online' : ''}"></span>
      <span class="u-name">${escapeHtml(u.nickname)}</span>
      <span class="check">✓</span>`;
    row.addEventListener('click', () => {
      if (state.wizard.selected[uid]) delete state.wizard.selected[uid];
      else state.wizard.selected[uid] = { nickname: u.nickname, avatar: u.avatar || null, color: u.color || null, photo: u.photo || null };
      renderUserList();
    });
    list.appendChild(row);
  });

  if (!list.children.length) list.innerHTML = '<div class="empty">Никого не найдено</div>';
  renderRecentChips();   // подсветка чипов идёт за выбором в списке
}

async function createMatch() {
  const selectedIds = Object.keys(state.wizard.selected);
  if (!selectedIds.length) { showAlert('Выбери хотя бы одного игрока', '👥'); return; }
  if (!state.wizard.goalType) { showAlert('Не выбран тип матча', '🎯'); return; }

  const matchId = db.ref('matches').push().key;
  const matchName = (($('#match-name').value || '').trim()) || `Матч ${state.nickname}`;
  // Дата + время → метка старта. Назначаем, только если реально в будущем (>30с).
  const dateVal = $('#match-date').value, timeVal = $('#match-time').value;
  let startAt = null;
  if (dateVal && timeVal) {
    const t = new Date(`${dateVal}T${timeVal}`).getTime();
    if (t && t > serverNow() + 30000) startAt = t;
  }

  const players = {};
  players[state.userId] = {
    nickname: state.nickname, avatar: state.avatar || null, color: state.color || null, photo: state.photo || null,
    status: 'joined', hits: 0, misses: 0, points: 0, streak: 0, best: 0, joinedAt: TS
  };
  selectedIds.forEach(uid => {
    const sel = state.wizard.selected[uid];
    players[uid] = {
      nickname: sel.nickname, avatar: sel.avatar || null, color: sel.color || null, photo: sel.photo || null,
      status: 'waiting', hits: 0, misses: 0, points: 0, streak: 0, best: 0
    };
  });

  const match = {
    creatorId: state.userId,
    name: matchName,
    startAt: startAt || null,
    type: 'normal',
    shotMode: state.wizard.shotMode || 'simple',                        // 'simple' | 'zones'
    goalType: state.wizard.goalType,                                    // 'common' | 'individual' | 'timed'
    targetHits: state.wizard.goalType === 'common' ? state.wizard.targetHits : null,
    durationMin: state.wizard.goalType === 'timed' ? state.wizard.durationMin : null,
    endsAt: null,                                                       // проставим на старте матча
    scorer: state.wizard.scorer || 'shooter',                           // 'shooter' | 'creator'
    turnSeconds: state.wizard.turnSeconds || 0,                         // 0 = без таймера
    turnStartedAt: null,
    status: 'lobby',
    players,
    currentTurnIndex: 0,
    createdAt: TS
  };
  await db.ref('matches/' + matchId).set(match);

  const updates = {};
  // Индекс «матчи игрока»: без него экран «Мои матчи» тянул бы всё дерево matches
  Object.keys(players).forEach(uid => { updates['userMatches/' + uid + '/' + matchId] = true; });
  selectedIds.forEach(uid => {
    updates['invites/' + uid + '/' + matchId] = {
      name: matchName,
      startAt: startAt || null,
      creatorNickname: state.nickname, creatorAvatar: state.avatar || null, creatorColor: state.color || null,
      creatorPhoto: state.photo || null,
      goalType: state.wizard.goalType, shotMode: state.wizard.shotMode || 'simple', timestamp: TS
    };
  });
  await db.ref().update(updates);

  enterMatch(matchId);
}

/* ---------- Приглашение по ссылке ---------- */
/* Ссылку можно кинуть в любой мессенджер: открывший её попадёт прямо в матч,
   даже если создатель не звал его из списка игроков. */
function matchLink(matchId) {
  return location.origin + location.pathname + '?join=' + encodeURIComponent(matchId);
}

async function shareMatchLink() {
  const mid = state.currentMatchId;
  if (!mid) return;
  const url = matchLink(mid);
  const name = (lobbyMatch && lobbyMatch.name) || 'матч';
  try {
    if (navigator.share) { await navigator.share({ title: 'Баскетбол', text: `Заходи в ${name}!`, url }); return; }
    await navigator.clipboard.writeText(url);
    showAlert('Ссылка скопирована — отправь её друзьям', '🔗');
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    // clipboard недоступен на http без сертификата — показываем ссылку целиком
    showAlert(url, '🔗');
  }
}

// Вход по ссылке: дописываемся в матч, если он ещё идёт
async function joinByLink(matchId) {
  let snap;
  try { snap = await db.ref('matches/' + matchId).get(); }
  catch (e) { showAlert('Не удалось открыть матч', '⚠️'); return false; }

  const m = snap.val();
  if (!m)                      { showAlert('Матч не найден — возможно, его удалили', '🔍'); return false; }
  if (m.status === 'finished') { showAlert('Этот матч уже завершён', '🏁'); return false; }

  const me = m.players && m.players[state.userId];
  // Уже в составе и не выходил — просто заходим
  if (me && !me.left && me.status === 'joined') { enterMatch(matchId); return true; }

  await db.ref('matches/' + matchId).transaction(mm => {
    if (!mm || mm.status === 'finished') return mm;
    if (!mm.players) mm.players = {};
    const p = mm.players[state.userId] || { hits: 0, misses: 0, points: 0, best: 0 };
    p.nickname = state.nickname;
    p.avatar = state.avatar || null;
    p.color  = state.color  || null;
    p.photo  = state.photo  || null;
    p.status = 'joined';
    p.joinedAt = serverNow();
    p.left = false;
    p.finished = false;
    p.streak = 0;
    mm.players[state.userId] = p;

    // В идущий матч надо ещё встать в очередь бросков
    if (mm.status === 'active') {
      mm.turnOrder = mm.turnOrder || [];
      if (mm.turnOrder.indexOf(state.userId) === -1) mm.turnOrder.push(state.userId);
      if (!mm.events) mm.events = {};
      const k = db.ref().push().key;
      mm.events[k] = { time: serverNow(), userId: state.userId, action: 'join', text: `${state.nickname} присоединился по ссылке` };
    }
    return mm;
  });

  await db.ref().update({
    ['userMatches/' + state.userId + '/' + matchId]: true,
    ['invites/' + state.userId + '/' + matchId]: null
  });
  enterMatch(matchId);
  return true;
}

/* ---------- Тренировка в одиночку ---------- */
/* Обычный матч требует минимум двоих. Тренировка — тот же матч, только сам с
   собой: броски и точность идут в общую статистику, а победы и поражения нет,
   иначе их можно было бы накрутить, играя без соперника. */
async function startSolo() {
  if (!state.userId) return;
  const zones = await showConfirm(
    'Тренировка: бросаешь сколько хочешь, счёт идёт в статистику. Считать броски по зонам?',
    'С зонами', '🎯');

  const matchId = db.ref('matches').push().key;
  const players = {};
  players[state.userId] = {
    nickname: state.nickname, avatar: state.avatar || null, color: state.color || null, photo: state.photo || null,
    status: 'joined', hits: 0, misses: 0, points: 0, streak: 0, best: 0, joinedAt: TS
  };

  await db.ref('matches/' + matchId).set({
    creatorId: state.userId,
    name: 'Тренировка',
    solo: true,
    startAt: null,
    type: 'normal',
    shotMode: zones ? 'zones' : 'simple',
    goalType: 'individual',
    targetHits: null,
    durationMin: null,
    endsAt: null,
    scorer: 'shooter',
    turnSeconds: 0,
    turnStartedAt: serverNow(),
    status: 'active',              // лобби ждать некого — начинаем сразу
    players,
    turnOrder: [state.userId],
    currentTurnIndex: 0,
    createdAt: TS
  });
  await db.ref('userMatches/' + state.userId + '/' + matchId).set(true);
  await db.ref('matches/' + matchId + '/events').push({
    time: serverNow(), userId: '', action: 'start', text: '🎯 Тренировка началась' });

  enterMatch(matchId);
}

/* ================================================================
   ВХОД В МАТЧ + РОУТИНГ ПО СТАТУСУ
   ================================================================ */
function enterMatch(matchId) {
  stopMenuWatch();
  stopMatchWatch();
  state.currentMatchId = matchId;
  lastEventTime = null;    // не проигрывать анимации для уже существующих событий
  lastReactionTime = null; // и не показывать реакции, прилетевшие до входа
  prevTurnUid = null;
  confettiFor = null;
  prevMatchStatus = null;
  localStorage.setItem(LS.activeMatch, matchId);
  matchWatchRef = db.ref('matches/' + matchId);
  matchWatchRef.on('value', onMatchValue);
}

function stopMatchWatch() {
  if (matchWatchRef) { matchWatchRef.off(); matchWatchRef = null; }
  stopMatchClock();
}

function onMatchValue(snap) {
  const m = snap.val();
  if (!m) { showAlert('Матч был отменён', '⚠️'); goMenu(); return; }

  // Свисток при старте (переход лобби → активный матч)
  if (prevMatchStatus === 'lobby' && m.status === 'active') Sound.start();
  prevMatchStatus = m.status;

  if (m.status === 'lobby')       renderLobby(m);
  else if (m.status === 'active') renderMatch(m);
  else if (m.status === 'finished') { renderResults(m); finalizeAll(m); }
}

/* ================================================================
   ЭКРАН 4 — ЛОББИ
   ================================================================ */
function renderLobby(m) {
  showScreen('screen-lobby');
  stopTurnTimer();
  const isCreator = m.creatorId === state.userId;
  const creatorNick = (m.players[m.creatorId] || {}).nickname || '—';

  $('#lobby-title').textContent = m.name || (isCreator ? 'Твоё лобби' : 'Лобби · ' + creatorNick);
  let info;
  if (m.goalType === 'common')     info = `🎯 На цель — каждому нужно набрать ${m.targetHits} ${isZones(m) ? 'очков' : 'попаданий'}`;
  else if (m.goalType === 'timed') info = `⏳ На время — ${m.durationMin} мин, побеждает лучший счёт`;
  else                             info = '🔥 Свободный матч — заканчивает создатель, побеждает лучший счёт';
  if (isZones(m))     info += ' · 🎖️ броски с зон (+1/+2/+3)';
  if (m.turnSeconds)  info += ` · ⏱ ${m.turnSeconds}с на ход`;
  if (m.scorer === 'creator') info += ' · броски отмечает создатель';
  if (m.startAt) info += ` · 🕐 старт в ${fmtClock(m.startAt)}`;
  $('#lobby-info').textContent = info;

  const box = $('#lobby-players');
  box.innerHTML = '';

  Object.entries(m.players).forEach(([uid, p]) => {
    let badge;
    if (uid === m.creatorId)          badge = '<span class="badge creator">создатель</span>';
    else if (p.status === 'joined')   badge = '<span class="badge joined">присоединился</span>';
    else if (p.status === 'declined') badge = '<span class="badge declined">отклонил</span>';
    else                              badge = '<span class="badge waiting">ожидание</span>';
    const row = document.createElement('div');
    row.className = 'lobby-row';
    row.dataset.uid = uid;
    row.innerHTML = `
      <div class="l-avatar" style="${avatarBg(colorOf(p))}">${faceOf(p)}</div>
      <span class="status-dot${presenceOnline[uid] ? ' online' : ''}"></span>
      <span class="l-name">${escapeHtml(p.nickname)}</span>${badge}`;

    // Создатель может убрать того, кто так и не зашёл
    if (isCreator && uid !== m.creatorId && p.status !== 'joined') {
      const kick = document.createElement('button');
      kick.className = 'lobby-kick';
      kick.type = 'button';
      kick.title = 'Убрать из матча';
      kick.textContent = '✕';
      kick.addEventListener('click', () => kickFromLobby(uid, p.nickname));
      row.appendChild(kick);
    }
    box.appendChild(row);
  });

  watchLobbyPresence(Object.keys(m.players));
  lobbyMatch = m;
  refreshStartBtn();
  if (!lobbyIntervalId) lobbyIntervalId = setInterval(refreshStartBtn, 1000);
}

/* Убрать из лобби приглашённого, который не зашёл: у него пропадёт приглашение,
   а список перестанет ждать лишнего человека. */
async function kickFromLobby(uid, nick) {
  const mid = state.currentMatchId;
  if (!mid) return;
  if (!await showConfirm(`Убрать ${nick} из матча?`, 'Убрать', '🚪')) return;
  await db.ref('matches/' + mid).transaction(m => {
    if (!m || m.status !== 'lobby') return m;
    if (m.creatorId !== state.userId) return;
    const p = m.players && m.players[uid];
    if (!p || p.status === 'joined') return;   // зашедшего уже не выставляем
    delete m.players[uid];
    return m;
  });
  await db.ref().update({
    ['invites/' + uid + '/' + mid]: null,
    ['userMatches/' + uid + '/' + mid]: null
  });
}

// Состояние кнопки «Начать»: гейт по времени старта + «начать с теми, кто есть»
function refreshStartBtn() {
  const m = lobbyMatch;
  if (!m) return;
  const startBtn = $('#start-btn');
  if (m.creatorId !== state.userId) { startBtn.style.display = 'none'; return; }
  startBtn.style.display = 'block';

  const players = Object.entries(m.players || {});
  const joinedOthers = players.filter(([uid, p]) => uid !== m.creatorId && p.status === 'joined').length;
  const someWaiting  = players.some(([uid, p]) => uid !== m.creatorId && p.status === 'waiting');
  const now = serverNow();
  const scheduled = m.startAt && now < m.startAt;

  if (joinedOthers < 1) { startBtn.disabled = true; startBtn.textContent = 'Ждём игроков...'; return; }
  if (scheduled) {
    startBtn.disabled = true;
    startBtn.textContent = `Старт через ${fmtCountdown(Math.ceil((m.startAt - now) / 1000))}`;
    return;
  }
  startBtn.disabled = false;
  startBtn.textContent = someWaiting ? 'Начать с теми, кто есть' : 'Начать матч';
}

function stopLobbyTimer() {
  if (lobbyIntervalId) { clearInterval(lobbyIntervalId); lobbyIntervalId = null; }
  lobbyMatch = null;
  stopLobbyPresence();
}

/* Кто из приглашённых сейчас в сети. Слушаем по одному флагу на игрока,
   а не весь узел users — в лобби людей единицы. */
function stopLobbyPresence() {
  Object.values(presenceRefs).forEach(r => r.off());
  presenceRefs = {};
  presenceOnline = {};
}

function watchLobbyPresence(uids) {
  // Отписываемся от тех, кого в матче уже нет
  Object.keys(presenceRefs).forEach(uid => {
    if (uids.indexOf(uid) === -1) { presenceRefs[uid].off(); delete presenceRefs[uid]; delete presenceOnline[uid]; }
  });
  uids.forEach(uid => {
    if (presenceRefs[uid]) return;
    const ref = db.ref('users/' + uid + '/online');
    presenceRefs[uid] = ref;
    ref.on('value', snap => {
      presenceOnline[uid] = !!snap.val();
      const dot = document.querySelector('.lobby-row[data-uid="' + uid + '"] .status-dot');
      if (dot) dot.classList.toggle('online', presenceOnline[uid]);
    });
  });
}

async function startMatch() {
  const mid = state.currentMatchId;
  let started = false;

  const res = await db.ref('matches/' + mid).transaction(m => {
    started = false;
    if (!m || m.status !== 'lobby') return m;
    if (m.startAt && serverNow() < m.startAt) return m;   // ещё не наступило время старта

    // Стартуем с теми, кто уже присоединился (создатель + минимум 1 игрок)
    const joined = Object.entries(m.players || {})
      .filter(([, p]) => p.status === 'joined')
      .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
    if (joined.length < 2) return m;

    m.turnOrder = joined.map(([uid]) => uid);
    m.currentTurnIndex = 0;
    m.status = 'active';
    m.turnStartedAt = serverNow();
    // Часы матча «на время» тикают от реального старта, а не от создания
    if (m.goalType === 'timed' && m.durationMin) m.endsAt = serverNow() + m.durationMin * 60000;
    // «Ожидающих» НЕ отклоняем и приглашения НЕ удаляем — они смогут
    // присоединиться к уже идущему матчу позже (поздний вход).
    started = true;
    return m;
  });

  if (started && res.committed && res.snapshot.exists()) {
    db.ref('matches/' + mid + '/events').push({ time: serverNow(), userId: '', action: 'start', text: '🏀 Матч начался!' });
  }
}

// Выход из ЛОББИ (до старта): создатель отменяет матч, остальные — просто уходят.
async function leaveLobby() {
  const mid = state.currentMatchId;
  const snap = await db.ref('matches/' + mid).get();
  const m = snap.val();
  // Создатель просто выходит — матч остаётся сохранённым в «Мои матчи»
  // (оттуда можно вернуться, изменить или удалить). Приглашённый — отмечает выход.
  if (m && m.creatorId !== state.userId) {
    await db.ref('matches/' + mid + '/players/' + state.userId + '/status').set('declined');
  }
  goMenu();
}

/* ================================================================
   ЭКРАН 5 — МАТЧ
   ================================================================ */
function medal(place) {
  return place === 1 ? '🥇' : place === 2 ? '🥈' : place === 3 ? '🥉' : '#' + place;
}

function renderMatch(m) {
  showScreen('screen-match');
  stopLobbyTimer();
  ensureNet();
  buildReactionsRow();
  lastRenderedMatch = m;
  const order = m.turnOrder || [];
  const activeId = order[m.currentTurnIndex];
  const isMyTurn = activeId === state.userId;
  const isCreator = m.creatorId === state.userId;
  const isCommon = m.goalType === 'common';
  const zones = isZones(m);
  const scorer = effectiveScorer(m);   // при выходе создателя откатывается на 'shooter'
  const iAmScorer = scorer === 'creator' ? isCreator : isMyTurn;

  // Кто бросает
  const activeNick = (m.players[activeId] || {}).nickname || '—';
  const turnEl = $('#match-turn');
  if (scorer === 'creator' && isCreator) {
    turnEl.innerHTML = `Отметь: <b>${escapeHtml(activeNick)}</b>`; turnEl.classList.remove('my');
  } else if (isMyTurn) {
    turnEl.innerHTML = 'Твой бросок'; turnEl.classList.add('my');
  } else {
    turnEl.innerHTML = `Бросает <b>${escapeHtml(activeNick)}</b>`; turnEl.classList.remove('my');
  }

  // Очередь только что дошла до меня — подсказываем, даже если вкладка свёрнута
  if (isMyTurn && !m.pausedAt && prevTurnUid !== state.userId) { Haptics.turn(); Notify.turn(m.name); }
  prevTurnUid = activeId;

  setupTurnTimer(m);
  setupMatchClock(m);

  const boardName = m.name || 'ТАБЛО';
  let goalTxt;
  if (isCommon)                    goalTxt = `ДО ${m.targetHits}` + (zones ? ' ОЧКОВ' : '');
  else if (m.goalType === 'timed') goalTxt = `${m.durationMin} МИН`;
  else                             goalTxt = 'СВОБОДНЫЙ';
  $('#match-target').textContent = `${boardName} · ${goalTxt}`;
  $('#match-score-head').textContent = zones ? 'ОЧКИ' : 'ПОПАЛ';

  // Рейтинг-таблица: сортировка по очкам
  const rows = order.map(uid => ({ uid, p: m.players[uid] })).filter(x => x.p)
    .sort((a, b) => cmpPlayers(a.p, b.p));
  const leadUid = rows.length && ptsOf(rows[0].p) > 0 ? rows[0].uid : null;

  const tb = $('#match-players');
  tb.innerHTML = '';
  rows.forEach((x, i) => {
    const p = x.p, uid = x.uid;
    const active = uid === activeId && !p.finished && !p.left;
    const done = p.finished || p.left;
    let badge = '';
    if (p.left)          badge = '<span class="mb left">вышел</span>';
    else if (p.finished) badge = `<span class="mb done">готово${p.place ? ' · ' + p.place + ' место' : ''}</span>`;
    else if (active)     badge = '<span class="mb turn">бросает</span>';
    else if (uid === leadUid) badge = '<span class="mb lead">лидер</span>';
    const color = colorOf(p);
    const strk = (!done && p.streak > 1) ? `<b class="fire">${p.streak}</b>` : (p.streak || 0);
    // Колонка очков залита градиентом с обрезкой по тексту, поэтому мелкие
    // подписи туда не кладём — они бы перекрасились. Попадания идут под ником.
    const hitsNote = zones ? `<span class="acc">${p.hits || 0} поп.</span>` : '';
    const row = document.createElement('div');
    row.className = 'trow' + (active ? ' active' : '') + (i === 0 ? ' top1' : '') + (done ? ' done' : '');
    row.innerHTML = `
      <div class="rank">#${i + 1}</div>
      <div class="who">
        <div class="ava" style="--ring:${color};--glow:${hexA(color, active ? .7 : .26)};background:${hexA(color, .16)}">${faceOf(p)}</div>
        <div class="nm">
          <div class="name">${escapeHtml(p.nickname)}</div>
          <div class="sub-line">${badge}<span class="acc">${accuracy(p.hits, p.misses)}%</span>${hitsNote}</div>
        </div>
      </div>
      <div class="hits" id="mh-${uid}">${ptsOf(p)}</div>
      <div class="strk">${strk}</div>`;
    tb.appendChild(row);
  });

  // --- Лента «Ход матча»: только 10 последних (полный лог — в истории матчей) ---
  const events = m.events ? Object.values(m.events) : [];
  events.sort((a, b) => (a.time || 0) - (b.time || 0)); // от старых к новым

  const feed = $('#match-events-feed');
  if (feed) {
    feed.innerHTML = '';
    events.slice(-10).forEach(ev => {
      const el = document.createElement('div');
      el.className = 'event-item ' + (ev.action || '');
      el.textContent = ev.text || '';
      feed.appendChild(el);
    });
    feed.scrollTop = feed.scrollHeight; // автоскролл к последнему
  }

  // Фидбек (звук + анимация) на КАЖДОЕ новое событие с прошлого рендера.
  // Важно для победного броска: в одной транзакции пишутся hit + finish,
  // поэтому надо проиграть оба, а не только самое последнее событие.
  const newest = events[events.length - 1];
  if (lastEventTime === null) {
    // Первый рендер: запоминаем отметку, чтобы не переигрывать уже случившееся
    lastEventTime = newest ? (newest.time || 0) : 0;
  } else {
    events.filter(ev => (ev.time || 0) > lastEventTime).forEach(triggerShotFeedback);
    if (newest) lastEventTime = Math.max(lastEventTime, newest.time || 0);
  }

  // --- Реакции игроков: показываем только то, что прилетело после прошлого рендера ---
  const rx = m.reactions ? Object.values(m.reactions).sort((a, b) => (a.time || 0) - (b.time || 0)) : [];
  const newestRx = rx[rx.length - 1];
  if (lastReactionTime === null) {
    lastReactionTime = newestRx ? (newestRx.time || 0) : 0;
  } else {
    rx.filter(r => (r.time || 0) > lastReactionTime).forEach(flyReaction);
    if (newestRx) lastReactionTime = Math.max(lastReactionTime, newestRx.time || 0);
  }

  // Кнопки броска — только тому, кто вправе отмечать
  const activePlayer = m.players[activeId];
  const paused = !!m.pausedAt;
  const canShoot = iAmScorer && !paused && activePlayer && !activePlayer.finished && !activePlayer.left;
  $('#paused-banner').hidden = !paused;
  $('#screen-match').classList.toggle('is-paused', paused);
  const pauseBtn = $('#pause-btn');
  pauseBtn.hidden = !isCreator;
  pauseBtn.classList.toggle('on', paused);
  pauseBtn.title = paused ? 'Продолжить' : 'Пауза';
  $('#zones-bar').hidden = !zones;
  $('#btn-hit').hidden = zones;                 // в зонах роль «Попал» играют кнопки +1/+2/+3
  $('#btn-hit').disabled = !canShoot;
  $('#btn-miss').disabled = !canShoot;
  $$('#zones-bar .zone').forEach(b => { b.disabled = !canShoot; });
  $('#finish-btn').hidden = !isCreator;         // ⏹ Завершить — только создателю; ⏸ Выйти — всем
  $('#undo-btn').hidden = paused || !canUndo(m);
  $$('.rx-btn').forEach(b => { b.disabled = paused; });
}

/* Записать бросок — в транзакции (защита от гонок).
   points: сколько очков стоит попадание (1 в простом режиме, 1/2/3 — в зонах). */
function recordShot(result, points) {
  const mid = state.currentMatchId;
  if (!mid) return;
  const ref = db.ref('matches/' + mid);
  const now = serverNow();

  // Кого мы ВИДЕЛИ активным в момент клика. Если пока транзакция летит на
  // сервер, ход уже сменится (например, гонка с авто-промахом по таймеру),
  // бросок НЕ должен уйти следующему игроку — лучше честно отменить и
  // сообщить, чем молча записать очко не тому.
  const expectedOrder = (lastRenderedMatch && lastRenderedMatch.turnOrder) || [];
  const expectedIdx = lastRenderedMatch ? lastRenderedMatch.currentTurnIndex : -1;
  const expectedUid = expectedOrder[expectedIdx];

  let raced = false;   // ход сменился под ногами — транзакция намеренно отменена
  let expired = false; // в матче «на время» время вышло, пока клик летел
  let paused = false;  // создатель поставил паузу, пока клик летел

  const p1 = ref.transaction(m => {
    raced = false; expired = false; paused = false;
    if (!m || m.status !== 'active') return m;
    if (m.pausedAt) { paused = true; return m; }

    // Матч «на время»: срок вышел — бросок не засчитываем, закрываем матч
    if (m.endsAt && now >= m.endsAt) { expired = true; return closeMatch(m, now); }

    // Чей сейчас ход
    const order = m.turnOrder || [];
    const activeUid = order[m.currentTurnIndex];

    // Ход уже перешёл к другому игроку, пока клик долетал до сервера — отменяем.
    if (expectedUid && activeUid !== expectedUid) { raced = true; return; }

    // Кто вправе отметить бросок:
    //  scorer='creator' — только создатель матча (за активного игрока);
    //  scorer='shooter' — сам активный игрок (по умолчанию).
    // Если создатель вышел — effectiveScorer вернёт 'shooter' (фолбэк).
    const scorer = effectiveScorer(m);
    const allowed = scorer === 'creator' ? (m.creatorId === state.userId) : (activeUid === state.userId);
    if (!allowed) return;

    const p = m.players[activeUid];
    if (!p || p.finished || p.left) return;
    if (!m.events) m.events = {};

    // Снимок для отмены: по нему undoShot() возвращает всё как было
    const snap = {
      uid: activeUid, by: state.userId, action: result, time: now,
      prevStreak: p.streak || 0, prevTurnIndex: m.currentTurnIndex,
      prevTurnStartedAt: m.turnStartedAt || null, keys: []
    };

    let advance = false;
    const k1 = db.ref().push().key;
    snap.keys.push(k1);

    if (result === 'hit') {
      const gain = isZones(m) ? Math.max(1, Math.min(3, points || 1)) : 1;
      p.hits   = (p.hits || 0) + 1;
      p.points = (p.points != null ? p.points : (p.hits - 1)) + gain;
      p.streak = (p.streak || 0) + 1;
      p.best   = Math.max(p.best || 0, p.streak);
      snap.points = gain;

      const zoneTag = isZones(m) ? ` (+${gain})` : '';
      m.events[k1] = { time: now, userId: activeUid, action: 'hit', points: gain,
        text: `${p.nickname} попал${zoneTag}${p.streak > 1 ? ' — ' + p.streak + ' подряд' : ''}` };

      if (m.goalType === 'common' && m.targetHits && ptsOf(p) >= m.targetHits) {
        p.finished = true;
        const finishedCount = Object.values(m.players).filter(x => x.finished).length;
        p.place = finishedCount;
        snap.finished = true;

        const k2 = db.ref().push().key;
        snap.keys.push(k2);
        m.events[k2] = { time: now + 1, userId: activeUid, action: 'finish',
          text: `🏁 ${p.nickname} достиг цели — место #${finishedCount}` };
        advance = true;
      }
    } else {
      p.misses = (p.misses || 0) + 1;
      p.streak = 0;
      snap.points = 0;
      m.events[k1] = { time: now, userId: activeUid, action: 'miss', text: `${p.nickname} промахнулся` };
      advance = true;
    }

    m.lastShot = snap;

    if (advance) {
      const next = findNextTurn(m, m.currentTurnIndex);
      if (next === -1) return closeMatch(m, now);
      m.currentTurnIndex = next;
    }
    // Сброс отсчёта хода на каждый бросок (и когда попал и продолжает, и при передаче хода)
    if (m.status === 'active') m.turnStartedAt = serverNow();
    return m;
  });

  p1.then(res => {
    if (paused)  { popMatch('Матч на паузе', 'warn'); return; }
    if (expired) { popMatch('Время вышло', 'warn'); return; }
    if (raced || !res.committed) popMatch('Ход сменился', 'warn');
  }).catch(() => { popMatch('Не отправилось', 'warn'); });
}

/* Общее закрытие матча: и по достижению цели, и по таймеру, и вручную */
function closeMatch(m, now) {
  m.status = 'finished';
  m.winnerId = computeWinner(m);
  m.finishedAt = now || serverNow();
  m.lastShot = null;
  return m;
}

/* ---------- Отмена последнего броска ---------- */
/* Промахнулся мимо кнопки — обычное дело, когда телефон лежит на скамейке.
   Отменить можно только свою последнюю отметку и только пока матч идёт. */
const UNDO_WINDOW_MS = 25000;

// Можно ли прямо сейчас показать кнопку «Отменить»
function canUndo(m) {
  const ls = m && m.lastShot;
  if (!ls || m.status !== 'active') return false;
  if (ls.by !== state.userId) return false;
  return serverNow() - (ls.time || 0) < UNDO_WINDOW_MS;
}

async function undoShot() {
  const mid = state.currentMatchId;
  if (!mid) return;
  let reason = '';

  const res = await db.ref('matches/' + mid).transaction(m => {
    reason = '';
    if (!m || m.status !== 'active') { reason = 'Матч уже завершён'; return m; }
    const ls = m.lastShot;
    if (!ls)                         { reason = 'Нечего отменять';   return m; }
    if (ls.by !== state.userId)      { reason = 'Отметил не ты';     return m; }
    if (serverNow() - (ls.time || 0) >= UNDO_WINDOW_MS) { reason = 'Уже поздно отменять'; return m; }

    const p = m.players[ls.uid];
    if (!p) { reason = 'Игрока больше нет'; return m; }

    // Возвращаем счёт игрока
    if (ls.action === 'hit') {
      p.hits   = Math.max(0, (p.hits || 0) - 1);
      p.points = Math.max(0, ptsOf(p) - (ls.points || 1));
    } else {
      p.misses = Math.max(0, (p.misses || 0) - 1);
    }
    p.streak = ls.prevStreak || 0;
    // Если этим броском игрок закрыл цель — снимаем финиш и освобождаем место
    if (ls.finished) { p.finished = false; p.place = null; }

    // Убираем записи брошенных событий из ленты
    if (m.events) (ls.keys || []).forEach(k => { delete m.events[k]; });

    // Возвращаем очередь тому, кто бросал
    m.currentTurnIndex = ls.prevTurnIndex != null ? ls.prevTurnIndex : m.currentTurnIndex;
    m.turnStartedAt = serverNow();

    if (!m.events) m.events = {};
    const k = db.ref().push().key;
    m.events[k] = { time: serverNow(), userId: ls.uid, action: 'undo',
      text: `↶ Бросок отменён — снова бросает ${p.nickname}` };

    m.lastShot = null;
    return m;
  });

  if (reason) popMatch(reason, 'warn');
  else if (res.committed) { Sound.click(); Haptics.tap(); }
}

/* ---------- Пауза ---------- */
/* Игра идёт вживую: мяч укатился, кто-то отошёл. На паузе замирают и таймер
   хода, и часы матча — при снятии оба сдвигаются на длительность простоя,
   чтобы никто не потерял свои секунды. */
async function togglePause() {
  const mid = state.currentMatchId;
  if (!mid) return;
  await db.ref('matches/' + mid).transaction(m => {
    if (!m || m.status !== 'active') return m;
    if (m.creatorId !== state.userId) return;      // паузу ставит только создатель
    if (!m.events) m.events = {};
    const k = db.ref().push().key;

    if (m.pausedAt) {
      const delta = serverNow() - m.pausedAt;
      if (m.turnStartedAt) m.turnStartedAt += delta;
      if (m.endsAt)        m.endsAt += delta;
      m.pausedAt = null;
      m.events[k] = { time: serverNow(), userId: state.userId, action: 'start', text: '▶️ Игра продолжается' };
    } else {
      m.pausedAt = serverNow();
      m.events[k] = { time: serverNow(), userId: state.userId, action: 'leave', text: '⏸ Матч поставлен на паузу' };
    }
    return m;
  });
}

/* ---------- Матч «на время» ---------- */
/* Время может выйти, когда никто не бросает, поэтому каждый клиент тикает сам
   и первый заметивший закрывает матч транзакцией. Остальные её не продублируют:
   статус уже будет finished. */
function stopMatchClock() {
  if (clockIntervalId) { clearInterval(clockIntervalId); clockIntervalId = null; }
}

function setupMatchClock(m) {
  const wrap = $('#match-clock');
  if (!wrap) return;
  if (m.status !== 'active' || !m.endsAt) { stopMatchClock(); wrap.hidden = true; return; }
  if (m.pausedAt) { stopMatchClock(); return; }   // на паузе часы замирают на месте
  wrap.hidden = false;

  const mid = state.currentMatchId, endsAt = m.endsAt;
  const num = $('#match-clock-num');
  const tick = () => {
    const rem = Math.max(0, Math.ceil((endsAt - serverNow()) / 1000));
    if (num) num.textContent = Math.floor(rem / 60) + ':' + String(rem % 60).padStart(2, '0');
    wrap.classList.toggle('low', rem <= 30);
    if (rem <= 0) { stopMatchClock(); expireMatch(mid, endsAt); }
  };
  stopMatchClock();
  tick();
  clockIntervalId = setInterval(tick, 500);
}

function expireMatch(mid, expectedEndsAt) {
  db.ref('matches/' + mid).transaction(m => {
    if (!m || m.status !== 'active' || m.pausedAt) return m;
    if (m.endsAt !== expectedEndsAt) return m;       // матч успели изменить
    if (serverNow() < m.endsAt) return m;            // страховка от рассинхрона часов
    if (!m.events) m.events = {};
    const k = db.ref().push().key;
    m.events[k] = { time: serverNow(), userId: '', action: 'finish', text: '⏳ Время вышло — матч окончен' };
    return closeMatch(m, serverNow());
  });
}

/* ---------- Быстрые реакции ---------- */
const REACTIONS = ['🔥', '👏', '😂', '😱', '💪', '🧊'];
const REACTIONS_KEEP = 24;   // сколько последних держим в матче, чтобы узел не разрастался

function sendReaction(emoji) {
  const mid = state.currentMatchId;
  if (!mid || REACTIONS.indexOf(emoji) === -1) return;
  Haptics.tap();
  db.ref('matches/' + mid + '/reactions').transaction(r => {
    r = r || {};
    const k = db.ref().push().key;
    r[k] = { emoji, userId: state.userId, nickname: state.nickname, time: serverNow() };
    // Оставляем только последние — иначе за длинный матч накопятся сотни записей
    const keys = Object.keys(r).sort((a, b) => (r[a].time || 0) - (r[b].time || 0));
    while (keys.length > REACTIONS_KEEP) delete r[keys.shift()];
    return r;
  });
}

// Пролетающая эмодзи-реакция
function flyReaction(rx) {
  const layer = $('#reaction-layer');
  if (!layer) return;
  const el = document.createElement('div');
  el.className = 'rx';
  el.style.left = (12 + Math.random() * 64) + '%';
  el.style.setProperty('--drift', (Math.random() * 60 - 30).toFixed(0) + 'px');
  el.innerHTML = `<span class="rx-em">${escapeHtml(rx.emoji)}</span><span class="rx-who">${escapeHtml(rx.nickname || '')}</span>`;
  layer.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

function buildReactionsRow() {
  const row = $('#reactions-row');
  if (!row || row.childElementCount) return;
  REACTIONS.forEach(em => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'rx-btn';
    b.textContent = em;
    b.addEventListener('click', () => sendReaction(em));
    row.appendChild(b);
  });
}

// Фактический режим отметки: если выбран 'creator', но создатель вышел из матча —
// отмечать может сам бросающий, чтобы игра не зависла.
function effectiveScorer(m) {
  const scorer = m.scorer || 'shooter';
  if (scorer === 'creator') {
    const c = m.players[m.creatorId];
    if (!c || c.left) return 'shooter';
  }
  return scorer;
}

// Следующий играющий (не finished / не left) по кругу; -1 если таких нет
function findNextTurn(m, from) {
  const order = m.turnOrder || [];
  const n = order.length;
  for (let s = 1; s <= n; s++) {
    const idx = (from + s) % n;
    const p = m.players[order[idx]];
    if (p && !p.finished && !p.left) return idx;
  }
  return -1;
}

/* ---------- Таймер на ход ---------- */
function stopTurnTimer() {
  if (timerState.intervalId) { clearInterval(timerState.intervalId); timerState.intervalId = null; }
}

function setupTurnTimer(m) {
  const wrap = $('#turn-timer');
  const on = m.status === 'active' && !m.pausedAt && m.turnSeconds > 0 && m.turnStartedAt;
  if (!on) { stopTurnTimer(); if (wrap) wrap.hidden = true; timerState.startedAt = null; return; }
  wrap.hidden = false;

  // Уже тикаем для этого хода — не перезапускаем
  if (timerState.startedAt === m.turnStartedAt && (timerState.intervalId || timerState.firedAt === m.turnStartedAt)) return;

  stopTurnTimer();
  timerState.startedAt = m.turnStartedAt;
  const seconds = m.turnSeconds, mid = state.currentMatchId, startedAt = m.turnStartedAt;
  const bar = $('#turn-timer-bar'), num = $('#turn-timer-num');

  const tick = () => {
    const rem = seconds - (serverNow() - startedAt) / 1000;
    const pct = Math.max(0, Math.min(100, (rem / seconds) * 100));
    if (bar) bar.style.width = pct + '%';
    if (num) num.textContent = String(Math.max(0, Math.ceil(rem)));
    wrap.classList.toggle('low', rem <= 5);
    // Предупреждаем за 5 секунд — но один раз за ход и только того, кто бросает
    if (rem <= 5 && rem > 0 && timerState.warnedAt !== startedAt) {
      timerState.warnedAt = startedAt;
      const activeUid = (lastRenderedMatch && (lastRenderedMatch.turnOrder || [])[lastRenderedMatch.currentTurnIndex]);
      if (activeUid === state.userId) { Sound.tick(); Haptics.tap(); }
    }
    // Небольшой зазор (300мс) после нуля — даём шанс уже отправленному клику
    // «Попал/Промах» дойти до сервера первым, прежде чем сработает авто-промах.
    if (rem <= -0.3) {
      stopTurnTimer();
      if (timerState.firedAt !== startedAt) { timerState.firedAt = startedAt; expireTurn(mid, startedAt, seconds); }
    }
  };
  tick();
  if (timerState.firedAt !== startedAt) timerState.intervalId = setInterval(tick, 200);
}

// Время хода вышло → авто-промах активному игроку (защищено по turnStartedAt, срабатывает один раз)
function expireTurn(mid, expectedStartedAt, seconds) {
  db.ref('matches/' + mid).transaction(m => {
    if (!m || m.status !== 'active' || m.pausedAt) return m;
    if (m.turnStartedAt !== expectedStartedAt) return m;                 // ход уже сменился
    if ((serverNow() - m.turnStartedAt) < seconds * 1000 - 400) return m; // ещё не истёк (страховка от рассинхрона)

    const order = m.turnOrder || [];
    const activeUid = order[m.currentTurnIndex];
    const p = m.players[activeUid];
    if (!p || p.finished || p.left) return m;

    p.misses = (p.misses || 0) + 1;
    p.streak = 0;
    if (!m.events) m.events = {};
    const k = db.ref().push().key;
    m.events[k] = { time: serverNow(), userId: activeUid, action: 'miss', text: `${p.nickname} не успел — промах` };

    m.lastShot = null;   // авто-промах отменять нельзя — отменять нечего было
    const next = findNextTurn(m, m.currentTurnIndex);
    if (next === -1) return closeMatch(m, serverNow());
    m.currentTurnIndex = next; m.turnStartedAt = serverNow();
    return m;
  });
}

function winnerByPlace(m) {
  for (const [uid, p] of Object.entries(m.players)) if (p.place === 1) return uid;
  return null;
}

// Победитель: место #1, иначе лучший счёт среди участников
function computeWinner(m) {
  const byPlace = winnerByPlace(m);
  if (byPlace) return byPlace;

  const order = m.turnOrder || Object.keys(m.players);
  // Вышедшие из матча в борьбе за победу не участвуют
  const live = order.map(uid => ({ uid, p: m.players[uid] })).filter(x => x.p && !x.p.left);
  if (!live.length) return null;

  live.sort((a, b) => cmpPlayers(a.p, b.p));
  // Если лучших двое с абсолютно одинаковым счётом — это ничья (баннер «Ничья»)
  if (live.length > 1 && cmpPlayers(live[0].p, live[1].p) === 0) return null;
  return live[0].uid;
}

/* Завершить матч вручную (создатель) */
async function finishMatch() {
  const mid = state.currentMatchId;
  if (!mid) return;
  if (!await showConfirm('Завершить матч для всех? Счёт зафиксируется как есть.', 'Завершить', '🏁')) return;
  await db.ref('matches/' + mid).transaction(m => {
    if (!m || m.status === 'finished') return m;
    return closeMatch(m, serverNow());
  });
}

/* Выйти из матча, НЕ завершая его для остальных */
async function leaveMatch() {
  if (!await showConfirm('Выйти из матча? Матч продолжится без тебя.', 'Выйти', '🚪')) return;
  const mid = state.currentMatchId;
  const myId = state.userId;

  const res = await db.ref('matches/' + mid).transaction(m => {
    if (!m) return m;
    const p = m.players[myId];
    if (!p) return m;
    p.left = true;
    if (p.status === 'joined') p.status = 'left';

    if (m.status === 'active') {
      const order = m.turnOrder || [];
      const wasActive = order[m.currentTurnIndex] === myId;
      const playing = order.filter(uid => {
        const pl = m.players[uid];
        return pl && !pl.finished && !pl.left;
      }).length;
      if (playing <= 1) return closeMatch(m, serverNow());
      if (wasActive) {
        const next = findNextTurn(m, m.currentTurnIndex);
        if (next !== -1) { m.currentTurnIndex = next; m.turnStartedAt = serverNow(); }
      }
    }
    return m;
  });

  if (res.committed && res.snapshot && res.snapshot.exists()) {
    const m = res.snapshot.val();
    db.ref('matches/' + mid + '/events').push({
      time: serverNow(), userId: myId, action: 'leave', text: `${state.nickname} вышел из матча`
    });
    // Финализируем (статистика + история), ТОЛЬКО если матч из-за выхода завершился.
    // Иначе матч продолжается и остаётся в «Мои матчи» — можно вернуться.
    if (m.status === 'finished') await finalizePlayer(mid, myId, m);
  }

  stopMatchWatch();
  localStorage.removeItem(LS.activeMatch);
  state.currentMatchId = null;
  goMenu();
}

/* ================================================================
   ЭКРАН 6 — РЕЗУЛЬТАТЫ
   ================================================================ */
function renderResults(m) {
  showScreen('screen-results');
  stopTurnTimer();
  stopLobbyTimer();
  stopMatchClock();
  Notify.stopTitle();
  lastFinishedMatch = m;
  $('#results-title').textContent = m.name ? 'Итоги · ' + m.name : 'Итоги матча';
  const zones = isZones(m);
  const order = m.turnOrder || Object.keys(m.players).filter(uid => m.players[uid].status === 'joined');

  const ranked = order.map(uid => ({ uid, p: m.players[uid] })).filter(x => x.p);
  ranked.sort((a, b) => cmpFinal(a.p, b.p));

  const winner = m.players[m.winnerId];
  const unit = zones ? 'очков' : 'попаданий';
  if (m.solo) {
    const me = m.players[state.userId] || {};
    $('#results-title').textContent = 'Итоги тренировки';
    $('#results-winner').innerHTML = `
      <div class="cup">🎯</div>
      <div class="mini-av w-avatar" style="${avatarBg(colorOf(me))}">${faceOf(me)}</div>
      <div class="w-name">${ptsOf(me)} ${unit}</div>
      <div class="w-sub">${me.hits || 0} из ${(me.hits || 0) + (me.misses || 0)} бросков · точность ${accuracy(me.hits, me.misses)}% · лучшая серия ${me.best || 0}</div>`;
  } else $('#results-winner').innerHTML = winner ? `
    <div class="cup">🏆</div>
    <div class="mini-av w-avatar" style="${avatarBg(colorOf(winner))}">${faceOf(winner)}</div>
    <div class="w-name">${escapeHtml(winner.nickname)}</div>
    <div class="w-sub">${ptsOf(winner)} ${unit} · точность ${accuracy(winner.hits, winner.misses)}%</div>
  ` : '<div class="cup">🏀</div><div class="w-name">Ничья</div>';

  const list = $('#results-list');
  list.innerHTML = '';
  ranked.forEach((x, i) => {
    const leftTag = x.p.left ? ' <span class="tag-left">(вышел)</span>' : '';
    // В зонах очки и попадания — разные числа, показываем оба
    const score = zones
      ? `<b>${ptsOf(x.p)}</b> очк · ${x.p.hits || 0}/${x.p.misses || 0}`
      : `<b>${x.p.hits || 0}</b> / ${x.p.misses || 0}`;
    const row = document.createElement('div');
    row.className = 'result-row' + (i === 0 && !x.p.left ? ' first' : '');
    row.innerHTML = `
      <div class="rank">${i + 1}</div>
      ${miniAvatar(x.p, true)}
      <div class="r-name">${escapeHtml(x.p.nickname)}${leftTag}</div>
      <div class="r-score">${score} · ${accuracy(x.p.hits, x.p.misses)}%${x.p.best > 1 ? ' · 🔥' + x.p.best : ''}</div>`;
    list.appendChild(row);
  });

  // Реванш зовём только тех, кто реально играл (не отклонивших приглашение)
  const playedOthers = order.filter(uid => uid !== state.userId && m.players[uid]).length;
  $('#results-rematch-btn').hidden = m.solo || playedOthers < 1;

  // Конфетти + звук — один раз на матч
  if (confettiFor !== state.currentMatchId) {
    confettiFor = state.currentMatchId;
    if (m.solo) { Sound.finish(); }
    else {
      if (winner) launchConfetti();
      if (m.winnerId === state.userId) { Sound.win(); Haptics.win(); }
      else Sound.lose();
    }
  }
}

/* ---------- Реванш: новый матч тем же составом и с теми же настройками ---------- */
async function startRematch() {
  const m = lastFinishedMatch;
  if (!m) return;
  const others = (m.turnOrder || Object.keys(m.players)).filter(uid => uid !== state.userId && m.players[uid]);
  if (!others.length) { showAlert('Некого звать на реванш', '👥'); return; }
  if (!await showConfirm(`Позвать всех на реванш? Настройки матча сохранятся.`, 'Зовём', '🔁')) return;

  const matchId = db.ref('matches').push().key;
  const baseName = (m.name || 'Матч').replace(/\s*·\s*реванш\s*\d*$/i, '');
  const matchName = baseName + ' · реванш';

  const blank = uid => {
    const src = m.players[uid] || {};
    return {
      nickname: src.nickname, avatar: src.avatar || null, color: src.color || null, photo: src.photo || null,
      status: uid === state.userId ? 'joined' : 'waiting',
      hits: 0, misses: 0, points: 0, streak: 0, best: 0,
      joinedAt: uid === state.userId ? TS : null
    };
  };
  const players = {};
  players[state.userId] = blank(state.userId);
  // Свои аватар и ник могли поменяться с прошлого матча — берём актуальные
  players[state.userId].nickname = state.nickname;
  players[state.userId].avatar = state.avatar || null;
  players[state.userId].color = state.color || null;
  players[state.userId].photo = state.photo || null;
  others.forEach(uid => { players[uid] = blank(uid); });

  await db.ref('matches/' + matchId).set({
    creatorId: state.userId,
    name: matchName,
    startAt: null,
    type: 'normal',
    shotMode: m.shotMode || 'simple',
    goalType: m.goalType,
    targetHits: m.targetHits || null,
    durationMin: m.durationMin || null,
    endsAt: null,
    scorer: m.scorer || 'shooter',
    turnSeconds: m.turnSeconds || 0,
    turnStartedAt: null,
    status: 'lobby',
    players,
    currentTurnIndex: 0,
    rematchOf: state.currentMatchId || null,
    createdAt: TS
  });

  const updates = {};
  Object.keys(players).forEach(uid => { updates['userMatches/' + uid + '/' + matchId] = true; });
  others.forEach(uid => {
    updates['invites/' + uid + '/' + matchId] = {
      name: matchName, startAt: null,
      creatorNickname: state.nickname, creatorAvatar: state.avatar || null,
      creatorColor: state.color || null, creatorPhoto: state.photo || null,
      goalType: m.goalType, shotMode: m.shotMode || 'simple', timestamp: TS
    };
  });
  await db.ref().update(updates);

  enterMatch(matchId);
}

/* ---------- Поделиться итогом матча ---------- */
async function shareResults() {
  const m = lastFinishedMatch;
  if (!m) return;
  const zones = isZones(m);
  const order = m.turnOrder || Object.keys(m.players);
  const ranked = order.map(uid => m.players[uid]).filter(Boolean).sort(cmpFinal);

  const lines = ranked.map((p, i) => {
    const place = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : (i + 1) + '.';
    return `${place} ${p.nickname} — ${ptsOf(p)}${zones ? ' очк' : ''} (${accuracy(p.hits, p.misses)}%)`;
  });
  const text = `🏀 ${m.name || 'Матч'}\n` + lines.join('\n');

  try {
    if (navigator.share) { await navigator.share({ title: 'Итоги матча', text }); return; }
    await navigator.clipboard.writeText(text);
    showAlert('Итоги скопированы — вставляй куда нужно', '📋');
  } catch (e) {
    // Отмена в системном окне «Поделиться» — это не ошибка, молчим
    if (e && e.name === 'AbortError') return;
    showAlert('Не получилось поделиться', '⚠️');
  }
}

/* ================================================================
   ФИНАЛИЗАЦИЯ — статистика + запись в историю (один раз на игрока)
   ================================================================ */
async function finalizePlayer(mid, uid, m) {
  const res = await db.ref('matches/' + mid + '/players/' + uid + '/counted')
    .transaction(cur => (cur ? undefined : true));
  if (!res.committed) return; // уже засчитано другим клиентом
  const p = m.players[uid];
  if (!p) return;

  // 1. Общая статистика игрока
  const solo = !!m.solo;
  const won = !solo && m.winnerId === uid && !p.left;
  db.ref('users/' + uid + '/stats').transaction(s => {
    s = s || {};
    s.matches = (s.matches || 0) + 1;
    s.hits    = (s.hits || 0) + (p.hits || 0);
    s.misses  = (s.misses || 0) + (p.misses || 0);
    s.points  = (s.points || 0) + ptsOf(p);
    s.best    = Math.max(s.best || 0, p.best || 0);
    // Тренировка сам с собой не даёт ни побед, ни поражений — иначе их
    // можно было бы накрутить, играя без соперника.
    if (!solo) {
      s.wins   = (s.wins || 0) + (won ? 1 : 0);
      // Поражением считаем только доигранный матч: ушёл сам — это не поражение
      s.losses = (s.losses || 0) + (!won && !p.left ? 1 : 0);
      // Серия побед подряд: считаем текущую и запоминаем лучшую
      s.winStreak = won ? (s.winStreak || 0) + 1 : 0;
      s.bestWinStreak = Math.max(s.bestWinStreak || 0, s.winStreak);
    }
    return s;
  });

  // 2. Запись в историю этого игрока
  writeHistory(mid, uid, m);

  // 3. Матч больше не активный — убираем из индекса «Мои матчи»
  db.ref('userMatches/' + uid + '/' + mid).remove();
}

function writeHistory(mid, uid, m) {
  const p = m.players[uid];
  const order = m.turnOrder || Object.keys(m.players);
  const roster = order.map(id => ({ id, p: m.players[id] })).filter(x => x.p).map(({ id, p: x }) => ({
    userId: id,                                   // нужен для статистики личных встреч
    nickname: x.nickname, avatar: x.avatar || null, color: x.color || null, photo: x.photo || null,
    hits: x.hits || 0, misses: x.misses || 0, points: ptsOf(x), best: x.best || 0,
    place: x.place || null, left: !!x.left
  })).sort(cmpFinal);

  let result;
  if (m.solo)                  result = 'solo';   // сам с собой — ни победы, ни поражения
  else if (p.left)             result = 'left';
  else if (m.winnerId === uid) result = 'win';
  else                         result = 'lose';

  // Полный лог хода матча — чтобы в истории открыть его целиком
  const events = (m.events ? Object.values(m.events) : [])
    .sort((a, b) => (a.time || 0) - (b.time || 0))
    .map(e => ({ action: e.action || '', text: e.text || '', time: e.time || 0 }));

  const winner = m.players[m.winnerId];
  db.ref('history/' + uid + '/' + mid).set({
    time: m.finishedAt || serverNow(),
    name: m.name || null,
    goalType: m.goalType,
    solo: !!m.solo,
    shotMode: m.shotMode || 'simple',
    targetHits: m.targetHits || null,
    durationMin: m.durationMin || null,
    result,
    place: p.place || null,
    myHits: p.hits || 0,
    myMisses: p.misses || 0,
    myPoints: ptsOf(p),
    myBest: p.best || 0,
    winnerId: m.winnerId || null,
    winnerNickname: winner ? winner.nickname : null,
    roster,
    events
  });
}

function finalizeAll(m) {
  // Каждый клиент обновляет только свою собственную статистику и историю.
  // Это предотвращает ошибки записи в чужие узлы БД.
  if (m.players && m.players[state.userId]) {
    finalizePlayer(state.currentMatchId, state.userId, m);
  }
}

/* ================================================================
   ЭКРАН 7 — ИСТОРИЯ МАТЧЕЙ
   ================================================================ */
async function openHistory() {
  showScreen('screen-history');
  const list = $('#history-list');
  list.innerHTML = '<div class="empty">Загружаем…</div>';
  const snap = await db.ref('history/' + state.userId).get();
  // Ключ записи (_k) нужен кнопке «Удалить», чтобы снести именно её
  historyCache = Object.entries(snap.val() || {}).map(([_k, h]) => ({ ...h, _k }))
    .sort((a, b) => (b.time || 0) - (a.time || 0));
  renderHistory();
}

function renderHistory() {
  const list = $('#history-list');
  const empty = $('#history-empty');
  list.innerHTML = '';
  const entries = historyCache.filter(h =>
    historyFilter === 'all' ? true :
    historyFilter === 'win' ? h.result === 'win' :
    // «Поражения» включают и матчи, из которых вышли, но не тренировки
    (h.result === 'lose' || h.result === 'left'));
  empty.style.display = entries.length ? 'none' : 'block';
  if (!entries.length && historyCache.length) {
    empty.querySelector('div:last-child').textContent = 'В этой подборке пусто';
  }

  entries.forEach(h => {
    let modeTxt;
    if (h.goalType === 'common')     modeTxt = `🎯 На цель · ${h.targetHits}`;
    else if (h.goalType === 'timed') modeTxt = `⏳ На время · ${h.durationMin} мин`;
    else                             modeTxt = '🔥 Свободный';
    if (h.shotMode === 'zones') modeTxt += ' · 🎖️ зоны';

    let resultTxt, resultCls;
    if (h.result === 'solo')      { resultTxt = '🎯 Тренировка'; resultCls = 'solo'; }
    else if (h.result === 'win')  { resultTxt = '🏆 Победа'; resultCls = 'win'; }
    else if (h.result === 'left') { resultTxt = '🚪 Вышел из матча'; resultCls = 'left'; }
    else                          { resultTxt = h.place ? `${medal(h.place)} ${h.place}-е место` : '💪 Поражение'; resultCls = 'lose'; }

    const players = (h.roster || []).map((r, i) => {
      const isMe = r.nickname === state.nickname;
      const rankTxt = r.place ? medal(r.place) : (i + 1);
      const leftTag = r.left ? ' <span class="me-tag">вышел</span>' : '';
      return `<div class="hc-player${isMe ? ' me' : ''}">
        <span class="hp-rank">${rankTxt}</span>
        ${miniAvatar(r, true)}
        <span class="hp-name">${escapeHtml(r.nickname)}${isMe ? ' <span class="me-tag">ты</span>' : ''}${leftTag}</span>
        <span class="hp-score"><b>${r.hits}</b> / ${r.misses}</span>
      </div>`;
    }).join('');

    const hasLog = Array.isArray(h.events) ? h.events.length : (h.events && Object.keys(h.events).length);
    const logBtn = hasLog ? '<button class="hc-log-btn">📜 Ход матча</button>' : '';
    const evsArr = hasLog ? (Array.isArray(h.events) ? h.events : Object.values(h.events)) : [];
    const hasShots = evsArr.some(e => e.action === 'hit' || e.action === 'miss');
    const vidBtn = hasShots ? '<button class="hc-log-btn hc-vid-btn">🎬 Сгенерировать видео</button>' : '';

    const card = document.createElement('div');
    card.className = 'history-card ' + resultCls;
    card.innerHTML = `
      <div class="hc-top">
        <span class="hc-result">${resultTxt}</span>
        <span class="hc-date">${formatDate(h.time)}</span>
      </div>
      ${h.name ? `<div class="hc-name">${escapeHtml(h.name)}</div>` : ''}
      <div class="hc-mode">${modeTxt} · твой счёт: ${h.myPoints != null ? h.myPoints + ' очк (' + h.myHits + '/' + h.myMisses + ')' : h.myHits + ' / ' + h.myMisses}</div>
      <div class="hc-players">${players}</div>
      ${logBtn}${vidBtn}
      <button class="hc-del-btn" title="Удалить из истории">🗑 Удалить</button>`;
    if (hasLog) {
      card.querySelector('.hc-log-btn').addEventListener('click', () => openMatchLog(evsArr, h));
    }
    if (hasShots) {
      card.querySelector('.hc-vid-btn').addEventListener('click',
        () => MatchVideo.open(MatchVideo.fromHistory(h), h.name || 'Видео матча'));
    }
    card.querySelector('.hc-del-btn').addEventListener('click', () => deleteHistory(h, card));
    list.appendChild(card);
  });
}

/* ================================================================
   ЭКРАН 8 — МОИ МАТЧИ (сохранённые/идущие, куда можно вернуться)
   ================================================================ */
async function openMyMatches() {
  showScreen('screen-mymatches');
  const list = $('#mymatches-list');
  list.innerHTML = '<div class="empty">Загружаем…</div>';

  // Читаем только свои матчи — по индексу userMatches, а не всё дерево matches
  const idxSnap = await db.ref('userMatches/' + state.userId).get();
  const ids = Object.keys(idxSnap.val() || {});
  const snaps = await Promise.all(ids.map(id => db.ref('matches/' + id).get()));

  const mine = [];
  const stale = {};
  snaps.forEach((snap, i) => {
    const id = ids[i], m = snap.val();
    // Матча нет или меня в нём нет — чистим протухший индекс
    if (!m || !m.players || !m.players[state.userId]) { stale['userMatches/' + state.userId + '/' + id] = null; return; }
    if (m.status === 'finished') {
      // Ленивая финализация: матч завершился, пока меня не было — засчитать в историю
      if (!m.players[state.userId].counted) finalizePlayer(id, state.userId, m);
      stale['userMatches/' + state.userId + '/' + id] = null; // завершённые живут в «Истории»
      return;
    }
    mine.push({ id, m });
  });
  if (Object.keys(stale).length) db.ref().update(stale);

  // Сначала те, где ход за тобой, потом свежие
  const myTurnIn = ({ m }) => m.status === 'active' && !m.pausedAt &&
    (m.turnOrder || [])[m.currentTurnIndex] === state.userId ? 1 : 0;
  mine.sort((a, b) => myTurnIn(b) - myTurnIn(a) || (b.m.createdAt || 0) - (a.m.createdAt || 0));
  renderMyMatches(mine);
}

function renderMyMatches(items) {
  const list = $('#mymatches-list');
  const empty = $('#mymatches-empty');
  list.innerHTML = '';
  empty.style.display = items.length ? 'none' : 'block';

  items.forEach(({ id, m }) => {
    const me = m.players[state.userId] || {};
    const isCreator = m.creatorId === state.userId;
    const isLobby = m.status === 'lobby';
    const statusBadge = isLobby ? '<span class="mm-badge lobby">Лобби</span>' : '<span class="mm-badge live">Идёт</span>';
    const roleBadge = isCreator ? '<span class="mm-badge creator">ваш</span>' : '';
    const leftBadge = me.left ? '<span class="mm-badge left">вы вышли</span>' : '';
    const count = Object.values(m.players).filter(p => p.status === 'joined').length;
    let modeTxt;
    if (m.goalType === 'common')     modeTxt = `🎯 до ${m.targetHits}`;
    else if (m.goalType === 'timed') modeTxt = `⏳ ${m.durationMin} мин`;
    else                             modeTxt = '🔥 свободный';
    if (isZones(m)) modeTxt += ' · 🎖️ зоны';
    const timeTxt = m.startAt ? ` · 🕐 ${fmtClock(m.startAt)}` : '';

    // Чей ход — главное, что хочется увидеть в списке идущих матчей
    const activeUid = !isLobby && (m.turnOrder || [])[m.currentTurnIndex];
    const myTurn = activeUid === state.userId && !me.left && !me.finished;
    const turnBadge = m.pausedAt ? '<span class="mm-badge left">пауза</span>'
      : myTurn ? '<span class="mm-badge turn">твой ход</span>'
      : activeUid ? `<span class="mm-badge wait">ходит ${escapeHtml((m.players[activeUid] || {}).nickname || '—')}</span>` : '';

    // Текущий счёт — коротко, в порядке табло
    const scoreTxt = isLobby ? '' : (m.turnOrder || []).map(uid => m.players[uid]).filter(Boolean)
      .sort(cmpPlayers).slice(0, 4)
      .map(p => `${escapeHtml(p.nickname)} <b>${ptsOf(p)}</b>`).join(' · ');

    const card = document.createElement('div');
    card.className = 'history-card' + (myTurn ? ' my-turn' : '');
    card.innerHTML = `
      <div class="hc-top">
        <span class="hc-result">${escapeHtml(m.name || 'Матч')}</span>
        <span class="mm-badges">${statusBadge}${roleBadge}${leftBadge}${turnBadge}</span>
      </div>
      <div class="hc-mode">${modeTxt} · 👥 ${count}${timeTxt}</div>
      ${scoreTxt ? `<div class="mm-score">${scoreTxt}</div>` : ''}
      <div class="mm-actions"></div>`;
    const actions = card.querySelector('.mm-actions');

    const enterBtn = document.createElement('button');
    enterBtn.className = 'btn btn-accent mm-btn';
    enterBtn.textContent = me.left ? 'Вернуться' : (isLobby ? 'Открыть' : 'Продолжить');
    enterBtn.addEventListener('click', () => reenterMatch(id, m));
    actions.appendChild(enterBtn);

    // Ролик можно собрать, если в матче уже были броски
    const hasShots = Object.values(m.events || {}).some(e => e.action === 'hit' || e.action === 'miss');
    if (hasShots) {
      const vidBtn = document.createElement('button');
      vidBtn.className = 'btn btn-ghost mm-btn';
      vidBtn.textContent = '🎬 Видео';
      vidBtn.addEventListener('click', () => MatchVideo.open(MatchVideo.fromMatch(m), m.name || 'Видео матча'));
      actions.appendChild(vidBtn);
    }

    if (isCreator && isLobby) {
      const editBtn = document.createElement('button');
      editBtn.className = 'btn btn-ghost mm-btn';
      editBtn.textContent = 'Изменить';
      editBtn.addEventListener('click', () => openEditMatch(id, m));
      actions.appendChild(editBtn);

      const delBtn = document.createElement('button');
      delBtn.className = 'btn btn-ghost mm-btn';
      delBtn.textContent = 'Удалить';
      delBtn.addEventListener('click', () => deleteMatch(id, m));
      actions.appendChild(delBtn);
    }
    list.appendChild(card);
  });
}

// Вернуться в матч: если он идёт и я выходил — снимаем «вышел» и дописываемся в очередь
async function reenterMatch(id, m) {
  const me = m.players[state.userId];
  if (m.status === 'active' && me && me.left) {
    await db.ref('matches/' + id).transaction(mm => {
      if (!mm || mm.status !== 'active') return mm;
      const p = mm.players[state.userId];
      if (!p) return mm;
      p.left = false;
      p.status = 'joined';
      p.streak = 0;
      mm.turnOrder = mm.turnOrder || [];
      if (mm.turnOrder.indexOf(state.userId) === -1) mm.turnOrder.push(state.userId);
      if (!mm.events) mm.events = {};
      const k = db.ref().push().key;
      mm.events[k] = { time: serverNow(), userId: state.userId, action: 'join', text: `${state.nickname} вернулся` };
      return mm;
    });
  }
  enterMatch(id);
}

async function deleteMatch(id, m) {
  if (!await showConfirm('Удалить матч? Он исчезнет у всех приглашённых.', 'Удалить', '🗑️')) return;
  const updates = { ['matches/' + id]: null };
  Object.keys(m.players || {}).forEach(uid => {
    updates['invites/' + uid + '/' + id] = null;
    updates['userMatches/' + uid + '/' + id] = null;
  });
  await db.ref().update(updates);
  openMyMatches();
}

// Удалить одну запись из истории (только у себя — история у каждого своя)
async function deleteHistory(h, card) {
  const label = h.name ? '«' + h.name + '»' : 'этот матч';
  if (!await showConfirm('Удалить ' + label + ' из истории? Только у тебя.', 'Удалить', '🗑️')) return;
  if (h._k) await db.ref('history/' + state.userId + '/' + h._k).remove();
  historyCache = historyCache.filter(x => x._k !== h._k);
  card.remove();
  if (!$('#history-list').children.length) $('#history-empty').style.display = 'block';
}

function openEditMatch(id, m) {
  editingMatchId = id;
  $('#edit-name').value = m.name || '';
  const d = m.startAt ? new Date(m.startAt) : new Date();
  const pad = n => String(n).padStart(2, '0');
  $('#edit-date').value = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  $('#edit-time').value = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  $('#edit-backdrop').hidden = false;
}

async function saveEditMatch() {
  const id = editingMatchId;
  if (!id) return;
  const name = (($('#edit-name').value || '').trim()) || `Матч ${state.nickname}`;
  const dateVal = $('#edit-date').value, timeVal = $('#edit-time').value;
  let startAt = null;
  if (dateVal && timeVal) {
    const t = new Date(`${dateVal}T${timeVal}`).getTime();
    if (t && t > serverNow() + 30000) startAt = t;
  }
  const snap = await db.ref('matches/' + id).get();
  const m = snap.val();
  if (!m) { $('#edit-backdrop').hidden = true; editingMatchId = null; return; }

  const updates = {
    ['matches/' + id + '/name']: name,
    ['matches/' + id + '/startAt']: startAt
  };
  // Обновляем приглашения только у тех, кто ещё «в ожидании» (у них приглашение живо)
  Object.entries(m.players || {}).forEach(([uid, p]) => {
    if (uid !== m.creatorId && p.status === 'waiting') {
      updates['invites/' + uid + '/' + id + '/name'] = name;
      updates['invites/' + uid + '/' + id + '/startAt'] = startAt;
    }
  });
  await db.ref().update(updates);
  $('#edit-backdrop').hidden = true;
  editingMatchId = null;
  openMyMatches();
}

/* ================================================================
   ЭКРАН 10 — ЛИЧНЫЕ ВСТРЕЧИ
   ================================================================ */
/* Счёт против каждого соперника считаем из собственной истории: там лежит
   состав каждого матча, а значит и результат очной встречи. */
function openH2H() {
  showScreen('screen-h2h');
  const list = $('#h2h-list');
  const empty = $('#h2h-empty');
  list.innerHTML = '';

  const foes = {};
  historyCache.forEach(h => {
    const roster = h.roster || [];
    const me = roster.find(r => r.userId === state.userId)
            || roster.find(r => r.nickname === state.nickname);
    if (!me) return;

    roster.forEach(r => {
      // Старые записи в истории писались без userId — тогда опираемся на ник
      const key = r.userId || ('nick:' + r.nickname);
      if (r.userId === state.userId || (!r.userId && r.nickname === state.nickname)) return;

      const f = foes[key] || (foes[key] = {
        nickname: r.nickname, avatar: r.avatar, color: r.color, photo: r.photo,
        games: 0, wins: 0, losses: 0, draws: 0, myPts: 0, hisPts: 0, lastTime: 0
      });
      f.nickname = r.nickname;                 // ник мог поменяться — держим свежий
      f.games++;
      f.myPts  += me.points != null ? me.points : (me.hits || 0);
      f.hisPts += r.points != null ? r.points : (r.hits || 0);
      f.lastTime = Math.max(f.lastTime, h.time || 0);

      // Сравниваем по месту, если оно есть, иначе по счёту
      const c = cmpFinal(me, r);
      if (c < 0) f.wins++; else if (c > 0) f.losses++; else f.draws++;
    });
  });

  const rows = Object.values(foes).sort((a, b) => b.games - a.games || b.lastTime - a.lastTime);
  empty.style.display = rows.length ? 'none' : 'block';

  rows.forEach(f => {
    const verdict = f.wins > f.losses ? 'good' : f.wins < f.losses ? 'bad' : 'even';
    const row = document.createElement('div');
    row.className = 'rate-row h2h-row ' + verdict;
    row.innerHTML = `
      ${miniAvatar(f)}
      <div class="rate-info">
        <div class="rate-name">${escapeHtml(f.nickname)}</div>
        <div class="rate-sub">${f.games} ${plural(f.games, 'встреча', 'встречи', 'встреч')} · очки ${f.myPts}:${f.hisPts}${f.draws ? ' · ничьих ' + f.draws : ''}</div>
      </div>
      <div class="h2h-score"><b>${f.wins}</b><i>:</i><b>${f.losses}</b></div>`;
    list.appendChild(row);
  });
}

// Русские окончания для счётных слов: 1 встреча, 2 встречи, 5 встреч
function plural(n, one, few, many) {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b > 1 && b < 5) return few;
  if (b === 1) return one;
  return many;
}

/* ================================================================
   ЭКРАН 9 — РЕЙТИНГ ИГРОКОВ
   ================================================================ */
// Сколько бросков нужно, чтобы попасть в рейтинг по точности —
// иначе первое место занимает тот, кто бросил один раз и попал.
const RATING_MIN_SHOTS = 20;

const RATING_SORTS = {
  wins:   { label: 'побед',    value: st => st.wins || 0 },
  hits:   { label: 'попаданий', value: st => st.hits || 0 },
  streak: { label: 'серия',    value: st => st.best || 0 },
  acc:    { label: 'точность', value: st => accuracy(st.hits, st.misses),
            eligible: st => (st.hits || 0) + (st.misses || 0) >= RATING_MIN_SHOTS }
};

async function openRating() {
  showScreen('screen-rating');
  $('#rating-search').value = '';
  const list = $('#rating-list');
  list.innerHTML = '<div class="empty">Считаем…</div>';
  try {
    const snap = await db.ref('users').get();
    ratingUsers = Object.entries(snap.val() || {}).map(([uid, u]) => ({
      uid, nickname: u.nickname || '—', avatar: u.avatar, color: u.color, photo: u.photo,
      st: u.stats || {}
    }));
    renderRating();
  } catch (e) {
    list.innerHTML = '<div class="empty">Не удалось загрузить рейтинг</div>';
  }
}

function renderRating() {
  const list = $('#rating-list');
  const sort = RATING_SORTS[ratingSort] || RATING_SORTS.wins;
  list.innerHTML = '';

  const q = ($('#rating-search').value || '').trim().toLowerCase();
  const rows = ratingUsers
    .filter(u => (u.st.matches || 0) > 0)
    .filter(u => !q || u.nickname.toLowerCase().includes(q))
    .filter(u => !sort.eligible || sort.eligible(u.st))
    .sort((a, b) => sort.value(b.st) - sort.value(a.st) || (b.st.matches || 0) - (a.st.matches || 0));

  if (!rows.length) {
    list.innerHTML = q ? '<div class="empty">Никого не найдено</div>' :
      ratingSort === 'acc'
      ? `<div class="empty">Пока ни у кого нет ${RATING_MIN_SHOTS} бросков — сыграйте ещё</div>`
      : '<div class="empty">Сыгранных матчей пока нет</div>';
    return;
  }

  rows.forEach((u, i) => {
    const st = u.st;
    const val = sort.value(st) + (ratingSort === 'acc' ? '%' : '');
    const row = document.createElement('div');
    row.className = 'rate-row' + (u.uid === state.userId ? ' me' : '') + (i < 3 ? ' podium' : '');
    row.innerHTML = `
      <div class="rate-place">${i < 3 ? medal(i + 1) : i + 1}</div>
      ${miniAvatar(u)}
      <div class="rate-info">
        <div class="rate-name">${escapeHtml(u.nickname)}${u.uid === state.userId ? ' <span class="me-tag">ты</span>' : ''}</div>
        <div class="rate-sub">${st.matches || 0} матч. · ${st.wins || 0} побед · ${accuracy(st.hits, st.misses)}% точность</div>
      </div>
      <div class="rate-val">${val}<small>${sort.label}</small></div>`;
    list.appendChild(row);
  });
}

/* ================================================================
   ДОСТИЖЕНИЯ
   ================================================================ */
const ACHIEVEMENTS = [
  { icon: '🏀', name: 'Дебют',          desc: 'Сыграть первый матч',           has: st => (st.matches || 0) >= 1 },
  { icon: '🎮', name: 'Разыгрался',     desc: 'Сыграть 10 матчей',             has: st => (st.matches || 0) >= 10 },
  { icon: '🏟️', name: 'Ветеран',        desc: 'Сыграть 50 матчей',             has: st => (st.matches || 0) >= 50 },
  { icon: '🏆', name: 'Первая победа',  desc: 'Выиграть матч',                 has: st => (st.wins || 0) >= 1 },
  { icon: '👑', name: 'Чемпион',        desc: 'Выиграть 10 матчей',            has: st => (st.wins || 0) >= 10 },
  { icon: '💯', name: 'Сотня',          desc: '100 попаданий за всё время',    has: st => (st.hits || 0) >= 100 },
  { icon: '💎', name: 'Пятьсот очков',  desc: 'Набрать 500 очков',             has: st => (st.points || st.hits || 0) >= 500 },
  { icon: '🔥', name: 'В огне',         desc: '5 попаданий подряд',            has: st => (st.best || 0) >= 5 },
  { icon: '☄️', name: 'Не остановить',  desc: '10 попаданий подряд',           has: st => (st.best || 0) >= 10 },
  { icon: '🎯', name: 'Снайпер',        desc: `Точность 60% (от ${RATING_MIN_SHOTS} бросков)`,
    has: st => (st.hits || 0) + (st.misses || 0) >= RATING_MIN_SHOTS && accuracy(st.hits, st.misses) >= 60 },
  { icon: '🦅', name: 'Хирург',         desc: 'Точность 75% (от 50 бросков)',
    has: st => (st.hits || 0) + (st.misses || 0) >= 50 && accuracy(st.hits, st.misses) >= 75 },
  { icon: '📈', name: 'На ходу',        desc: '3 победы подряд',               has: st => (st.bestWinStreak || 0) >= 3 },
  { icon: '🧱', name: 'Стена',          desc: '5 побед подряд',                has: st => (st.bestWinStreak || 0) >= 5 }
];

function renderProfileStats(st) {
  st = st || {};
  const shots = (st.hits || 0) + (st.misses || 0);
  const cells = [
    ['Матчей',   st.matches || 0],
    ['Побед',    st.wins || 0],
    ['Поражений', st.losses || 0],
    ['Очков',    st.points != null ? st.points : (st.hits || 0)],
    ['Бросков',  shots],
    ['Точность', accuracy(st.hits, st.misses) + '%'],
    ['Лучшая серия', st.best || 0],
    // Winrate считаем от доигранных матчей: тренировки и уходы его не портят
    ['Winrate',  (st.wins || 0) + (st.losses || 0)
                   ? Math.round(((st.wins || 0) / ((st.wins || 0) + (st.losses || 0))) * 100) + '%' : '0%'],
    ['Побед подряд', st.winStreak || 0],
    ['Рекорд серии', st.bestWinStreak || 0]
  ];
  $('#profile-stats').innerHTML = cells
    .map(([k, v]) => `<div class="pstat"><b>${v}</b><span>${k}</span></div>`).join('');

  $('#profile-ach').innerHTML = ACHIEVEMENTS.map(a => {
    const got = a.has(st);
    return `<div class="ach${got ? ' got' : ''}" title="${escapeHtml(a.desc)}">
      <div class="ach-ic">${a.icon}</div>
      <div class="ach-nm">${escapeHtml(a.name)}</div>
      <div class="ach-ds">${escapeHtml(a.desc)}</div>
    </div>`;
  }).join('');
}

/* ================================================================
   ВИДЕО МАТЧА — 18-секундный ролик, собранный из хода матча
   ================================================================
   Кадры рисуются на canvas в стиле экрана матча, звук — трек с 22-й
   секунды, всё вместе пишется через MediaRecorder в один файл.

   Сюжет (в скобках — секунда трека):
     0.0 (22)  разгон: реплей всех бросков, попадание — зелёным, промах — красным
     4.0 (26)  чёрно-белая вспышка, на табло остаётся только победитель
     4.5 (26)  реплей бросков победителя: счёт, серии
    10.0 (32)  фон сереет и темнеет, замедленный решающий бросок на весь экран
    11.0 (33)  карточка победителя: корона, счёт, макс. серия, ☠️
    18.0 (40)  конец
   ================================================================ */
const MatchVideo = (() => {
  const AUDIO_CLIP_SCRIPT = 'audio-clip.js?v=25'; // 18 с трека (с 22-й секунды) в base64
  const AUDIO_START = 22;                 // с какой секунды трека вырезан клип
  const W = 720, H = 1280, FPS = 30, DUR = 18;

  // Ключевые точки сюжета в секундах ВИДЕО (= секунда трека − AUDIO_START)
  const T_BW   = 26 - AUDIO_START;        // 4.0
  const T_SLOW = 32 - AUDIO_START;        // 10.0
  const T_WIN  = 33 - AUDIO_START;        // 11.0

  const BW_LEN = 0.55;                    // длительность ч/б вспышки и перестроения
  const A0 = 0.5,  A1 = T_BW - 0.15;      // окно реплея всех игроков
  const R0 = T_BW + BW_LEN, R1 = T_SLOW - 0.25; // окно реплея победителя
  const SHOT_FLY = 0.8;                   // полёт мяча в слоу-мо

  // Палитра — та же, что в CSS
  const C = {
    bg: '#0a0c11', text: '#f3f5f8', muted: 'rgba(255,255,255,.54)', faint: 'rgba(255,255,255,.34)',
    cyan: '#6cc9ff', cyan2: '#a6ddff', accent: '#ff7a45', accent2: '#ff9563',
    green: '#4ade80', red: '#fb7185', gold: '#ffd36b', hair: 'rgba(255,255,255,.09)'
  };
  const FONT  = 'Inter, system-ui, -apple-system, "Segoe UI", sans-serif';
  const EMOJI = '"Segoe UI Emoji", "Apple Color Emoji", "Noto Color Emoji", sans-serif';

  /* ---------- состояние модуля ---------- */
  let source = null;      // нормализованные данные матча
  let running = false;    // идёт запись/проигрывание
  let cancelled = false;
  let blob = null, blobUrl = null, fileName = 'match.webm';
  let AC = null, gainNode = null, audioDest = null;
  let audioBuf = null, srcNode = null;    // вшитый кусок трека и его источник
  let monitor = null, silent = false;     // контроль, что в дорожку реально идёт сигнал
  let AF = null;                          // разбор трека по битам: громкость и удары
  const photoCache = {};  // dataURI -> Image

  /* ================= НОРМАЛИЗАЦИЯ ДАННЫХ ================= */

  // Из живого матча
  function fromMatch(m) {
    if (!m || !m.players) return null;
    const order = (m.turnOrder && m.turnOrder.length) ? m.turnOrder : Object.keys(m.players);
    const players = order.map(id => {
      const p = m.players[id];
      return p ? { id, nickname: p.nickname, avatar: p.avatar || null, photo: p.photo || null,
                   color: p.color || null, hits: p.hits || 0, misses: p.misses || 0,
                   place: p.place || null, left: !!p.left } : null;
    }).filter(Boolean);
    const events = Object.values(m.events || {})
      .sort((a, b) => (a.time || 0) - (b.time || 0))
      .map(e => ({ userId: e.userId || null, action: e.action || '', text: e.text || '' }));
    return finish({
      name: m.name || 'Матч',
      time: m.finishedAt || Date.now(),
      goalType: m.goalType, targetHits: m.targetHits || null,
      players, events, winnerId: m.winnerId || null
    });
  }

  // Из записи истории (в ней у событий нет userId — вычисляем по нику в тексте)
  function fromHistory(h) {
    if (!h) return null;
    const players = (h.roster || []).map((r, i) => ({
      id: 'p' + i, nickname: r.nickname, avatar: r.avatar || null, photo: r.photo || null,
      color: r.color || null, hits: r.hits || 0, misses: r.misses || 0,
      place: r.place || null, left: !!r.left
    }));
    const raw = Array.isArray(h.events) ? h.events : Object.values(h.events || {});
    // длинные ники вперёд, чтобы «Ден» не перехватил событие «Дениса»
    const byLen = players.slice().sort((a, b) => (b.nickname || '').length - (a.nickname || '').length);
    const events = raw.slice().sort((a, b) => (a.time || 0) - (b.time || 0)).map(e => {
      const txt = e.text || '';
      const owner = byLen.find(p => p.nickname && txt.indexOf(p.nickname) !== -1);
      return { userId: owner ? owner.id : null, action: e.action || '', text: txt };
    });
    let winnerId = null;
    if (h.winnerNickname) { const w = players.find(p => p.nickname === h.winnerNickname); if (w) winnerId = w.id; }
    return finish({
      name: h.name || 'Матч', time: h.time || Date.now(),
      goalType: h.goalType, targetHits: h.targetHits || null,
      players, events, winnerId
    });
  }

  // Досчитать всё, что нужно ролику: порядок, броски, серии, победитель
  function finish(d) {
    d.players.sort((a, b) => {
      if (a.place && b.place) return a.place - b.place;
      if (a.place) return -1;
      if (b.place) return 1;
      return (b.hits || 0) - (a.hits || 0);
    });

    d.shots = d.events.filter(e => e.action === 'hit' || e.action === 'miss');

    const streak = {}, best = {};
    d.shots.forEach(s => {
      const u = s.userId; if (!u) return;
      if (s.action === 'hit') { streak[u] = (streak[u] || 0) + 1; best[u] = Math.max(best[u] || 0, streak[u]); }
      else streak[u] = 0;
    });
    d.players.forEach(p => { p.best = best[p.id] || 0; });

    if (!d.winnerId || !d.players.some(p => p.id === d.winnerId)) {
      const alive = d.players.filter(p => !p.left);
      d.winnerId = (alive[0] || d.players[0] || {}).id || null;
    }
    d.winner = d.players.find(p => p.id === d.winnerId) || d.players[0] || null;
    d.winShots = d.winner ? d.shots.filter(s => s.userId === d.winner.id) : [];
    return d;
  }

  /* ================= РИСОВАЛКИ ================= */

  function rr(ctx, x, y, w, h, r) {
    const rad = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    if (ctx.roundRect) { ctx.roundRect(x, y, w, h, rad); return; }
    ctx.moveTo(x + rad, y);
    ctx.arcTo(x + w, y, x + w, y + h, rad); ctx.arcTo(x + w, y + h, x, y + h, rad);
    ctx.arcTo(x, y + h, x, y, rad);         ctx.arcTo(x, y, x + w, y, rad);
    ctx.closePath();
  }

  // Текст с вертикальным градиентом — как background-clip:text в CSS
  function gtext(ctx, txt, x, y, size, weight, c1, c2, align) {
    ctx.save();
    ctx.font = weight + ' ' + size + 'px ' + FONT;
    ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
    const g = ctx.createLinearGradient(0, y - size * .58, 0, y + size * .58);
    g.addColorStop(0, c1); g.addColorStop(1, c2);
    ctx.fillStyle = g; ctx.fillText(txt, x, y);
    ctx.restore();
  }

  function text(ctx, txt, x, y, size, weight, color, align, spacing) {
    ctx.save();
    ctx.font = weight + ' ' + size + 'px ' + FONT;
    ctx.textAlign = align || 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = color;
    if (spacing && 'letterSpacing' in ctx) ctx.letterSpacing = spacing + 'px';
    ctx.fillText(txt, x, y);
    ctx.restore();
  }

  // Подобрать кегль, чтобы строка влезла в ширину; если совсем нет — обрезать
  function fit(ctx, txt, maxW, size, min, weight, spacing) {
    let s = size;
    while (s > min && measure(ctx, txt, s, weight, spacing) > maxW) s -= 1;
    let out = txt;
    while (out.length > 4 && measure(ctx, out + '…', s, weight, spacing) > maxW) out = out.slice(0, -1);
    return { size: s, txt: out === txt ? txt : out + '…' };
  }

  function measure(ctx, txt, size, weight, spacing) {
    ctx.save();
    ctx.font = weight + ' ' + size + 'px ' + FONT;
    if (spacing && 'letterSpacing' in ctx) ctx.letterSpacing = spacing + 'px';
    const w = ctx.measureText(txt).width;
    ctx.restore();
    return w;
  }

  function emoji(ctx, ch, x, y, size, alpha) {
    ctx.save();
    ctx.globalAlpha = alpha === undefined ? 1 : alpha;
    ctx.font = size + 'px ' + EMOJI;
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.fillText(ch, x, y);
    ctx.restore();
  }

  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function ease(p) { return p < .5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; }
  function easeOut(p) { return 1 - Math.pow(1 - p, 3); }
  function hexA(hex, a) {
    const n = parseInt((hex || '#888888').slice(1), 16);
    return 'rgba(' + (n >> 16) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ',' + a + ')';
  }
  function pColor(p) {
    if (p && p.color) return p.color;
    return typeof colorFromString === 'function' ? colorFromString((p && p.nickname) || '') : '#6cc9ff';
  }

  // Фон площадки — как #screen-match
  function drawBg(ctx) {
    ctx.fillStyle = C.bg; ctx.fillRect(0, 0, W, H);
    let g = ctx.createLinearGradient(0, 0, 0, H * .42);
    g.addColorStop(0, 'rgba(22,34,52,.5)'); g.addColorStop(1, 'rgba(22,34,52,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H * .42);
    g = ctx.createRadialGradient(W / 2, 40, 0, W / 2, 40, W * .62);
    g.addColorStop(0, 'rgba(255,255,255,.06)'); g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H * .5);
    g = ctx.createRadialGradient(W / 2, H, 0, W / 2, H, W * .95);
    g.addColorStop(0, 'rgba(255,138,58,.15)'); g.addColorStop(1, 'rgba(255,138,58,0)');
    ctx.fillStyle = g; ctx.fillRect(0, H * .55, W, H * .45);
  }

  // Кольцо со щитом и сеткой — повторяет SVG с экрана матча
  function drawHoop(ctx, cx, topY, s, tint, netWob) {
    ctx.save();
    ctx.translate(cx - 200 * s, topY);
    ctx.scale(s, s);

    ctx.fillStyle = 'rgba(255,255,255,.05)';
    ctx.strokeStyle = 'rgba(255,255,255,.16)'; ctx.lineWidth = 1.5;
    rr(ctx, 118, 18, 164, 118, 14); ctx.fill(); ctx.stroke();

    ctx.strokeStyle = tint || C.accent; ctx.lineWidth = 3; ctx.globalAlpha = .8;
    rr(ctx, 168, 60, 64, 46, 4); ctx.stroke(); ctx.globalAlpha = 1;

    const N = 12, ncx = 200, tY = 152, tRx = 62, tRy = 15, bY = 214, bRx = 26, bRy = 6;
    const top = [], bot = [], wob = netWob || 0;
    for (let i = 0; i < N; i++) {
      const a = (i / N) * Math.PI * 2 - Math.PI / 2;
      top.push([ncx + Math.cos(a) * tRx, tY + Math.sin(a) * tRy]);
      bot.push([ncx + Math.cos(a) * bRx * (1 + wob * .5), bY + Math.sin(a) * bRy + wob * 26]);
    }
    ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 1.3;
    ctx.beginPath();
    for (let i = 0; i < N; i++) {
      ctx.moveTo(top[i][0], top[i][1]); ctx.lineTo(bot[i][0], bot[i][1]);
      ctx.moveTo(top[i][0], top[i][1]); ctx.lineTo(bot[(i + 1) % N][0], bot[(i + 1) % N][1]);
    }
    ctx.stroke();

    ctx.strokeStyle = tint ? 'rgba(255,255,255,.35)' : 'rgba(255,138,58,.4)'; ctx.lineWidth = 5;
    ctx.beginPath(); ctx.ellipse(200, 152, 64, 16, 0, Math.PI, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = tint || '#ff8a3a'; ctx.lineWidth = 6;
    ctx.shadowColor = tint || 'rgba(255,138,58,.7)'; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.ellipse(200, 152, 64, 16, 0, 0, Math.PI); ctx.stroke();
    ctx.restore();
  }

  // Мяч — как SVG #match-ball
  function drawBall(ctx, x, y, r, rot) {
    ctx.save();
    ctx.translate(x, y); ctx.rotate(rot || 0); ctx.scale(r / 46, r / 46);
    ctx.shadowColor = 'rgba(0,0,0,.5)'; ctx.shadowBlur = 18; ctx.shadowOffsetY = 8;
    const g = ctx.createRadialGradient(-11, -16, 2, 0, 0, 62);
    g.addColorStop(0, '#ffb27a'); g.addColorStop(.55, '#ff7a2e'); g.addColorStop(1, '#d1541a');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 46, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.strokeStyle = 'rgba(58,22,8,.85)'; ctx.lineWidth = 2.4;
    ctx.beginPath();
    ctx.arc(0, 0, 46, 0, Math.PI * 2);
    ctx.moveTo(0, -46); ctx.lineTo(0, 46);
    ctx.moveTo(-46, 0); ctx.lineTo(46, 0);
    ctx.moveTo(-35, -32); ctx.quadraticCurveTo(0, 0, -35, 32);
    ctx.moveTo(35, -32);  ctx.quadraticCurveTo(0, 0, 35, 32);
    ctx.stroke();
    ctx.restore();
  }

  // Аватар: фото или эмодзи/буква в кружке с обводкой цветом игрока
  function drawAvatar(ctx, p, cx, cy, r, glow) {
    const col = pColor(p);
    ctx.save();
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = hexA(col, .16); ctx.fill();
    const img = p.photo ? photoCache[p.photo] : null;
    if (img && img.complete && img.naturalWidth) {
      ctx.save(); ctx.clip();
      const sc = Math.max((r * 2) / img.naturalWidth, (r * 2) / img.naturalHeight);
      const w = img.naturalWidth * sc, h = img.naturalHeight * sc;
      ctx.drawImage(img, cx - w / 2, cy - h / 2, w, h);
      ctx.restore();
    } else {
      const ch = p.avatar || (p.nickname ? p.nickname.charAt(0).toUpperCase() : '?');
      ctx.save();
      ctx.font = '700 ' + Math.round(r * .95) + 'px ' + EMOJI + ', ' + FONT;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillStyle = 'rgba(255,255,255,.92)';
      ctx.fillText(ch, cx, cy + r * .04);
      ctx.restore();
    }
    ctx.lineWidth = Math.max(2, r * .1);
    ctx.strokeStyle = col;
    if (glow) { ctx.shadowColor = hexA(col, .9); ctx.shadowBlur = 22 * glow; }
    ctx.beginPath(); ctx.arc(cx, cy, r, 0, Math.PI * 2); ctx.stroke();
    ctx.restore();
  }

  // Шапка: кольцо + название матча + режим/дата
  function drawHead(ctx, d) {
    drawHoop(ctx, W / 2, 22, .95, null, 0);
    const f = fit(ctx, (d.name || 'Матч').toUpperCase(), W - 96, 30, 19, 800);
    gtext(ctx, f.txt, W / 2, 282, f.size, 800, '#c9ecff', '#5cb4ff');
    const mode = d.goalType === 'common' ? 'ДО ' + d.targetHits + ' ПОПАДАНИЙ' : 'СВОБОДНЫЙ';
    const dt = typeof formatDate === 'function' ? formatDate(d.time) : '';
    text(ctx, mode + '  ·  ' + dt, W / 2, 318, 16, 600, C.faint, 'center', 2.4);
  }

  /* --- Сцена 1: табло со всеми игроками, реплей бросков --- */
  function drawBoard(ctx, d, t, alpha) {
    ctx.save(); ctx.globalAlpha = alpha;

    const n = d.shots.length;
    const done = n ? clamp(Math.floor((t - A0) / (A1 - A0) * n), 0, n) : 0;
    const stat = {}, statPrev = {}, flash = {};
    d.players.forEach(p => { stat[p.id] = { hits: 0, miss: 0 }; });
    for (let i = 0; i < done; i++) {
      // снимок счёта перед последним броском — от него ведём анимацию перестановки
      if (i === done - 1) d.players.forEach(p => { statPrev[p.id] = { hits: stat[p.id].hits, miss: stat[p.id].miss }; });
      const s = d.shots[i]; if (!s.userId || !stat[s.userId]) continue;
      if (s.action === 'hit') stat[s.userId].hits++; else stat[s.userId].miss++;
      flash[s.userId] = { at: A0 + (i + 1) / n * (A1 - A0), hit: s.action === 'hit' };
    }
    if (!done) d.players.forEach(p => { statPrev[p.id] = { hits: 0, miss: 0 }; });
    if (t >= A1 || !n) d.players.forEach(p => {
      statPrev[p.id] = { hits: p.hits, miss: p.misses };
      stat[p.id] = { hits: p.hits, miss: p.misses };
    });

    // Высота карточки — под число игроков, по центру свободного места
    const list0 = d.players;
    const rowH0 = clamp(608 / Math.max(list0.length, 1), 56, 128);
    const x = 36, w = W - 72;
    const h = Math.min(736, 124 + list0.length * rowH0 + 14);
    const y = 344 + Math.round((736 - h) / 2);
    ctx.fillStyle = 'rgba(18,28,42,.66)';
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
    rr(ctx, x, y, w, h, 26); ctx.fill(); ctx.restore();
    ctx.strokeStyle = C.hair; ctx.lineWidth = 1;
    rr(ctx, x, y, w, h, 26); ctx.stroke();

    text(ctx, 'ТАБЛО', W / 2, y + 34, 15, 800, 'rgba(190,205,225,.55)', 'center', 4);
    ctx.strokeStyle = C.hair; ctx.beginPath();
    ctx.moveTo(x + 18, y + 92); ctx.lineTo(x + w - 18, y + 92); ctx.stroke();
    text(ctx, 'ИГРОК', x + 96,       y + 74, 13, 700, 'rgba(190,205,225,.5)', 'left', 2.4);
    text(ctx, 'ПОПАЛ', x + w - 168,  y + 74, 13, 700, 'rgba(190,205,225,.5)', 'center', 2.4);
    text(ctx, 'МИМО',  x + w - 60,   y + 74, 13, 700, 'rgba(190,205,225,.5)', 'center', 2.4);

    // Места считаем по текущему счёту, а не по порядку ходов — то же правило,
    // что на экране «Итоги»: сначала дошедшие до цели, затем больше попаданий,
    // при равенстве — меньше промахов.
    const fin = (t >= A1 || !n);
    const rankBy = st => list0.slice().sort((a, b) => {
      const sa = st[a.id] || { hits: 0, miss: 0 }, sb = st[b.id] || { hits: 0, miss: 0 };
      if (fin) {
        if (a.place && b.place) return a.place - b.place;
        if (a.place) return -1;
        if (b.place) return 1;
      }
      if (sb.hits !== sa.hits) return sb.hits - sa.hits;
      return sa.miss - sb.miss;
    }).reduce((mp, pl, i) => (mp[pl.id] = i, mp), {});

    // Строки не прыгают, а переезжают: считаем места до последнего броска и после,
    // и плавно ведём каждую строку между этими двумя позициями.
    const rNow = rankBy(stat), rPrev = rankBy(statPrev);
    const tShot = n ? A0 + done / n * (A1 - A0) : A0;
    const move = easeOut(clamp((t - tShot) / .34, 0, 1));
    const posOf = p => {
      const a = rPrev[p.id] || 0, b = rNow[p.id] || 0;
      return a + (b - a) * move;
    };

    const rowH = rowH0;
    const y0 = y + 108;

    // разделители — по фиксированным слотам, иначе они ездили бы вместе со строками
    for (let i = 0; i < list0.length - 1; i++) {
      ctx.strokeStyle = 'rgba(120,160,220,.08)'; ctx.beginPath();
      ctx.moveTo(x + 14, y0 + (i + 1) * rowH); ctx.lineTo(x + w - 14, y0 + (i + 1) * rowH); ctx.stroke();
    }

    // рисуем сверху вниз, чтобы разъезжающиеся строки перекрывались естественно
    const list = list0.slice().sort((a, b) => posOf(a) - posOf(b));

    list.forEach(p => {
      const st = stat[p.id] || { hits: 0, miss: 0 };
      const f = flash[p.id];
      const fk = f ? clamp(1 - (t - f.at) / .42, 0, 1) : 0;
      const pos = posOf(p);
      const i = Math.round(pos);
      const ry = y0 + pos * rowH;
      const cy = ry + rowH / 2;
      // пока строка переезжает — слегка приподнимаем её и подсвечиваем
      const moving = Math.min(1, Math.abs((rNow[p.id] || 0) - (rPrev[p.id] || 0))) * (1 - Math.abs(move * 2 - 1));
      if (moving > 0.01) {
        ctx.save();
        ctx.fillStyle = hexA((p.color || '#6cc9ff'), .10 * moving);
        rr(ctx, x + 8, ry + 3, w - 16, rowH - 6, 16); ctx.fill();
        ctx.restore();
      }

      if (fk > 0) {
        const col = f.hit ? '#4ade80' : '#fb7185';
        const g = ctx.createLinearGradient(x + 8, 0, x + w - 8, 0);
        g.addColorStop(0, hexA(col, .32 * fk)); g.addColorStop(1, hexA(col, 0));
        ctx.fillStyle = g; rr(ctx, x + 8, ry + 3, w - 16, rowH - 6, 16); ctx.fill();
        ctx.fillStyle = hexA(col, .35 + .65 * fk); rr(ctx, x + 8, ry + 3, 5, rowH - 6, 3); ctx.fill();
      }

      if (i === 0) gtext(ctx, '#1', x + 46, cy, 22, 800, '#ffe7a6', '#ffbf3d');
      else text(ctx, '#' + (i + 1), x + 46, cy, 22, 800, C.faint);

      const ar = Math.min(28, rowH * .33);
      drawAvatar(ctx, p, x + 96, cy, ar, fk * .8);
      const nick = p.nickname.length > 12 ? p.nickname.slice(0, 11) + '…' : p.nickname;
      ctx.save(); ctx.shadowColor = 'rgba(108,201,255,.3)'; ctx.shadowBlur = 12;
      text(ctx, nick, x + 96 + ar + 16, cy - (p.left ? 11 : 0), 23, 700, C.cyan2, 'left');
      ctx.restore();
      if (p.left) text(ctx, 'ВЫШЕЛ', x + 96 + ar + 16, cy + 17, 12, 700, C.muted, 'left', 1.6);

      const bump = (fk > 0 && f.hit) ? 1 + fk * .18 : 1;
      ctx.save();
      ctx.translate(x + w - 168, cy); ctx.scale(bump, bump);
      gtext(ctx, String(st.hits), 0, 0, 34, 800, '#ffd695', '#ff8a2e');
      ctx.restore();
      text(ctx, String(st.miss), x + w - 60, cy, 24, 700, 'rgba(255,255,255,.4)');
    });
    ctx.restore();
  }

  /* --- Сцена 2: остался только победитель, реплей его бросков --- */
  function drawReel(ctx, d, t, alpha) {
    const p = d.winner; if (!p) return;
    ctx.save(); ctx.globalAlpha = alpha;

    const n = d.winShots.length;
    const done = n ? clamp(Math.floor((t - R0) / (R1 - R0) * n), 0, n) : 0;
    let hits = 0, miss = 0, run = 0, best = 0, lastAt = -9, lastHit = false;
    for (let i = 0; i < done; i++) {
      const s = d.winShots[i];
      if (s.action === 'hit') { hits++; run++; if (run > best) best = run; }
      else { miss++; run = 0; }
      lastAt = R0 + (i + 1) / n * (R1 - R0); lastHit = s.action === 'hit';
    }
    if (t >= R1 || !n) { hits = p.hits; miss = p.misses; best = p.best; }
    const fk = clamp(1 - (t - lastAt) / .38, 0, 1);

    const x = 36, w = W - 72, y = 344, h = 736;
    ctx.fillStyle = 'rgba(18,28,42,.66)';
    ctx.save(); ctx.shadowColor = 'rgba(0,0,0,.4)'; ctx.shadowBlur = 40; ctx.shadowOffsetY = 18;
    rr(ctx, x, y, w, h, 26); ctx.fill(); ctx.restore();
    ctx.strokeStyle = C.hair; ctx.lineWidth = 1;
    rr(ctx, x, y, w, h, 26); ctx.stroke();

    if (fk > 0) {
      ctx.save();
      rr(ctx, x, y, w, h, 26); ctx.clip();
      const g = ctx.createRadialGradient(W / 2, y + 190, 10, W / 2, y + 190, 360);
      g.addColorStop(0, hexA(lastHit ? '#4ade80' : '#fb7185', .22 * fk));
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
      ctx.restore();
    }

    text(ctx, 'ЛИДЕР МАТЧА', W / 2, y + 40, 14, 800, C.gold, 'center', 4);
    drawAvatar(ctx, p, W / 2, y + 152, 72, .5 + fk * .5);
    ctx.save(); ctx.shadowColor = 'rgba(108,201,255,.35)'; ctx.shadowBlur = 20;
    text(ctx, p.nickname, W / 2, y + 264, 40, 800, C.cyan2);
    ctx.restore();

    const bump = 1 + (lastHit ? fk * .13 : 0);
    const hw = measure(ctx, String(hits), 92, 800);
    ctx.save(); ctx.translate(W / 2 - 40, y + 360); ctx.scale(bump, bump);
    gtext(ctx, String(hits), 0, 0, 92, 800, '#ffd695', '#ff8a2e');
    ctx.restore();
    text(ctx, '/ ' + miss, W / 2 - 40 + hw / 2 + 20, y + 378, 30, 700, 'rgba(255,255,255,.38)', 'left');
    text(ctx, 'ПОПАДАНИЙ  ·  ПРОМАХОВ', W / 2, y + 430, 13, 700, C.faint, 'center', 3);

    if (best > 1) {
      const label = (run > 1 ? run : best) + ' ПОДРЯД';
      const tw = measure(ctx, label, 17, 800) + 76;
      const bx = W / 2 - tw / 2, by = y + 460;
      ctx.fillStyle = hexA('#ff7a45', run > 1 ? .26 : .13);
      ctx.strokeStyle = hexA('#ff7a45', .5); ctx.lineWidth = 1;
      rr(ctx, bx, by, tw, 42, 21); ctx.fill(); ctx.stroke();
      emoji(ctx, '🔥', bx + 27, by + 21, 21);
      text(ctx, label, bx + 48, by + 21, 17, 800, C.accent2, 'left', 1.4);
    }

    // лента бросков: по квадратику на каждый бросок победителя
    if (n) {
      const cols = clamp(Math.ceil(Math.sqrt(n * 2.6)), 8, 20);
      const gap = 5;
      const cell = clamp(Math.floor((w - 60 - gap * (cols - 1)) / cols), 8, 26);
      const rows = Math.ceil(n / cols);
      const gw = cols * cell + (cols - 1) * gap;
      const gx = W / 2 - gw / 2, gy = y + h - 42 - rows * (cell + gap);
      for (let i = 0; i < n; i++) {
        const cxx = gx + (i % cols) * (cell + gap);
        const cyy = gy + Math.floor(i / cols) * (cell + gap);
        const on = i < done;
        const isHit = d.winShots[i].action === 'hit';
        ctx.fillStyle = !on ? 'rgba(255,255,255,.07)'
          : (isHit ? hexA('#4ade80', i === done - 1 ? .95 : .58) : hexA('#fb7185', .42));
        rr(ctx, cxx, cyy, cell, cell, 5); ctx.fill();
      }
    }
    ctx.restore();
  }

  /* --- Сцена 3: замедленный решающий бросок --- */
  function drawSlowMo(ctx, d, t) {
    const local = t - T_SLOW;
    const p = clamp(local / SHOT_FLY, 0, 1);
    const e = ease(p);
    const scored = local >= SHOT_FLY;
    const after = local - SHOT_FLY;

    const s = 1.85, rimX = W / 2, rimY = 22 + 152 * s;
    const wob = scored ? Math.sin(clamp(after, 0, .8) * 22) * Math.exp(-after * 5) * .55 : 0;
    drawHoop(ctx, W / 2, 22, s, scored ? '#4ade80' : null, wob);

    text(ctx, 'РЕШАЮЩИЙ БРОСОК', W / 2, 648, 17, 800,
         'rgba(255,255,255,' + (0.3 + clamp(local, 0, .5)).toFixed(2) + ')', 'center', 8);

    // траектория — парабола снизу в кольцо, с небольшим уходом влево
    const bx = k => { const u = 1 - k; return u * u * (W / 2 - 120) + 2 * u * k * (W / 2 - 70) + k * k * rimX; };
    const by = k => { const u = 1 - k; return u * u * (H - 120) + 2 * u * k * (rimY - 560) + k * k * rimY; };

    if (!scored) {
      for (let i = 5; i >= 1; i--) {   // шлейф — намёк на смазку движения
        const k = clamp(e - i * .06, 0, 1);
        ctx.save(); ctx.globalAlpha = .09 * (1 - i / 6);
        drawBall(ctx, bx(k), by(k), 42, k * 5);
        ctx.restore();
      }
      drawBall(ctx, bx(e), by(e), 46, e * 5.2);
    } else {
      const f = clamp(after / .55, 0, 1);
      if (f < 1) drawBall(ctx, rimX, rimY + f * 220, 46 * (1 - f * .3), 5.2 + f * 2);
      const fl = clamp(1 - after / .3, 0, 1);
      if (fl > 0) { ctx.fillStyle = hexA('#ffffff', .3 * fl); ctx.fillRect(0, 0, W, H); }
      const rk = clamp(after / .7, 0, 1);
      if (rk < 1) {
        ctx.save();
        ctx.strokeStyle = hexA('#4ade80', .55 * (1 - rk));
        ctx.lineWidth = 10 * (1 - rk);
        ctx.beginPath(); ctx.arc(rimX, rimY, 40 + rk * 420, 0, Math.PI * 2); ctx.stroke();
        ctx.restore();
      }
    }

    if (d.winner) {
      ctx.save(); ctx.globalAlpha = clamp(local * 2, 0, 1);
      drawAvatar(ctx, d.winner, W / 2, H - 215, 46, scored ? 1 : .3);
      text(ctx, d.winner.nickname, W / 2, H - 132, 30, 800, C.cyan2);
      ctx.restore();
    }
  }

  /* --- Сцена 4: карточка победителя --- */
  function drawWinner(ctx, d, t) {
    const p = d.winner; if (!p) return;
    const local = t - T_WIN;
    const col = pColor(p);

    const g = ctx.createRadialGradient(W / 2, 420, 20, W / 2, 420, 540);
    g.addColorStop(0, hexA(col, .2)); g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);

    const nm = (d.name || 'Матч').toUpperCase();
    text(ctx, nm.length > 24 ? nm.slice(0, 23) + '…' : nm, W / 2, 106, 17, 700, C.faint, 'center', 4);

    const inA = clamp(local / .45, 0, 1), pop = easeOut(inA);
    ctx.save(); ctx.globalAlpha = inA;
    emoji(ctx, '👑', W / 2, 232 - (1 - pop) * 40, Math.round(92 * (0.7 + pop * .3)));
    ctx.restore();

    ctx.save();
    ctx.translate(W / 2, 418); ctx.scale(.86 + pop * .14, .86 + pop * .14); ctx.translate(-W / 2, -418);
    drawAvatar(ctx, p, W / 2, 418, 106, 1 + Math.sin(local * 2.2) * .25);
    ctx.restore();

    ctx.save(); ctx.shadowColor = hexA(col, .5); ctx.shadowBlur = 26;
    text(ctx, p.nickname, W / 2, 578, 54, 800, C.cyan2);
    ctx.restore();
    text(ctx, 'ПОБЕДИТЕЛЬ', W / 2, 628, 15, 800, C.gold, 'center', 6);

    const sA = clamp((local - .25) / .4, 0, 1);
    ctx.save(); ctx.globalAlpha = sA;
    const hw = measure(ctx, String(p.hits), 76, 800);
    gtext(ctx, String(p.hits), W / 2 - 46, 722, 76, 800, '#ffd695', '#ff8a2e');
    text(ctx, '/ ' + p.misses, W / 2 - 46 + hw / 2 + 18, 734, 30, 700, 'rgba(255,255,255,.38)', 'left');
    text(ctx, 'ПОПАДАНИЙ  ·  ПРОМАХОВ', W / 2, 782, 13, 700, C.faint, 'center', 3);

    if (p.best > 0) {
      const label = 'МАКС. СЕРИЯ  ' + p.best;
      const tw = measure(ctx, label, 18, 800) + 86;
      const bx = W / 2 - tw / 2, by = 818;
      ctx.fillStyle = hexA('#ff7a45', .18);
      ctx.strokeStyle = hexA('#ff7a45', .5); ctx.lineWidth = 1;
      rr(ctx, bx, by, tw, 48, 24); ctx.fill(); ctx.stroke();
      emoji(ctx, '🔥', bx + 31, by + 24, 23);
      text(ctx, label, bx + 54, by + 24, 18, 800, C.accent2, 'left', 2);
    }
    ctx.restore();

    // ☠️ по центру — финальный акцент
    const kA = clamp((local - .55) / .5, 0, 1);
    if (kA > 0) {
      const k = easeOut(kA);
      const puls = 1 + Math.sin(local * 2.6) * .04;
      ctx.save();
      ctx.globalAlpha = kA;
      ctx.shadowColor = 'rgba(255,255,255,.35)'; ctx.shadowBlur = 40 * k;
      emoji(ctx, '☠️', W / 2, 1032, Math.round(200 * (0.55 + k * .45) * puls));
      ctx.restore();
    }
    const dt = typeof formatDate === 'function' ? formatDate(d.time) : '';
    text(ctx, dt, W / 2, 1204, 15, 600, C.faint, 'center', 2);
  }

  /* --- Сборка кадра --- */
  // Плёночное зерно. Тайлы рисуем один раз и крутим по кругу — генерировать
  // шум на каждый кадр в полном разрешении слишком дорого для записи в реальном времени.
  let grainTiles = null;
  function makeGrain() {
    grainTiles = [];
    for (let k = 0; k < 4; k++) {
      const g = document.createElement('canvas'); g.width = 180; g.height = 320;
      const gx = g.getContext('2d');
      const img = gx.createImageData(g.width, g.height);
      for (let i = 0; i < img.data.length; i += 4) {
        const v = 110 + ((i * 2654435761 + k * 40503) % 91);   // без Math.random — кадры воспроизводимы
        img.data[i] = img.data[i + 1] = img.data[i + 2] = v; img.data[i + 3] = 255;
      }
      gx.putImageData(img, 0, 0);
      grainTiles.push(g);
    }
  }
  function drawGrain(ctx, t, alpha) {
    if (alpha <= 0.005) return;
    if (!grainTiles) makeGrain();
    ctx.save();
    ctx.globalCompositeOperation = 'overlay';
    ctx.globalAlpha = alpha;
    ctx.drawImage(grainTiles[Math.floor(t * 24) % grainTiles.length], 0, 0, W, H);
    ctx.restore();
  }

  /* Аура: радиальное сияние и вращающиеся лучи за объектом. Рисуется ПОД сценой,
     цвет берём у победителя — это то самое «свечение», на котором держится стиль. */
  function drawAura(g, d, t, pop, nrg) {
    const col = (d.winner && d.winner.color) || '#ff8a2e';
    const cx = W / 2;
    const win = t >= T_WIN;
    const cy = win ? 430 : H * 0.56;          // на реплее «объект» — само табло
    const R  = (win ? 560 : 520) * (0.84 + 0.2 * pop + 0.1 * nrg);
    const k  = (0.35 + 0.65 * pop) * (win ? 1 : 1.6);   // на реплее сияние заметнее

    g.save();
    g.globalCompositeOperation = 'lighter';
    const rg = g.createRadialGradient(cx, cy, 0, cx, cy, R);
    rg.addColorStop(0,   hexA(col, .30 * k));
    rg.addColorStop(.35, hexA(col, .12 * k));
    rg.addColorStop(1,   hexA(col, 0));
    g.fillStyle = rg;
    g.beginPath(); g.arc(cx, cy, R, 0, Math.PI * 2); g.fill();

    // лучи-сияние, медленно вращаются
    g.translate(cx, cy); g.rotate(t * 0.30);
    const n = 20;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const len = R * (0.72 + 0.34 * Math.abs(Math.sin(i * 2.7 + t * 1.4)));
      const wd  = 0.018 + 0.026 * ((i % 3) / 3);
      const lg = g.createLinearGradient(0, 0, Math.cos(a) * len, Math.sin(a) * len);
      lg.addColorStop(0,   hexA(col, 0));
      lg.addColorStop(.3,  hexA(col, .13 * k));
      lg.addColorStop(1,   hexA(col, 0));
      g.fillStyle = lg;
      g.beginPath(); g.moveTo(0, 0);
      g.lineTo(Math.cos(a - wd) * len, Math.sin(a - wd) * len);
      g.lineTo(Math.cos(a + wd) * len, Math.sin(a + wd) * len);
      g.closePath(); g.fill();
    }
    g.restore();
  }

  /* Свечение (bloom): яркие места растекаются светом. Считаем на уменьшенной
     копии — размывать кадр 720×1280 на каждом кадре не успеть в реальном времени. */
  let bloomC = null, bloomX = null;
  function drawBloom(ctx, oc, alpha, punch) {
    if (alpha <= 0.01 || !('filter' in ctx)) return;
    if (!bloomC) {
      bloomC = document.createElement('canvas');
      bloomC.width = Math.round(W / 4); bloomC.height = Math.round(H / 4);
      bloomX = bloomC.getContext('2d');
    }
    bloomX.clearRect(0, 0, bloomC.width, bloomC.height);
    bloomX.filter = 'brightness(1.45) saturate(1.8) contrast(1.2)';
    bloomX.drawImage(oc, 0, 0, bloomC.width, bloomC.height);
    bloomX.filter = 'none';
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    ctx.globalAlpha = alpha;
    ctx.filter = 'blur(9px)';
    ctx.translate(W / 2, H / 2); ctx.scale(punch, punch); ctx.translate(-W / 2, -H / 2);
    ctx.drawImage(bloomC, 0, 0, W, H);
    ctx.restore();
  }

  // Тряска камеры на удар — детерминированная, чтобы кадры не «шумели» случайно
  function shakeAt(t, pop) {
    if (pop < 0.35) return { x: 0, y: 0, r: 0 };
    const f = Math.floor(t * FPS);
    const s = (n) => ((Math.sin(n * 12.9898) * 43758.5453) % 1 + 1) % 1 - 0.5;
    const amp = (pop - 0.35) * 18;
    return { x: s(f) * amp, y: s(f + 7.3) * amp, r: s(f + 19.1) * amp * 0.0016 };
  }

  function drawFrame(ctx, oc, occ, d, t) {
    const beat = beatAt(t), nrg = nrgAt(t);
    const pop = clamp(beat * 1.7, 0, 1);
    const canFilter = 'filter' in ctx;

    // 1) базовая сцена — в офскрин, её можно обесцветить целиком
    occ.clearRect(0, 0, W, H);
    drawBg(occ);
    if (t < T_SLOW || t >= T_WIN) drawAura(occ, d, t, pop, nrg);   // сияние за сценой

    let bwFlash = 0;
    if (t < T_WIN) {
      drawHead(occ, d);
      if (t < T_BW) {
        drawBoard(occ, d, t, 1);
      } else if (t < T_BW + BW_LEN) {
        // Табло гаснет, победитель проявляется — но не одновременно,
        // чтобы слои не наложились кашей под чёрно-белой вспышкой.
        const k = (t - T_BW) / BW_LEN;
        if (k < .5) drawBoard(occ, d, t, 1 - easeOut(k / .5));
        else        drawReel(occ, d, t, easeOut((k - .5) / .5));
        bwFlash = k < .35 ? k / .35 : clamp(1 - (k - .35) / .5, 0, 1);
      } else {
        drawReel(occ, d, t, 1);
      }
    } else {
      drawWinner(occ, d, t);
    }

    // 2) блит: цвет и масштаб живут по битам трека
    // Между ударами кадр уходит в серое, на удар возвращается в цвет.
    // Это и есть «то серо, то обычно» — ровно в такт фонку.
    let grey;
    if (t >= T_SLOW && t < T_WIN)      grey = 1;                        // слоу-мо: полностью серо
    else if (bwFlash > 0)              grey = Math.max(bwFlash, 0.6);   // вспышка на 26-й
    // Без разбора трека (звук не загрузился) не сереем вообще — иначе весь ролик был бы блёклым
    else if (!AF)                      grey = 0;
    // pop — резкая кривая: чуть тише удара, и кадр уже уезжает в ч/б
    else if (t >= T_WIN)               grey = 0.45 * Math.pow(1 - pop, 1.2);  // победитель — мягче
    else                               grey = 0.95 * Math.pow(1 - pop, 1.2);  // основная часть — качает
    const sat = 1 + 0.75 * pop;        // на удар цвета ещё и насыщеннее
    const bright = 1 + 0.22 * pop;

    const punch = 1 + 0.05 * pop + 0.014 * nrg;   // подскок кадра на удар
    const sh = shakeAt(t, pop);                   // тряска камеры на удар
    const cam = c => {                            // общая «камера» для всех слоёв
      c.translate(W / 2 + sh.x, H / 2 + sh.y); c.rotate(sh.r); c.scale(punch, punch);
      c.translate(-W / 2, -H / 2);
    };

    ctx.clearRect(0, 0, W, H);
    ctx.save();
    if (canFilter) ctx.filter = 'grayscale(' + grey.toFixed(3) + ') saturate(' + sat.toFixed(2)
      + ') brightness(' + bright.toFixed(2) + ')';
    cam(ctx);
    ctx.drawImage(oc, 0, 0);
    ctx.restore();

    // 2b) свечение поверх — то самое «ауровое» растекание света
    drawBloom(ctx, oc, (0.10 + 0.16 * pop) * (1 - grey * 0.55) * (t >= T_WIN ? 0.6 : 1), punch);

    // RGB-сдвиг на сильных ударах — фонковая «глючность»
    if (canFilter && pop > 0.55 && grey < 0.85) {
      const dx = (pop - 0.55) * 9;
      ctx.save();
      ctx.globalCompositeOperation = 'lighter';
      ctx.globalAlpha = (pop - 0.55) * 0.4;
      cam(ctx);
      ctx.filter = 'grayscale(1) sepia(1) hue-rotate(-40deg) saturate(7)';
      ctx.drawImage(oc, -dx, 0);
      ctx.filter = 'grayscale(1) sepia(1) hue-rotate(150deg) saturate(7)';
      ctx.drawImage(oc, dx, 0);
      ctx.restore();
    }

    // 3) слой поверх: затемнение + слоу-мо в цвете
    if (t >= T_SLOW && t < T_WIN) {
      // фон почти в ноль — на экране должен читаться только бросок
      ctx.fillStyle = 'rgba(10,12,17,.9)'; ctx.fillRect(0, 0, W, H);
      drawSlowMo(ctx, d, t);
    }

    // 3b) неоновый градиент поверх кадра: фиолет сверху, циан снизу.
    // Между ударами тянет картинку в холодный неон, на удар почти уходит.
    if (t < T_SLOW || t >= T_WIN) {
      const ng = ctx.createLinearGradient(0, 0, W * .35, H);
      ng.addColorStop(0,  'rgba(150,90,255,1)');
      ng.addColorStop(.5, 'rgba(255,110,60,1)');
      ng.addColorStop(1,  'rgba(60,200,255,1)');
      ctx.save();
      ctx.globalCompositeOperation = 'soft-light';
      ctx.globalAlpha = 0.26 - 0.14 * pop;
      ctx.fillStyle = ng; ctx.fillRect(0, 0, W, H);
      ctx.restore();
    }

    // 4) виньетка дышит: на удар раскрывается, между ударами сжимается
    const vIn = H * (.36 - .07 * pop), vOut = H * (.80 - .05 * pop);
    const vg = ctx.createRadialGradient(W / 2, H / 2, vIn, W / 2, H / 2, vOut);
    vg.addColorStop(0, 'rgba(0,0,0,0)');
    vg.addColorStop(1, 'rgba(0,0,0,' + (.5 + .16 * (1 - pop)).toFixed(2) + ')');
    ctx.fillStyle = vg; ctx.fillRect(0, 0, W, H);

    // 4b) вспышка на самых мощных ударах + зерно, чтобы картинка не была стерильной
    if (pop > 0.8) {
      ctx.fillStyle = 'rgba(255,255,255,' + ((pop - 0.8) * 0.22).toFixed(3) + ')';
      ctx.fillRect(0, 0, W, H);
    }
    drawGrain(ctx, t, 0.035 + 0.04 * (1 - pop));
    ctx.save(); ctx.globalAlpha = .5;
    emoji(ctx, '🏀', W / 2 - 64, H - 36, 20);
    text(ctx, 'БАСКЕТБОЛ', W / 2 + 14, H - 36, 14, 800, C.muted, 'center', 4);
    ctx.restore();
  }

  /* ================= ЗВУК =================
     Музыку берём из вшитого куска (audio-clip.js, 18 с с 22-й секунды трека)
     и декодируем в AudioBuffer.
     Через <audio> + createMediaElementSource делать НЕЛЬЗЯ: если mp3 лежит
     рядом на file:// или на другом origin, узел по правилам CORS отдаёт в граф
     тишину — видео писалось немым. Декодированный буфер таких ограничений не
     имеет, и заодно не надо тянуть полный трек ради 18 секунд.                    */
  async function setupAudio() {
    try {
      if (!AC) AC = new (window.AudioContext || window.webkitAudioContext)();
      if (AC.state === 'suspended') await AC.resume();
      if (!gainNode) {
        gainNode  = AC.createGain();
        audioDest = AC.createMediaStreamDestination();
        monitor   = AC.createAnalyser(); monitor.fftSize = 2048;
        gainNode.connect(audioDest);
        gainNode.connect(AC.destination);
        gainNode.connect(monitor);       // чтобы поймать немую дорожку и честно об этом сказать
      }
      if (!audioBuf) {
        const data = await loadClipScript();
        if (data) {
          const bytes = await (await fetch(data)).arrayBuffer();
          audioBuf = await AC.decodeAudioData(bytes);
          analyzeAudio(audioBuf);
        }
      }
      return !!audioBuf;
    } catch (e) { return false; }
  }

  // audio-clip.js весит ~400 КБ — грузим его только когда реально собираем видео,
  // а не при каждом открытии страницы. <script> (а не fetch) — чтобы работало и на file://.
  let clipScriptPromise = null;
  function loadClipScript() {
    if (typeof VIDEO_AUDIO_CLIP !== 'undefined') return Promise.resolve(VIDEO_AUDIO_CLIP);
    if (!clipScriptPromise) {
      clipScriptPromise = new Promise(res => {
        const sc = document.createElement('script');
        sc.src = AUDIO_CLIP_SCRIPT;
        sc.onload = () => res(typeof VIDEO_AUDIO_CLIP !== 'undefined' ? VIDEO_AUDIO_CLIP : null);
        sc.onerror = () => { clipScriptPromise = null; sc.remove(); res(null); };
        document.head.appendChild(sc);
      });
    }
    return clipScriptPromise;
  }

  /* Разбор трека: громкость и удары. По ним вся картинка потом «дышит» —
     на удар кадр вспыхивает цветом и подпрыгивает, между ударами уходит в серое. */
  function analyzeAudio(buf) {
    try {
      const sr = buf.sampleRate, hop = 512;
      const chans = [];
      for (let c = 0; c < buf.numberOfChannels; c++) chans.push(buf.getChannelData(c));
      const n = Math.floor(buf.length / hop);
      const rms = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let s = 0;
        const from = i * hop, to = from + hop;
        for (let j = from; j < to; j++) {
          let v = 0;
          for (let c = 0; c < chans.length; c++) v += chans[c][j];
          v /= chans.length; s += v * v;
        }
        rms[i] = Math.sqrt(s / hop);
      }
      // поток нарастаний громкости = моменты ударов
      const flux = new Float32Array(n);
      for (let i = 1; i < n; i++) flux[i] = Math.max(0, rms[i] - rms[i - 1]);
      const sorted = Array.from(flux).sort((a, b) => a - b);
      const hi = sorted[Math.floor(n * 0.97)] || 1;
      const loud = sorted.length ? (Array.from(rms).sort((a, b) => a - b)[Math.floor(n * 0.9)] || 1) : 1;
      // затухающий след от каждого удара — чтобы вспышка не была в один кадр
      const pulse = new Float32Array(n);
      const decay = 0.90;
      for (let i = 0; i < n; i++) {
        const hit = clamp(flux[i] / hi, 0, 1);
        pulse[i] = Math.max(hit, i ? pulse[i - 1] * decay : 0);
      }
      // Нормализация «по месту»: у трека тихий вход, и в начале удары слабее.
      // Делим на локальный максимум в окне ±1.5 с — тогда качает и на тихих кусках.
      const win = Math.round(1.5 / (hop / sr));
      const norm = new Float32Array(n);
      for (let i = 0; i < n; i++) {
        let mx = 0;
        const from = Math.max(0, i - win), to = Math.min(n - 1, i + win);
        for (let j = from; j <= to; j += 4) if (pulse[j] > mx) mx = pulse[j];
        norm[i] = clamp(pulse[i] / Math.max(mx, 0.05), 0, 1);
      }
      const nrg = new Float32Array(n);
      for (let i = 0; i < n; i++) nrg[i] = clamp(rms[i] / loud, 0, 1);
      AF = { pulse: norm, nrg, step: hop / sr, n };
    } catch (e) { AF = null; }
  }

  function sampleAF(arr, t) {
    if (!AF || !arr) return 0;
    const i = Math.round(t / AF.step);
    if (i < 0 || i >= AF.n) return 0;
    return arr[i];
  }
  const beatAt = t => sampleAF(AF && AF.pulse, t);   // 0..1 — удар только что был
  const nrgAt  = t => sampleAF(AF && AF.nrg,   t);   // 0..1 — насколько сейчас громко

  function startMusic() {
    if (!audioBuf || !gainNode) return;
    stopMusic();
    srcNode = AC.createBufferSource();
    srcNode.buffer = audioBuf;
    srcNode.connect(gainNode);
    const t = AC.currentTime;
    gainNode.gain.cancelScheduledValues(t);
    gainNode.gain.setValueAtTime(0.0001, t);
    gainNode.gain.linearRampToValueAtTime(1, t + 0.35);
    gainNode.gain.setValueAtTime(1, t + DUR - 1.2);
    gainNode.gain.linearRampToValueAtTime(0.0001, t + DUR - 0.05);
    srcNode.start(t);                        // буфер уже начинается с 22-й секунды трека
  }

  function stopMusic() {
    if (srcNode) { try { srcNode.stop(); } catch (e) {} try { srcNode.disconnect(); } catch (e) {} srcNode = null; }
  }

  /* ================= ЗАПИСЬ ================= */
  function pickMime() {
    if (!window.MediaRecorder) return null;
    // MP4 в приоритете: WebM от MediaRecorder пишется без длительности в
    // заголовке, из-за чего галерея телефона и Windows-плееры показывают 00:00
    // и часто вообще не проигрывают звуковую дорожку. MP4 таких проблем не имеет.
    const list = ['video/mp4;codecs=avc1.42E01E,mp4a.40.2', 'video/mp4;codecs=avc1,mp4a.40.2',
                  'video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm'];
    for (let i = 0; i < list.length; i++) {
      try { if (MediaRecorder.isTypeSupported(list[i])) return list[i]; } catch (e) {}
    }
    return '';
  }

  function preloadPhotos(d) {
    const jobs = d.players.filter(p => p.photo && !photoCache[p.photo]).map(p => new Promise(res => {
      const img = new Image();
      img.onload = img.onerror = () => res();
      photoCache[p.photo] = img;
      img.src = p.photo;
    }));
    return Promise.all(jobs);
  }

  /* ================= UI ================= */
  const ui = {};
  function cacheUI() {
    ui.back = $('#video-backdrop'); ui.canvas = $('#video-canvas'); ui.video = $('#video-result');
    ui.overlay = $('#video-overlay'); ui.hint = $('#video-hint'); ui.bar = $('#video-bar');
    ui.status = $('#video-status'); ui.save = $('#video-save'); ui.again = $('#video-again');
    ui.close = $('#video-close'); ui.title = $('#video-title');
  }

  function setProgress(p) { if (ui.bar) ui.bar.style.width = (p * 100).toFixed(1) + '%'; }
  function setHint(txt, show) {
    if (!ui.overlay) return;
    ui.overlay.hidden = !show;
    if (txt && ui.hint) ui.hint.textContent = txt;
  }

  function resetUI() {
    setProgress(0);
    ui.video.hidden = true; ui.canvas.hidden = false;
    ui.save.hidden = true; ui.again.hidden = true;
    ui.status.textContent = 'Не переключайся на другие вкладки — запись идёт в реальном времени';
    if (blobUrl) { URL.revokeObjectURL(blobUrl); blobUrl = null; }
    blob = null;
  }

  function close() {
    cancelled = true; running = false;
    stopMusic();
    if (ui.video) { try { ui.video.pause(); } catch (e) {} }
    if (ui.back) ui.back.hidden = true;
  }

  /* ================= ГЕНЕРАЦИЯ ================= */
  async function generate() {
    if (running || !source) return;
    running = true; cancelled = false;
    resetUI();

    const d = source;
    const ctx = ui.canvas.getContext('2d');
    const oc = document.createElement('canvas'); oc.width = W; oc.height = H;
    const occ = oc.getContext('2d');

    setHint('Готовим кадры…', true);
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
    await preloadPhotos(d);
    drawFrame(ctx, oc, occ, d, 0);           // прогрев шрифтов и картинок
    if (cancelled) { running = false; return; }

    setHint('Загружаем музыку…', true);
    const haveAudio = await setupAudio();
    if (cancelled) { running = false; return; }

    const mime = pickMime();
    const canRecord = mime !== null && typeof ui.canvas.captureStream === 'function';

    let rec = null;
    const chunks = [];
    if (canRecord) {
      try {
        const stream = ui.canvas.captureStream(FPS);
        if (haveAudio && audioDest) audioDest.stream.getAudioTracks().forEach(tr => stream.addTrack(tr));
        rec = new MediaRecorder(stream, mime
          ? { mimeType: mime, videoBitsPerSecond: 6000000, audioBitsPerSecond: 128000 }
          : undefined);
        rec.ondataavailable = e => { if (e.data && e.data.size) chunks.push(e.data); };
      } catch (e) { rec = null; }
    }

    silent = false;
    if (haveAudio) {
      try { startMusic(); } catch (e) {}
      // Через пару секунд смотрим, идёт ли по графу реальный сигнал. Если нет —
      // скажем об этом сразу, а не после скачивания немого файла.
      setTimeout(() => {
        if (!monitor || cancelled) return;
        const b = new Float32Array(monitor.fftSize);
        monitor.getFloatTimeDomainData(b);
        let peak = 0; for (let i = 0; i < b.length; i++) { const q = Math.abs(b[i]); if (q > peak) peak = q; }
        if (peak < 0.005) silent = true;
      }, 2000);
    }

    setHint('', false);
    if (rec) { try { rec.start(200); } catch (e) { rec = null; } }
    if (!rec) ui.status.textContent = 'Браузер не умеет записывать видео — показываю ролик как есть. Для скачивания открой в Chrome.';

    const t0 = performance.now();
    await new Promise(resolve => {
      let done = false, raf = 0, wd = 0, lastDraw = t0;
      const finishUp = () => {
        if (done) return;
        done = true;
        cancelAnimationFrame(raf); clearInterval(wd);
        resolve();
      };
      const tick = () => {
        if (done) return;
        if (cancelled) return finishUp();
        const now = performance.now();
        lastDraw = now;
        const t = (now - t0) / 1000;
        if (t >= DUR) { drawFrame(ctx, oc, occ, d, DUR - 0.001); setProgress(1); return finishUp(); }
        drawFrame(ctx, oc, occ, d, t);
        setProgress(t / DUR);
        if (rec) ui.status.textContent = 'Записываю…  ' + t.toFixed(1) + ' / ' + DUR + ' с — не сворачивай вкладку';
        else     ui.status.textContent = 'Проигрываю…  ' + t.toFixed(1) + ' / ' + DUR + ' с';
        cancelAnimationFrame(raf);
        raf = requestAnimationFrame(tick);
      };
      // Если вкладку свернули, requestAnimationFrame замирает: кадры перестают
      // рисоваться и генерация висела бы вечно. Таймер добивает кадры сам.
      wd = setInterval(() => {
        if (done) return;
        if (performance.now() - lastDraw > 400) tick();
      }, 250);
      raf = requestAnimationFrame(tick);
    });

    stopMusic();

    if (cancelled) {
      if (rec && rec.state !== 'inactive') { try { rec.stop(); } catch (e) {} }
      running = false;
      return;
    }

    if (rec) {
      await new Promise(res => { rec.onstop = res; try { rec.stop(); } catch (e) { res(); } });
      const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
      blob = new Blob(chunks, { type });
      blobUrl = URL.createObjectURL(blob);
      const ext = type.indexOf('mp4') !== -1 ? 'mp4' : 'webm';
      const safe = (d.name || 'match').replace(/[^\wА-Яа-яЁё\- ]+/g, '').trim().replace(/\s+/g, '_') || 'match';
      fileName = safe + '_' + new Date(d.time).toISOString().slice(0, 10) + '.' + ext;

      ui.canvas.hidden = true;
      ui.video.hidden = false;
      ui.video.src = blobUrl;
      ui.video.controls = true;
      try { await ui.video.play(); } catch (e) {}
      ui.save.hidden = false;
      ui.status.textContent = 'Готово · ' + DUR + ' с · ' + (blob.size / 1048576).toFixed(1) + ' МБ'
        + (!haveAudio ? ' · без звука: трек не загрузился'
          : silent    ? ' · ⚠️ звук не записался'
                      : ' · со звуком 🎵');
    } else {
      ui.status.textContent = 'Ролик показан. Скачивание в этом браузере недоступно.';
    }
    ui.again.hidden = false;
    running = false;
  }

  /* ================= ПУБЛИЧНОЕ API ================= */
  function open(src, titleTxt) {
    cacheUI();
    if (!ui.back) return;
    if (!src || !src.players || !src.players.length) {
      showAlert('В этом матче ещё нет данных для ролика', '🎬');
      return;
    }
    if (!src.shots.length) {
      showAlert('Ещё не было ни одного броска — ролик собирать не из чего', '🎬');
      return;
    }
    source = src;
    ui.title.textContent = titleTxt || 'Видео матча';
    ui.back.hidden = false;
    cancelled = false;
    generate();
  }

  function save() {
    if (!blob || !blobUrl) return;
    const a = document.createElement('a');
    a.href = blobUrl; a.download = fileName;
    document.body.appendChild(a); a.click(); a.remove();
  }

  function bind() {
    cacheUI();
    if (!ui.back) return;
    ui.close.addEventListener('click', close);
    ui.back.addEventListener('click', e => { if (e.target.id === 'video-backdrop') close(); });
    ui.save.addEventListener('click', save);
    ui.again.addEventListener('click', () => {
      if (running) return;
      ui.video.hidden = true; ui.canvas.hidden = false;
      generate();
    });
  }

  // Отладка: нарисовать один кадр на секунде t (без записи и звука)
  async function _frame(src, t) {
    cacheUI();
    ui.back.hidden = false; setHint('', false);
    ui.video.hidden = true; ui.canvas.hidden = false;
    try { if (document.fonts && document.fonts.ready) await document.fonts.ready; } catch (e) {}
    await preloadPhotos(src);
    const ctx = ui.canvas.getContext('2d');
    const oc = document.createElement('canvas'); oc.width = W; oc.height = H;
    drawFrame(ctx, oc, oc.getContext('2d'), src, t);
    return true;
  }

  return { open, bind, fromMatch, fromHistory, _frame, _af: () => AF,
           isRunning: function () { return running; } };
})();
