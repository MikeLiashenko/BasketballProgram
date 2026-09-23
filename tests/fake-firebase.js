// Мини-эмуляция Firebase RTDB в памяти — чтобы гонять логику приложения в браузере.
window.__DB = {};
(function () {
  let counter = 0;
  const now = () => Date.now();
  const clone = v => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const listeners = []; // {path, cb}

  function split(p) { return String(p || '').split('/').filter(Boolean); }
  function getAt(path) {
    let node = window.__DB;
    for (const k of split(path)) { if (node == null || typeof node !== 'object') return null; node = node[k]; }
    return node === undefined ? null : node;
  }
  function setAt(path, val) {
    const parts = split(path);
    if (!parts.length) { window.__DB = val == null ? {} : clone(val); return; }
    let node = window.__DB;
    for (let i = 0; i < parts.length - 1; i++) {
      if (typeof node[parts[i]] !== 'object' || node[parts[i]] === null) node[parts[i]] = {};
      node = node[parts[i]];
    }
    const last = parts[parts.length - 1];
    if (val === null || val === undefined) delete node[last];
    else node[last] = clone(val);
  }
  // Раскрываем метки времени сервера
  function resolveTS(v) {
    if (v && typeof v === 'object') {
      if (v.__ts__) return now();
      const out = Array.isArray(v) ? [] : {};
      for (const k in v) { const r = resolveTS(v[k]); if (r !== undefined) out[k] = r; }
      return out;
    }
    return v;
  }
  function fire() {
    listeners.slice().forEach(l => { try { l.cb(snapOf(l.path)); } catch (e) { console.error('listener', e); } });
  }
  function snapOf(path) {
    const v = getAt(path);
    return { val: () => clone(v), exists: () => v !== null && v !== undefined };
  }

  function Ref(path) {
    this.path = path;
    this.key = split(path).pop() || null;
  }
  Ref.prototype.child = function (p) { return new Ref(this.path ? this.path + '/' + p : p); };
  Ref.prototype.get = function () { return Promise.resolve(snapOf(this.path)); };
  Ref.prototype.once = function () { return this.get(); };
  Ref.prototype.set = function (v) { setAt(this.path, resolveTS(v)); fire(); return Promise.resolve(); };
  Ref.prototype.remove = function () { setAt(this.path, null); fire(); return Promise.resolve(); };
  Ref.prototype.update = function (obj) {
    // В корневом update ключи — это пути
    Object.entries(obj).forEach(([k, v]) => setAt(this.path ? this.path + '/' + k : k, resolveTS(v)));
    fire(); return Promise.resolve();
  };
  Ref.prototype.push = function (v) {
    const key = '-K' + String(++counter).padStart(8, '0');
    const child = this.child(key);
    if (v !== undefined) { setAt(child.path, resolveTS(v)); fire(); }
    return child;
  };
  Ref.prototype.transaction = function (fn) {
    const cur = clone(getAt(this.path));
    const res = fn(cur === null ? null : cur);
    if (res === undefined) {
      return Promise.resolve({ committed: false, snapshot: snapOf(this.path) });
    }
    setAt(this.path, resolveTS(res));
    fire();
    return Promise.resolve({ committed: true, snapshot: snapOf(this.path) });
  };
  Ref.prototype.on = function (ev, cb) { const l = { path: this.path, cb }; listeners.push(l); cb(snapOf(this.path)); this._l = l; return cb; };
  Ref.prototype.off = function () {
    for (let i = listeners.length - 1; i >= 0; i--) if (listeners[i].path === this.path) listeners.splice(i, 1);
  };
  Ref.prototype.onDisconnect = function () { return { set: () => Promise.resolve() }; };

  const database = () => ({ ref: p => new Ref(p || '') });
  database.ServerValue = { TIMESTAMP: { __ts__: true } };
  window.firebase = { initializeApp() {}, database };
})();
