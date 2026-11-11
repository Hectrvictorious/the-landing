(() => {
  'use strict';
  const TZ = 'America/New_York';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const hex = c => (/^#[0-9a-f]{3,8}$/i.test(String(c || '')) ? c : '#8a96a0');
  const safeUrl = u => (/^https:\/\//i.test(String(u || '')) ? u : '');

  const VIEWS = ['today', 'checkin', 'life', 'loops', 'horizon'];
  const isView = v => VIEWS.indexOf(v) >= 0;

  const S = {
    db: null, nodb: false, got: false, slow: false, err: null,
    days: [], dayIdx: 0, loops: {}, gotLoops: false, areas: [], areaMap: {}, stars: [], feeds: [], inbox: [], status: null,
    asks: {}, gotAsks: false, checkins: {}, readings: [], learned: {}, week: null, weekId: '', config: {}, next: null,
    view: 'today', openLoops: {}, openAreas: {}, help: {}, dropArm: null,
    multi: {}, askAll: false, knowAll: false, readAll: false, scriptOpen: false, appInfo: null, unlinkArm: false, linkMiss: false, showLink: false, prefs: {}, handNote: {}, handOpen: {}, handFix: {},
    habits: {}, gotHabits: false, hEdit: null, hArm: null, hWhy: false,
    tts: null, speaking: false, dict: null, listening: false, sample: null
  };

  /* ---------- dates (always the owner's clock, Eastern) ---------- */
  const fYMD = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const todayYMD = () => fYMD.format(new Date());
  const asDate = ymd => { const p = String(ymd).split('-').map(Number); return new Date(Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1, 12)); };
  const dayDiff = (a, b) => Math.round((asDate(a) - asDate(b)) / 86400000);
  const addDays = (ymd, n) => { const d = asDate(ymd); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const fShort = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });
  const fLong = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
  const fWeekday = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long' });
  const fClock = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  const fStamp = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric', minute: '2-digit' });
  const fDayTime = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fDow = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short' });
  const fHour = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' });
  const hourNow = () => Number(fHour.format(new Date())) || 0;
  const fHM = new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit', hourCycle: 'h23' });
  /* The owner's clock as a number: 13.25 is a quarter past one in the afternoon. */
  const clockNow = () => { const p = fHM.formatToParts(new Date()); const g = t => Number((p.find(x => x.type === t) || {}).value) || 0; return (g('hour') % 24) + g('minute') / 60; };
  /* "10:00 AM" -> 10, "2:30 PM" -> 14.5. Words like "Evening" or "By tonight" -> null. */
  function clockOf(text) { const m = /(\d{1,2})(?::(\d{2}))?\s*([AP])\.?M/i.exec(String(text || '')); if (!m) return null; let h = Number(m[1]) % 12; if (/p/i.test(m[3])) h += 12; return h + (Number(m[2]) || 0) / 60; }
  const validYMD = s => /^\d{4}-\d{2}-\d{2}$/.test(String(s || ''));
  const mondayOf = ymd => { const d = asDate(ymd); return addDays(ymd, -((d.getUTCDay() + 6) % 7)); };
  function inDays(ymd) {
    if (!validYMD(ymd)) return '';
    const n = dayDiff(ymd, todayYMD());
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    if (n < 0) return Math.abs(n) + ' days ago';
    return 'in ' + n + ' days';
  }
  function dueText(ymd) {
    if (!validYMD(ymd)) return '';
    const n = dayDiff(ymd, todayYMD());
    if (n < 0) return 'was due ' + fShort.format(asDate(ymd));
    if (n === 0) return 'due today';
    if (n === 1) return 'due tomorrow';
    if (n < 7) return 'due ' + fWeekday.format(asDate(ymd));
    return 'due ' + fShort.format(asDate(ymd));
  }
  function ago(iso) {
    const t = Date.parse(iso || ''); if (!t) return '';
    const m = Math.round((Date.now() - t) / 60000);
    if (m < 2) return 'just now';
    if (m < 60) return m + ' min ago';
    if (m < 60 * 20) return Math.round(m / 60) + ' h ago';
    return fStamp.format(new Date(t));
  }

  /* ---------- small drawings ---------- */
  function buoy(a, b, w) {
    w = w || 18; const h = Math.round(w * 1.7);
    return '<svg viewBox="0 0 20 34" width="' + w + '" height="' + h + '" aria-hidden="true">' +
      '<rect x="9.2" y="0.5" width="1.6" height="9" rx=".8" fill="var(--ink-2)"/>' +
      '<path d="M4 13.5C4 9.900 6.700 8 10 8s6 1.900 6 5.500V20H4z" fill="' + hex(a) + '"/>' +
      '<path d="M4 20h12l-1.300 9.200c-.3 2.300-2.300 3.800-4.700 3.800s-4.400-1.500-4.700-3.800z" fill="' + hex(b) + '"/>' +
      '<path d="M4 13.5C4 9.900 6.700 8 10 8s6 1.900 6 5.500V20l-1.300 9.200c-.3 2.300-2.300 3.800-4.700 3.800s-4.400-1.500-4.700-3.800L4 20z" fill="none" stroke="var(--ink)" stroke-opacity=".5" stroke-width=".8"/></svg>';
  }
  const areaOf = id => S.areaMap[id] || { id: id || '', name: id || '', buoy: ['#8a96a0', '#cfd6da'] };
  const dot = id => { const a = areaOf(id); return '<span class="adot" title="' + esc(a.name) + '" style="--a:' + hex(a.buoy && a.buoy[0]) + ';--b:' + hex(a.buoy && a.buoy[1]) + '"></span>'; };
  const STATUS = { needs: 'Needs you', moving: 'Under way', steady: 'On course', quiet: 'Quiet' };
  const stKey = s => (STATUS[s] ? s : 'quiet');

  /* ---------- derived ---------- */
  const day = () => S.days[S.dayIdx] || null;
  const latest = () => S.days[0] || null;
  const loopList = () => Object.keys(S.loops).map(k => S.loops[k]);
  const isSnoozed = L => validYMD(L.snoozeUntil) && dayDiff(L.snoozeUntil, todayYMD()) > 0;
  const openLoops = () => loopList().filter(L => L.status === 'open');
  const byDue = (a, b) => {
    const da = validYMD(a.due) ? a.due : '9999-99-99', dbb = validYMD(b.due) ? b.due : '9999-99-99';
    if (da !== dbb) return da < dbb ? -1 : 1;
    return (b.weight || 0) - (a.weight || 0) || String(a.title).localeCompare(String(b.title));
  };
  const askList = () => Object.keys(S.asks).map(k => S.asks[k]);
  const openAsks = () => askList().filter(A => A.status === 'open' && A.text && (!validYMD(A.showOn) || A.showOn <= todayYMD()))
    .sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id).localeCompare(String(b.id)));
  const checkin = () => S.checkins[todayYMD()] || {};
  const cfgList = k => (Array.isArray(S.config[k]) ? S.config[k] : []);
  const DEF_CHECKS = [{ id: 'energy', label: 'Energy right now', options: [{ v: 'low', t: 'Low' }, { v: 'ok', t: 'OK' }, { v: 'good', t: 'Good' }] }];
  const checks = () => { const c = cfgList('checkin').filter(x => x && x.id && Array.isArray(x.options) && x.options.length); return c.length ? c : DEF_CHECKS; };
  const weekItems = () => { const w = S.week; return ((w && Array.isArray(w.items) && w.items.length) ? w.items : cfgList('weekly')).filter(x => x && x.id && x.label); };
  const BLOCKS = [['time', 'Ran out of time'], ['energy', 'Low energy'], ['start', 'Not sure how to start'], ['dread', 'Dreading it'], ['waiting', 'Waiting on someone'], ['unneeded', 'Not needed now']];
  const CHIP_RE = /^(I finished|Don't let me forget|An idea:|For Sunday:|About this page:)\s*/i;
  /* What he sees when something lands follows his own answer to the "when something lands" question. */
  function landedMsg() {
    const A = S.asks['a-wins']; const v = A && A.status === 'answered' ? String(A.answer || '') : '';
    if (/checkmark/i.test(v)) return 'Landed.';
    if (/count/i.test(v)) {
      const wk = Date.now() - 7 * 86400000;
      const n = loopList().filter(L => L.status === 'done' && Date.parse(L.doneAt || '') > wk).length + 1;
      return 'Landed. That makes ' + n + ' in the last seven days.';
    }
    return 'Landed. Nicely done.';
  }

  /* ---------- render ---------- */
  let raf = 0;
  function schedule() { if (raf) return; raf = requestAnimationFrame(() => { raf = 0; render(); }); }

  /* Put html into el only when it changed, and keep whatever he is typing (and where the cursor is) across the repaint. */
  function paint(el, html) {
    if (el.__html === html) return;
    const keep = {}; el.querySelectorAll('input[id], textarea[id], select[id]').forEach(i => { keep[i.id] = i.value; });
    const act = document.activeElement; const actId = act && act.id && el.contains(act) ? act.id : '';
    const sel = actId && typeof act.selectionStart === 'number' ? [act.selectionStart, act.selectionEnd] : null;
    el.innerHTML = html; el.__html = html;
    Object.keys(keep).forEach(id => { const i = $(id); if (i && el.contains(i) && keep[id] && i.value !== keep[id]) i.value = keep[id]; });
    if (actId) { const i = $(actId); if (i && el.contains(i)) { try { i.focus({ preventScroll: true }); if (sel && i.setSelectionRange) i.setSelectionRange(sel[0], sel[1]); } catch (e) { /* focus is a nicety */ } } }
  }

  function render() {
    renderMast(); renderStrip(); renderTabs();
    VIEWS.forEach(v => { $('view-' + v).hidden = S.view !== v; });
    if (S.view === 'today') renderToday();
    else if (S.view === 'checkin') renderCheckin();
    else if (S.view === 'life') renderLife();
    else if (S.view === 'loops') renderLoops();
    else renderHorizon();
  }

  function renderMast() {
    $('mastDate').textContent = fLong.format(asDate(todayYMD()));
    $('mastSub').textContent = S.config.owner ? String(S.config.owner) + '\u2019s day' : '';
  }

  function renderStrip() {
    const d = latest(); const st = (d && d.areas) || {};
    let needs = 0;
    $('stripBuoys').innerHTML = S.areas.map(a => {
      const k = stKey(st[a.id] && st[a.id].status); if (k === 'needs') needs++;
      return '<button class="sb" type="button" data-act="area" data-id="' + esc(a.id) + '" aria-label="' + esc(a.name + ': ' + STATUS[k]) + '">' + buoy(a.buoy && a.buoy[0], a.buoy && a.buoy[1], 16) + '<span class="lamp ' + k + '"></span></button>';
    }).join('');
    $('stripNote').innerHTML = S.areas.length ? (needs ? '<b>' + needs + '</b> need' + (needs === 1 ? 's' : '') + ' you' : 'All on course') : '';
  }

  function renderTabs() {
    document.querySelectorAll('.tab').forEach(t => { if (t.dataset.id === S.view) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); });
    const n = loopList().filter(L => L.status === 'unsure').length;
    const c = $('loopCount'); c.hidden = !n; c.textContent = n;
    const q = openAsks().length;
    const a = $('askCount'); a.hidden = !q; a.textContent = q > 9 ? '9+' : q;
  }

  function stateNotice() {
    if (S.nodb) {
      if (!window.LandingApp) return '<p class="notice">Your notes live in your Claude account. Open this page signed in as yourself to see your day.</p>';
      if (!window.LandingApp.status().canLink) return '<p class="notice">This browser is too old to run the app. Try it in Chrome.</p>';
      return '<div class="notice"><p><b>This app isn\'t linked to your notes yet.</b></p>' +
        '<p>In Claude, open The Landing, go to Horizon, and tap Open the phone app. If that opens in a different browser than this one, tap Copy the link there instead and paste it here.</p>' +
        '<div class="linkbox"><input type="text" class="link-in" placeholder="Paste the link here" aria-label="Paste the link here" autocomplete="off" autocapitalize="off" spellcheck="false"><button class="btn small primary" type="button" data-act="applink">Link it</button></div>' +
        (S.linkMiss ? '<p class="meta">That isn\'t the link. The right one ends with "join=" and a long run of letters.</p>' : '') + '</div>';
    }
    if (S.err) return '<p class="notice bad">Your notes can\'t be reached right now (' + esc(S.err) + '). Close and reopen the page in a minute.</p>';
    if (S.slow && !S.got) return '<p class="notice">Still reaching your notes. If you\'re on the boat with no signal, this fills in once you\'re back in range.</p>';
    return '';
  }

  /* ---------- handing a loop to Claude ----------
     One tap asks the next run to do the part Claude can do alone. The run writes its work back onto the loop:
     handoff { status asked|ready|cant|seen|cancelled, askedAt, note, changes, doneAt, result { summary, body, link, needs, finishes } }.
     The page only ever writes status, the times, note and changes. */
  const hand = L => ((L && L.handoff && typeof L.handoff === 'object') ? L.handoff : null);
  const handBack = L => { const h = hand(L); return !!(h && h.result && typeof h.result === 'object' && (h.status === 'ready' || h.status === 'cant')); };
  function richText(t) {
    return String(t == null ? '' : t).split(/(https:\/\/[^\s<>"')\]]+)/g).map((part, i) => {
      if (i % 2 === 0) return esc(part);
      const tail = (/[.,;:!?]+$/.exec(part) || [''])[0]; const url = tail ? part.slice(0, -tail.length) : part;
      return '<a href="' + esc(url) + '" target="_blank" rel="noopener">' + esc(url) + '</a>' + esc(tail);
    }).join('');
  }
  function handBlock(L, live) {
    const h = hand(L); const id = esc(L.id); const st = h ? String(h.status || '') : '';
    const field = (ph, act, label) => '<div class="linkbox"><input class="hand-in" type="text" maxlength="600" placeholder="' + ph + '" aria-label="' + ph + '"><button class="btn small primary" type="button" data-act="' + act + '" data-id="' + id + '">' + label + '</button></div>';
    if (st === 'asked') {
      return '<div class="hand"><p class="hand-h">Handed to Claude</p><p class="meta">' + (h.changes ? 'Sent back with your changes. ' : '') + 'It comes back with the next edition: about 1:15 in the afternoon, or before 9 in the morning.</p>' +
        (h.changes ? '<p class="meta">What you asked to change: ' + esc(h.changes) + '</p>' : '') + (h.note ? '<p class="meta">Your note: ' + esc(h.note) + '</p>' : '') +
        (live ? (S.handNote[L.id] ? field('Anything Claude should know?', 'handnote', 'Save') :
          '<div class="row"><button class="link" type="button" data-act="handnoteopen" data-id="' + id + '">' + (h.note ? 'Change the note' : 'Add a note for Claude') + '</button><button class="link" type="button" data-act="handback" data-id="' + id + '">Take it back</button></div>') : '') + '</div>';
    }
    if ((st === 'ready' || st === 'cant' || st === 'seen') && h.result && typeof h.result === 'object') {
      const r = h.result; const open = !!S.handOpen[L.id]; const link = safeUrl(r.link);
      return '<div class="hand back"><p class="hand-h">' + (st === 'cant' ? 'Claude needs something from you' : 'Back from Claude') + (h.doneAt ? ' · ' + esc(ago(h.doneAt)) : '') + '</p>' +
        (r.summary ? '<p>' + esc(r.summary) + '</p>' : '') + (r.needs ? '<p class="soft">' + esc(r.needs) + '</p>' : '') +
        (r.body ? '<div class="row"><button class="link" type="button" data-act="handshow" data-id="' + id + '" aria-expanded="' + open + '">' + (open ? 'Hide it' : 'Show it') + '</button>' + (open ? '<button class="link" type="button" data-act="handcopy" data-id="' + id + '">Copy</button>' : '') + '</div>' + (open ? '<div class="body">' + richText(r.body) + '</div>' : '') : '') +
        (link ? '<div class="row"><a class="link" href="' + esc(link) + '" target="_blank" rel="noopener">Open the full version ↗</a></div>' : '') +
        (live ? (S.handFix[L.id] ? field(st === 'cant' ? 'Your answer' : 'What should change?', 'handfix', 'Send it back') :
          '<div class="row">' + (st !== 'seen' && L.status !== 'done' ? '<button class="btn small primary" type="button" data-act="handseen" data-id="' + id + '">' + (r.finishes ? 'Looks good. That\'s done.' : 'Looks good') + '</button>' : '') +
          '<button class="btn small" type="button" data-act="handfixopen" data-id="' + id + '">' + (st === 'cant' ? 'Answer Claude' : 'Change something') + '</button></div>') : '') + '</div>';
    }
    if (!live || (L.status !== 'open' && L.status !== 'unsure')) return '';
    return '<div class="hand offer">' + (L.offer ? '<p class="meta">Claude can take this: ' + esc(L.offer) + '</p>' : '') +
      '<div class="row"><button class="btn small" type="button" data-act="handoff" data-id="' + id + '">Hand it to Claude</button></div></div>';
  }
  /* What has come back and not been looked at yet, gathered at the top of Today. */
  function backBlock(live, skipId) {
    const list = loopList().filter(L => handBack(L) && L.id !== skipId).sort((a, b) => String(hand(b).doneAt || '').localeCompare(String(hand(a).doneAt || '')));
    if (!list.length) return '';
    return '<section class="sec" aria-labelledby="bkH"><h2 class="h" id="bkH">Back from Claude · ' + list.length + '</h2><div>' + list.map(L =>
      '<div class="backrow"><h3>' + esc(L.title) + '</h3>' + handBlock(L, live) + '</div>').join('') + '</div></section>';
  }

  /* ---------- one habit at a time ----------
     habits/<id>: { title, anchor, tiny, after, when, area, why, status idea|building|paused|kept|dropped, startedOn, keptOn,
     days { ymd: 'yes'|'no' }, miss { ymd: forgot|time|energy|skip }, feel { ymd: effort|easier|auto }, note, suggest { anchor, tiny, why, on },
     suggestAnswered, adjustOn, keepAskedOn, rhythmId, reading }. Only one is "building" at a time, and the page asks about it once a day.
     A day with no answer is a blank, never a miss. The run reads the answers and may leave a note or one suggestion. */
  const habitList = () => Object.keys(S.habits).map(k => S.habits[k]).filter(H => H && !H.deleted && (H.title || H.tiny));
  const building = () => habitList().filter(H => H.status === 'building').sort((a, b) => String(b.startedOn || '').localeCompare(String(a.startedOn || '')) || String(a.id).localeCompare(String(b.id)))[0] || null;
  const hSay = (H, d) => { const v = H && H.days && H.days[d]; return v === 'yes' || v === 'no' ? v : ''; };
  const trimEnd = s => String(s == null ? '' : s).trim().replace(/[.!\s]+$/, '');
  const cleanAnchor = s => trimEnd(s).replace(/^after\s+/i, '');
  const cleanTiny = s => trimEnd(s).replace(/^(and\s+|then\s+)?i(\s+will|['’]ll)\s+/i, '');
  const planHtml = H => { const a = cleanAnchor(H.anchor), t = cleanTiny(H.tiny) || trimEnd(H.title); return (a ? 'After ' + esc(a) + ', I will ' : 'I will ') + '<b>' + esc(t) + '</b>.'; };
  const planText = H => { const a = cleanAnchor(H.anchor), t = cleanTiny(H.tiny) || trimEnd(H.title); return (a ? 'After ' + a + ', I will ' : 'I will ') + t + '.'; };
  const FEELS = [['effort', 'I have to push'], ['easier', 'Getting easier'], ['auto', 'I just do it']];
  const MISSES = [['forgot', 'Forgot'], ['time', 'No time'], ['energy', 'Low energy'], ['skip', 'Didn’t want to']];
  const WHENS = [['morning', 'Morning'], ['afternoon', 'Afternoon'], ['evening', 'Evening']];
  const DEF_ANCHORS = [{ t: 'I sit down at my desk', w: 'morning' }, { t: 'I finish lunch', w: 'afternoon' }, { t: 'I finish dinner', w: 'evening' }, { t: 'I get out of the shower', w: 'evening' }];
  const anchorChips = () => { const c = cfgList('anchors').filter(x => x && x.t); return c.length ? c : DEF_ANCHORS; };
  const hSug = H => { const g = H && H.suggest; return g && typeof g === 'object' && g.on && H.suggestAnswered !== g.on && (g.anchor || g.tiny) ? g : null; };
  function hQuiet() { try { const v = localStorage.getItem('tl.hquiet') || ''; return validYMD(v) && dayDiff(todayYMD(), v) < 7; } catch (e) { return false; } }
  function hStats(H) {
    const t = todayYMD(); const start = validYMD(H.startedOn) && H.startedOn <= t ? H.startedOn : t;
    const n = dayDiff(t, start) + 1;                        // which day of building this is, today included
    const span = Math.min(n, 14); let yes = 0, yes21 = 0, off = 0, total = 0;
    for (let i = 0; i < n; i++) { const v = hSay(H, addDays(t, -i)); if (v !== 'yes') continue; total++; if (i < span) yes++; if (i < 21) yes21++; }
    for (let i = 1; i < n && i <= 7; i++) { if (hSay(H, addDays(t, -i)) === 'no') off++; else break; }   // "not done" days in a row, ending yesterday
    const fd = Object.keys(H.feel || {}).filter(d => validYMD(d) && H.feel[d] && d >= start).sort(); const lastFeelOn = fd[fd.length - 1] || '';
    return { t: t, start: start, n: n, span: span, yes: yes, yes21: yes21, off: off, total: total, lastFeelOn: lastFeelOn, lastFeel: lastFeelOn ? H.feel[lastFeelOn] : '' };
  }
  const hCount = st => (st.n < 14 ? st.yes + ' of ' + st.n + ' day' + (st.n === 1 ? '' : 's') + ' so far' : st.yes + ' of the last 14 days');
  function hDots(H, st) {
    let h = '';
    for (let i = st.span - 1; i >= 0; i--) h += '<i class="' + (hSay(H, addDays(st.t, -i)) || 'blank') + (i === 0 ? ' tod' : '') + '"></i>';
    return '<div class="hdots" role="img" aria-label="' + esc(hCount(st)) + '">' + h + '</div>';
  }
  /* Four weeks, a square a day. Tapping a square fixes that day: done, not done, or back to blank. */
  function hCal(H, st) {
    const first = addDays(st.t, -27); let h = '';
    for (let i = 0; i < 7; i++) h += '<span>' + esc(fDow.format(asDate(addDays(first, i))).slice(0, 2)) + '</span>';
    for (let i = 0; i < 28; i++) {
      const d = addDays(first, i); const v = hSay(H, d); const off = d < st.start;
      h += '<button type="button" class="' + v + (d === st.t ? ' tod' : '') + '"' + (off ? ' disabled' : ' data-act="hdot" data-id="' + esc(H.id) + '" data-day="' + d + '"') +
        ' aria-label="' + esc(fShort.format(asDate(d)) + ': ' + (off ? 'before you started' : v === 'yes' ? 'done' : v === 'no' ? 'not done' : 'no answer')) + '">' + Number(d.slice(8)) + '</button>';
    }
    return '<div class="hcal">' + h + '</div>';
  }
  /* Today's question, yesterday's if it was left blank, and whatever follows from the answers. */
  function habitAsk(H, st) {
    const id = esc(H.id); const t = st.t; const y = addDays(t, -1); const today = hSay(H, t);
    const btn = (label, val, d, cls) => '<button class="btn small' + (cls || '') + '" type="button" data-act="hday" data-id="' + id + '" data-val="' + val + '" data-day="' + d + '">' + label + '</button>';
    const redo = label => ' <button class="link inline" type="button" data-act="hday" data-id="' + id + '" data-val="" data-day="' + t + '">' + label + '</button>';
    let h = ''; const g = hSug(H);
    if (g) {
      h += '<div class="soft"><p>' + esc(g.why || 'A suggestion from Claude, from how the last days went:') + '</p><p class="plan">' + planHtml({ anchor: g.anchor || H.anchor, tiny: g.tiny || H.tiny, title: H.title }) + '</p>' +
        '<div class="row"><button class="btn small primary" type="button" data-act="hsugyes" data-id="' + id + '">Use that</button><button class="btn small quiet" type="button" data-act="hsugno" data-id="' + id + '">Keep mine</button></div></div>';
    } else if (H.note) h += '<p class="soft">' + esc(H.note) + '</p>';
    if (!today) h += '<div class="row">' + btn('Done today', 'yes', t, ' primary') + btn('Not today', 'no', t) + '</div>';
    else if (today === 'yes') {
      h += '<p><b>Done today.</b>' + (st.total === 1 ? ' That is the first one, and the early days do the most.' : '') + redo('undo') + '</p>' + (H.after ? '<p class="meta">Now: ' + esc(trimEnd(H.after)) + '.</p>' : '');
    } else {
      const lab = (MISSES.find(m => m[0] === (H.miss && H.miss[t])) || [])[1];
      h += '<p class="soft">Not today. One missed day doesn’t set a habit back; the research is clear on that. Tomorrow is the one that counts.' + redo('change') + '</p>' +
        (lab ? '<p class="meta">In the way: ' + esc(lab.toLowerCase()) + '. Noted.</p>' :
          '<div class="seg"><span class="meta">What got in the way? One tap, and only if you feel like it.</span><div class="chips">' + MISSES.map(m => '<button class="chip" type="button" data-act="hmiss" data-id="' + id + '" data-val="' + m[0] + '">' + m[1] + '</button>').join('') + '</div></div>');
    }
    if (st.n > 1 && !hSay(H, y)) h += '<div class="seg"><span class="meta">And yesterday?</span><div class="row">' + btn('Yes, did it', 'yes', y) + btn('No', 'no', y) + '</div></div>';
    const adjusted = validYMD(H.adjustOn) && dayDiff(t, H.adjustOn) < 3;
    if (st.off >= 2 && today !== 'yes' && !adjusted && !g) {
      h += '<div class="soft"><p>Two days off in a row. That usually means the step is too big or the cue is in the wrong spot. It says nothing about you.</p>' +
        '<div class="row"><button class="btn small" type="button" data-act="hsmaller" data-id="' + id + '">Make it smaller</button><button class="btn small" type="button" data-act="hmove" data-id="' + id + '">Move it</button><button class="btn small quiet" type="button" data-act="hfine" data-id="' + id + '">It’s fine as it is</button></div></div>';
    }
    if (today && st.n >= 7 && (!st.lastFeelOn || dayDiff(t, st.lastFeelOn) >= 7)) {
      h += '<div class="seg"><span class="meta">Once a week: how automatic is it by now?</span><div class="row">' + FEELS.map(f => '<button class="btn small" type="button" data-act="hfeel" data-id="' + id + '" data-val="' + f[0] + '">' + f[1] + '</button>').join('') + '</div></div>';
    }
    const asked = validYMD(H.keepAskedOn) && dayDiff(t, H.keepAskedOn) < 7;
    if (!asked && ((st.n >= 21 && st.yes21 >= 17 && st.lastFeel === 'auto') || (st.n >= 66 && st.yes21 >= 15))) {
      h += '<div class="soft"><p><b>This looks like a habit now.</b> ' + st.yes21 + ' of the last 21 days' + (st.lastFeel === 'auto' ? ', and you said you just do it' : '') + '.</p>' +
        '<div class="row"><button class="btn small primary" type="button" data-act="hkeep" data-id="' + id + '">Call it built</button><button class="btn small quiet" type="button" data-act="hwait" data-id="' + id + '">Keep building</button></div></div>';
    }
    return h;
  }
  /* The card near the top of Today. */
  function habitCard() {
    if (!S.gotHabits || !S.db) return '';
    const H = building();
    if (!H) {
      if (hQuiet()) return '';
      const n = habitList().filter(x => x.status === 'idea').length; const kept = habitList().some(x => x.status === 'kept');
      return '<section class="habit" aria-label="One habit at a time"><div class="eyebrow">One habit at a time</div>' +
        '<p>' + (kept ? 'Nothing in the making right now. Ready for the next one?' : 'Build one small habit, tied to something you already do. The page asks once a day whether it happened.') + (n ? ' ' + n + (n === 1 ? ' is' : ' are') + ' ready to pick from.' : '') + '</p>' +
        '<div class="row"><button class="btn small primary" type="button" data-act="hgo">' + (n ? 'Pick one' : 'Write one') + '</button><button class="btn small quiet" type="button" data-act="hquiet">Not now</button></div></section>';
    }
    const st = hStats(H);
    return '<section class="habit" aria-label="Your one habit"><div class="eyebrow">One habit · day ' + st.n + '</div><p class="plan">' + planHtml(H) + '</p>' +
      habitAsk(H, st) + hDots(H, st) + '<p class="meta">' + hCount(st) + ' · <button class="link inline" type="button" data-act="hgo">more</button></p></section>';
  }
  /* The reasons, in plain words. These are the general ones; the owner's own notes may carry a fuller set
     (meta/config.habitWhy, a list of { b, t }, and habitWhyNote), written for him by the run. */
  const HWHY_DEF = [
    { b: 'Tied to something you already do.', t: 'Plans shaped like \u201cAfter this, I will do that\u201d gave a medium-to-large lift in follow-through across 94 studies and more than 8,000 people. A cue that happens anyway does the remembering for you.' },
    { b: 'Small on purpose.', t: 'What builds a habit is repeating it in the same spot, not how big it is. The two-minute version counts in full.' },
    { b: 'A missed day is only a missed day.', t: 'In the best-known study (96 people, twelve weeks), missing one day made no real difference to how the habit formed. People who were very inconsistent didn\u2019t get there. Hence: never miss twice.' },
    { b: 'It takes as long as it takes.', t: 'In that study it took about two months on average before the thing ran by itself, and the range was 18 days to 254. The three-week rule is a myth. The steepest gains come in the first weeks.' },
    { b: 'One question a day.', t: 'Across 138 experiments, people who kept a record of their progress got further, and more so when the record was written down where they could see it.' },
    { b: 'Something good right after.', t: 'A small reward straight after the habit does more to keep it going than a big one far off.' }];
  const HWHY_NOTE = 'Sources: Lally and colleagues, 2010; Gollwitzer and Sheeran, 2006; Keller and colleagues, 2021; Harkin and colleagues, 2016; Singh and colleagues, 2024; Woolley and Fishbach, 2017.';
  function hWhyHtml() {
    const own = cfgList('habitWhy').filter(x => x && x.t); const list = own.length ? own : HWHY_DEF;
    return '<div class="hwhy">' + list.map(x => '<p>' + (x.b ? '<b>' + esc(x.b) + '</b> ' : '') + esc(x.t) + '</p>').join('') + '<p class="meta">' + esc((own.length && S.config.habitWhyNote) || HWHY_NOTE) + '</p></div>';
  }
  function habitEditor() {
    const E = S.hEdit; const H = E.id ? S.habits[E.id] : null; const live = !!(H && H.status === 'building');
    const inp = (key, id, label, ph, max) => '<label>' + label + '<input class="field" id="' + id + '" data-h="' + key + '" type="text" maxlength="' + max + '" placeholder="' + ph + '" value="' + esc(E[key] || '') + '" autocomplete="off"></label>';
    return '<div class="card hedit">' +
      inp('title', 'hTitle', 'The habit, in a few words', 'A short walk', 120) +
      inp('anchor', 'hAnchor', 'After… (something that already happens every day)', 'I sit down at my desk', 160) +
      '<div class="chips" aria-label="Things already in your day">' + anchorChips().map(a => '<button class="chip" type="button" data-act="hanchor" data-id="' + esc(a.t) + '" data-val="' + esc(a.w || '') + '">' + esc(a.t) + '</button>').join('') + '</div>' +
      inp('tiny', 'hTiny', 'I will… (the two-minute version; it counts in full)', 'put my shoes on and walk to the mailbox', 200) +
      '<div class="seg"><span class="meta">Which part of the day is that?</span><div class="row">' + WHENS.map(w => '<button class="btn small" type="button" data-act="hwhen" data-id="' + w[0] + '" aria-pressed="' + (E.when === w[0] ? 'true' : 'false') + '">' + w[1] + '</button>').join('') + '</div></div>' +
      inp('after', 'hAfter', 'Something good right after (optional)', 'the first coffee', 120) +
      '<div class="row"><button class="btn primary" type="button" data-act="hsave">' + (live ? 'Save' : 'Start it') + '</button><button class="btn quiet" type="button" data-act="hcancel">Cancel</button></div>' +
      (live ? '' : '<p class="meta">Starting one pauses any other habit in the making. One at a time.</p>') + '</div>';
  }
  /* The whole of it, under Check in: the habit in the making, the ones waiting, the ones built, and the reasons. */
  function habitSection() {
    if (!S.gotHabits) return '';
    const H = building(); const all = habitList();
    const ideas = all.filter(x => x.status === 'idea').sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id).localeCompare(String(b.id)));
    const paused = all.filter(x => x.status === 'paused');
    const kept = all.filter(x => x.status === 'kept').sort((a, b) => String(a.keptOn || '').localeCompare(String(b.keptOn || '')));
    let h = '<section class="sec" id="habitSec" aria-labelledby="ciH"><h2 class="h" id="ciH">One habit at a time</h2>';
    if (S.hEdit) h += habitEditor();
    else if (H) {
      const st = hStats(H); const id = esc(H.id);
      const feels = Object.keys(H.feel || {}).filter(d => validYMD(d) && H.feel[d] && d >= st.start).sort().slice(-4).map(d => esc(fShort.format(asDate(d))) + ', “' + esc(String((FEELS.find(f => f[0] === H.feel[d]) || [])[1] || '')) + '”').join(' · ');
      h += '<div class="habit"><div class="eyebrow">In the making · day ' + st.n + '</div>' + (H.title ? '<h3>' + esc(H.title) + '</h3>' : '') + '<p class="plan">' + planHtml(H) + '</p>' +
        (H.why ? '<p class="meta">' + esc(H.why) + '</p>' : '') + habitAsk(H, st) + hCal(H, st) +
        '<p class="meta">' + st.total + ' day' + (st.total === 1 ? '' : 's') + ' done since you started on ' + esc(fShort.format(asDate(st.start))) + '. Tap a day to fix it: done, not done, or blank. A blank is only a blank.</p>' +
        (feels ? '<p class="meta">How automatic it has felt: ' + feels + '.</p>' : '') +
        '<div class="row"><button class="link" type="button" data-act="hedit" data-id="' + id + '">Change the words</button><button class="link" type="button" data-act="hpause" data-id="' + id + '">Pause it</button>' +
        '<button class="link" type="button" data-act="hdrop" data-id="' + id + '">' + (S.hArm === 'drop:' + H.id ? 'Tap again to let it go' : 'Let it go') + '</button></div></div>';
    } else {
      h += '<p>' + (kept.length ? 'Ready for the next one? ' : '') + 'Pick one habit, tie it to something you already do, and make it small enough to do on a bad day. The page asks once a day whether it happened.</p>' +
        (ideas.length || paused.length ? '' : '<p class="meta">No suggestions are here yet. They arrive with the next edition. You can write your own now.</p>');
    }
    if (!S.hEdit) {
      const pick = ideas.concat(paused);
      if (pick.length) {
        h += '<div class="card">' + (H ? '<p class="meta">Waiting their turn, for when this one is built or set down:</p>' : '') + '<div>' + pick.map(x => {
          const xid = esc(x.id); const arm = S.hArm === 'start:' + x.id;
          return '<div class="hidea"><h3>' + esc(x.title || 'A habit') + (x.status === 'paused' ? ' <span class="meta">paused</span>' : '') + '</h3><p class="plan">' + planHtml(x) + '</p>' + (x.why ? '<p class="meta">' + esc(x.why) + '</p>' : '') +
            '<div class="row"><button class="btn small' + (H ? '' : ' primary') + '" type="button" data-act="hstart" data-id="' + xid + '">' + (arm ? 'Tap again: it pauses the current one' : x.status === 'paused' ? 'Pick it back up' : 'Start this one') + '</button>' +
            '<button class="link" type="button" data-act="hedit" data-id="' + xid + '">Change the words first</button></div></div>';
        }).join('') + '</div></div>';
      }
      h += '<div class="row"><button class="btn small" type="button" data-act="hedit" data-id="">Write your own</button></div>';
    }
    if (kept.length) h += '<div><p class="meta">Habits you’ve built:</p><ul class="wins">' + kept.map(x => '<li>' + esc(x.title || cleanTiny(x.tiny)) + (validYMD(x.keptOn) ? ' <span class="meta">since ' + esc(fShort.format(asDate(x.keptOn))) + '</span>' : '') + '</li>').join('') + '</ul></div>';
    return h + '<div class="row"><button class="link" type="button" data-act="hwhy" aria-expanded="' + (S.hWhy ? 'true' : 'false') + '">' + (S.hWhy ? 'Hide the reasons' : 'Why it works this way') + '</button></div>' + (S.hWhy ? hWhyHtml() : '') + '</section>';
  }

  /* ---------- the hour ----------
     The top of Today changes through the day: the plan in the morning, the one thing in the hour he says hard things
     go best, what's left in the afternoon, the evening's items and Close the day at night. It reads the clock; no run needed. */
  function hardWindow() {
    const pref = S.prefs && S.prefs.hardThingTime; const A = askList().find(a => a.sets === 'hardThingTime' && a.status === 'answered');
    const v = String((pref && pref.value) || (A && A.answer) || '');
    if (/first thing/i.test(v)) return { from: 7, to: 10, said: 'first thing' };
    if (/late morning/i.test(v)) return { from: 10, to: 12, said: 'late in the morning' };
    if (/evening/i.test(v)) return { from: 18, to: 21, said: 'in the evening' };
    if (/after lunch/i.test(v)) return { from: 12.5, to: 15.5, said: 'after lunch' };
    return { from: 12.5, to: 15.5, said: '' };
  }
  function nowCard(d) {
    const t = clockNow(); const ticks = d.ticks || {}; const c = checkin();
    const items = (Array.isArray(d.today) ? d.today : []).filter(it => it && it.title);
    const isDone = it => { const L = it.loopId && S.loops[it.loopId]; return L ? L.status === 'done' : !!ticks[it.id]; };
    const left = items.filter(it => it.kind !== 'event' && it.kind !== 'holiday' && !isDone(it));
    const next = items.map(it => ({ it: it, c: clockOf(it.time) })).filter(x => x.c != null && x.c > t - 0.25 && !isDone(x.it)).sort((a, b) => a.c - b.c)[0];
    const ch = oneChoice(d, true); const o = ch.o && ch.o.title ? ch.o : null;
    const L = (o && o.loopId && S.loops[o.loopId]) || null;
    const oneOpen = !!o && (!L || (L.status === 'open' && !isSnoozed(L)));
    const oneLanded = !!(L && L.status === 'done');
    const w = hardWindow();
    const nextLine = next ? '<p><b>Next:</b> ' + esc(next.it.time) + ' · ' + esc(next.it.title) + '</p>' : '';
    const pm = d.afternoon && d.afternoon.line ? '<p class="meta">After lunch' + (d.afternoon.writtenLabel ? ', ' + esc(d.afternoon.writtenLabel) : '') + ': ' + esc(d.afternoon.line) + '</p>' : '';
    const close = !c.rating ? '<div class="row"><button class="btn small" type="button" data-act="nav" data-id="checkin">Close the day</button></div>' : '';
    let eyebrow, body;
    if (oneOpen && t >= w.from && t < w.to) {
      eyebrow = 'Your hour for the hard thing';
      body = (w.said ? '<p class="meta">You said hard things go best ' + w.said + '.</p>' : '') + '<h3>' + esc(o.title) + '</h3>' +
        (o.firstStep ? '<p><b>First two minutes:</b> ' + esc(o.firstStep) + '</p>' : '') +
        (o.waiting ? '<p>' + esc(o.waiting) + '</p>' : '') + (o.after ? '<p class="meta">Then: ' + esc(o.after) + '</p>' : '') +
        (c.energy === 'low' ? '<p class="meta">Low-energy day: the first two minutes are plenty.</p>' : '') + pm;
    } else if (t < 12) {
      eyebrow = 'This morning';
      body = (nextLine || '<p>Nothing on the clock this morning.</p>') + (oneOpen && t < w.from ? '<p class="meta">The one thing waits for ' + (w.said || 'early afternoon') + ': ' + esc(o.title) + '.</p>' : '');
    } else if (t < 17) {
      eyebrow = 'This afternoon';
      body = (oneLanded ? '<p>The one thing has landed.</p>' : oneOpen ? '<p>The one thing is still open, and two minutes is enough to start it.</p>' : '') + nextLine +
        '<p class="meta">' + (left.length ? left.length + ' thing' + (left.length === 1 ? '' : 's') + ' left on today\'s list.' : 'Today\'s list is clear.') + '</p>' + pm;
    } else if (t < 21.5) {
      const eve = left.filter(it => { const k = clockOf(it.time); return k != null ? k >= 17 : /even|tonight|night/i.test(String(it.time || '')); }).slice(0, 3);
      eyebrow = 'This evening';
      body = (eve.length ? '<p>' + eve.map(it => esc(it.title)).join(' · ') + '</p>' : '<p>Nothing left that needs you tonight.</p>') +
        (oneLanded ? '<p class="meta">The one thing landed today.</p>' : '') + pm + close;
    } else {
      const landed = items.filter(isDone).length + loopList().filter(x => x.status === 'done' && Date.parse(x.doneAt || '') && fYMD.format(new Date(x.doneAt)) === todayYMD() && !items.some(it => it.loopId === x.id)).length;
      eyebrow = 'The day is done';
      body = '<p>' + (landed ? landed + ' thing' + (landed === 1 ? '' : 's') + ' landed today.' : 'Nothing more is owed tonight. What didn\'t happen keeps.') + '</p>' + close + '<p class="meta">Tomorrow\'s page is ready before 9.</p>';
    }
    return '<section class="now" aria-label="Right now"><div class="eyebrow">' + eyebrow + '</div>' + body + '</section>';
  }

  function loopActions(L, opts) {
    opts = opts || {};
    const id = esc(L.id);
    if (L.status === 'done') return '<div class="row"><span class="meta">Landed ' + esc(ago(L.doneAt)) + '</span><button class="link" type="button" data-act="reopen" data-id="' + id + '">Undo</button></div>';
    if (L.status === 'unsure') return '<div class="row"><button class="btn small primary" type="button" data-act="done" data-id="' + id + '">Done</button><button class="btn small" type="button" data-act="still" data-id="' + id + '">Still open</button><button class="btn small quiet" type="button" data-act="drop" data-id="' + id + '">' + (S.dropArm === L.id ? 'Tap again to let it go' : 'Not mine') + '</button></div>';
    if (L.status === 'waiting') return '<div class="row"><button class="btn small primary" type="button" data-act="done" data-id="' + id + '">It\'s done</button><button class="btn small" type="button" data-act="still" data-id="' + id + '">Back with me</button><button class="btn small quiet" type="button" data-act="drop" data-id="' + id + '">' + (S.dropArm === L.id ? 'Tap again to let it go' : 'Let it go') + '</button></div>';
    return '<div class="row"><button class="btn small primary" type="button" data-act="done" data-id="' + id + '">I did it</button>' +
      (isSnoozed(L) ? '<span class="meta">Set down until ' + esc(fShort.format(asDate(L.snoozeUntil))) + '</span>' : '<button class="btn small" type="button" data-act="pass" data-id="' + id + '">Not today</button>') +
      '<button class="btn small quiet" type="button" data-act="drop" data-id="' + id + '">' + (S.dropArm === L.id ? 'Tap again to let it go' : 'Let it go') + '</button>' +
      (S.sample && !opts.noHelp ? '<button class="link" type="button" data-act="help" data-id="' + id + '">Help me start</button>' : '') + '</div>';
  }
  function parseSteps(text) {
    return String(text || '').split('\n').map(l => (/^\s*\d+[.)]\s+(.+)$/.exec(l) || [])[1]).filter(Boolean).map(s => s.trim().slice(0, 160)).slice(0, 6);
  }
  const loopSteps = L => (Array.isArray(L.steps) ? L.steps.filter(s => s && s.id && s.text) : []);
  function helpBlock(id) {
    const h = S.help[id]; if (!h) return '';
    const L = S.loops[id];
    const canList = !h.busy && L && !loopSteps(L).length && parseSteps(h.text).length >= 2;
    return '<div class="helpout" aria-live="polite">' + esc(h.text) + '</div>' + (h.busy ? '' : '<div class="row">' +
      (canList ? '<button class="btn small" type="button" data-act="mksteps" data-id="' + esc(id) + '">Make these a checklist</button>' : '') +
      '<button class="link" type="button" data-act="copyhelp" data-id="' + esc(id) + '">Copy</button><button class="link" type="button" data-act="hidehelp" data-id="' + esc(id) + '">Hide</button></div>');
  }
  /* A loop's small steps as a tickable list. Ticks are saved on the loop, so they survive a refresh and a new edition. */
  function stepsBlock(L, live) {
    const st = loopSteps(L); if (!st.length) return '';
    const tk = L.stepTicks || {}; const n = st.filter(s => tk[s.id]).length;
    return '<div><div class="steps-h">Step by step · ' + n + ' of ' + st.length + '</div><ul class="steps">' + st.map(s => {
      const on = !!tk[s.id];
      return '<li class="' + (on ? 'on' : '') + '">' + (live ? '<button class="tick" type="button" data-act="step" data-id="' + esc(L.id) + '" data-val="' + esc(s.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + esc((on ? 'Done: ' : 'Mark done: ') + s.text) + '"></button>' : '') +
        '<span>' + esc(s.text) + '</span></li>';
    }).join('') + '</ul>' + (live && n === st.length && L.status !== 'done' ? '<p class="meta">Every step is ticked. Tap I did it to land it.</p>' : '') + '</div>';
  }
  /* After "Not today": one optional tap on what got in the way. It changes how the thing comes back. */
  function blockerRow(L) {
    if (L.passedOn !== todayYMD()) return '';
    if (L.blocker && L.blockerOn === todayYMD()) { const b = BLOCKS.find(x => x[0] === L.blocker); return '<p class="meta">In the way: ' + esc(b ? b[1].toLowerCase() : L.blocker) + '. Noted. It shapes how this one comes back.</p>'; }
    return '<div class="seg"><span class="meta">What got in the way? One tap, and only if you feel like it.</span><div class="chips">' + BLOCKS.map(b => '<button class="chip" type="button" data-act="block" data-id="' + esc(L.id) + '" data-val="' + b[0] + '">' + b[1] + '</button>').join('') + '</div></div>';
  }
  /* One question, with its buttons. kind: choice (default), multi, text or number. */
  function askCard(A, pos) {
    const id = esc(A.id); const kind = A.kind || 'choice';
    const opts = Array.isArray(A.options) ? A.options : [];
    let h = '<div class="ask">' + (pos ? '<div class="of">' + esc(pos) + '</div>' : '') + '<p class="q">' + esc(A.text) + '</p>';
    if (kind === 'multi') {
      const sel = S.multi[A.id] || {};
      h += '<div class="row">' + opts.map((o, i) => '<button class="btn small" type="button" data-act="pick" data-id="' + id + '" data-val="' + i + '" aria-pressed="' + (sel[i] ? 'true' : 'false') + '">' + esc(o) + '</button>').join('') + '</div>';
      if (A.allowOther) h += '<div class="row"><input class="field" id="ans-' + id + '" type="text" maxlength="300" placeholder="Or in your own words" aria-label="Your own answer"></div>';
      h += '<div class="row"><button class="btn small primary" type="button" data-act="ansmulti" data-id="' + id + '">Save</button><span class="meta">Pick any that fit.</span></div>';
    } else if (kind === 'text' || kind === 'number') {
      h += '<div class="row"><input class="field" id="ans-' + id + '" type="text"' + (kind === 'number' ? ' inputmode="decimal"' : '') + ' maxlength="300" placeholder="' + (kind === 'number' ? 'A number' : 'A few words') + '" aria-label="' + esc(A.text) + '"><button class="btn small primary" type="button" data-act="anstext" data-id="' + id + '">Save</button></div>';
    } else {
      h += '<div class="row">' + opts.map((o, i) => '<button class="btn small" type="button" data-act="ans" data-id="' + id + '" data-val="' + i + '">' + esc(o) + '</button>').join('') + '</div>';
      if (A.allowOther) h += '<div class="row"><input class="field" id="ans-' + id + '" type="text" maxlength="300" placeholder="Or in your own words" aria-label="Your own answer"><button class="btn small" type="button" data-act="anstext" data-id="' + id + '">Save</button></div>';
    }
    return h + (A.why ? '<p class="why">Why I ask: ' + esc(A.why) + '</p>' : '') + '<div class="row"><button class="link" type="button" data-act="skipask" data-id="' + id + '">Skip this one</button></div></div>';
  }
  /* The day's one-tap checks (energy, sleep). compact = the single line shown on Today. */
  function checkStrip(compact) {
    const c = checkin();
    return checks().slice(0, compact ? 1 : 8).map(k => {
      const cur = c[k.id]; const kid = esc(k.id);
      if (compact && cur) { const o = k.options.find(x => x.v === cur); return '<p class="meta">' + esc(k.label) + ': <b>' + esc(o ? o.t : cur) + '</b> · <button class="link inline" type="button" data-act="check" data-id="' + kid + '" data-val="">change</button></p>'; }
      return '<div class="seg"><span class="lab">' + esc(k.label) + '</span><div class="row">' + k.options.map(o => '<button class="btn small" type="button" data-act="check" data-id="' + kid + '" data-val="' + esc(o.v) + '" aria-pressed="' + (cur === o.v ? 'true' : 'false') + '">' + esc(o.t) + '</button>').join('') + '</div></div>';
    }).join('');
  }

  /* The edition may carry up to two other candidates. Which one he is looking at is saved with the day's check-in. */
  const altKey = x => String((x && (x.loopId || x.title)) || '');
  function oneChoice(d, actionable) {
    const base = d.oneThing || {};
    const alts = (Array.isArray(base.alternates) ? base.alternates : []).filter(x => x && x.title);
    const sw = actionable ? String(checkin().swappedTo || '') : '';
    const at = sw ? alts.findIndex(x => altKey(x) === sw) + 1 : 0;
    return { base: base, alts: alts, at: at, o: at ? alts[at - 1] : base };
  }
  function renderOne(d) {
    if (!d.oneThing || !d.oneThing.title) return '';
    const actionable = S.dayIdx === 0;
    const ch = oneChoice(d, actionable); const o = ch.o;
    const L = (o.loopId && S.loops[o.loopId]) || null;
    const a = areaOf(o.area || (L && L.area));
    const swap = actionable && ch.alts.length && S.db ? '<div class="row"><button class="link" type="button" data-act="swap">' + (ch.at === ch.alts.length ? 'Back to the first one' : 'Show me a different one') + '</button></div>' : '';
    const metaBits = [];
    if (o.minutes) metaBits.push('about ' + esc(o.minutes) + ' minutes');
    if (a.name) metaBits.push(esc(a.name));
    if (L && validYMD(L.due)) metaBits.push(esc(dueText(L.due)));
    if (L && L.status === 'done') {
      return '<section class="one landed" aria-label="The one thing"><div class="eyebrow">Landed</div><h2>' + esc(o.title) + '</h2><p class="why">That one is off your plate. ' + esc(o.landedNote || 'Tomorrow brings a different one.') + '</p>' + loopActions(L) + '</section>';
    }
    if (L && L.status === 'dropped') {
      return '<section class="one set" aria-label="The one thing"><div class="eyebrow">Let go</div><h2>' + esc(o.title) + '</h2><p class="why">Off the list. If it turns out to matter, add it back from Loops.</p><div class="row"><button class="link" type="button" data-act="reopen" data-id="' + esc(L.id) + '">Put it back</button></div>' + swap + '</section>';
    }
    if (L && L.status === 'waiting') {
      return '<section class="one set" aria-label="The one thing"><div class="eyebrow">Waiting on someone</div><h2>' + esc(o.title) + '</h2><p class="why">It\'s in someone else\'s hands for now. It stays on the list under Waiting.</p>' + loopActions(L) + swap + '</section>';
    }
    if (L && actionable && isSnoozed(L)) {
      return '<section class="one set" aria-label="The one thing"><div class="eyebrow">Set down for today</div><h2>' + esc(o.title) + '</h2><p class="why">Fine. It comes back around. Never miss twice.</p>' + blockerRow(L) + '<div class="row"><button class="link" type="button" data-act="unpass" data-id="' + esc(L.id) + '">Pick it back up</button></div>' + swap + '</section>';
    }
    const low = actionable && checkin().energy === 'low';
    return '<section class="one" aria-label="The one thing"><div class="eyebrow">' + (ch.at ? 'Another option · ' + (ch.at + 1) + ' of ' + (ch.alts.length + 1) : 'The one thing') + '</div><h2>' + esc(o.title) + '</h2>' +
      (o.why ? '<p class="why">' + esc(o.why) + '</p>' : '') +
      (o.firstStep ? '<div class="first"><span class="lab">First two minutes</span><p>' + esc(o.firstStep) + '</p></div>' : '') +
      (o.waiting ? '<p class="meta">' + esc(o.waiting) + '</p>' : '') + (o.after ? '<p class="meta">Then: ' + esc(o.after) + '</p>' : '') +
      (low ? '<p class="soft">Low-energy day. The first two minutes are plenty; the rest can wait for a better hour.</p>' : '') +
      (L ? stepsBlock(L, actionable) : '') +
      (o.script ? '<div class="script"><button class="link" type="button" data-act="script" aria-expanded="' + (S.scriptOpen ? 'true' : 'false') + '">' + (S.scriptOpen ? 'Hide the words' : 'What to say') + '</button>' + (S.scriptOpen ? '<p>' + esc(o.script) + '</p>' : '') + '</div>' : '') +
      (L && actionable ? loopActions(L) + helpBlock(L.id) + handBlock(L, !!S.db) : '') + swap +
      (metaBits.length ? '<p class="meta">' + metaBits.join(' · ') + '</p>' : '') + '</section>';
  }

  function renderToday() {
    const d = day(); const top = $('todayTop');
    const note = stateNotice();
    if (!d) {
      paint(top, note || (S.got ? '<p class="notice">No edition has been written yet. The first one arrives in the morning, before 9.</p>' : '<p class="skeleton">Reaching your notes…</p>'));
      paint($('todayFeeds'), ''); paint($('todayComing'), ''); paint($('todayWins'), ''); paint($('todayFoot'), ''); renderCaps(); return;
    }
    const isToday = d.date === todayYMD();
    let h = note + hopNotice();
    h += '<div class="edition"><p class="meta"><b>' + esc(d.long || fLong.format(asDate(d.date))) + '</b> · ' + esc(d.edition || 'Edition') + (d.writtenLabel ? ', written ' + esc(d.writtenLabel) : '') + '</p>' +
      (S.days.length > 1 ? '<div class="ed-nav">' +
      '<button type="button" data-act="older"' + (S.dayIdx >= S.days.length - 1 ? ' disabled' : '') + ' aria-label="Earlier edition">‹ Earlier</button>' +
      '<button type="button" data-act="newer"' + (S.dayIdx <= 0 ? ' disabled' : '') + ' aria-label="Later edition">Later ›</button></div>' : '') + '</div>';
    if (!isToday && S.dayIdx === 0) h += '<p class="notice">This is ' + esc(fWeekday.format(asDate(d.date))) + '\'s edition. Today\'s is ready before 9 in the morning.</p>';
    const live0 = S.dayIdx === 0 && !!S.db;
    if (live0 && isToday) h += nowCard(d);
    if (live0) h += habitCard();
    if (live0) { const one = oneChoice(d, true).o; h += backBlock(true, one && one.loopId); }
    h += '<p class="lede">' + esc(d.nameTheDay || '') + '</p>';
    if (d.weather || S.tts) h += '<div class="row">' + (d.weather ? '<p class="weather">' + esc(d.weather) + '</p>' : '') + (S.tts ? '<button class="link" type="button" data-act="speak">' + (S.speaking ? 'Stop reading' : 'Read it to me') + '</button>' : '') + '</div>';
    const live = S.dayIdx === 0 && !!S.db;
    if (live) h += '<div>' + checkStrip(true) + '</div>';
    h += renderOne(d);

    const items = Array.isArray(d.today) ? d.today : [];
    if (items.length) {
      const ticks = d.ticks || {};
      h += '<section class="sec" aria-labelledby="tH"><h2 class="h" id="tH">Today</h2><ul class="tlist">' + items.map(it => {
        const L = it.loopId && S.loops[it.loopId];
        const on = L ? L.status === 'done' : !!ticks[it.id];
        const tickable = it.kind !== 'event' && it.kind !== 'holiday';
        return '<li class="trow' + (on ? ' on' : '') + '">' +
          (tickable ? '<button class="tick" type="button" data-act="tick" data-id="' + esc(it.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + esc((on ? 'Done: ' : 'Mark done: ') + it.title) + '"></button>' : '<span class="tslot"><i></i></span>') +
          '<div class="tmain">' + (it.time ? '<div class="ttime">' + esc(it.time) + '</div>' : '') + '<div class="ttitle">' + esc(it.title) + '</div>' + (it.note ? '<div class="tnote">' + esc(it.note) + '</div>' : '') + '</div>' + dot(it.area) + '</li>';
      }).join('') + '</ul></section>';
    }

    const oa = live ? openAsks() : [];
    const q = d.question;
    if (q && q.text && (q.answered || !oa.length)) {
      h += '<section class="ask" aria-label="A question for you"><p class="q">' + esc(q.text) + '</p>';
      if (q.answered) h += '<p class="meta">You said: ' + esc(q.answered) + '. Noted.</p>';
      else if (isToday || S.dayIdx === 0) h += '<div class="row">' + (Array.isArray(q.options) ? q.options : []).map(o => '<button class="btn small" type="button" data-act="answer" data-id="' + esc(o) + '">' + esc(o) + '</button>').join('') + '</div>';
      h += '</section>';
    }
    if (oa.length) {
      h += '<section class="sec" aria-labelledby="qH"><h2 class="h" id="qH">A question for you</h2>' + askCard(oa[0]) +
        (oa.length > 1 ? '<div class="row"><button class="link" type="button" data-act="nav" data-id="checkin">' + (oa.length - 1) + ' more in Check in</button></div>' : '') + '</section>';
    }
    paint(top, h);

    /* agents */
    const cutoff = addDays(todayYMD(), -8);
    const feeds = S.feeds.filter(f => f.sentence && (!validYMD(f.date) || f.date >= cutoff)).sort((a, b) => String(b.at || '').localeCompare(String(a.at || '')));
    paint($('todayFeeds'), feeds.length ? '<section class="sec" aria-labelledby="fH"><h2 class="h" id="fH">From your agents</h2><div>' + feeds.map(f =>
      '<div class="feed"><div class="fname">' + esc(f.name || f.agent || 'Agent') + '<span>' + esc(ago(f.at)) + '</span></div><p>' + esc(f.sentence) + '</p>' +
      (Array.isArray(f.detail) && f.detail.length ? '<ul>' + f.detail.slice(0, 6).map(x => '<li>' + esc(x) + '</li>').join('') + '</ul>' : '') +
      (f.where ? '<p class="fwhere">' + esc(f.where) + '</p>' : '') + '</div>').join('') + '</div></section>' : '');

    /* coming up */
    const cu = (Array.isArray(d.comingUp) ? d.comingUp : []).filter(c => validYMD(c.date) && dayDiff(c.date, todayYMD()) >= 0);
    const near = cu.filter(c => dayDiff(c.date, todayYMD()) <= 7);
    const shown = S.allComing || near.length < 3 ? cu : near;
    paint($('todayComing'), cu.length ? '<section class="sec" aria-labelledby="cH"><h2 class="h" id="cH">Coming up</h2><div>' + shown.map(c => {
      const n = dayDiff(c.date, todayYMD());
      return '<div class="crow' + (n <= 2 ? ' soon' : '') + '"><div class="cdate">' + esc(fShort.format(asDate(c.date))) + '<small>' + esc(inDays(c.date)) + '</small></div><div><div class="ctitle">' + esc(c.title) + '</div>' + (c.note ? '<div class="cnote">' + esc(c.note) + '</div>' : '') + '</div>' + dot(c.area) + '</div>';
    }).join('') + '</div>' + (cu.length > shown.length ? '<div class="row"><button class="link" type="button" data-act="morecoming">Show ' + (cu.length - shown.length) + ' more, through ' + esc(fShort.format(asDate(cu[cu.length - 1].date))) + '</button></div>' : (S.allComing && cu.length > near.length && near.length >= 3 ? '<div class="row"><button class="link" type="button" data-act="morecoming">Show the next week only</button></div>' : '')) + '</section>' : '');

    renderCaps();

    /* wins */
    const weekAgo = Date.now() - 7 * 86400000;
    const landed = loopList().filter(L => L.status === 'done' && Date.parse(L.doneAt || '') > weekAgo).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
    const wins = (Array.isArray(d.wins) ? d.wins : []);
    paint($('todayWins'), (wins.length || landed.length) ? '<section class="sec" aria-labelledby="wH"><h2 class="h" id="wH">Landed lately</h2><ul class="wins">' +
      landed.map(L => '<li>' + esc(L.title) + ' <span class="meta">' + esc(ago(L.doneAt)) + '</span></li>').join('') + wins.map(w => '<li>' + esc(w) + '</li>').join('') + '</ul></section>' : '');

    const src = d.sources || {};
    const st = S.status || {};
    paint($('todayFoot'), '<p class="meta">' + (Array.isArray(src.reached) && src.reached.length ? 'Read for this edition: ' + esc(src.reached.join(', ')) + '. ' : '') +
      (Array.isArray(src.missed) && src.missed.length ? 'Couldn\'t reach: ' + esc(src.missed.join(', ')) + '. ' : '') + esc(st.next || 'Next edition: tomorrow, before 9:00 AM.') +
      (window.LandingApp && window.LandingApp.status().waiting ? ' ' + window.LandingApp.status().waiting + ' of your taps are waiting for a signal.' : '') + '</p>');
  }

  function renderCaps() {
    paint($('capList'), S.inbox.filter(x => x.kind === 'capture').sort((a, b) => String(b.at).localeCompare(String(a.at))).map(x =>
      '<li><span>' + esc(x.text) + '</span><button type="button" data-act="uncap" data-id="' + esc(x.id) + '">Remove</button></li>').join(''));
  }

  function loopRow(L) {
    const open = !!S.openLoops[L.id];
    const bits = [];
    if (validYMD(L.due) && L.status !== 'done') { const n = dayDiff(L.due, todayYMD()); bits.push('<span class="due' + (n <= 3 ? ' soon' : '') + '">' + esc(dueText(L.due)) + '</span>'); }
    if (L.minutes) bits.push('about ' + esc(L.minutes) + ' min');
    bits.push(esc(areaOf(L.area).name));
    if (L.source) bits.push(esc(L.source));
    const st = loopSteps(L);
    if (st.length && L.status !== 'done') bits.push(st.filter(x => L.stepTicks && L.stepTicks[x.id]).length + ' of ' + st.length + ' steps');
    const hs = hand(L) ? String(hand(L).status || '') : '';
    if (hs === 'asked') bits.push('with Claude'); else if (handBack(L)) bits.push('<b>back from Claude</b>'); else if (L.offer && L.status === 'open') bits.push('Claude can take this');
    return '<div class="loop' + (L.status === 'done' ? ' done' : '') + '"><div class="loop-top">' + dot(L.area) +
      '<button class="loop-title" type="button" data-act="toggle" data-id="' + esc(L.id) + '" aria-expanded="' + open + '">' + esc(L.title) + '</button></div>' +
      '<div class="loop-body"><p class="loop-meta">' + bits.join(' · ') + '</p>' +
      (open || L.status === 'unsure' ? (L.why ? '<p class="why">' + esc(L.why) + '</p>' : '') + (L.firstStep && L.status !== 'done' ? '<p class="fs"><b>First step</b>' + esc(L.firstStep) + '</p>' : '') : '') +
      (open && L.status !== 'done' ? stepsBlock(L, true) : '') +
      (open || L.status === 'unsure' || L.status === 'done' ? loopActions(L) + helpBlock(L.id) : '') +
      (open || hs === 'asked' || handBack(L) ? handBlock(L, !!S.db) : '') +
      (open && L.status === 'open' ? blockerRow(L) : '') + '</div></div>';
  }

  function renderLife() {
    const d = latest(); const st = (d && d.areas) || {};
    const el = $('view-life');
    if (!S.areas.length) { paint(el, stateNotice() || '<p class="skeleton">Reaching your notes…</p>'); return; }
    paint(el, stateNotice() + '<p class="meta">Every part of life gets a buoy. The light under it is this morning\'s read.</p>' + S.areas.map(a => {
      const s = st[a.id] || {}; const k = stKey(s.status);
      const mine = loopList().filter(L => L.area === a.id && (L.status === 'open' || L.status === 'unsure' || L.status === 'waiting')).sort(byDue);
      const open = !!S.openAreas[a.id];
      const links = (Array.isArray(a.links) ? a.links : []).filter(l => safeUrl(l.url));
      return '<article class="area" id="area-' + esc(a.id) + '"><div class="area-top">' + buoy(a.buoy && a.buoy[0], a.buoy && a.buoy[1], 22) + '<h3>' + esc(a.name) + '</h3><span class="pill ' + k + '">' + STATUS[k] + '</span></div>' +
        (s.line ? '<p class="line">' + esc(s.line) + '</p>' : (a.about ? '<p class="line">' + esc(a.about) + '</p>' : '')) +
        (s.next ? '<p class="next"><b>Next</b>' + esc(s.next) + '</p>' : '') +
        (links.length ? '<div class="links">' + links.map(l => '<a href="' + esc(safeUrl(l.url)) + '" target="_blank" rel="noopener">' + esc(l.label) + ' ↗</a>').join('') + '</div>' : '') +
        (mine.length ? '<div class="row"><button class="link" type="button" data-act="openarea" data-id="' + esc(a.id) + '" aria-expanded="' + open + '">' + (open ? 'Hide' : 'Show') + ' ' + mine.length + ' open loop' + (mine.length === 1 ? '' : 's') + '</button></div>' : '') +
        (open && mine.length ? '<div class="area-loops group">' + mine.map(loopRow).join('') + '</div>' : '') + '</article>';
    }).join(''));
  }

  function renderLoops() {
    const el = $('view-loops');
    if (!S.gotLoops) { paint(el, stateNotice() || '<p class="skeleton">Reaching your notes…</p>'); return; }
    const all = loopList();
    const unsure = all.filter(L => L.status === 'unsure').sort(byDue);
    const open = all.filter(L => L.status === 'open').sort(byDue);
    const waiting = all.filter(L => L.status === 'waiting').sort(byDue);
    const cut = Date.now() - 14 * 86400000;
    const done = all.filter(L => L.status === 'done' && Date.parse(L.doneAt || '') > cut).sort((a, b) => String(b.doneAt).localeCompare(String(a.doneAt)));
    const soon = open.filter(L => validYMD(L.due) && dayDiff(L.due, todayYMD()) <= 7);
    const later = open.filter(L => validYMD(L.due) && dayDiff(L.due, todayYMD()) > 7);
    const undated = open.filter(L => !validYMD(L.due)).sort((a, b) => (b.weight || 0) - (a.weight || 0));
    const sec = (title, list, hint) => list.length ? '<section class="sec"><h2 class="h">' + title + ' · ' + list.length + '</h2>' + (hint ? '<p class="meta">' + hint + '</p>' : '') + '<div class="group">' + list.map(loopRow).join('') + '</div></section>' : '';
    paint(el, stateNotice() +
      '<p class="meta">Everything you\'re carrying, in one list. Tap a title for the why and the first step.</p>' +
      sec('Needs a yes or no', unsure, 'These came from older notes and recordings, so they may already be done. One tap each clears the fog.') +
      sec('This week', soon) + sec('Later, with a date', later) + sec('No date', undated) + sec('Waiting on someone else', waiting) +
      '<section class="sec"><h2 class="h">Add something you\'re carrying</h2><div class="add"><label for="newTitle" hidden>What is it</label><input id="newTitle" type="text" placeholder="What is it?" maxlength="140">' +
      '<label for="newArea" hidden>Part of life</label><select id="newArea">' + S.areas.map(a => '<option value="' + esc(a.id) + '">' + esc(a.name) + '</option>').join('') + '</select>' +
      '<button class="btn primary" type="button" data-act="addloop">Add</button></div></section>' +
      sec('Landed in the last two weeks', done));
  }

  const safeAppUrl = u => (/^https:\/\/[a-z0-9.-]+\.github\.io\/[A-Za-z0-9._\/-]*$/.test(String(u || '')) ? String(u) : '');
  /* When copying isn't allowed where the page is running, show the link so it can be copied by hand. */
  function linkField(link) { return S.showLink ? '<div class="linkbox"><input type="text" class="link-out" readonly value="' + esc(link) + '" aria-label="The link"></div><p class="meta">Press and hold the link, choose Select all, then Copy.</p>' : ''; }
  function copyLink(link) {
    const shown = () => { S.showLink = true; schedule(); toast('Couldn\'t copy from here. The link is shown below instead.'); };
    if (!link) return;
    if (!navigator.clipboard || !navigator.clipboard.writeText) { shown(); return; }
    navigator.clipboard.writeText(link).then(() => toast('Copied. Paste it into the box in the other browser.')).catch(shown);
  }
  /* On an Android phone, in a browser other than Chrome: one tap hands the link to Chrome. */
  function chromeHop(A, cls) {
    const w = A.where ? A.where() : {}; const link = A.chromeLink ? A.chromeLink() : '';
    return (w.android && w.browser && w.browser !== 'Chrome' && link) ? '<a class="' + cls + '" href="' + esc(link) + '">Open in Chrome</a>' : '';
  }
  function hopNotice() {
    const A = window.LandingApp; if (!A || !A.where || !A.status().linked) return '';
    const w = A.where(); if (!w.android || !w.browser || w.browser === 'Chrome' || w.installed) return '';
    let stay = false; try { stay = localStorage.getItem('tl.stay') === '1'; } catch (e) { /* no storage */ }
    if (stay) return '';
    return '<div class="notice"><p><b>This opened in ' + esc(w.browser) + '.</b> Rather have the app in Chrome?</p>' +
      '<div class="row">' + chromeHop(A, 'btn small primary') + '<button class="btn small quiet" type="button" data-act="appstay">Stay in ' + esc(w.browser) + '</button></div>' +
      '<p class="meta">If that button does nothing, go to Horizon here and tap Copy the link, then paste it into the app in Chrome.</p></div>';
  }

  function appBlock() {
    const A = window.LandingApp;
    if (A) {
      const st = A.status();
      const when = Date.parse(st.baseAt || '') ? fDayTime.format(new Date(st.baseAt)) : '';
      return '<section class="sec" aria-labelledby="apH"><h2 class="h" id="apH">This device</h2><div class="card">' +
        '<p>' + (st.linked ? 'Linked. ' + (when ? 'The newest edition here arrived ' + esc(when) + '.' : 'No edition has arrived yet. The next one comes before 9 in the morning.') : 'Not linked yet.') +
        (st.waiting ? ' ' + st.waiting + ' tap' + (st.waiting === 1 ? ' is' : 's are') + ' waiting to go out. They\'re saved here and will send by themselves.' : st.linked ? ' Everything you\'ve tapped has been sent.' : '') + '</p>' +
        (st.err ? '<p class="notice bad">' + esc(st.err) + '</p>' : '') +
        '<p class="meta">Your taps are saved on this device first, then sent sealed. The page in Claude catches up each morning.</p>' +
        '<div class="row"><button class="btn small" type="button" data-act="appsync">Check for updates</button>' +
        (st.linked ? '<button class="btn small quiet" type="button" data-act="appunlink">' + (S.unlinkArm ? 'Tap again to unlink' : 'Unlink this device') + '</button>' : '') + '</div>' +
        (st.linked && A.joinLink ? '<p class="meta">Want this in a different browser on this phone?</p><div class="row">' + chromeHop(A, 'btn small') +
          '<button class="btn small" type="button" data-act="appcopy">Copy the link</button></div>' + linkField(A.joinLink()) : '') +
        '</div></section>';
    }
    const app = S.appInfo || {}; const url = safeAppUrl(app.url);
    if (!url || !/^[A-Za-z0-9_-]{43}$/.test(String(app.key || ''))) return '';
    return '<section class="sec" aria-labelledby="apH"><h2 class="h" id="apH">The phone app</h2><div class="card">' +
      '<p>The same page as its own app: its own icon, no address bar, and it opens with no signal.</p>' +
      '<ol class="howto"><li>On your phone, tap the button below.</li><li>In the browser\'s menu, choose Add to Home screen (or Install app).</li><li>Open it from the new icon.</li></ol>' +
      '<div class="row"><a class="btn primary" href="' + esc(url + '#join=' + app.key) + '" target="_blank" rel="noopener">Open the phone app</a>' +
      '<button class="btn small" type="button" data-act="copylink">Copy the link</button></div>' + linkField(url + '#join=' + app.key) +
      '<p class="meta">The button opens in your phone\'s default browser. If that isn\'t the one you want the app in, tap Copy the link, open the app in the browser you do want, and paste it into the box there.</p>' +
      '<p class="meta">The app and this page trade notes once a day, with the morning edition: what you tap in one shows in the other the next morning.</p>' +
      '<p class="meta">That button carries this page\'s key. Only use it on your own devices, and don\'t forward the link it opens.</p></div></section>';
  }

  function renderHorizon() {
    const el = $('view-horizon');
    if (!S.stars.length) { paint(el, (stateNotice() || '<p class="skeleton">Reaching your notes…</p>') + (window.LandingApp ? appBlock() : '')); return; }
    paint(el, stateNotice() + '<p class="meta">Where all of this is headed. The daily list serves these, not the other way around.</p><div>' + S.stars.map(s => {
      const a = areaOf(s.area); const m = s.measure;
      const pct = m && Number(m.of) > 0 ? Math.max(0, Math.min(100, (Number(m.value) / Number(m.of)) * 100)) : null;
      return '<article class="star"><div class="star-top">' + buoy(a.buoy && a.buoy[0], a.buoy && a.buoy[1], 20) + '<h3>' + esc(s.title) + '</h3></div>' +
        (s.why ? '<p class="why">' + esc(s.why) + '</p>' : '') +
        '<dl>' + (s.now ? '<dt>Now</dt><dd>' + esc(s.now) + '</dd>' : '') + (s.next ? '<dt>Next</dt><dd>' + esc(s.next) + '</dd>' : '') + '</dl>' +
        (pct != null ? '<div class="bar" role="img" aria-label="' + esc(m.label + ': ' + m.value + ' of ' + m.of + ' ' + (m.unit || '')) + '"><i style="width:' + pct.toFixed(1) + '%"></i></div><p class="bar-lab">' + esc(m.label) + ': ' + esc(m.value) + ' of ' + esc(m.of) + ' ' + esc(m.unit || '') + '</p>' : '') + '</article>';
    }).join('') + '</div>' +
      appBlock() +
      '<section class="sec how"><h2 class="h">How this page works</h2><div>' +
      '<p>Each morning a new edition is written from your notes, your calendar, your recordings, your money and piano pages, and your agents\' headlines. It starts a little after 8 and is ready before 9. It picks one thing you\'ve been putting off and makes the first step small. A second, shorter pass runs after lunch, about 1:15. In between, the top of Today follows the clock.</p>' +
      '<p>Every tap here is saved right away and read at the next pass: I did it, Not today, Let it go, the steps and lists you tick, and anything you type or say under Tell The Landing. Nothing here sends email or contacts anyone.</p>' +
      '<p>Hand it to Claude does what it says. The next pass does the part Claude can do alone (research, a draft, a comparison, a call sheet) and brings it back here for you to read. Drafts only: nothing gets sent, bought or signed.</p>' +
      '<p>One habit at a time lives under Check in, with its one question near the top of Today. You choose it and tie it to something already in your day; the page asks once a day whether it happened; a day with no answer is only a blank. When it runs by itself you call it built, it joins your daily rhythm, and the next one starts.</p>' +
      '<p>Check in is where the page learns you: a few one-tap questions at a time, each saying why it asks. Your answers change what the next editions pick, when they suggest it and how they word it. What the page has taken from you is listed there too, and you can correct any line.</p>' +
      '<p>Only you can open this page.</p></div></section>');
  }

  /* ---------- Check in: where the page learns him, one tap at a time ---------- */
  function weekBlock() {
    const items = weekItems(); if (!items.length) return '';
    const tk = (S.week && S.week.ticks) || {}; const n = items.filter(x => tk[x.id]).length;
    return '<section class="sec" aria-labelledby="ciW"><h2 class="h" id="ciW">This week · ' + n + ' of ' + items.length + '</h2><ul class="tlist">' + items.map(x => {
      const on = !!tk[x.id];
      return '<li class="trow' + (on ? ' on' : '') + '"><button class="tick" type="button" data-act="wtick" data-id="' + esc(x.id) + '" aria-pressed="' + (on ? 'true' : 'false') + '" aria-label="' + esc((on ? 'Done: ' : 'Mark done: ') + x.label) + '"></button>' +
        '<div class="tmain">' + (x.when ? '<div class="ttime">' + esc(x.when) + '</div>' : '') + '<div class="ttitle">' + esc(x.label) + '</div>' + (x.note ? '<div class="tnote">' + esc(x.note) + '</div>' : '') + '</div>' + dot(x.area) + '</li>';
    }).join('') + '</ul></section>';
  }

  function readingText(r) {
    const b = [];
    if (r.sys && r.dia) b.push(r.sys + '/' + r.dia);
    if (r.pulse) b.push('pulse ' + r.pulse);
    if (r.weight) b.push(r.weight + ' lb');
    return b.join(' · ');
  }
  const readingWhen = r => (Date.parse(r.at || '') ? fDayTime.format(new Date(r.at)) : String(r.day || ''));
  function readingsBlock() {
    const rs = S.readings.slice(0, S.readAll ? 60 : 5);
    return '<section class="sec" aria-labelledby="ciR"><h2 class="h" id="ciR">Readings</h2>' + (S.config.readingsNote ? '<p class="meta">' + esc(S.config.readingsNote) + '</p>' : '') +
      '<div class="rform"><label>Top number<input class="field" id="rSys" type="text" inputmode="numeric" maxlength="3" autocomplete="off"></label>' +
      '<label>Bottom number<input class="field" id="rDia" type="text" inputmode="numeric" maxlength="3" autocomplete="off"></label>' +
      '<label>Pulse (optional)<input class="field" id="rPulse" type="text" inputmode="numeric" maxlength="3" autocomplete="off"></label>' +
      '<label>Weight, pounds (optional)<input class="field" id="rWt" type="text" inputmode="decimal" maxlength="6" autocomplete="off"></label></div>' +
      '<div class="row"><button class="btn primary" type="button" data-act="addreading">Save reading</button>' + (S.readings.length ? '<button class="link" type="button" data-act="copyreadings">Copy the list</button>' : '') + '</div>' +
      (rs.length ? '<div>' + rs.map(r => '<div class="rrow"><span class="rv">' + esc(readingText(r)) + '</span><span class="meta">' + esc(readingWhen(r)) + ' · <button class="link inline" type="button" data-act="delreading" data-id="' + esc(r.id) + '">remove</button></span></div>').join('') + '</div>' : '') +
      (S.readings.length > 5 ? '<div class="row"><button class="link" type="button" data-act="readall">' + (S.readAll ? 'Show the last five' : 'Show all ' + S.readings.length) + '</button></div>' : '') + '</section>';
  }

  /* Up to three candidates for tomorrow's one thing: what's due within a week first, then the heaviest. */
  function pickCandidates() {
    const t = todayYMD(); const tom = addDays(t, 1);
    return openLoops().filter(L => L.kind !== 'habit' && !(validYMD(L.snoozeUntil) && dayDiff(L.snoozeUntil, tom) > 0)).sort((a, b) => {
      const sa = validYMD(a.due) && dayDiff(a.due, t) <= 7 ? 0 : 1, sb = validYMD(b.due) && dayDiff(b.due, t) <= 7 ? 0 : 1;
      if (sa !== sb) return sa - sb;
      if (sa === 0 && a.due !== b.due) return a.due < b.due ? -1 : 1;
      return (b.weight || 0) - (a.weight || 0) || String(a.title).localeCompare(String(b.title));
    }).slice(0, 3);
  }
  function closeBlock() {
    const c = checkin(); const tom = addDays(todayYMD(), 1);
    const nx = S.next && S.next.forDate === tom && S.next.loopId && S.loops[S.next.loopId] ? S.next : null;
    const cands = pickCandidates();
    if (nx && !cands.some(L => L.id === nx.loopId)) cands.unshift(S.loops[nx.loopId]);
    const R = [['hard', 'Hard'], ['mixed', 'Mixed'], ['good', 'Good']];
    return '<section class="sec" aria-labelledby="ciC"><h2 class="h" id="ciC">Close the day</h2><div class="card">' +
      '<div class="seg"><span class="lab">How did today go?</span><div class="row">' + R.map(r => '<button class="btn small" type="button" data-act="check" data-id="rating" data-val="' + r[0] + '" aria-pressed="' + (c.rating === r[0] ? 'true' : 'false') + '">' + r[1] + '</button>').join('') + '</div></div>' +
      '<div class="seg"><span class="lab">Tomorrow\'s one thing</span><p class="meta">Pick it tonight and the morning page builds around it. Or leave the choice to The Landing.</p>' +
      cands.map(L => '<button class="btn small wide" type="button" data-act="picknext" data-id="' + esc(L.id) + '" aria-pressed="' + (nx && nx.loopId === L.id ? 'true' : 'false') + '">' + esc(L.title) + '</button>').join('') +
      '<button class="btn small wide quiet" type="button" data-act="picknext" data-id="" aria-pressed="' + (nx ? 'false' : 'true') + '">The Landing picks</button></div></div></section>';
  }

  /* The last seven days of the daily rhythm, from the ticks on each day's edition. */
  function dotsBlock() {
    const rh = cfgList('rhythm').filter(x => x && x.id && x.label); if (!rh.length) return '';
    const t = todayYMD(); const days = []; for (let i = 6; i >= 0; i--) days.push(addDays(t, -i));
    const byDate = {}; S.days.forEach(d => { byDate[d.date] = d; });
    const readDays = {}; S.readings.forEach(r => { if (r.day) readDays[r.day] = true; });
    const said = [];
    let h = '';
    rh.forEach(x => {
      let n = 0;
      h += '<span class="dl">' + esc(x.label) + '</span>' + days.map(d => {
        const ed = byDate[d];
        const on = !!(ed && ed.ticks && ed.ticks[x.id]) || !!(x.reading && readDays[d]);
        const listed = !!(ed && (ed.today || []).some(it => it.id === x.id));
        if (on) n++;
        return '<i class="' + (on ? 'on' : listed ? '' : 'na') + '"></i>';
      }).join('');
      said.push(x.label + ' ' + n + ' of 7');
    });
    return '<section class="sec" aria-labelledby="ciD"><h2 class="h" id="ciD">Your week in dots</h2><p class="meta">A dot fills in when you tick it on that day\'s list. A gap is only a gap. Never miss twice.</p>' +
      '<div class="dots" role="img" aria-label="' + esc('The last seven days: ' + said.join(', ')) + '"><span></span>' + days.map(d => '<span class="dh' + (d === t ? ' now' : '') + '">' + esc(fDow.format(asDate(d)).slice(0, 2)) + '</span>').join('') + h + '</div></section>';
  }

  const ansText = A => (Array.isArray(A.answer) ? A.answer.join(', ') : String(A.answer == null ? '' : A.answer));
  function knowBlock() {
    const ans = askList().filter(A => A.status === 'answered').sort((a, b) => String(b.answeredAt || '').localeCompare(String(a.answeredAt || '')));
    const ln = Object.keys(S.learned).map(k => S.learned[k]).filter(x => x.text).sort((a, b) => (Number(a.order) || 0) - (Number(b.order) || 0) || String(a.id).localeCompare(String(b.id)));
    if (!ans.length && !ln.length) return '';
    const la = S.knowAll ? ans : ans.slice(0, 4); const ll = S.knowAll ? ln : ln.slice(0, 6);
    const more = (ans.length - la.length) + (ln.length - ll.length);
    return '<section class="sec" aria-labelledby="ciK"><h2 class="h" id="ciK">What The Landing knows from you</h2><p class="meta">Your answers, and what the page has taken from what you\'ve said. Fix anything that\'s off.</p><div>' +
      la.map(A => '<div class="know"><p class="kq">' + esc(A.text) + '</p><p class="ka">' + esc(ansText(A)) + '</p><div class="row"><button class="link" type="button" data-act="reask" data-id="' + esc(A.id) + '">Change my answer</button></div></div>').join('') +
      ll.map(x => {
        const id = esc(x.id); let tail;
        if (x.ok === true) tail = '<p class="meta">You confirmed this.</p>';
        else if (x.ok === false) tail = x.correction ? '<p class="meta">Your correction: ' + esc(x.correction) + '</p><p class="meta">It gets fixed in the next edition.</p>' :
          '<div class="row"><input class="field" id="fix-' + id + '" type="text" maxlength="300" placeholder="What\'s truer?" aria-label="What is truer"><button class="btn small" type="button" data-act="fixsave" data-id="' + id + '">Save</button></div>';
        else tail = '<div class="row"><button class="btn small" type="button" data-act="lok" data-id="' + id + '">Right</button><button class="btn small quiet" type="button" data-act="lno" data-id="' + id + '">Not quite</button></div>';
        return '<div class="know"><p class="ka">' + esc(x.text) + '</p>' + (x.from ? '<p class="meta">' + esc(x.from) + '</p>' : '') + tail + '</div>';
      }).join('') + '</div>' +
      (more > 0 || S.knowAll ? '<div class="row"><button class="link" type="button" data-act="knowall">' + (S.knowAll ? 'Show fewer' : 'Show ' + more + ' more') + '</button></div>' : '') + '</section>';
  }

  function feedbackBlock() {
    const c = checkin(); const F = [['helpful', 'Helpful'], ['toomuch', 'Too much'], ['missed', 'Missed something']];
    const ask = c.feedback === 'missed' || c.feedback === 'toomuch';
    return '<section class="sec" aria-labelledby="ciF"><h2 class="h" id="ciF">The page itself</h2><div class="seg"><span class="lab">How was today\'s page?</span><div class="row">' +
      F.map(f => '<button class="btn small" type="button" data-act="check" data-id="feedback" data-val="' + f[0] + '" aria-pressed="' + (c.feedback === f[0] ? 'true' : 'false') + '">' + f[1] + '</button>').join('') + '</div></div>' +
      (ask ? (c.feedbackNote ? '<p class="meta">You said: ' + esc(c.feedbackNote) + '</p>' : '') + '<div class="row"><input class="field" id="fbText" type="text" maxlength="300" placeholder="' + (c.feedback === 'missed' ? 'What did it miss?' : 'What would you cut?') + '" aria-label="Tell me more"><button class="btn small" type="button" data-act="fbsave">Save</button></div>' : '') + '</section>';
  }

  function renderCheckin() {
    const el = $('view-checkin');
    const note = stateNotice();
    if (!S.db || (!S.got && !S.gotAsks)) { paint(el, note || '<p class="skeleton">Reaching your notes…</p>'); return; }
    let h = note + '<p class="meta">Everything here is one tap. What you tap shapes tomorrow\'s page, and the ones after it.</p>';
    h += '<section class="sec" aria-labelledby="ciN"><h2 class="h" id="ciN">Right now</h2>' + checkStrip(false) + '</section>';
    h += habitSection();
    const oa = openAsks(); const shown = S.askAll ? oa : oa.slice(0, 3);
    h += '<section class="sec" aria-labelledby="ciQ"><h2 class="h" id="ciQ">Questions for you' + (oa.length ? ' · ' + oa.length : '') + '</h2>' +
      (oa.length ? shown.map((A, i) => askCard(A, (i + 1) + ' of ' + oa.length)).join('') + (oa.length > 3 ? '<div class="row"><button class="link" type="button" data-act="askall">' + (S.askAll ? 'Show three at a time' : 'Show ' + (oa.length - shown.length) + ' more') + '</button></div>' : '')
        : '<p class="soft">No questions waiting. New ones come with the morning edition, a few at a time.</p>') + '</section>';
    const unsure = loopList().filter(L => L.status === 'unsure').sort(byDue);
    if (unsure.length) {
      h += '<section class="sec" aria-labelledby="ciU"><h2 class="h" id="ciU">A yes or no · ' + unsure.length + '</h2><p class="meta">Older items that may already be done. One tap each clears the fog.</p><div class="group">' + unsure.slice(0, 3).map(loopRow).join('') + '</div>' +
        (unsure.length > 3 ? '<div class="row"><button class="link" type="button" data-act="nav" data-id="loops">The other ' + (unsure.length - 3) + ' are in Loops</button></div>' : '') + '</section>';
    }
    h += weekBlock() + readingsBlock() + closeBlock() + dotsBlock() + knowBlock() + feedbackBlock();
    paint(el, h);
  }

  /* ---------- toast ---------- */
  let toastTimer = 0;
  function toast(msg, undo) {
    const host = $('toastHost'); clearTimeout(toastTimer);
    host.innerHTML = '<div class="toast" role="status"><span>' + esc(msg) + '</span>' + (undo ? '<button type="button" id="toastUndo">Undo</button>' : '') + '</div>';
    if (undo) $('toastUndo').addEventListener('click', () => { host.innerHTML = ''; undo(); });
    toastTimer = setTimeout(() => { host.innerHTML = ''; }, undo ? 7000 : 3500);
  }
  const saveFail = e => toast(e && e.code === 'invalid_argument' ? 'This view can\'t save changes.' : 'Couldn\'t save that. Try again in a moment.');

  /* ---------- writes ---------- */
  /* One write at a time per document: each path gets its own queue, so quick taps never overlap. */
  const WQ = {};
  function wq(path, fn) {
    const p = (WQ[path] || Promise.resolve()).then(fn, fn);
    WQ[path] = p.catch(() => {});
    return p;
  }
  const BAG = { loops: () => S.loops, asks: () => S.asks, learned: () => S.learned };
  /* Change fields on one loop, question or learned line: shown at once, saved behind it. Returns an undo. */
  function patchDoc(col, id, patch) {
    const bag = BAG[col](); const old = bag[id]; if (!old || !S.db) return null;
    const prev = {}; Object.keys(patch).forEach(k => { prev[k] = old[k] === undefined ? '' : old[k]; });
    const put = (p, back) => {
      const stamp = { updatedAt: new Date().toISOString(), by: 'page' };
      const cur = BAG[col]();
      cur[id] = Object.assign({}, cur[id] || old, p, stamp); schedule();
      wq(col + '/' + id, () => S.db.doc(col + '/' + id).update(Object.assign({}, p, stamp))).catch(e => { if (back) { BAG[col]()[id] = back; schedule(); } saveFail(e); });
    };
    put(patch, old);
    return () => { if (BAG[col]()[id]) put(prev, null); };
  }
  function setLoop(id, patch, msg, undoable) {
    const undo = patchDoc('loops', id, patch);
    if (undo && msg) toast(msg, undoable ? undo : null);
    return undo;
  }
  /* Change the hand-off on a loop. Only the fields given are sent; the run's own work (result) is never written from here. */
  function patchHand(id, fields, extra) {
    const L = S.loops[id]; if (!L || !S.db) return false;
    const stamp = { updatedAt: new Date().toISOString(), by: 'page' };
    S.loops[id] = Object.assign({}, L, extra || {}, { handoff: Object.assign({}, hand(L) || {}, fields) }, stamp); schedule();
    wq('loops/' + id, () => S.db.doc('loops/' + id).update(Object.assign({}, extra || {}, { handoff: fields }, stamp))).catch(e => { S.loops[id] = L; schedule(); saveFail(e); });
    return true;
  }
  /* Change a habit: shown at once, saved behind it. The day-by-day maps are sent one entry at a time, so a tap on the
     phone and a tap on the computer never overwrite each other. */
  const HMAPS = ['days', 'miss', 'feel'];
  function saveHabit(id, patch, msg, undoable) {
    const H = S.habits[id]; if (!H || !S.db) return null;
    const stamp = { updatedAt: new Date().toISOString(), by: 'page' };
    const next = Object.assign({}, H, patch, stamp); const prev = {};
    Object.keys(patch).forEach(k => {
      if (HMAPS.indexOf(k) < 0) { prev[k] = H[k] === undefined ? '' : H[k]; return; }
      next[k] = Object.assign({}, H[k] || {}, patch[k]); prev[k] = {};
      Object.keys(patch[k]).forEach(d => { prev[k][d] = (H[k] && H[k][d]) || ''; });
    });
    S.habits[id] = next; schedule();
    wq('habits/' + id, () => S.db.doc('habits/' + id).update(Object.assign({}, patch, stamp))).catch(e => { S.habits[id] = H; schedule(); saveFail(e); });
    const undo = () => { if (S.habits[id]) saveHabit(id, prev); };
    if (msg) toast(msg, undoable ? undo : null);
    return undo;
  }
  /* One day's answer: 'yes', 'no', or '' for a blank. A day that is no longer "not done" loses its reason. */
  function habitDay(H, d, v) {
    const patch = { days: { [d]: v } }; if (v !== 'no' && H.miss && H.miss[d]) patch.miss = { [d]: '' };
    return saveHabit(H.id, patch);
  }
  /* A habit that is also one of the daily rhythm items keeps the two in step: "done" here ticks it on today's list. */
  function habitToRhythm(H, on) {
    const d = latest(); if (!on || !H.rhythmId || !d || d.date !== todayYMD()) return;
    const it = (d.today || []).find(x => x.id === H.rhythmId && !x.loopId);
    if (it && !(d.ticks && d.ticks[it.id])) tickDay(d, it.id, new Date().toISOString());
  }
  function openHabitEditor(id, focus) {
    const H = id ? S.habits[id] : null;
    ['hTitle', 'hAnchor', 'hTiny', 'hAfter'].forEach(k => { const el = $(k); if (el) el.value = ''; });
    S.hEdit = { id: H ? H.id : '', title: H ? String(H.title || '') : '', anchor: H ? cleanAnchor(H.anchor) : '', tiny: H ? cleanTiny(H.tiny) : '', after: H ? trimEnd(H.after) : '', when: H ? String(H.when || '') : '' };
    S.hArm = null;
    if (S.view !== 'checkin') go('checkin'); else render();
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const sec = $('habitSec'); if (sec) sec.scrollIntoView({ block: 'start' });
      const f = focus && $(focus); if (f) { try { f.focus({ preventScroll: true }); } catch (e) { /* focus is a nicety */ } }
    }));
  }
  const fieldText = btn => { const box = btn && btn.closest('.linkbox'); const inp = box && box.querySelector('input'); return inp ? String(inp.value || '').trim().slice(0, 600) : ''; };
  function addInbox(doc) {
    if (!S.db) return Promise.reject({ code: 'unavailable' });
    return S.db.collection('inbox').add(Object.assign({ at: new Date().toISOString(), day: todayYMD(), handled: false }, doc));
  }
  /* Today's one-tap answers about the day itself live in checkins/<date>, made on the first tap. */
  function setCheckin(patch) {
    if (!S.db) return;
    const date = todayYMD(); const cur = S.checkins[date] || null; const now = new Date().toISOString();
    const next = Object.assign({ date: date }, cur || {}, patch, { updatedAt: now }); delete next.id;
    S.checkins[date] = next; schedule();
    wq('checkins/' + date, () => (cur ? S.db.doc('checkins/' + date).update(Object.assign({}, patch, { updatedAt: now })) : S.db.doc('checkins/' + date).set(next)))
      .catch(e => { if (cur) S.checkins[date] = cur; else delete S.checkins[date]; schedule(); saveFail(e); });
  }
  function tickDay(d, itemId, val) {
    const nd = Object.assign({}, d, { ticks: Object.assign({}, d.ticks || {}, { [itemId]: val }) });
    S.days = S.days.map(x => (x.date === d.date ? nd : x)); schedule();
    wq('days/' + d.date, () => S.db.doc('days/' + d.date).update({ ticks: { [itemId]: val } })).catch(e => { S.days = S.days.map(x => (x.date === d.date ? d : x)); schedule(); saveFail(e); });
  }
  /* Saving a reading also ticks today's "take a reading" item, when the list has one. */
  function tickReadingItem() {
    const d = latest(); if (!d || d.date !== todayYMD()) return;
    const ids = cfgList('rhythm').filter(x => x && x.reading).map(x => x.id);
    const it = (d.today || []).find(x => ids.indexOf(x.id) >= 0 && !x.loopId && !(d.ticks && d.ticks[x.id]));
    if (it) tickDay(d, it.id, new Date().toISOString());
  }
  function answerAsk(A, value) {
    const undoAsk = patchDoc('asks', A.id, { status: 'answered', answer: value, answeredAt: new Date().toISOString() });
    if (!undoAsk) return;
    let undoLoop = null;
    const fx = typeof value === 'string' && Array.isArray(A.effects) ? A.effects.find(x => x && x.when === value) : null;
    if (fx && A.loopId && S.loops[A.loopId]) {
      if (fx.loop === 'done') undoLoop = patchDoc('loops', A.loopId, { status: 'done', doneAt: new Date().toISOString(), doneVia: 'answer' });
      else if (fx.loop === 'open' || fx.loop === 'waiting' || fx.loop === 'dropped') undoLoop = patchDoc('loops', A.loopId, { status: fx.loop });
    }
    toast('Noted. Thank you.', () => { undoAsk(); if (undoLoop) undoLoop(); });
  }

  const ACT = {
    nav(id) { go(id); },
    area(id) { S.openAreas[id] = true; go('life'); requestAnimationFrame(() => requestAnimationFrame(() => { const el = $('area-' + id); if (el) el.scrollIntoView({ block: 'start' }); })); },
    openarea(id) { S.openAreas[id] = !S.openAreas[id]; schedule(); },
    morecoming() { S.allComing = !S.allComing; schedule(); },
    toggle(id) { S.openLoops[id] = !S.openLoops[id]; schedule(); },
    older() { if (S.dayIdx < S.days.length - 1) { S.dayIdx++; schedule(); } },
    newer() { if (S.dayIdx > 0) { S.dayIdx--; schedule(); } },
    script() { S.scriptOpen = !S.scriptOpen; schedule(); },
    applink(id, btn) {
      const box = btn && btn.closest('.linkbox'); const inp = box && box.querySelector('input'); const v = inp ? inp.value : '';
      if (window.LandingApp && window.LandingApp.link && window.LandingApp.link(v)) { toast('Linked. Opening your page…'); return; }
      S.linkMiss = true; schedule();
    },
    appcopy() { if (window.LandingApp && window.LandingApp.joinLink) copyLink(window.LandingApp.joinLink()); },
    appstay() { try { localStorage.setItem('tl.stay', '1'); } catch (e) { /* it will ask again next time */ } schedule(); },
    copylink() { const app = S.appInfo || {}; const url = safeAppUrl(app.url); if (url && /^[A-Za-z0-9_-]{43}$/.test(String(app.key || ''))) copyLink(url + '#join=' + app.key); },
    appsync() { if (window.LandingApp) { toast('Checking…'); window.LandingApp.sync().then(() => { toast('Up to date.'); schedule(); }); } },
    appunlink() {
      if (!window.LandingApp) return;
      if (!S.unlinkArm) { S.unlinkArm = true; schedule(); setTimeout(() => { if (S.unlinkArm) { S.unlinkArm = false; schedule(); } }, 5000); return; }
      window.LandingApp.unlink();
    },
    swap() {
      const d = latest(); if (!d || !d.oneThing || S.dayIdx !== 0) return;
      const ch = oneChoice(d, true); if (!ch.alts.length) return;
      const next = (ch.at + 1) % (ch.alts.length + 1);
      S.scriptOpen = false;
      setCheckin({ swappedTo: next ? altKey(ch.alts[next - 1]) : '', swappedAt: new Date().toISOString() });
    },
    handoff(id) { if (patchHand(id, { status: 'asked', askedAt: new Date().toISOString(), changes: '' })) toast('Handed to Claude. It comes back with the next edition.'); },
    handback(id) { if (patchHand(id, { status: 'cancelled', cancelledAt: new Date().toISOString() })) { delete S.handNote[id]; toast('Taken back. It\'s yours again.'); } },
    handnoteopen(id) { S.handNote[id] = true; schedule(); },
    handnote(id, btn) { if (patchHand(id, { note: fieldText(btn) })) { delete S.handNote[id]; toast('Note saved.'); } },
    handshow(id) { S.handOpen[id] = !S.handOpen[id]; schedule(); },
    handcopy(id) {
      const h = hand(S.loops[id]); const t = h && h.result ? String(h.result.body || h.result.summary || '') : ''; if (!t) return;
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(t).then(() => toast('Copied.')).catch(() => toast('Couldn\'t copy from here. Press and hold the text instead.'));
      else toast('Couldn\'t copy from here. Press and hold the text instead.');
    },
    handseen(id) {
      const L = S.loops[id]; const h = hand(L); if (!h) return; const now = new Date().toISOString();
      const fin = !!(h.result && h.result.finishes) && L.status !== 'done';
      if (patchHand(id, { status: 'seen', seenAt: now }, fin ? { status: 'done', doneAt: now, doneVia: 'handoff' } : null)) toast(fin ? landedMsg() : 'Good. It stays with the loop if you want it again.');
    },
    handfixopen(id) { S.handFix[id] = true; schedule(); },
    handfix(id, btn) {
      const v = fieldText(btn); if (!v) { toast('Say what should change first.'); return; }
      if (patchHand(id, { status: 'asked', askedAt: new Date().toISOString(), changes: v })) { delete S.handFix[id]; toast('Sent back to Claude.'); }
    },
    hgo() {
      /* With nothing to pick from, go straight to writing one. */
      if (S.db && !S.hEdit && !habitList().some(x => x.status === 'idea' || x.status === 'paused' || x.status === 'building')) { openHabitEditor('', 'hTitle'); return; }
      go('checkin'); requestAnimationFrame(() => requestAnimationFrame(() => { const el = $('habitSec'); if (el) el.scrollIntoView({ block: 'start' }); }));
    },
    hquiet() { try { localStorage.setItem('tl.hquiet', todayYMD()); } catch (e) { /* it shows again next time */ } render(); },
    hwhy() { S.hWhy = !S.hWhy; schedule(); },
    hday(id, b) {
      const H = S.habits[id]; if (!H || !b || !S.db) return;
      const v = b.dataset.val === 'yes' || b.dataset.val === 'no' ? b.dataset.val : ''; const t = todayYMD(); const d = validYMD(b.dataset.day) ? b.dataset.day : t;
      if (d > t) return;
      habitDay(H, d, v);
      if (d === t) habitToRhythm(H, v === 'yes');
      if (v === 'yes') toast(d === t ? 'Done for today.' : 'Noted.');
    },
    hdot(id, b) {
      const H = S.habits[id]; const d = b && b.dataset.day; if (!H || !S.db || !validYMD(d) || d > todayYMD()) return;
      const cur = hSay(H, d); const v = cur === '' ? 'yes' : cur === 'yes' ? 'no' : '';
      habitDay(H, d, v);
      if (d === todayYMD()) habitToRhythm(H, v === 'yes');
    },
    hmiss(id, b) { const v = (b && b.dataset.val) || ''; if (MISSES.some(m => m[0] === v)) saveHabit(id, { miss: { [todayYMD()]: v } }, 'Noted.', true); },
    hfeel(id, b) { const v = (b && b.dataset.val) || ''; if (FEELS.some(f => f[0] === v)) saveHabit(id, { feel: { [todayYMD()]: v } }, 'Noted.', true); },
    hfine(id) { saveHabit(id, { adjustOn: todayYMD() }, 'Kept as it is.'); },
    hsmaller(id) { openHabitEditor(id, 'hTiny'); },
    hmove(id) { openHabitEditor(id, 'hAnchor'); },
    hedit(id) { openHabitEditor(id, id ? '' : 'hTitle'); },
    hcancel() { S.hEdit = null; schedule(); },
    hwhen(v) { if (S.hEdit) { S.hEdit.when = S.hEdit.when === v ? '' : v; schedule(); } },
    hanchor(text, b) {
      if (!S.hEdit || !text) return;
      S.hEdit.anchor = text; const w = (b && b.dataset.val) || ''; if (w) S.hEdit.when = w;
      const i = $('hAnchor'); if (i) i.value = text;
      schedule();
    },
    hsave() {
      const E = S.hEdit; if (!E || !S.db) return;
      [['title', 'hTitle'], ['anchor', 'hAnchor'], ['tiny', 'hTiny'], ['after', 'hAfter']].forEach(p => { const el = $(p[1]); if (el) E[p[0]] = el.value; });
      const tiny = cleanTiny(E.tiny).slice(0, 200), anchor = cleanAnchor(E.anchor).slice(0, 160), after = trimEnd(E.after).slice(0, 120);
      const title = (trimEnd(E.title) || tiny).slice(0, 120);
      if (!title) { toast('Say what the habit is first.'); const f = $('hTiny'); if (f) f.focus(); return; }
      if (!anchor) { toast('Tie it to something that already happens: “After…”'); const f = $('hAnchor'); if (f) f.focus(); return; }
      const t = todayYMD(); const H = E.id ? S.habits[E.id] : null;
      const words = { title: title, anchor: anchor, tiny: tiny || title, after: after, when: E.when || '' };
      if (H && H.status === 'building') saveHabit(H.id, Object.assign(words, { adjustOn: t }), 'Saved.');
      else {
        habitList().filter(x => x.status === 'building').forEach(x => saveHabit(x.id, { status: 'paused', pausedOn: t }));
        if (H) saveHabit(H.id, Object.assign(words, { status: 'building', startedOn: t }), 'Started. The page asks once a day.');
        else {
          const id = (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'habit') + '-' + Math.random().toString(36).slice(2, 6);
          const doc = Object.assign({ area: '', why: '', status: 'building', startedOn: t, days: {}, updatedAt: new Date().toISOString(), by: 'page' }, words);
          S.habits[id] = Object.assign({ id: id }, doc);
          wq('habits/' + id, () => S.db.doc('habits/' + id).set(doc)).then(() => toast('Started. The page asks once a day.')).catch(e => { delete S.habits[id]; schedule(); saveFail(e); });
        }
      }
      S.hEdit = null; schedule();
    },
    hstart(id) {
      const H = S.habits[id]; if (!H || !S.db) return; const B = building(); const t = todayYMD();
      if (B && B.id !== id && S.hArm !== 'start:' + id) { S.hArm = 'start:' + id; schedule(); setTimeout(() => { if (S.hArm === 'start:' + id) { S.hArm = null; schedule(); } }, 6000); return; }
      S.hArm = null;
      if (B && B.id !== id) saveHabit(B.id, { status: 'paused', pausedOn: t });
      saveHabit(id, { status: 'building', startedOn: t }, 'Started. The page asks once a day.');
    },
    hpause(id) { saveHabit(id, { status: 'paused', pausedOn: todayYMD() }, 'Paused. Its record is kept.', true); },
    hdrop(id) {
      if (S.hArm !== 'drop:' + id) { S.hArm = 'drop:' + id; schedule(); setTimeout(() => { if (S.hArm === 'drop:' + id) { S.hArm = null; schedule(); } }, 5000); return; }
      S.hArm = null; saveHabit(id, { status: 'dropped', droppedOn: todayYMD() }, 'Let go.', true);
    },
    hkeep(id) { if (saveHabit(id, { status: 'kept', keptOn: todayYMD() }, 'Built. It stays in your days from here on.', true)) ACT.hgo(); },
    hwait(id) { saveHabit(id, { keepAskedOn: todayYMD() }, 'Fine. It keeps building.'); },
    hsugyes(id) {
      const H = S.habits[id]; const g = hSug(H); if (!g) return;
      const p = { suggestAnswered: g.on, adjustOn: todayYMD() }; if (g.anchor) p.anchor = cleanAnchor(g.anchor); if (g.tiny) p.tiny = cleanTiny(g.tiny);
      saveHabit(id, p, 'Changed.', true);
    },
    hsugno(id) { const g = hSug(S.habits[id]); if (g) saveHabit(id, { suggestAnswered: g.on }, 'Kept as it was.'); },
    done(id) { S.dropArm = null; setLoop(id, { status: 'done', doneAt: new Date().toISOString(), doneVia: 'page' }, landedMsg(), true); },
    still(id) { setLoop(id, { status: 'open' }, 'Kept on the list.', true); },
    pass(id) { const L = S.loops[id]; if (!L) return; setLoop(id, { snoozeUntil: addDays(todayYMD(), 1), passes: (Number(L.passes) || 0) + 1, passedOn: todayYMD() }, 'Set down for today.', true); },
    unpass(id) { const L = S.loops[id]; if (!L) return; setLoop(id, { snoozeUntil: '', passes: Math.max(0, (Number(L.passes) || 1) - 1), passedOn: '' }); },
    drop(id) {
      if (S.dropArm !== id) { S.dropArm = id; schedule(); setTimeout(() => { if (S.dropArm === id) { S.dropArm = null; schedule(); } }, 5000); return; }
      S.dropArm = null; setLoop(id, { status: 'dropped', droppedAt: new Date().toISOString() }, 'Let go.', true);
    },
    reopen(id) { setLoop(id, { status: 'open', doneAt: '', snoozeUntil: '' }, 'Back on the list.'); },
    block(id, b) {
      const v = (b && b.dataset.val) || ''; if (!BLOCKS.some(x => x[0] === v)) return;
      const t = todayYMD();
      if (v === 'unneeded') setLoop(id, { status: 'dropped', droppedAt: new Date().toISOString(), blocker: v, blockerOn: t }, 'Let go.', true);
      else if (v === 'waiting') setLoop(id, { status: 'waiting', blocker: v, blockerOn: t }, 'Moved to Waiting on someone else.', true);
      else setLoop(id, { blocker: v, blockerOn: t }, 'Noted.', true);
    },
    step(id, b) {
      const L = S.loops[id]; const sid = (b && b.dataset.val) || ''; if (!L || !sid) return;
      const was = !!(L.stepTicks && L.stepTicks[sid]);
      patchDoc('loops', id, { stepTicks: Object.assign({}, L.stepTicks || {}, { [sid]: was ? false : new Date().toISOString() }) });
    },
    mksteps(id) {
      const h = S.help[id]; const L = S.loops[id]; if (!h || !L) return;
      const st = parseSteps(h.text); if (st.length < 2) { toast('Couldn\'t find steps in that.'); return; }
      const tag = 'p' + Date.now().toString(36);
      setLoop(id, { steps: st.map((t, i) => ({ id: tag + i, text: t })), stepsBy: 'page' }, 'Checklist made. Tick as you go.');
    },
    tick(itemId) {
      const d = day(); if (!d || !S.db) return;
      const it = (d.today || []).find(x => x.id === itemId); if (!it) return;
      if (it.loopId && S.loops[it.loopId]) { const L = S.loops[it.loopId]; if (L.status === 'done') ACT.reopen(L.id); else ACT.done(L.id); return; }
      const was = !!(d.ticks && d.ticks[itemId]);
      tickDay(d, itemId, was ? false : new Date().toISOString());
      const B = building(); if (!was && B && B.rhythmId === itemId && d.date === todayYMD() && hSay(B, d.date) !== 'yes') habitDay(B, d.date, 'yes');
    },
    wtick(itemId) {
      if (!S.db || !S.weekId) return;
      const wid = S.weekId; const items = weekItems(); if (!items.some(x => x.id === itemId)) return;
      const cur = S.week; const val = cur && cur.ticks && cur.ticks[itemId] ? false : new Date().toISOString(); const now = new Date().toISOString();
      const next = Object.assign({ week: wid, items: items }, cur || {}, { ticks: Object.assign({}, (cur && cur.ticks) || {}, { [itemId]: val }), updatedAt: now });
      S.week = next; schedule();
      wq('weeks/' + wid, () => (cur ? S.db.doc('weeks/' + wid).update({ ticks: { [itemId]: val }, updatedAt: now }) : S.db.doc('weeks/' + wid).set(Object.assign({}, next, { madeBy: 'page' }))))
        .catch(e => { S.week = cur; schedule(); saveFail(e); });
    },
    check(key, b) {
      if (!key) return; const val = (b && b.dataset.val) || '';
      const v = checkin()[key] === val ? '' : val;
      setCheckin({ [key]: v, [key + 'At']: new Date().toISOString() });
    },
    answer(value) {
      const d = day(); if (!d || !d.question || !S.db) return;
      const nd = Object.assign({}, d, { question: Object.assign({}, d.question, { answered: value, answeredAt: new Date().toISOString() }) });
      S.days = S.days.map(x => (x.date === d.date ? nd : x)); schedule();
      wq('days/' + d.date, () => S.db.doc('days/' + d.date).update({ question: { answered: value, answeredAt: new Date().toISOString() } })).catch(saveFail);
      addInbox({ kind: 'answer', ref: d.question.id || '', text: d.question.text || '', value: value }).catch(() => {});
    },
    ans(id, b) { const A = S.asks[id]; if (!A || !b) return; const o = (Array.isArray(A.options) ? A.options : [])[Number(b.dataset.val)]; if (o == null) return; answerAsk(A, String(o)); },
    pick(id, b) { if (!b) return; const m = Object.assign({}, S.multi[id] || {}); const i = b.dataset.val; m[i] = !m[i]; S.multi[id] = m; schedule(); },
    ansmulti(id) {
      const A = S.asks[id]; if (!A) return; const m = S.multi[id] || {};
      const vals = (Array.isArray(A.options) ? A.options : []).filter((o, i) => m[i]).map(String);
      const inp = $('ans-' + id); const other = inp ? inp.value.trim().slice(0, 300) : ''; if (other) vals.push(other);
      if (!vals.length) { toast('Pick at least one, or skip it.'); return; }
      if (inp) inp.value = ''; delete S.multi[id]; answerAsk(A, vals);
    },
    anstext(id) {
      const A = S.asks[id]; const inp = $('ans-' + id); if (!A || !inp) return;
      const v = inp.value.trim().slice(0, 300); if (!v) { inp.focus(); return; }
      inp.value = ''; answerAsk(A, v);
    },
    skipask(id) { const undo = patchDoc('asks', id, { status: 'skipped', skippedOn: todayYMD() }); if (undo) toast('Skipped.', undo); },
    reask(id) { if (patchDoc('asks', id, { status: 'open', answer: '', answeredAt: '', showOn: '' })) toast('Back in your questions.'); },
    askall() { S.askAll = !S.askAll; schedule(); },
    knowall() { S.knowAll = !S.knowAll; schedule(); },
    readall() { S.readAll = !S.readAll; schedule(); },
    lok(id) { if (patchDoc('learned', id, { ok: true, okOn: todayYMD() })) toast('Good. Kept.'); },
    lno(id) { patchDoc('learned', id, { ok: false, okOn: todayYMD(), correction: '' }); },
    fixsave(id) {
      const inp = $('fix-' + id); const v = inp ? inp.value.trim().slice(0, 300) : ''; if (!v) { if (inp) inp.focus(); return; }
      inp.value = ''; if (patchDoc('learned', id, { correction: v })) toast('Thanks. It gets fixed in the next edition.');
    },
    fbsave() {
      const inp = $('fbText'); const v = inp ? inp.value.trim().slice(0, 300) : ''; if (!v) { if (inp) inp.focus(); return; }
      inp.value = ''; setCheckin({ feedbackNote: v });
      addInbox({ kind: 'capture', text: 'About this page: ' + v }).then(() => toast('Thanks. Noted for the next edition.')).catch(saveFail);
    },
    addreading() {
      if (!S.db) return;
      const num = id => { const el = $(id); const v = el ? el.value.trim().replace(',', '.') : ''; return v === '' ? null : Number(v); };
      const sys = num('rSys'), dia = num('rDia'), pulse = num('rPulse'), wt = num('rWt');
      const off = (v, lo, hi) => v != null && !(v >= lo && v <= hi);
      if ((sys == null) !== (dia == null)) { toast('Blood pressure needs both numbers.'); return; }
      if (sys == null && wt == null && pulse == null) { toast('Type a reading first.'); if ($('rSys')) $('rSys').focus(); return; }
      if (off(sys, 50, 280) || off(dia, 30, 200) || off(pulse, 25, 250) || off(wt, 50, 800)) { toast('One of those numbers looks mistyped.'); return; }
      const doc = { at: new Date().toISOString(), day: todayYMD(), by: 'page' };
      if (sys != null) { doc.sys = Math.round(sys); doc.dia = Math.round(dia); }
      if (pulse != null) doc.pulse = Math.round(pulse);
      if (wt != null) doc.weight = Math.round(wt * 10) / 10;
      S.db.collection('readings').add(doc).then(() => {
        ['rSys', 'rDia', 'rPulse', 'rWt'].forEach(i => { if ($(i)) $(i).value = ''; }); toast('Saved.'); tickReadingItem();
        const B = building(); if (B && B.reading && hSay(B, todayYMD()) !== 'yes') habitDay(B, todayYMD(), 'yes');   // a habit that is "take a reading" is done by taking one
        schedule();
      }).catch(saveFail);
    },
    delreading(id) {
      const r = S.readings.find(x => x.id === id); if (!r || !S.db) return;
      S.db.doc('readings/' + id).delete().then(() => toast('Removed.', () => { const c = Object.assign({}, r); delete c.id; S.db.collection('readings').add(c).catch(saveFail); })).catch(saveFail);
    },
    copyreadings() {
      const t = S.readings.slice().reverse().map(r => readingWhen(r) + ': ' + readingText(r)).join('\n');
      if (navigator.clipboard) navigator.clipboard.writeText(t).then(() => toast('Copied.')).catch(() => toast('Couldn\'t copy from here.'));
      else toast('Couldn\'t copy from here.');
    },
    picknext(id) {
      if (!S.db) return;
      const L = id ? S.loops[id] : null;
      const doc = { loopId: L ? L.id : '', title: L ? L.title : '', forDate: addDays(todayYMD(), 1), pickedAt: new Date().toISOString(), by: 'page' };
      const old = S.next; S.next = doc; schedule();
      wq('meta/next', () => S.db.doc('meta/next').set(doc)).then(() => toast(L ? 'Tomorrow starts with that one.' : 'The Landing will pick.')).catch(e => { S.next = old; schedule(); saveFail(e); });
    },
    chip(text) {
      const ta = $('capText'); if (!ta || !text) return;
      ta.value = text + ' ' + ta.value.replace(CHIP_RE, '').replace(/^\s+/, '');
      ta.focus(); try { ta.setSelectionRange(ta.value.length, ta.value.length); } catch (e) { /* caret is a nicety */ }
    },
    capture() {
      const ta = $('capText'); const text = ta.value.trim(); if (!text) { ta.focus(); return; }
      if (S.listening && S.dict) S.dict.stop().catch(() => {});
      addInbox({ kind: 'capture', text: text.slice(0, 4000) }).then(() => { ta.value = ''; toast('Got it. It gets filed with the next edition.'); }).catch(saveFail);
    },
    uncap(id) { if (S.db) S.db.doc('inbox/' + id).delete().catch(saveFail); },
    addloop() {
      const t = $('newTitle'); const title = t.value.trim(); if (!title || !S.db) { t.focus(); return; }
      const id = (title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'loop') + '-' + Math.random().toString(36).slice(2, 6);
      const now = new Date().toISOString();
      const doc = { title: title, area: $('newArea').value, status: 'open', why: '', firstStep: '', minutes: null, due: '', kind: 'task', weight: 3, source: 'added by you', since: todayYMD(), offered: 0, lastOffered: '', snoozeUntil: '', doneAt: '', updatedAt: now, by: 'page' };
      S.loops[id] = Object.assign({ id: id }, doc); t.value = ''; schedule();
      wq('loops/' + id, () => S.db.doc('loops/' + id).set(doc)).then(() => toast('Added. The next edition gives it a first step.')).catch(e => { delete S.loops[id]; schedule(); saveFail(e); });
    },
    help(id) { startHelp(id); },
    hidehelp(id) { delete S.help[id]; schedule(); },
    copyhelp(id) { const h = S.help[id]; if (h && navigator.clipboard) navigator.clipboard.writeText(h.text).then(() => toast('Copied.')).catch(() => toast('Couldn\'t copy from here.')); },
    speak() { speakDay(); }
  };

  function go(view) {
    if (!isView(view)) view = 'today';
    S.view = view; S.dropArm = null;
    try { if (location.hash !== '#' + view) history.replaceState(null, '', '#' + view); } catch (e) { /* hash is a convenience only */ }
    render(); window.scrollTo(0, 0);
  }

  document.addEventListener('click', ev => {
    const b = ev.target.closest('[data-act]'); if (!b) return;
    const fn = ACT[b.dataset.act]; if (fn) fn(b.dataset.id || '', b);
  });
  /* Enter in a one-line field presses the button beside it. */
  document.addEventListener('keydown', ev => {
    if (ev.key !== 'Enter' || !ev.target || ev.target.tagName !== 'INPUT') return;
    const lb = ev.target.closest('.linkbox'); if (lb) { const go = lb.querySelector('button[data-act]'); if (go) { ev.preventDefault(); go.click(); } return; }
    const he = ev.target.closest('.hedit'); if (he) { const go = he.querySelector('button[data-act="hsave"]'); if (go) { ev.preventDefault(); go.click(); } return; }
    const scope = ev.target.closest('.ask, .know, .add') || ev.target.closest('section'); if (!scope) return;
    const btn = scope.querySelector('button[data-act="anstext"], button[data-act="ansmulti"], button[data-act="fixsave"], button[data-act="fbsave"], button[data-act="addloop"], button[data-act="addreading"]');
    if (btn) { ev.preventDefault(); btn.click(); }
  });
  /* The habit editor keeps what is typed in S.hEdit, so a repaint never loses or resurrects a word. */
  document.addEventListener('input', ev => { const k = ev.target && ev.target.dataset && ev.target.dataset.h; if (k && S.hEdit) S.hEdit[k] = ev.target.value; });
  window.addEventListener('hashchange', () => { const v = location.hash.replace('#', ''); if (v && v !== S.view && isView(v)) { S.view = v; render(); } });

  /* ---------- Claude extras: help starting, reading aloud, speaking a note ---------- */
  async function startHelp(id) {
    const L = S.loops[id]; if (!L || !S.sample) return;
    if (S.help[id] && S.help[id].busy) return;
    S.help[id] = { text: 'Thinking…', busy: true }; schedule();
    const prompt = 'You are helping someone get started on something they have been putting off. ' +
      (S.config.helpContext ? String(S.config.helpContext) : 'They do best with one small concrete step, plain words, and no pressure.') + '\n\n' +
      'The task: ' + L.title + '\nWhy it matters: ' + (L.why || 'not recorded') + '\nSuggested first step: ' + (L.firstStep || 'not recorded') + (validYMD(L.due) ? '\nDue: ' + L.due : '') + '\n\n' +
      'Write, in plain text with no markdown:\n1) "Ten minutes, three steps:" then three numbered steps, one short sentence each, starting with the very first physical action.\n' +
      '2) If the task involves a message, an email or a call, a short draft to use, under the label "Words to use:". Warm, plain-spoken, a little informal. Use few dashes. Leave a bracketed blank for any fact you do not know; never invent names, numbers or dates.\n' +
      '3) One closing sentence of encouragement that is specific to this task and not cheesy.\nKeep the whole answer under 170 words.';
    try {
      const r = await S.sample(prompt, { modelTier: 'default', cache: false, onText: p => { if (S.help[id]) { S.help[id] = { text: p.text || 'Thinking…', busy: true }; schedule(); } } });
      S.help[id] = { text: (r && r.text) || '', busy: false };
    } catch (e) {
      if (e && e.code === 'not_granted') { S.sample = null; delete S.help[id]; }
      else S.help[id] = { text: e && e.code === 'rate_limited' ? 'Claude is busy. Try again in a minute.' : 'Couldn\'t reach Claude just now. Try again in a minute.', busy: false };
    }
    schedule();
  }

  function speakDay() {
    if (!S.tts) return;
    if (S.speaking) { try { S.tts.stop(); } catch (e) { /* already quiet */ } return; }
    const d = day(); if (!d) return;
    const parts = [d.long || '', d.nameTheDay || '', d.weather || ''];
    const one = d.oneThing && d.oneThing.title ? oneChoice(d, S.dayIdx === 0).o : null;
    if (one) parts.push('The one thing: ' + one.title + '. ' + (one.why || '') + ' First two minutes: ' + (one.firstStep || ''));
    const B = S.dayIdx === 0 ? building() : null; if (B) parts.push('Your one habit: ' + planText(B));
    (d.today || []).forEach(it => parts.push((it.time ? it.time + ': ' : '') + it.title + '. ' + (it.note || '')));
    const text = parts.filter(Boolean).join(' ').slice(0, 1950);
    S.tts.speak(text).catch(e => { if (e && e.code === 'not_granted') { S.tts = null; schedule(); } });
  }

  function setupMic() {
    const b = $('micBtn'); if (!S.dict || !b) return;
    b.hidden = false;
    S.dict.onFinal(p => { const ta = $('capText'); ta.value = (ta.value ? ta.value.replace(/\s+$/, '') + ' ' : '') + (p.text || ''); });
    S.dict.onState(p => { S.listening = p.state === 'listening'; b.textContent = S.listening ? 'Stop' : 'Speak'; b.classList.toggle('on', S.listening); });
    b.addEventListener('click', () => {
      if (S.listening) { S.dict.stop().catch(() => {}); return; }
      S.dict.start().catch(e => { if (e && e.code === 'not_granted') b.hidden = true; });
    });
  }

  /* ---------- data ---------- */
  function got(snap) {
    if (!snap || !snap.metadata || !snap.metadata.fromCache) { S.got = true; S.slow = false; clearTimeout(S.timer); }
    schedule();
  }
  const rows = snap => snap.docs.map(d => Object.assign({ id: d.id }, d.data() || {}));

  async function boot() {
    const v = location.hash.replace('#', ''); if (isView(v)) S.view = v;
    render();
    const cl = window.claude;
    if (!cl || typeof cl.use !== 'function') { S.nodb = true; render(); return; }
    cl.use('tts').then(t => { if (!t) return; S.tts = t; try { t.onState(p => { S.speaking = p.state === 'speaking'; schedule(); }); } catch (e) { /* no state events */ } schedule(); }).catch(() => {});
    cl.use('dictation').then(d => { if (d) { S.dict = d; setupMic(); } }).catch(() => {});
    cl.use('sample').then(s => { if (s) { S.sample = s; schedule(); } }).catch(() => {});
    let db = null;
    try { db = await cl.use('db'); } catch (e) { db = null; }
    if (!db) { S.nodb = true; render(); return; }
    S.db = db;
    S.timer = setTimeout(() => { if (!S.got) { S.slow = true; schedule(); } }, 10000);
    const onErr = e => { S.err = (e && e.code) || 'unavailable'; clearTimeout(S.timer); schedule(); };
    db.collection('days').orderBy('date', 'desc').limit(10).onSnapshot(snap => { S.days = rows(snap).filter(x => validYMD(x.date)); if (S.dayIdx >= S.days.length) S.dayIdx = 0; got(snap); }, onErr);
    db.collection('loops').limit(800).onSnapshot(snap => { const m = {}; rows(snap).forEach(x => { m[x.id] = x; }); S.loops = m; S.gotLoops = true; got(snap); }, onErr);
    db.collection('feeds').onSnapshot(snap => { S.feeds = rows(snap); got(snap); }, () => {});
    db.collection('inbox').where('handled', '==', false).onSnapshot(snap => { S.inbox = rows(snap).filter(x => !x.deleted); got(snap); }, () => {});
    db.collection('areas').onSnapshot(snap => { S.areas = rows(snap).sort((a, b) => (a.order || 0) - (b.order || 0)); S.areaMap = {}; S.areas.forEach(a => { S.areaMap[a.id] = a; }); schedule(); }, () => {});
    db.collection('stars').onSnapshot(snap => { S.stars = rows(snap).sort((a, b) => (a.order || 0) - (b.order || 0)); schedule(); }, () => {});
    db.doc('meta/status').onSnapshot(s => { S.status = s.exists ? s.data() : null; schedule(); }, () => {});
    /* Check in: questions, the day's one-tap answers, readings, what the page has learned, this week's list, settings, tomorrow's pick. */
    db.collection('asks').limit(400).onSnapshot(snap => { const m = {}; rows(snap).forEach(x => { m[x.id] = x; }); S.asks = m; S.gotAsks = true; got(snap); }, () => {});
    db.collection('checkins').orderBy('date', 'desc').limit(14).onSnapshot(snap => { const m = {}; rows(snap).forEach(x => { const k = validYMD(x.id) ? x.id : x.date; if (validYMD(k)) m[k] = x; }); S.checkins = m; got(snap); }, () => {});
    db.collection('readings').orderBy('at', 'desc').limit(60).onSnapshot(snap => { S.readings = rows(snap).filter(x => !x.deleted); got(snap); }, () => {});
    db.collection('learned').limit(200).onSnapshot(snap => { const m = {}; rows(snap).forEach(x => { m[x.id] = x; }); S.learned = m; got(snap); }, () => {});
    db.collection('habits').limit(200).onSnapshot(snap => { const m = {}; rows(snap).forEach(x => { m[x.id] = x; }); S.habits = m; S.gotHabits = true; got(snap); }, () => {});
    S.weekId = mondayOf(todayYMD());
    db.doc('weeks/' + S.weekId).onSnapshot(s => { S.week = s.exists ? s.data() : null; schedule(); }, () => {});
    db.doc('meta/config').onSnapshot(s => { S.config = (s.exists && s.data()) || {}; schedule(); }, () => {});
    db.doc('meta/next').onSnapshot(s => { S.next = s.exists ? s.data() : null; schedule(); }, () => {});
    db.doc('meta/prefs').onSnapshot(s => { S.prefs = (s.exists && s.data()) || {}; schedule(); }, () => {});
    if (!window.LandingApp) db.doc('meta/app').onSnapshot(s => { S.appInfo = s.exists ? s.data() : null; schedule(); }, () => {});
  }
  window.addEventListener('landing-sync', schedule);
  setInterval(() => { if (!document.hidden) schedule(); }, 60000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) schedule(); });
  boot();
})();
