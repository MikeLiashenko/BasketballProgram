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

// Смещение серверных часов — чтобы таймер хода был одинаковым у всех клиентов
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
  if (obj && obj.photo) return `<img src="${obj.photo}" style="width:100%;height:100%;object-fit:cover;border-radius:inherit;display:block;border:none;">`;
  return escapeHtml((obj && obj.avatar) || ((obj && obj.nickname) ? obj.nickname.charAt(0) : '?')); 
}

// Функция сжатия фото до 120x120 px
function compressImage(file, callback) {
  if (!file || !file.type.startsWith('image/')) return;
  const reader = new FileReader();
  reader.onload = e => {
    const img = new Image();
    img.onload = () => {
      const cvs = document.createElement('canvas');
      const max = 120;
      let w = img.width, h = img.height;
      if (w > h) { if (w > max) { h *= max / w; w = max; } } else { if (h > max) { w *= max / h; h = max; } }
      cvs.width = w; cvs.height = h;
      cvs.getContext('2d').drawImage(img, 0, 0, w, h);
      callback(cvs.toDataURL('image/jpeg', 0.85)); // Переводим в легкий base64
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}
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
  state.photo  = u.photo || null;
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
  $('#mymatches-btn').addEventListener('click', openMyMatches);
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

  // --- Модалка «Ход матча» (полный лог из истории) ---
  $('#log-close').addEventListener('click', () => { $('#log-backdrop').hidden = true; });
  $('#log-backdrop').addEventListener('click', e => { if (e.target.id === 'log-backdrop') $('#log-backdrop').hidden = true; });

  // --- Модалка редактирования матча ---
  $('#edit-save').addEventListener('click', saveEditMatch);
  $('#edit-cancel').addEventListener('click', () => { $('#edit-backdrop').hidden = true; editingMatchId = null; });
  $('#edit-backdrop').addEventListener('click', e => { if (e.target.id === 'edit-backdrop') { $('#edit-backdrop').hidden = true; editingMatchId = null; } });
}

/* Открыть полный лог хода матча (из карточки истории) */
function openMatchLog(events) {
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
  $('#profile-backdrop').hidden = false;
}

async function saveProfile() {
  state.avatar = profAvatar;
  state.color = profColor;
  state.photo = profPhoto;
  await db.ref('users/' + state.userId).update({ avatar: profAvatar, color: profColor, photo: profPhoto });
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
  stopTurnTimer();
  stopLobbyTimer();
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
  av.innerHTML = faceOf(u);
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

  if (!m || m.status === 'finished') { showAlert('Матч уже завершён', '⚠️'); return; }

  if (m.status === 'lobby') {
    // Обычный вход в лобби
    await db.ref('matches/' + matchId + '/players/' + state.userId)
      .update({ status: 'joined', joinedAt: TS, avatar: state.avatar || null, color: state.color || null, photo: state.photo || null });
    enterMatch(matchId);
    return;
  }

  // Матч уже идёт — присоединяемся на ходу (поздний вход)
  const now = Date.now();
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
  state.wizard = { goalType: null, targetHits: 10, scorer: 'shooter', turnSeconds: 0, name: '', selected: {} };
  // Выбираем визуально "Обычный" тип по умолчанию
  $('#type-normal').classList.add('selected');
  $$('[data-goal]').forEach(c => c.classList.remove('selected'));
  $('#target-wrap').hidden = true;
  $('#target-input').value = 10;
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
      else state.wizard.selected[uid] = { nickname: u.nickname, avatar: u.avatar || null, color: u.color || null, photo: u.photo || null };
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
    status: 'joined', hits: 0, misses: 0, streak: 0, joinedAt: TS
  };
  selectedIds.forEach(uid => {
    const sel = state.wizard.selected[uid];
    players[uid] = {
      nickname: sel.nickname, avatar: sel.avatar || null, color: sel.color || null, photo: sel.photo || null,
      status: 'waiting', hits: 0, misses: 0, streak: 0
    };
  });

  const match = {
    creatorId: state.userId,
    name: matchName,
    startAt: startAt || null,
    type: 'normal',
    goalType: state.wizard.goalType,                                    // 'common' | 'individual'
    targetHits: state.wizard.goalType === 'common' ? state.wizard.targetHits : null,
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
  selectedIds.forEach(uid => {
    updates['invites/' + uid + '/' + matchId] = {
      name: matchName,
      startAt: startAt || null,
      creatorNickname: state.nickname, creatorAvatar: state.avatar || null, creatorColor: state.color || null,
      creatorPhoto: state.photo || null,
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
  stopTurnTimer();
  const isCreator = m.creatorId === state.userId;
  const creatorNick = (m.players[m.creatorId] || {}).nickname || '—';

  $('#lobby-title').textContent = m.name || (isCreator ? 'Твоё лобби' : 'Лобби · ' + creatorNick);
  let info = m.goalType === 'common'
    ? `🎯 На цель — каждому нужно набрать ${m.targetHits} попаданий`
    : '🔥 Свободный матч — заканчивает создатель, побеждает лучший счёт';
  if (m.turnSeconds) info += ` · ⏱ ${m.turnSeconds}с на ход`;
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
    row.innerHTML = `
      <div class="l-avatar" style="${avatarBg(colorOf(p))}">${faceOf(p)}</div>
      <span class="l-name">${escapeHtml(p.nickname)}</span>${badge}`;
    box.appendChild(row);
  });

  lobbyMatch = m;
  refreshStartBtn();
  if (!lobbyIntervalId) lobbyIntervalId = setInterval(refreshStartBtn, 1000);
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
    // «Ожидающих» НЕ отклоняем и приглашения НЕ удаляем — они смогут
    // присоединиться к уже идущему матчу позже (поздний вход).
    started = true;
    return m;
  });

  if (started && res.committed && res.snapshot.exists()) {
    db.ref('matches/' + mid + '/events').push({ time: Date.now(), userId: '', action: 'start', text: '🏀 Матч начался!' });
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
  const order = m.turnOrder || [];
  const activeId = order[m.currentTurnIndex];
  const isMyTurn = activeId === state.userId;
  const isCreator = m.creatorId === state.userId;
  const isCommon = m.goalType === 'common';
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

  setupTurnTimer(m);

  const boardName = m.name || 'ТАБЛО';
  $('#match-target').textContent = isCommon ? `${boardName} · ДО ${m.targetHits}` : `${boardName} · СВОБОДНЫЙ`;

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
  if (lastEventTime !== null) {
    events.filter(ev => (ev.time || 0) > lastEventTime).forEach(triggerShotFeedback);
  }
  const newest = events[events.length - 1];
  if (newest) lastEventTime = Math.max(lastEventTime || 0, newest.time || 0);
  // Кнопки броска — только активному игроку
  const activePlayer = m.players[activeId];
  const canShoot = iAmScorer && activePlayer && !activePlayer.finished && !activePlayer.left;
  $('#btn-hit').disabled = !canShoot;
  $('#btn-miss').disabled = !canShoot;
  $('#finish-btn').hidden = !isCreator;   // ⏹ Завершить — только создателю; ⏸ Выйти — всем
}

/* Записать бросок — в транзакции (защита от гонок) */
/* Записать бросок — в транзакции (защита от гонок) */
/* Записать бросок — в транзакции (защита от гонок) */
function recordShot(result) {
  const mid = state.currentMatchId;
  const ref = db.ref('matches/' + mid);
  const now = Date.now();

  ref.transaction(m => {
    if (!m || m.status !== 'active') return m;

    // Чей сейчас ход
    const order = m.turnOrder || [];
    const activeUid = order[m.currentTurnIndex];

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

    let advance = false;
    const k1 = db.ref().push().key; 

    if (result === 'hit') {
      p.hits = (p.hits || 0) + 1;
      p.streak = (p.streak || 0) + 1;
      m.events[k1] = { time: now, userId: activeUid, action: 'hit',
        text: `${p.nickname} попал${p.streak > 1 ? ' — ' + p.streak + ' подряд' : ''}` };
      
      if (m.goalType === 'common' && m.targetHits && p.hits >= m.targetHits) {
        p.finished = true;
        const finishedCount = Object.values(m.players).filter(x => x.finished).length;
        p.place = finishedCount;
        
        const k2 = db.ref().push().key; 
        m.events[k2] = { time: now + 1, userId: activeUid, action: 'finish',
          text: `🏁 ${p.nickname} достиг цели — место #${finishedCount}` };
        advance = true;
      }
    } else {
      p.misses = (p.misses || 0) + 1;
      p.streak = 0;
      m.events[k1] = { time: now, userId: activeUid, action: 'miss', text: `${p.nickname} промахнулся` };
      advance = true;
    }

    if (advance) {
      const next = findNextTurn(m, m.currentTurnIndex);
      if (next === -1) { m.status = 'finished'; m.winnerId = computeWinner(m); m.finishedAt = now; }
      else m.currentTurnIndex = next;
    }
    // Сброс отсчёта хода на каждый бросок (и когда попал и продолжает, и при передаче хода)
    if (m.status === 'active') m.turnStartedAt = serverNow();
    return m;
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
  const on = m.status === 'active' && m.turnSeconds > 0 && m.turnStartedAt;
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
    if (rem <= 0) {
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
    if (!m || m.status !== 'active') return m;
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
    m.events[k] = { time: Date.now(), userId: activeUid, action: 'miss', text: `${p.nickname} не успел — промах` };

    const next = findNextTurn(m, m.currentTurnIndex);
    if (next === -1) { m.status = 'finished'; m.winnerId = computeWinner(m); m.finishedAt = Date.now(); }
    else { m.currentTurnIndex = next; m.turnStartedAt = serverNow(); }
    return m;
  });
}

function winnerByPlace(m) {
  for (const [uid, p] of Object.entries(m.players)) if (p.place === 1) return uid;
  return null;
}

// Победитель: место #1, иначе лучший счёт среди участников
// Победитель: место #1, иначе лучший счёт среди участников
function computeWinner(m) {
  const byPlace = winnerByPlace(m);
  if (byPlace) return byPlace;
  
  const order = m.turnOrder || Object.keys(m.players);
  let best = null;
  let isTie = false; // Флаг для отслеживания ничьей

  order.forEach(uid => {
    const p = m.players[uid];
    // Пропускаем несуществующих игроков и тех, кто вышел (p.left)
    if (!p || p.left) return;

    if (!best) { 
      best = uid; 
      isTie = false;
      return; 
    }
    
    const bp = m.players[best];
    const pHits = p.hits || 0;
    const pMiss = p.misses || 0;
    const bpHits = bp.hits || 0;
    const bpMiss = bp.misses || 0;

    if (pHits > bpHits || (pHits === bpHits && pMiss < bpMiss)) {
      // Найден новый лидер
      best = uid;
      isTie = false;
    } else if (pHits === bpHits && pMiss === bpMiss) {
      // Показатели абсолютно равны — фиксируем ничью
      isTie = true;
    }
  });

  // Если ничья, возвращаем null (это включит баннер "Ничья" на экране результатов)
  return isTie ? null : best;
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
        if (next !== -1) { m.currentTurnIndex = next; m.turnStartedAt = serverNow(); }
      }
    }
    return m;
  });

  if (res.committed && res.snapshot && res.snapshot.exists()) {
    const m = res.snapshot.val();
    db.ref('matches/' + mid + '/events').push({
      time: Date.now(), userId: myId, action: 'leave', text: `${state.nickname} вышел из матча`
    });
    // Финализируем (статистика + история), ТОЛЬКО если матч из-за выхода завершился.
    // Иначе матч продолжается и остаётся в «Мои матчи» — можно вернуться.
    if (m.status === 'finished') await finalizePlayer(mid, myId, m);
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
  stopTurnTimer();
  stopLobbyTimer();
  $('#results-title').textContent = m.name ? 'Итоги · ' + m.name : 'Итоги матча';
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
    nickname: x.nickname, avatar: x.avatar || null, color: x.color || null, photo: x.photo || null,
    hits: x.hits || 0, misses: x.misses || 0,
    place: x.place || null, left: !!x.left
  })).sort((a, b) => {
    if (a.place && b.place) return a.place - b.place;
    if (a.place) return -1;
    if (b.place) return 1;
    return (b.hits) - (a.hits);
  });

  let result;
  if (p.left)                  result = 'left';
  else if (m.winnerId === uid) result = 'win';
  else                         result = 'lose';

  // Полный лог хода матча — чтобы в истории открыть его целиком
  const events = (m.events ? Object.values(m.events) : [])
    .sort((a, b) => (a.time || 0) - (b.time || 0))
    .map(e => ({ action: e.action || '', text: e.text || '', time: e.time || 0 }));

  const winner = m.players[m.winnerId];
  db.ref('history/' + uid + '/' + mid).set({
    time: m.finishedAt || Date.now(),
    name: m.name || null,
    goalType: m.goalType,
    targetHits: m.targetHits || null,
    result,
    place: p.place || null,
    myHits: p.hits || 0,
    myMisses: p.misses || 0,
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

    const hasLog = Array.isArray(h.events) ? h.events.length : (h.events && Object.keys(h.events).length);
    const logBtn = hasLog ? '<button class="hc-log-btn">📜 Ход матча</button>' : '';

    const card = document.createElement('div');
    card.className = 'history-card ' + resultCls;
    card.innerHTML = `
      <div class="hc-top">
        <span class="hc-result">${resultTxt}</span>
        <span class="hc-date">${formatDate(h.time)}</span>
      </div>
      ${h.name ? `<div class="hc-name">${escapeHtml(h.name)}</div>` : ''}
      <div class="hc-mode">${modeTxt} · твой счёт: ${h.myHits} / ${h.myMisses}</div>
      <div class="hc-players">${players}</div>
      ${logBtn}`;
    if (hasLog) {
      const evs = Array.isArray(h.events) ? h.events : Object.values(h.events);
      card.querySelector('.hc-log-btn').addEventListener('click', () => openMatchLog(evs));
    }
    list.appendChild(card);
  });
  }

/* ================================================================
   ЭКРАН 8 — МОИ МАТЧИ (сохранённые/идущие, куда можно вернуться)
   ================================================================ */
async function openMyMatches() {
  showScreen('screen-mymatches');
  const list = $('#mymatches-list');
  list.innerHTML = '';
  const snap = await db.ref('matches').get();
  const all = snap.val() || {};
  const mine = [];
  for (const [id, m] of Object.entries(all)) {
    if (!m || !m.players || !m.players[state.userId]) continue;
    if (m.status === 'finished') {
      // Ленивая финализация: матч завершился, пока меня не было — засчитать в историю
      if (!m.players[state.userId].counted) finalizePlayer(id, state.userId, m);
      continue; // завершённые здесь не показываем — они в «Истории»
    }
    mine.push({ id, m });
  }
  mine.sort((a, b) => (b.m.createdAt || 0) - (a.m.createdAt || 0));
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
    const modeTxt = m.goalType === 'common' ? `🎯 до ${m.targetHits}` : '🔥 свободный';
    const timeTxt = m.startAt ? ` · 🕐 ${fmtClock(m.startAt)}` : '';

    const card = document.createElement('div');
    card.className = 'history-card';
    card.innerHTML = `
      <div class="hc-top">
        <span class="hc-result">${escapeHtml(m.name || 'Матч')}</span>
        <span class="mm-badges">${statusBadge}${roleBadge}${leftBadge}</span>
      </div>
      <div class="hc-mode">${modeTxt} · 👥 ${count}${timeTxt}</div>
      <div class="mm-actions"></div>`;
    const actions = card.querySelector('.mm-actions');

    const enterBtn = document.createElement('button');
    enterBtn.className = 'btn btn-accent mm-btn';
    enterBtn.textContent = me.left ? 'Вернуться' : (isLobby ? 'Открыть' : 'Продолжить');
    enterBtn.addEventListener('click', () => reenterMatch(id, m));
    actions.appendChild(enterBtn);

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
      mm.events[k] = { time: Date.now(), userId: state.userId, action: 'join', text: `${state.nickname} вернулся` };
      return mm;
    });
  }
  enterMatch(id);
}

async function deleteMatch(id, m) {
  if (!await showConfirm('Удалить матч? Он исчезнет у всех приглашённых.', 'Удалить', '🗑️')) return;
  const updates = { ['matches/' + id]: null };
  Object.keys(m.players || {}).forEach(uid => { updates['invites/' + uid + '/' + id] = null; });
  await db.ref().update(updates);
  openMyMatches();
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
