/* The Landing — the phone app's engine.

   Inside Claude, the page keeps its notes in a private database. Out here it can't reach that, so this file gives
   the page the same kind of database, kept on this device: the last edition that arrived (the "base") plus
   everything tapped since (the "ops"). Taps show at once and are saved here first.

   Editions arrive, and taps leave, as sealed envelopes through a public relay (ntfy.sh): AES-GCM with a key that
   exists only on the owner's devices and in his private Claude page. The key comes in the link that set this
   device up, after the #, and that part of a link never reaches a server. The relay and GitHub hold only ciphertext.

   Nothing personal is written in this file. */
(() => {
  'use strict';
  const TEST = window.__LANDING_TEST__ || null;
  const RELAY = (TEST && TEST.relay) || 'https://ntfy.sh/';
  const ARCHIVE = (TEST && TEST.archive) || 'data/sync.json';
  const LS = 'tl.';
  const CHUNK = 2700;                 // payload bytes per envelope, so each relay message stays under 4 KB
  const DAY = 864e5;
  const enc = new TextEncoder(), dec = new TextDecoder();

  /* ---------- small helpers ---------- */
  const store = {
    get(k, d) { try { const v = localStorage.getItem(LS + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); return true; } catch (e) { return false; } },
    del(k) { try { localStorage.removeItem(LS + k); } catch (e) { /* nothing to remove */ } }
  };
  const b64e = u8 => { let s = ''; for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
  const b64d = s => { s = String(s).replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; const bin = atob(s); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; };
  const rid = n => b64e(crypto.getRandomValues(new Uint8Array(n || 12)));
  const clone = x => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
  const isObj = v => !!v && typeof v === 'object' && !Array.isArray(v);
  async function sha256hex(bytes) { const h = await crypto.subtle.digest('SHA-256', bytes); return Array.from(new Uint8Array(h), x => x.toString(16).padStart(2, '0')).join(''); }
  async function fetchT(url, opts, ms) { const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), ms || 12000); try { return await fetch(url, Object.assign({ signal: ctl.signal }, opts || {})); } finally { clearTimeout(t); } }
  function concat(list) { let n = 0; list.forEach(b => { n += b.length; }); const out = new Uint8Array(n); let at = 0; list.forEach(b => { out.set(b, at); at += b.length; }); return out; }
  async function gunzip(u8) { const r = new Response(new Blob([u8]).stream().pipeThrough(new DecompressionStream('gzip'))); return new Uint8Array(await r.arrayBuffer()); }

  /* ---------- the key ---------- */
  const K = { raw: null, key: null, fp: '', topic: '' };
  async function setKey(raw) {
    const bytes = b64d(raw); if (bytes.length !== 32) throw new Error('bad key');
    K.key = await crypto.subtle.importKey('raw', bytes, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
    K.raw = raw;
    K.fp = (await sha256hex(bytes)).slice(0, 8);
    K.topic = 'tl' + (await sha256hex(enc.encode('topic:' + raw))).slice(0, 22);
  }
  /* What an envelope says in the clear is bound to its contents, so nobody can relabel or reorder the parts. */
  const aadOf = e => enc.encode(['L1', e.fp, e.id, e.k, e.ts, e.g, e.i, e.n].join('|'));
  async function sealPart(k, bytes, g, i, n, ts) {
    const env = { v: 1, fp: K.fp, id: g + '.' + i, k: k, ts: ts, g: g, i: i, n: n };
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv, additionalData: aadOf(env) }, K.key, bytes);
    env.iv = b64e(iv); env.ct = b64e(new Uint8Array(ct));
    return env;
  }
  async function openPart(env) { return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64d(env.iv), additionalData: aadOf(env) }, K.key, b64d(env.ct))); }
  async function sealGroup(k, bytes, g, ts) {
    const n = Math.max(1, Math.ceil(bytes.length / CHUNK)); const out = [];
    for (let i = 0; i < n; i++) out.push(await sealPart(k, bytes.subarray(i * CHUNK, (i + 1) * CHUNK), g, i, n, ts));
    return out;
  }

  /* ---------- what this device holds ---------- */
  let BASE = null;       // the last edition that arrived: { sid, asOf, folded: [op ids], docs: { 'collection/id': {...} } }
  let OPS = [];          // taps not yet folded into an edition: { id, ts, w: set|upd|del, p: path, d: data, mine }
  let OUT = [];          // sealed envelopes waiting for a connection
  let SEEN = {};         // groups already opened: id -> when
  let DOCS = {};         // BASE.docs with OPS applied: what the page reads
  const PARTS = {};      // groups still arriving
  const BAD = {};        // groups that wouldn't open (kept for this visit only)
  const SY = { lastOk: 0, lastTry: 0, backoff: 0, refused: 0, flushing: false, polling: false, archIds: null, resent: {}, err: '' };
  const listeners = new Set();

  function merge(a, b) { Object.keys(b).forEach(k => { const v = b[k]; if (isObj(v) && isObj(a[k])) merge(a[k], v); else a[k] = clone(v); }); return a; }
  function applyOp(docs, o) {
    if (o.w === 'set') docs[o.p] = clone(o.d) || {};
    else if (o.w === 'upd') { if (docs[o.p]) merge(docs[o.p], o.d || {}); }
    else if (o.w === 'del') delete docs[o.p];
  }
  function rebuild() {
    const docs = clone((BASE && BASE.docs) || {});
    const folded = new Set((BASE && BASE.folded) || []);
    const old = Date.now() - 14 * DAY;      // an edition names the taps it has taken in for about a week; nothing waits longer than two
    OPS = OPS.filter(o => !folded.has(o.id) && o.ts > old).sort((a, b) => a.ts - b.ts || (a.id < b.id ? -1 : 1));
    OPS.forEach(o => { try { applyOp(docs, o); } catch (e) { /* skip one bad op */ } });
    DOCS = docs;
  }
  function save(what) {
    if (!what || what === 'base') { if (!store.set('base', BASE)) SY.err = 'This device is out of room to save the page.'; }
    if (!what || what === 'ops') store.set('ops', OPS);
    if (!what || what === 'out') store.set('out', OUT);
    if (!what || what === 'seen') store.set('seen', SEEN);
  }
  let noteT = 0;
  function notify() { clearTimeout(noteT); noteT = setTimeout(() => { listeners.forEach(fn => { try { fn(); } catch (e) { /* one listener must not stop the rest */ } }); try { window.dispatchEvent(new Event('landing-sync')); } catch (e) { /* older browsers */ } }, 0); }

  /* ---------- the database the page talks to (same shape as the one inside Claude) ---------- */
  const META = { fromCache: false, hasPendingWrites: false };
  const snapDoc = path => { const v = DOCS[path]; const data = v === undefined ? undefined : Object.freeze(clone(v)); return { id: path.split('/').pop(), exists: v !== undefined, data: () => data, metadata: META }; };
  const PATH_OK = /^[A-Za-z0-9_.~:@+-]{1,200}$/;
  function checkPath(path, even) {
    const seg = String(path).split('/');
    if ((seg.length % 2 === 0) !== even || !seg.every(s => PATH_OK.test(s) && s !== '.' && s !== '..')) throw new TypeError((even ? 'document' : 'collection') + ' path is not valid: ' + path);
  }
  function write(w, path, data) {
    const o = { id: rid(12), ts: Date.now(), w: w, p: path, mine: true };
    if (w !== 'del') o.d = clone(data);
    applyOp(DOCS, o); OPS.push(o); save('ops'); notify();
    queueOp(o);
  }
  function docRef(path) {
    checkPath(path, true);
    return {
      id: path.split('/').pop(), path: path,
      get: async () => snapDoc(path),
      set: async data => { if (!isObj(data)) throw { code: 'invalid_argument', message: 'a document is an object' }; write('set', path, data); },
      update: async data => { if (!isObj(data) || DOCS[path] === undefined) throw { code: 'invalid_argument', message: 'no such document' }; write('upd', path, data); },
      delete: async () => { if (DOCS[path] !== undefined) write('del', path); },
      onSnapshot: next => { const fn = () => next(snapDoc(path)); listeners.add(fn); setTimeout(fn, 0); return () => listeners.delete(fn); },
      collection: p => colRef(path + '/' + p)
    };
  }
  function colRef(path, q) {
    checkPath(path, false);
    q = q || { where: [], order: null, limit: 0 };
    const depth = path.split('/').length + 1;
    const cmp = (x, op, v) => (op === '==' ? x === v : op === '!=' ? x !== v : op === '<' ? x < v : op === '<=' ? x <= v : op === '>' ? x > v : op === '>=' ? x >= v
      : op === 'in' ? Array.isArray(v) && v.indexOf(x) >= 0 : op === 'not-in' ? Array.isArray(v) && v.indexOf(x) < 0 : op === 'array-contains' ? Array.isArray(x) && x.indexOf(v) >= 0 : false);
    const run = () => {
      let rows = Object.keys(DOCS).filter(p => p.lastIndexOf(path + '/', 0) === 0 && p.split('/').length === depth).sort().map(p => ({ p: p, d: DOCS[p] }));
      q.where.forEach(w => { rows = rows.filter(r => cmp(r.d[w[0]], w[1], w[2])); });
      if (q.order) {
        const f = q.order[0], dir = q.order[1] === 'desc' ? -1 : 1;
        rows.sort((a, b) => { const x = a.d[f], y = b.d[f]; if (x === undefined && y === undefined) return 0; if (x === undefined) return 1; if (y === undefined) return -1; return (x < y ? -1 : x > y ? 1 : 0) * dir; });
      }
      if (q.limit) rows = rows.slice(0, q.limit);
      const docs = rows.map(r => snapDoc(r.p));
      return { docs: docs, size: docs.length, empty: !docs.length, docChanges: () => [], metadata: META };
    };
    return {
      path: path,
      where: (f, op, v) => colRef(path, { where: q.where.concat([[f, op, v]]), order: q.order, limit: q.limit }),
      orderBy: (f, dir) => colRef(path, { where: q.where, order: [f, dir || 'asc'], limit: q.limit }),
      limit: n => colRef(path, { where: q.where, order: q.order, limit: n }),
      get: async () => run(),
      onSnapshot: next => { const fn = () => next(run()); listeners.add(fn); setTimeout(fn, 0); return () => listeners.delete(fn); },
      doc: id => docRef(path + '/' + (id || rid(15))),
      add: async data => { const r = docRef(path + '/' + rid(15)); await r.set(data); return r; }
    };
  }
  const db = { doc: docRef, collection: p => colRef(p) };

  /* ---------- sending and receiving ---------- */
  async function queueOp(o) {
    try {
      const envs = await sealGroup('o', enc.encode(JSON.stringify({ id: o.id, ts: o.ts, w: o.w, p: o.p, d: o.d })), o.id, o.ts);
      envs.forEach(e => OUT.push(e)); save('out'); notify();
      flushSoon();
    } catch (e) { /* stays in OPS; keepAlive sends it again */ }
  }
  let flushT = 0;
  function flushSoon() { clearTimeout(flushT); flushT = setTimeout(flush, 400); }
  /* The relay allows each network address so many messages. When it says "not now" (429), the outbox waits, a little
     longer each time, and then tries again by itself. Nothing is lost meanwhile: the taps are saved on this device. */
  const REFUSED_WAIT = [20000, 60000, 300000, 600000];
  async function flush() {
    if (SY.flushing || !OUT.length || !K.key) return;
    if (Date.now() < SY.backoff) { clearTimeout(flushT); flushT = setTimeout(flush, SY.backoff - Date.now() + 300); return; }
    SY.flushing = true;
    try {
      while (OUT.length) {
        const r = await fetchT(RELAY + K.topic, { method: 'POST', body: JSON.stringify(OUT[0]) }, 12000);
        if (r.status === 429) {
          const wait = REFUSED_WAIT[Math.min(SY.refused, REFUSED_WAIT.length - 1)]; SY.refused++;
          SY.backoff = Date.now() + wait; clearTimeout(flushT); flushT = setTimeout(flush, wait + 300); break;
        }
        if (r.status >= 500) break;
        SY.refused = 0;
        OUT.shift(); save('out');
      }
    } catch (e) { /* no signal: the outbox keeps it for next time */ }
    SY.flushing = false; notify();
  }
  const VALID_W = { set: 1, upd: 1, del: 1 };
  const validOp = o => isObj(o) && typeof o.id === 'string' && o.id.length <= 40 && Number.isFinite(o.ts) && VALID_W[o.w] === 1 && typeof o.p === 'string' && o.p.length < 300 && (o.w === 'del' || isObj(o.d));
  const validBase = b => isObj(b) && typeof b.sid === 'string' && typeof b.asOf === 'string' && isObj(b.docs) && (b.folded === undefined || Array.isArray(b.folded));
  const validEnv = e => isObj(e) && e.v === 1 && e.fp === K.fp && (e.k === 'o' || e.k === 's') && typeof e.g === 'string' && e.g.length >= 8 && e.g.length <= 40 && e.id === e.g + '.' + e.i
    && Number.isInteger(e.ts) && Number.isInteger(e.i) && Number.isInteger(e.n) && e.n >= 1 && e.n <= 400 && e.i >= 0 && e.i < e.n && typeof e.iv === 'string' && typeof e.ct === 'string' && e.ct.length <= 8000;
  async function ingest(list) {
    let baseNew = false, opsNew = false;
    for (const e of list || []) {
      if (!validEnv(e) || SEEN[e.g] || BAD[e.g]) continue;
      const grp = PARTS[e.g] || (PARTS[e.g] = { k: e.k, n: e.n, ts: e.ts, parts: {} });
      if (grp.n !== e.n || grp.k !== e.k || grp.ts !== e.ts) continue;
      grp.parts[e.i] = e;
      if (Object.keys(grp.parts).length < grp.n) continue;
      delete PARTS[e.g];
      try {
        const bufs = []; for (let i = 0; i < grp.n; i++) bufs.push(await openPart(grp.parts[i]));
        if (grp.k === 's') {
          const base = JSON.parse(dec.decode(await gunzip(concat(bufs))));
          if (validBase(base) && (!BASE || base.asOf > BASE.asOf)) { BASE = base; baseNew = true; }
        } else {
          const o = JSON.parse(dec.decode(concat(bufs)));
          if (validOp(o) && o.id === e.g && !OPS.some(x => x.id === o.id) && !(BASE && (BASE.folded || []).indexOf(o.id) >= 0)) { OPS.push({ id: o.id, ts: o.ts, w: o.w, p: o.p, d: o.d }); opsNew = true; }
        }
        SEEN[e.g] = Date.now();
      } catch (err) { BAD[e.g] = 1; }
    }
    if (baseNew || opsNew) {
      const cut = Date.now() - 12 * DAY; Object.keys(SEEN).forEach(g => { if (SEEN[g] < cut) delete SEEN[g]; });
      rebuild(); if (baseNew) save('base'); save('ops'); save('seen'); notify();
    }
    return baseNew || opsNew;
  }
  async function poll() {
    if (!K.key || SY.polling) return;
    SY.polling = true; SY.lastTry = Date.now();
    try {
      const r = await fetchT(RELAY + K.topic + '/json?poll=1&since=12h', { cache: 'no-store' }, 15000);
      if (r.ok) {
        const envs = [];
        (await r.text()).split('\n').forEach(line => { if (!line.trim()) return; try { const m = JSON.parse(line); if (m.event === 'message' && m.message) envs.push(JSON.parse(m.message)); } catch (e) { /* not ours */ } });
        await ingest(envs); SY.lastOk = Date.now(); store.set('ok', SY.lastOk);
      }
    } catch (e) { /* offline */ }
    SY.polling = false; notify();
    flush();
  }
  /* The relay forgets a message after about 12 hours, so the site keeps a sealed copy of the latest edition and the
     recent taps. A tap of ours that copy is still missing three hours on goes out again, so it isn't lost. */
  async function loadArchive() {
    if (!K.key) return;
    try {
      const r = await fetchT(ARCHIVE, { cache: 'no-store' }, 15000);
      if (!r.ok) return;
      const j = await r.json(); const evs = Array.isArray(j && j.events) ? j.events : [];
      SY.archIds = {}; evs.forEach(e => { if (e && typeof e.g === 'string') SY.archIds[e.g] = 1; });
      await ingest(evs);
      await keepAlive();
    } catch (e) { /* offline, or no copy yet */ }
  }
  async function keepAlive() {
    if (!SY.archIds) return;
    const now = Date.now(); let added = false;
    for (const o of OPS) {
      if (!o.mine || now - o.ts < 3 * 36e5 || SY.archIds[o.id] || (SY.resent[o.id] && now - SY.resent[o.id] < 3 * 36e5) || OUT.some(e => e.g === o.id)) continue;
      SY.resent[o.id] = now;
      try { (await sealGroup('o', enc.encode(JSON.stringify({ id: o.id, ts: o.ts, w: o.w, p: o.p, d: o.d })), o.id, o.ts)).forEach(e => OUT.push(e)); added = true; } catch (e) { /* try next time */ }
    }
    if (added) { save('out'); flushSoon(); }
  }
  let syncing = null;
  function sync() { if (!syncing) syncing = (async () => { await poll(); await loadArchive(); })().catch(() => {}).then(() => { syncing = null; }); return syncing; }

  /* ---------- reading aloud and speaking a note, with the phone's own voices ---------- */
  const tts = ('speechSynthesis' in window && 'SpeechSynthesisUtterance' in window) ? (() => {
    let cb = null, run = 0;
    const emit = s => { if (cb) { try { cb({ state: s }); } catch (e) { /* listener's problem */ } } };
    return {
      speak(text) {
        return new Promise(resolve => {
          const mine = ++run;
          try { speechSynthesis.cancel(); } catch (e) { /* nothing was playing */ }
          const bits = String(text || '').match(/[^.!?]+[.!?]*\s*/g) || [];
          if (!bits.length) { resolve(); return; }
          emit('speaking');
          const next = i => {
            if (mine !== run) { resolve(); return; }
            if (i >= bits.length) { emit('idle'); resolve(); return; }
            const u = new SpeechSynthesisUtterance(bits[i]); u.lang = 'en-US';
            u.onend = () => next(i + 1); u.onerror = () => { if (mine === run) emit('idle'); resolve(); };
            speechSynthesis.speak(u);
          };
          next(0);
        });
      },
      stop() { run++; try { speechSynthesis.cancel(); } catch (e) { /* already quiet */ } emit('idle'); },
      onState(fn) { cb = fn; }
    };
  })() : null;
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  const dictation = SR ? (() => {
    let rec = null, onFinal = null, onState = null;
    const st = s => { if (onState) { try { onState({ state: s }); } catch (e) { /* listener's problem */ } } };
    return {
      start() {
        return new Promise((resolve, reject) => {
          try {
            rec = new SR(); rec.lang = 'en-US'; rec.continuous = true; rec.interimResults = false;
            rec.onresult = ev => { for (let i = ev.resultIndex; i < ev.results.length; i++) { if (ev.results[i].isFinal && onFinal) onFinal({ text: String(ev.results[i][0].transcript || '').trim() }); } };
            rec.onstart = () => { st('listening'); resolve(); };
            rec.onend = () => st('idle');
            rec.onerror = e => { st('idle'); reject({ code: e && (e.error === 'not-allowed' || e.error === 'service-not-allowed') ? 'not_granted' : 'unavailable' }); };
            rec.start();
          } catch (e) { reject({ code: 'unavailable' }); }
        });
      },
      stop() { return new Promise(resolve => { try { if (rec) rec.stop(); } catch (e) { /* not running */ } resolve(); }); },
      onFinal(fn) { onFinal = fn; }, onPartial() {}, onState(fn) { onState = fn; }
    };
  })() : null;

  /* ---------- linking this device ----------
     The key normally arrives in the address, after "#join=". It can also arrive late: the address changes while the
     page is already open, another tab or window on this phone gets linked, or the owner pastes the link into the page. */
  function keyIn(text) {
    let s = String(text || ''); try { s = decodeURIComponent(s); } catch (e) { /* use it as it came */ }
    const m = /join=([A-Za-z0-9_-]{43})(?![A-Za-z0-9_-])/.exec(s) || /^\s*([A-Za-z0-9_-]{43})\s*$/.exec(s);
    return m ? m[1] : null;
  }
  function adopt(raw) { if (store.get('key', null) !== raw) { wipe(); store.set('key', raw); } }
  function cleanAddress() { try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* the link stays in the bar; harmless */ } }
  function linkFrom(text) {
    const k = keyIn(text); if (!k) return false;
    cleanAddress();
    if (k !== K.raw) { adopt(k); location.reload(); }
    return true;
  }

  /* ---------- start ---------- */
  function wipe() { ['base', 'ops', 'out', 'seen', 'ok'].forEach(k => store.del(k)); BASE = null; OPS = []; OUT = []; SEEN = {}; DOCS = {}; }
  async function boot() {
    if (!(window.crypto && crypto.subtle && crypto.getRandomValues && window.DecompressionStream)) return null;
    const fromLink = keyIn(location.hash);
    if (fromLink) { adopt(fromLink); cleanAddress(); }
    const raw = store.get('key', null);
    if (!raw) return null;
    try { await setKey(raw); } catch (e) { store.del('key'); return null; }
    BASE = store.get('base', null); OPS = store.get('ops', []); OUT = store.get('out', []); SEEN = store.get('seen', {}); SY.lastOk = store.get('ok', 0);
    if (!validBase(BASE)) BASE = null;
    if (!Array.isArray(OPS)) OPS = []; if (!Array.isArray(OUT)) OUT = []; if (!isObj(SEEN)) SEEN = {};
    rebuild();
    setTimeout(sync, 50);
    document.addEventListener('visibilitychange', () => { if (!document.hidden) sync(); });
    window.addEventListener('online', sync);
    setInterval(() => { if (!document.hidden) sync(); }, 60000);
    return db;
  }
  const ready = boot().catch(() => null);
  ready.then(() => {
    window.addEventListener('hashchange', () => { linkFrom(location.hash); });
    window.addEventListener('storage', e => {
      if (e.key !== LS + 'key') return;
      let v = null; try { v = JSON.parse(e.newValue); } catch (err) { /* removed */ }
      if (v !== K.raw) location.reload();
    });
    document.addEventListener('visibilitychange', () => { if (!document.hidden && store.get('key', null) !== K.raw) location.reload(); });
  });
  const UA = navigator.userAgent || '';
  const WHERE = {
    android: /Android/i.test(UA),
    browser: /EdgA\//.test(UA) ? 'Edge' : /SamsungBrowser\//.test(UA) ? 'Samsung Internet' : /Firefox\//.test(UA) ? 'Firefox' : /OPR\//.test(UA) ? 'Opera' : /Chrome\//.test(UA) ? 'Chrome' : '',
    installed: !!((window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || navigator.standalone)
  };
  const HOME = () => location.pathname.replace(/index\.html$/, '');
  const BUILD = ((document.querySelector('meta[name="landing-build"]') || {}).content || '').trim();

  /* New versions arrive by themselves: the service worker fetches the new build, then this page reloads once
     (never in the middle of typing, and at most twice in two minutes). */
  if ('serviceWorker' in navigator && !(TEST && TEST.noSW)) {
    const mine = 'landing-' + BUILD; let reloading = false;
    const reload = () => {
      if (reloading) return;
      const now = Date.now(); const recent = store.get('swReloads', []).filter(t => now - t < 120000);
      if (recent.length >= 2) return;
      recent.push(now); store.set('swReloads', recent); reloading = true; location.reload();
    };
    const consider = v => {
      if (!v || !BUILD || v === mine) return;
      const el = document.activeElement; const typing = !!(el && /^(INPUT|TEXTAREA)$/.test(el.tagName) && el.value);
      if (document.hidden || !typing) reload();
    };
    const hello = () => { try { const c = navigator.serviceWorker.controller; if (c) c.postMessage({ type: 'landing-hello' }); } catch (e) { /* no worker yet */ } };
    navigator.serviceWorker.addEventListener('message', e => {
      const d = e.data || {};
      if (d.type === 'landing-updated') { try { if (e.source) e.source.postMessage({ type: 'landing-ack' }); } catch (err) { /* worker went away */ } consider(d.version); }
      else if (d.type === 'landing-version') consider(d.version);
    });
    navigator.serviceWorker.addEventListener('controllerchange', hello);
    hello();
    try {
      navigator.serviceWorker.register('./sw.js').then(reg => {
        let last = Date.now();
        document.addEventListener('visibilitychange', () => { if (!document.hidden && Date.now() - last > 10 * 60000) { last = Date.now(); reg.update().catch(() => {}); } });
      }).catch(() => {});
    } catch (e) { /* no service worker here; the app still works online */ }
  }

  window.LandingApp = {
    build: BUILD,
    status: () => ({ linked: !!K.key, baseAt: BASE ? BASE.asOf : '', waiting: OUT.length, lastOk: SY.lastOk, taps: OPS.length, err: SY.err, canLink: !!(window.crypto && crypto.subtle && window.DecompressionStream) }),
    sync: () => sync(),
    unlink: () => { wipe(); store.del('key'); K.key = null; K.raw = null; location.reload(); },
    /* Linking by hand, and moving the link to another browser on the same phone. The link holds the key: it is only
       ever shown to, or handed on by, a device that already has it. */
    link: text => linkFrom(text),
    joinLink: () => (K.raw ? location.origin + HOME() + '#join=' + K.raw : ''),
    chromeLink: () => (K.raw ? 'intent://' + location.host + HOME() + '#join=' + K.raw + '#Intent;scheme=https;package=com.android.chrome;end' : ''),
    where: () => WHERE
  };
  window.claude = { use: async name => { const d = await ready; if (!d) return null; return name === 'db' ? d : name === 'tts' ? tts : name === 'dictation' ? dictation : null; } };
})();
