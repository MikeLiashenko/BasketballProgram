/* ================================================================
   Service worker: оболочка приложения работает офлайн.
   Данные матчей идут через Firebase по вебсокету — их мы не трогаем
   и не кэшируем, иначе игроки увидят устаревший счёт.
   ================================================================ */
const VERSION = 'v25';
const SHELL_CACHE = 'bb-shell-' + VERSION;
const RUNTIME_CACHE = 'bb-runtime-' + VERSION;

// Минимум, без которого приложение не откроется
const SHELL = ['./', './index.html', './style.css', './scripts.js', './icon.svg', './manifest.json'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      // addAll падает целиком, если хоть один файл не отдался, — кладём по одному
      .then(c => Promise.all(SHELL.map(u => c.add(u).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== SHELL_CACHE && k !== RUNTIME_CACHE).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('message', e => {
  if (e.data === 'skip-waiting') self.skipWaiting();
});

self.addEventListener('fetch', e => {
  const req = e.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);
  // Чужие домены (Firebase, шрифты Google) отдаём как есть — без нашего кэша
  if (url.origin !== self.location.origin) return;

  // HTML берём из сети: так обновление приложения доезжает сразу,
  // а кэш остаётся страховкой на случай офлайна.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req)
        .then(res => {
          const copy = res.clone();
          caches.open(SHELL_CACHE).then(c => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then(r => r || caches.match('./index.html')))
    );
    return;
  }

  // Остальная статика — из кэша, с тихим обновлением в фоне
  e.respondWith(
    caches.match(req).then(cached => {
      const network = fetch(req)
        .then(res => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(RUNTIME_CACHE).then(c => c.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});
