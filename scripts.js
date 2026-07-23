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

/* ---------- Глобальное состояние ---------- */
const state = {
  userId: null,
  nickname: null,
  avatar: null,
  color: null,
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

/* ================================================================
   УТИЛИТЫ
   ================================================================ */
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

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
const AVATARS = ['🏀','🔥','⚡','🐉','🦁','🦅','🐺','🦈','👑','⭐','💪','🎯','🚀','🐻','🦊','😎','👽','🤖','🐸','🦖','🍀','🌟'];
const COLORS  = ['#ff6a2b','#ff556a','#ffd257','#2fe08a','#45d6ff','#9d8bff','#ff8ac2','#5bd1c4','#a3e635','#f97316','#38bdf8','#c084fc'];

let regAvatar = AVATARS[0];   // выбор при регистрации
let regColor  = COLORS[0];
let profAvatar = AVATARS[0];  // выбор в модалке профиля
let profColor  = COLORS[0];

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
function faceOf(obj)  { return escapeHtml((obj && obj.avatar) || ((obj && obj.nickname) ? obj.nickname.charAt(0) : '?')); }
function avatarBg(color) { const c = color || '#888'; return `background:linear-gradient(135deg, ${c}, ${shade(c, -30)});`; }
function hexA(hex, a) { const n = parseInt((hex || '#888888').slice(1), 16); return `rgba(${n >> 16},${(n >> 8) & 255},${n & 255},${a})`; }

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
  if (ev.action === 'hit')       { Sound.hit();    animateShot(true, ev.userId); }
  else if (ev.action === 'miss') { Sound.miss();   animateShot(false, ev.userId); }
  else if (ev.action === 'finish') { Sound.finish(); }
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

function animateShot(make, scorerUid) {
  const scr = $('#screen-match'), ball = $('#match-ball'), hoop = $('#hoop-svg');
  if (!scr || !ball || !hoop) return;
  const reduce = matchMedia('(prefers-reduced-motion:reduce)').matches;
  if (reduce) { if (make) { netSwish(); bumpScore(scorerUid); } popMatch(make ? '+1' : 'МИМО', make ? 'make' : 'miss'); return; }
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
    else make ? ballDrop(x, y, scorerUid) : ballDeflect(x, y);
  })(t0);
}
function ballDrop(x, y, scorerUid) {
  const ball = $('#match-ball'); netSwish();
  const t0 = performance.now();
  (function f(now) {
    let p = (now - t0) / 220; if (p > 1) p = 1;
    ball.style.transform = `translate(${x}px,${y + p * 70}px) scale(${1 - p * .55})`;
    ball.style.opacity = 1 - p;
    if (p < 1) requestAnimationFrame(f);
    else { ball.style.opacity = 0; popMatch('+1', 'make'); bumpScore(scorerUid); }
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
  let muted = localStorage.getItem('bb_muted') === '1';

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
    toggle() { muted = !muted; localStorage.setItem('bb_muted', muted ? '1' : '0'); return muted; },
    click()  { if (!muted) tone(330, 0, 0.05, 'square', 0.05, 240); },
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

/* ================================================================
   ИНИЦИАЛИЗАЦИЯ
   ================================================================ */
document.addEventListener('DOMContentLoaded', init);

function init() {
  bindEvents();
  updateSoundIcon();
  setupRegPickers();
  const uid = localStorage.getItem('bb_userId');
  const nick = localStorage.getItem('bb_nickname');
  if (uid && nick) {
    state.userId = uid;
    state.nickname = nick;
    resumeUser().then(resumeOrMenu);
  } else {
    showScreen('screen-login');
    $('#login-nick').focus();
  }
}

async function resumeUser() {
  const snap = await db.ref('users/' + state.userId).get();
  if (!snap.exists()) {
    // Аккаунт удалён из БД — вернём на экран входа
    localStorage.clear();
    showScreen('screen-login');
    throw new Error('account-missing');
  }
  const u = snap.val();
  state.avatar = u.avatar || avatarFromString(state.userId);
  state.color  = u.color  || colorFromString(u.nickname || state.nickname);
  if (!u.avatar || !u.color) db.ref('users/' + state.userId).update({ avatar: state.avatar, color: state.color });
  setupPresence();
}

// Если был активный матч — вернуться в него, иначе меню
async function resumeOrMenu() {
  const activeId = localStorage.getItem('bb_activeMatch');
  if (activeId) {
    const snap = await db.ref('matches/' + activeId).get();
    const m = snap.val();
    const me = m && m.players && m.players[state.userId];
    if (m && m.status !== 'finished' && me && me.status === 'joined' && !me.left) {
      enterMatch(activeId);
      return;
    }
    localStorage.removeItem('bb_activeMatch');
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
  $('#logout-btn').addEventListener('click', logout);
  $('#history-btn').addEventListener('click', openHistory);
  $('#sound-btn').addEventListener('click', toggleSound);

  // --- Звук клика на любых кнопках (везде) ---
  document.addEventListener('pointerdown', e => {
    Sound.resume();
    if (e.target.closest('.btn, .btn-icon, .choice-card, .user-row, .auth-tab')) Sound.click();
  });

  // --- Навигация "назад в меню" ---
  $$('[data-nav="menu"]').forEach(b => b.addEventListener('click', goMenu));

  // --- Мастер: переходы между шагами ---
  $$('[data-goto]').forEach(b => b.addEventListener('click', () => {
    const target = +b.dataset.goto;
    if (target === 3 && !state.wizard.goalType) { flash(b, 'Выбери цель'); return; }
    goToStep(target);
  }));

  // --- Шаг 2: выбор цели ---
  $$('[data-goal]').forEach(card => card.addEventListener('click', () => {
    $$('[data-goal]').forEach(c => c.classList.remove('selected'));
    card.classList.add('selected');
    state.wizard.goalType = card.dataset.goal;
    $('#target-wrap').hidden = (card.dataset.goal !== 'common');
  }));

  // --- Шаг 2: степпер цели ---
  $$('[data-target]').forEach(b => b.addEventListener('click', () => {
    const inp = $('#target-input');
    let v = (parseInt(inp.value, 10) || 1) + (+b.dataset.target);
    v = Math.max(1, Math.min(99, v));
    inp.value = v; state.wizard.targetHits = v;
  }));
  $('#target-input').addEventListener('input', e => {
    state.wizard.targetHits = Math.max(1, Math.min(99, parseInt(e.target.value, 10) || 1));
  });

  // --- Шаг 3: поиск / отправка ---
  $('#user-search').addEventListener('input', renderUserList);
  $('#send-invites-btn').addEventListener('click', createMatch);

  // --- Лобби ---
  $('#start-btn').addEventListener('click', startMatch);
  $('#lobby-leave-btn').addEventListener('click', leaveLobby);

  // --- Матч ---
  $('#btn-hit').addEventListener('click', () => recordShot('hit'));
  $('#btn-miss').addEventListener('click', () => recordShot('miss'));
  $('#finish-btn').addEventListener('click', finishMatch);
  $('#leave-btn').addEventListener('click', leaveMatch);

  // --- Результаты ---
  $('#results-menu-btn').addEventListener('click', goMenu);

  // --- Модалка ---
  $('#modal-ok').addEventListener('click', () => closeModal(true));
  $('#modal-cancel').addEventListener('click', () => closeModal(false));
  $('#modal-backdrop').addEventListener('click', e => { if (e.target.id === 'modal-backdrop') closeModal(false); });

  // --- Профиль (аватар/цвет) ---
  $('#menu-avatar').addEventListener('click', openProfile);
  $('#profile-save').addEventListener('click', saveProfile);
  $('#profile-cancel').addEventListener('click', () => { $('#profile-backdrop').hidden = true; });
  $('#profile-backdrop').addEventListener('click', e => { if (e.target.id === 'profile-backdrop') $('#profile-backdrop').hidden = true; });
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
  el.textContent = regAvatar;
  el.style.background = `linear-gradient(135deg, ${regColor}, ${shade(regColor, -30)})`;
}

/* ---------- Модалка профиля ---------- */
function openProfile() {
  if (!state.userId) return;
  profAvatar = state.avatar || AVATARS[0];
  profColor  = state.color  || COLORS[0];
  const upd = () => {
    const el = $('#profile-preview');
    el.textContent = profAvatar;
    el.style.background = `linear-gradient(135deg, ${profColor}, ${shade(profColor, -30)})`;
  };
  buildEmojiGrid($('#profile-emoji'), () => profAvatar, em => { profAvatar = em; upd(); });
  buildColorGrid($('#profile-color'), () => profColor,  col => { profColor = col; upd(); });
  upd();
  $('#profile-backdrop').hidden = false;
}
async function saveProfile() {
  state.avatar = profAvatar;
  state.color = profColor;
  await db.ref('users/' + state.userId).update({ avatar: profAvatar, color: profColor });
  $('#profile-backdrop').hidden = true;
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
        avatar: regAvatar, color: regColor,
        stats: { matches: 0, hits: 0, misses: 0 }
      });
      state.avatar = regAvatar; state.color = regColor;
      loginLocal(userId, nick);
    } else {
      if (!found) { err.textContent = 'Аккаунт не найден — зарегистрируйся'; return; }
      const [uid, u] = found;
      if (!u.pin) {
        // Легаси-аккаунт без PIN (создан до ввода PIN) — привязываем PIN при первом входе
        await db.ref('users/' + uid + '/pin').set(hashPin(pin));
      } else if (u.pin !== hashPin(pin)) {
        err.textContent = 'Неверный PIN-код'; return;
      }
      // Аватар/цвет: берём из аккаунта, легаси без них — авто-назначаем
      state.avatar = u.avatar || avatarFromString(uid);
      state.color  = u.color  || colorFromString(u.nickname);
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
  localStorage.setItem('bb_userId', userId);
  localStorage.setItem('bb_nickname', nick);
  state.userId = userId;
  state.nickname = nick;
  setupPresence();
  $('#login-pin').value = '';
  goMenu();
}

async function logout() {
  if (!await showConfirm('Выйти из аккаунта?', 'Выйти', '⎋')) return;
  try { await db.ref('users/' + state.userId + '/online').set(false); } catch (e) {}
  stopMenuWatch();
  stopMatchWatch();
  localStorage.removeItem('bb_userId');
  localStorage.removeItem('bb_nickname');
  localStorage.removeItem('bb_activeMatch');
  state.userId = null; state.nickname = null; state.currentMatchId = null;
  setAuthMode('login');
  $('#login-nick').value = ''; $('#login-pin').value = '';
  showScreen('screen-login');
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
  state.currentMatchId = null;
  localStorage.removeItem('bb_activeMatch');
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
  av.textContent = (u.avatar || (u.nickname || '?').charAt(0));
  av.style.background = `linear-gradient(135deg, ${colorOf(u)}, ${shade(colorOf(u), -30)})`;
  const st = u.stats || {};
  $('#menu-stat-matches').textContent = st.matches || 0;
  $('#menu-stat-acc').textContent = accuracy(st.hits, st.misses) + '%';
}

function renderInvites(obj) {
  const list = $('#invites-list');
  const empty = $('#invites-empty');
  list.innerHTML = '';
  const entries = obj ? Object.entries(obj) : [];
  empty.style.display = entries.length ? 'none' : 'block';

  // Звук при появлении нового приглашения
  if (prevInviteCount >= 0 && entries.length > prevInviteCount) Sound.notify();
  prevInviteCount = entries.length;

  entries.forEach(([matchId, inv]) => {
    const typeLabel = inv.goalType === 'common' ? 'Общая цель' : 'Обычный матч';
    const creator = { nickname: inv.creatorNickname, avatar: inv.creatorAvatar, color: inv.creatorColor };
    const card = document.createElement('div');
    card.className = 'invite-card';
    card.innerHTML = `
      <div class="avatar" style="${avatarBg(colorOf(creator))}">${faceOf(creator)}</div>
      <div class="info">
        <div class="who">${escapeHtml(inv.creatorNickname || '—')}</div>
        <div class="sub">Приглашает в матч · ${typeLabel}</div>
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
  if (!m || m.status !== 'lobby') { showAlert('Матч уже начался или отменён', '⚠️'); return; }
  await db.ref('matches/' + matchId + '/players/' + state.userId)
    .update({ status: 'joined', joinedAt: TS, avatar: state.avatar || null, color: state.color || null });
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
  state.wizard = { goalType: null, targetHits: 10, selected: {} };
  $$('[data-goal]').forEach(c => c.classList.remove('selected'));
  $('#target-wrap').hidden = true;
  $('#target-input').value = 10;
  $('#user-search').value = '';
  goToStep(1);
  showScreen('screen-create');
  loadUsersForWizard();
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
      else state.wizard.selected[uid] = { nickname: u.nickname, avatar: u.avatar || null, color: u.color || null };
      renderUserList();
    });
    list.appendChild(row);
  });

  if (!list.children.length) list.innerHTML = '<div class="empty">Никого не найдено</div>';
}

async function createMatch() {
  const selectedIds = Object.keys(state.wizard.selected);
  if (!selectedIds.length) { showAlert('Выбери хотя бы одного игрока', '👥'); return; }
  if (!state.wizard.goalType) { showAlert('Не выбран тип матча', '🎯'); return; }

  const matchId = db.ref('matches').push().key;

  const players = {};
  players[state.userId] = {
    nickname: state.nickname, avatar: state.avatar || null, color: state.color || null,
    status: 'joined', hits: 0, misses: 0, streak: 0, joinedAt: TS
  };
  selectedIds.forEach(uid => {
    const sel = state.wizard.selected[uid];
    players[uid] = {
      nickname: sel.nickname, avatar: sel.avatar || null, color: sel.color || null,
      status: 'waiting', hits: 0, misses: 0, streak: 0
    };
  });

  const match = {
    creatorId: state.userId,
    type: 'normal',
    goalType: state.wizard.goalType,                                    // 'common' | 'individual'
    targetHits: state.wizard.goalType === 'common' ? state.wizard.targetHits : null,
    status: 'lobby',
    players,
    currentTurnIndex: 0,
    createdAt: TS
  };
  await db.ref('matches/' + matchId).set(match);

  const updates = {};
  selectedIds.forEach(uid => {
    updates['invites/' + uid + '/' + matchId] = {
      creatorNickname: state.nickname, creatorAvatar: state.avatar || null, creatorColor: state.color || null,
      goalType: state.wizard.goalType, timestamp: TS
    };
  });
  await db.ref().update(updates);

  enterMatch(matchId);
}

/* ================================================================
   ВХОД В МАТЧ + РОУТИНГ ПО СТАТУСУ
   ================================================================ */
function enterMatch(matchId) {
  stopMenuWatch();
  stopMatchWatch();
  state.currentMatchId = matchId;
  lastEventTime = null;   // не проигрывать анимации для уже существующих событий
  confettiFor = null;
  prevMatchStatus = null;
  localStorage.setItem('bb_activeMatch', matchId);
  matchWatchRef = db.ref('matches/' + matchId);
  matchWatchRef.on('value', onMatchValue);
}

function stopMatchWatch() {
  if (matchWatchRef) { matchWatchRef.off(); matchWatchRef = null; }
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
  const isCreator = m.creatorId === state.userId;
  const creatorNick = (m.players[m.creatorId] || {}).nickname || '—';

  $('#lobby-title').textContent = isCreator ? 'Твоё лобби' : 'Лобби · ' + creatorNick;
  $('#lobby-info').textContent = m.goalType === 'common'
    ? `🎯 На цель — каждому нужно набрать ${m.targetHits} попаданий`
    : '🔥 Свободный матч — заканчивает создатель, побеждает лучший счёт';

  const box = $('#lobby-players');
  box.innerHTML = '';
  let joinedOthers = 0;

  Object.entries(m.players).forEach(([uid, p]) => {
    if (uid !== m.creatorId && p.status === 'joined') joinedOthers++;
    let badge;
    if (uid === m.creatorId)          badge = '<span class="badge creator">создатель</span>';
    else if (p.status === 'joined')   badge = '<span class="badge joined">присоединился</span>';
    else if (p.status === 'declined') badge = '<span class="badge declined">отклонил</span>';
    else                              badge = '<span class="badge waiting">ожидание</span>';
    const row = document.createElement('div');
    row.className = 'lobby-row';
    row.innerHTML = `
      <div class="l-avatar" style="${avatarBg(colorOf(p))}">${faceOf(p)}</div>
      <span class="l-name">${escapeHtml(p.nickname)}</span>${badge}`;
    box.appendChild(row);
  });

  const startBtn = $('#start-btn');
  if (isCreator) {
    startBtn.style.display = 'block';
    startBtn.disabled = joinedOthers < 1;
    startBtn.textContent = joinedOthers < 1 ? 'Ждём игроков...' : 'Начать матч';
  } else {
    startBtn.style.display = 'none';
  }
}

async function startMatch() {
  const mid = state.currentMatchId;
  const snap = await db.ref('matches/' + mid).get();
  const m = snap.val();
  if (!m) return;

  const joined = Object.entries(m.players)
    .filter(([, p]) => p.status === 'joined')
    .sort((a, b) => (a[1].joinedAt || 0) - (b[1].joinedAt || 0));
  const turnOrder = joined.map(([uid]) => uid);

  const updates = {
    ['matches/' + mid + '/status']: 'active',
    ['matches/' + mid + '/turnOrder']: turnOrder,
    ['matches/' + mid + '/currentTurnIndex']: 0
  };
  Object.entries(m.players).forEach(([uid, p]) => {
    if (p.status === 'waiting') {
      updates['invites/' + uid + '/' + mid] = null;
      updates['matches/' + mid + '/players/' + uid + '/status'] = 'declined';
    }
  });
  await db.ref().update(updates);

  db.ref('matches/' + mid + '/events').push({ time: Date.now(), userId: '', action: 'start', text: '🏀 Матч начался!' });
}

// Выход из ЛОББИ (до старта): создатель отменяет матч, остальные — просто уходят.
async function leaveLobby() {
  const mid = state.currentMatchId;
  const snap = await db.ref('matches/' + mid).get();
  const m = snap.val();
  if (m && m.creatorId === state.userId) {
    const updates = { ['matches/' + mid]: null };
    Object.keys(m.players || {}).forEach(uid => { updates['invites/' + uid + '/' + mid] = null; });
    await db.ref().update(updates);
  } else if (m) {
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
  ensureNet();
  const order = m.turnOrder || [];
  const activeId = order[m.currentTurnIndex];
  const isMyTurn = activeId === state.userId;
  const isCreator = m.creatorId === state.userId;
  const isCommon = m.goalType === 'common';

  // Кто бросает
  const activeNick = (m.players[activeId] || {}).nickname || '—';
  const turnEl = $('#match-turn');
  if (isMyTurn) { turnEl.innerHTML = 'Твой бросок'; turnEl.classList.add('my'); }
  else { turnEl.innerHTML = `Бросает <b>${escapeHtml(activeNick)}</b>`; turnEl.classList.remove('my'); }

  $('#match-target').textContent = isCommon ? `ТАБЛО · ДО ${m.targetHits}` : 'ТАБЛО · СВОБОДНЫЙ';

  // Рейтинг-таблица: сортировка по попаданиям
  const rows = order.map(uid => ({ uid, p: m.players[uid] })).filter(x => x.p)
    .sort((a, b) => (b.p.hits || 0) - (a.p.hits || 0) || (b.p.streak || 0) - (a.p.streak || 0));
  const leadUid = rows.length && (rows[0].p.hits || 0) > 0 ? rows[0].uid : null;

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
    const row = document.createElement('div');
    row.className = 'trow' + (active ? ' active' : '') + (i === 0 ? ' top1' : '') + (done ? ' done' : '');
    row.innerHTML = `
      <div class="rank">#${i + 1}</div>
      <div class="who">
        <div class="ava" style="--ring:${color};--glow:${hexA(color, active ? .7 : .26)};background:${hexA(color, .16)}">${faceOf(p)}</div>
        <div class="nm"><div class="name">${escapeHtml(p.nickname)}</div>${badge}</div>
      </div>
      <div class="hits" id="mh-${uid}">${p.hits || 0}</div>
      <div class="strk">${strk}</div>`;
    tb.appendChild(row);
  });

  // Анимация нового события (у всех клиентов)
  const events = m.events ? Object.values(m.events) : [];
  events.sort((a, b) => (b.time || 0) - (a.time || 0));
  const newest = events[0];
  if (newest && lastEventTime !== null && newest.time > lastEventTime) triggerShotFeedback(newest);
  if (newest) lastEventTime = Math.max(lastEventTime || 0, newest.time || 0);

  // Кнопки броска — только активному игроку
  const me = m.players[state.userId];
  const canShoot = isMyTurn && me && !me.finished && !me.left;
  $('#btn-hit').disabled = !canShoot;
  $('#btn-miss').disabled = !canShoot;
  $('#finish-btn').hidden = !isCreator;   // ⏹ Завершить — только создателю; ⏸ Выйти — всем
}

/* Записать бросок — в транзакции (защита от гонок) */
function recordShot(result) {
  const mid = state.currentMatchId;
  const ref = db.ref('matches/' + mid);
  const k1 = db.ref('matches/' + mid + '/events').push().key;
  const k2 = db.ref('matches/' + mid + '/events').push().key;
  const now = Date.now();

  ref.transaction(m => {
    if (!m || m.status !== 'active') return m;
    const order = m.turnOrder || [];
    if (order[m.currentTurnIndex] !== state.userId) return; // не мой ход — отмена
    const p = m.players[state.userId];
    if (!p || p.finished || p.left) return;
    if (!m.events) m.events = {};

    let advance = false;
    if (result === 'hit') {
      p.hits = (p.hits || 0) + 1;
      p.streak = (p.streak || 0) + 1;
      m.events[k1] = { time: now, userId: state.userId, action: 'hit',
        text: `${p.nickname} попал${p.streak > 1 ? ' — ' + p.streak + ' подряд' : ''}` };
      if (m.goalType === 'common' && m.targetHits && p.hits >= m.targetHits) {
        p.finished = true;
        const finishedCount = Object.values(m.players).filter(x => x.finished).length;
        p.place = finishedCount;
        m.events[k2] = { time: now + 1, userId: state.userId, action: 'finish',
          text: `🏁 ${p.nickname} достиг цели — место #${finishedCount}` };
        advance = true;
      }
    } else {
      p.misses = (p.misses || 0) + 1;
      p.streak = 0;
      m.events[k1] = { time: now, userId: state.userId, action: 'miss', text: `${p.nickname} промахнулся` };
      advance = true;
    }

    if (advance) {
      const next = findNextTurn(m, m.currentTurnIndex);
      if (next === -1) { m.status = 'finished'; m.winnerId = computeWinner(m); m.finishedAt = now; }
      else m.currentTurnIndex = next;
    }
    return m;
  });
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

function winnerByPlace(m) {
  for (const [uid, p] of Object.entries(m.players)) if (p.place === 1) return uid;
  return null;
}

// Победитель: место #1, иначе лучший счёт среди участников
function computeWinner(m) {
  const byPlace = winnerByPlace(m);
  if (byPlace) return byPlace;
  const order = m.turnOrder || Object.keys(m.players);
  let best = null;
  order.forEach(uid => {
    const p = m.players[uid];
    if (!p) return;
    if (!best) { best = uid; return; }
    const bp = m.players[best];
    if ((p.hits || 0) > (bp.hits || 0) ||
        ((p.hits || 0) === (bp.hits || 0) && (p.misses || 0) < (bp.misses || 0))) best = uid;
  });
  return best;
}

/* Завершить матч вручную (создатель) */
async function finishMatch() {
  if (!await showConfirm('Завершить матч для всех? Счёт зафиксируется как есть.', 'Завершить', '🏁')) return;
  await db.ref('matches/' + state.currentMatchId).transaction(m => {
    if (!m || m.status === 'finished') return m;
    m.status = 'finished';
    m.winnerId = computeWinner(m);
    m.finishedAt = Date.now();
    return m;
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
      if (playing <= 1) { m.status = 'finished'; m.winnerId = computeWinner(m); m.finishedAt = Date.now(); }
      else if (wasActive) {
        const next = findNextTurn(m, m.currentTurnIndex);
        if (next !== -1) m.currentTurnIndex = next;
      }
    }
    return m;
  });

  if (res.committed && res.snapshot && res.snapshot.exists()) {
    const m = res.snapshot.val();
    db.ref('matches/' + mid + '/events').push({
      time: Date.now(), userId: myId, action: 'leave', text: `${state.nickname} покинул матч`
    });
    // Засчитать матч в статистику + историю при выходе (если игра уже стартовала)
    if (m.turnOrder && m.turnOrder.indexOf(myId) >= 0) {
      await finalizePlayer(mid, myId, m);
    }
  }

  stopMatchWatch();
  localStorage.removeItem('bb_activeMatch');
  state.currentMatchId = null;
  goMenu();
}

/* ================================================================
   ЭКРАН 6 — РЕЗУЛЬТАТЫ
   ================================================================ */
function renderResults(m) {
  showScreen('screen-results');
  const order = m.turnOrder || Object.keys(m.players).filter(uid => m.players[uid].status === 'joined');

  const ranked = order.map(uid => ({ uid, p: m.players[uid] })).filter(x => x.p);
  ranked.sort((a, b) => {
    if (a.p.place && b.p.place) return a.p.place - b.p.place;
    if (a.p.place) return -1;
    if (b.p.place) return 1;
    if ((b.p.hits || 0) !== (a.p.hits || 0)) return (b.p.hits || 0) - (a.p.hits || 0);
    return (a.p.misses || 0) - (b.p.misses || 0);
  });

  const winner = m.players[m.winnerId];
  $('#results-winner').innerHTML = winner ? `
    <div class="cup">🏆</div>
    <div class="mini-av w-avatar" style="${avatarBg(colorOf(winner))}">${faceOf(winner)}</div>
    <div class="w-name">${escapeHtml(winner.nickname)}</div>
    <div class="w-sub">${winner.hits || 0} попаданий · точность ${accuracy(winner.hits, winner.misses)}%</div>
  ` : '<div class="cup">🏀</div><div class="w-name">Ничья</div>';

  const list = $('#results-list');
  list.innerHTML = '';
  ranked.forEach((x, i) => {
    const leftTag = x.p.left ? ' <span class="tag-left">(вышел)</span>' : '';
    const row = document.createElement('div');
    row.className = 'result-row' + (i === 0 && !x.p.left ? ' first' : '');
    row.innerHTML = `
      <div class="rank">${i + 1}</div>
      ${miniAvatar(x.p, true)}
      <div class="r-name">${escapeHtml(x.p.nickname)}${leftTag}</div>
      <div class="r-score"><b>${x.p.hits || 0}</b> / ${x.p.misses || 0} · ${accuracy(x.p.hits, x.p.misses)}%</div>`;
    list.appendChild(row);
  });

  // Конфетти + звук — один раз на матч
  if (confettiFor !== state.currentMatchId) {
    confettiFor = state.currentMatchId;
    if (winner) launchConfetti();
    if (m.winnerId === state.userId) Sound.win();
    else Sound.lose();
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
  db.ref('users/' + uid + '/stats').transaction(s => {
    s = s || { matches: 0, hits: 0, misses: 0 };
    s.matches = (s.matches || 0) + 1;
    s.hits    = (s.hits || 0) + (p.hits || 0);
    s.misses  = (s.misses || 0) + (p.misses || 0);
    return s;
  });

  // 2. Запись в историю этого игрока
  writeHistory(mid, uid, m);
}

function writeHistory(mid, uid, m) {
  const p = m.players[uid];
  const order = m.turnOrder || Object.keys(m.players);
  const roster = order.map(id => m.players[id]).filter(Boolean).map(x => ({
    nickname: x.nickname, avatar: x.avatar || null, color: x.color || null,
    hits: x.hits || 0, misses: x.misses || 0,
    place: x.place || null, left: !!x.left
  })).sort((a, b) => {
    if (a.place && b.place) return a.place - b.place;
    if (a.place) return -1;
    if (b.place) return 1;
    return (b.hits) - (a.hits);
  });

  let result;
  if (p.left && m.status !== 'finished') result = 'left';
  else if (m.winnerId === uid)           result = 'win';
  else                                   result = 'lose';

  const winner = m.players[m.winnerId];
  db.ref('history/' + uid + '/' + mid).set({
    time: m.finishedAt || Date.now(),
    goalType: m.goalType,
    targetHits: m.targetHits || null,
    result,
    place: p.place || null,
    myHits: p.hits || 0,
    myMisses: p.misses || 0,
    winnerNickname: winner ? winner.nickname : null,
    roster
  });
}

function finalizeAll(m) {
  const order = m.turnOrder || [];
  order.forEach(uid => { if (m.players[uid]) finalizePlayer(state.currentMatchId, uid, m); });
}

/* ================================================================
   ЭКРАН 7 — ИСТОРИЯ МАТЧЕЙ
   ================================================================ */
async function openHistory() {
  showScreen('screen-history');
  const list = $('#history-list');
  list.innerHTML = '';
  const snap = await db.ref('history/' + state.userId).get();
  renderHistory(snap.val());
}

function renderHistory(obj) {
  const list = $('#history-list');
  const empty = $('#history-empty');
  list.innerHTML = '';
  const entries = obj ? Object.values(obj) : [];
  entries.sort((a, b) => (b.time || 0) - (a.time || 0));
  empty.style.display = entries.length ? 'none' : 'block';

  entries.forEach(h => {
    const modeTxt = h.goalType === 'common'
      ? `🎯 На цель · ${h.targetHits}`
      : '🔥 Свободный';

    let resultTxt, resultCls;
    if (h.result === 'win')       { resultTxt = '🏆 Победа'; resultCls = 'win'; }
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

    const card = document.createElement('div');
    card.className = 'history-card ' + resultCls;
    card.innerHTML = `
      <div class="hc-top">
        <span class="hc-result">${resultTxt}</span>
        <span class="hc-date">${formatDate(h.time)}</span>
      </div>
      <div class="hc-mode">${modeTxt} · твой счёт: ${h.myHits} / ${h.myMisses}</div>
      <div class="hc-players">${players}</div>`;
    list.appendChild(card);
  });
}
