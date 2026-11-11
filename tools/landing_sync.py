#!/usr/bin/env python3
"""The agent's side of the phone app: bring the phone's taps in, and send the new edition out.

The page's notes live in a private database. The phone app can't reach it, so each morning the agent:

  collect   reads the sealed taps waiting on the relay and in the site's sealed copy, opens them with the key,
            checks each one against a short list of things a tap is allowed to change, and applies them to an
            export of the database. It writes the documents that changed, for the agent to save back.
  publish   takes a fresh export, packs it into one edition, seals it and posts it to the relay.

The key never leaves the agent's sandbox, the private database and the owner's devices.

Usage:
  landing_sync.py check   --export DIR --key-file FILE
  landing_sync.py collect --export DIR --key-file FILE --out DIR
  landing_sync.py publish --export DIR --key-file FILE --out DIR
An export is one folder per collection (areas, loops, days, meta, ...) holding one JSON file per document, named
<document id>.json, either the document's fields or {id, data, version}. The key file is the key itself, or the
private page's meta/app document as exported (the key is read from its "key" field and never printed).
Needs: pip install cryptography."""
import argparse, base64, copy, datetime, gzip, hashlib, json, os, re, secrets, subprocess, sys, tempfile, time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

RELAY = 'https://ntfy.sh/'
SITE = 'https://hectrvictorious.github.io/the-landing/'
CHUNK = 2700
UA = 'the-landing agent (personal use)'
YMD = re.compile(r'^\d{4}-\d{2}-\d{2}$')
B64 = re.compile(r'^[A-Za-z0-9_-]+$')
COLLECTIONS = ['areas', 'stars', 'loops', 'days', 'feeds', 'inbox', 'asks', 'learned', 'checkins', 'readings', 'weeks', 'meta']
NEVER_PUBLISH = {'meta/app', 'meta/sync'}
DAY = 86400
HOLD_DAYS = 3        # a tap whose document is missing from the export waits this long before it is given up on
MAX_OP_DAYS = 15     # the app forgets its own taps after 14 days; anything older is not applied
KEEP_FOLDED_DAYS = 21  # how long the private page remembers which taps it has brought in
TELL_FOLDED_DAYS = 8   # how far back an edition tells devices "these are in" (the site keeps taps for 6 days)

b64e = lambda b: base64.urlsafe_b64encode(b).decode().rstrip('=')
b64d = lambda s: base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


class Key:
    def __init__(self, raw):
        raw = raw.strip()
        try: b = b64d(raw) if B64.match(raw) else b''
        except Exception: b = b''
        if len(b) != 32: sys.exit('the key file does not hold a 32-byte key')
        self.aes = AESGCM(b)
        self.fp = hashlib.sha256(b).hexdigest()[:8]
        self.topic = 'tl' + hashlib.sha256(('topic:' + raw).encode()).hexdigest()[:22]


def read_key(path):
    """The key file may be the bare key, or the page's meta/app document as it was exported."""
    try: text = open(path, encoding='utf-8').read().strip()
    except Exception: sys.exit('the key file could not be read')
    if text.startswith('{'):
        try:
            j = json.loads(text)
            if isinstance(j.get('data'), dict): j = j['data']
            text = str(j.get('key', ''))
        except Exception: sys.exit('the key file could not be read')
    return Key(text)


def aad(e): return '|'.join(['L1', e['fp'], e['id'], e['k'], str(e['ts']), e['g'], str(e['i']), str(e['n'])]).encode()


def seal_group(key, k, data, g, ts):
    n = max(1, -(-len(data) // CHUNK)); out = []
    for i in range(n):
        e = {'v': 1, 'fp': key.fp, 'id': f'{g}.{i}', 'k': k, 'ts': ts, 'g': g, 'i': i, 'n': n}
        iv = secrets.token_bytes(12)
        e['iv'] = b64e(iv); e['ct'] = b64e(key.aes.encrypt(iv, data[i * CHUNK:(i + 1) * CHUNK], aad(e)))
        out.append(e)
    return out


def valid_env(e, fp):
    return (isinstance(e, dict) and e.get('v') == 1 and e.get('fp') == fp and e.get('k') in ('o', 's')
            and isinstance(e.get('g'), str) and 8 <= len(e['g']) <= 40 and B64.match(e['g'])
            and isinstance(e.get('i'), int) and isinstance(e.get('n'), int) and 1 <= e['n'] <= 400 and 0 <= e['i'] < e['n']
            and e.get('id') == f"{e['g']}.{e['i']}" and isinstance(e.get('ts'), int)
            and isinstance(e.get('iv'), str) and isinstance(e.get('ct'), str) and len(e['ct']) <= 8000)


def curl(args, timeout=40):
    try: r = subprocess.run(['curl', '-sS', '-L', '-m', str(timeout), '-A', UA, '-w', '\n%{http_code}'] + args, capture_output=True, text=True, timeout=timeout + 20)
    except Exception as err: return 0, str(err)[:200]
    if r.returncode != 0: return 0, r.stderr.strip()[:200]
    body, _, code = r.stdout.rpartition('\n')
    return int(code or 0), body


# The relay allows each internet address so many requests and messages a day. An agent's sandbox shares its
# addresses with many others, and every new connection can leave through a different one: some are already over
# the limit (the relay answers 429) while others are fine. So a refusal is tried again on a new connection.
def get_retry(url, tries=6):
    code, body = 0, ''
    for attempt in range(tries):
        code, body = curl([url])
        if code not in (0, 429) and code < 500: break
        time.sleep(1.5 + attempt)
    return code, body


def post_all(url, envs, attempts=90):
    """Post every envelope. Each round sends all that are still waiting over ONE connection (one curl run), and
    stops at the first refusal, so an address that is over its limit costs a single request. Whatever a connection
    accepts is done; the rest wait for the next connection.
    Returns (indexes never accepted, last answer, rounds used)."""
    waiting, last, rounds, dead = list(range(len(envs))), 0, 0, 0
    with tempfile.TemporaryDirectory() as tmp:
        for i, e in enumerate(envs):
            with open(os.path.join(tmp, f'{i}.json'), 'w') as fh: fh.write(json.dumps(e, separators=(',', ':')))
        for attempt in range(attempts):
            rounds += 1; args = ['--fail-early']
            for n, i in enumerate(waiting):
                if n: args.append('--next')
                args += ['-sS', '-f', '-m', '40', '-A', UA, '-o', os.devnull, '-w', '%{http_code}\n', '-X', 'POST', '-H', 'Content-Type: text/plain',
                         '--data-binary', '@' + os.path.join(tmp, f'{i}.json'), url]
            try: codes = [int(c) for c in subprocess.run(['curl'] + args, capture_output=True, text=True, timeout=60 * len(waiting) + 30).stdout.split() if c.isdigit()]
            except Exception: codes = []
            # codes holds one answer per envelope tried, in order; curl stopped after the first one that wasn't accepted
            waiting = [i for n, i in enumerate(waiting) if not (n < len(codes) and codes[n] == 200)]
            answered = any(c > 0 for c in codes)
            if answered: last = next((c for c in codes if c != 200), 200)
            if not waiting: return [], 200, rounds
            if answered and last not in (200, 429) and last < 500: break   # refused for a reason another connection won't fix
            dead = 0 if answered else dead + 1
            if dead >= 6: last = 0; break                                    # nothing is answering at all: no network, or the relay is down
            time.sleep(1.5 if attempt < 30 else 3)
    return waiting, last, rounds


# ---------- the export ----------
def load_export(root):
    """path -> {'data': fields, 'version': n or None}. Accepts raw documents or {id, data, version} wrappers."""
    docs = {}
    def take(col, fallback_id, obj):
        if isinstance(obj, dict) and isinstance(obj.get('data'), dict) and ('id' in obj or 'version' in obj or 'updatedAt' in obj):
            did = str(obj.get('id') or fallback_id); docs[f'{col}/{did}'] = {'data': obj['data'], 'version': obj.get('version')}
        elif isinstance(obj, dict):
            docs[f'{col}/{fallback_id}'] = {'data': obj, 'version': None}
    for col in sorted(os.listdir(root)):
        cdir = os.path.join(root, col)
        if not os.path.isdir(cdir): continue
        for dirpath, _, files in os.walk(cdir):
            for name in sorted(files):
                p = os.path.join(dirpath, name); stem = os.path.splitext(name)[0]
                try:
                    text = open(p, encoding='utf-8').read()
                    if name.endswith(('.jsonl', '.ndjson')):
                        for line in text.splitlines():
                            if line.strip(): take(col, stem, json.loads(line))
                        continue
                    if not name.endswith('.json'): continue
                    obj = json.loads(text)
                except Exception as err:
                    print('skipped unreadable file', p, err, file=sys.stderr); continue
                if isinstance(obj, list):
                    for item in obj: take(col, stem, item)
                elif isinstance(obj, dict) and isinstance(obj.get('documents'), list):
                    for item in obj['documents']: take(col, stem, item)
                else:
                    take(col, stem, obj)
    return docs


# ---------- what a tap may change ----------
STATUS = {'open', 'unsure', 'waiting', 'done', 'dropped'}
LOOP_UPD = {'status', 'snoozeUntil', 'passes', 'passedOn', 'doneAt', 'doneVia', 'droppedAt', 'blocker', 'blockerOn', 'stepTicks', 'steps', 'stepsBy', 'updatedAt', 'by'}
LOOP_NEW = {'title', 'area', 'status', 'why', 'firstStep', 'minutes', 'due', 'kind', 'weight', 'source', 'since', 'offered', 'lastOffered', 'snoozeUntil', 'doneAt', 'updatedAt', 'by'}
ASK_UPD = {'status', 'answer', 'answeredAt', 'skippedOn', 'showOn', 'updatedAt', 'by'}
LEARN_UPD = {'ok', 'okOn', 'correction', 'updatedAt', 'by'}
ID_OK = re.compile(r'^[A-Za-z0-9_.~:@+-]{1,80}$')

scalar = lambda v, n=400: v is None or isinstance(v, (bool, int, float)) or (isinstance(v, str) and len(v) <= n)
ticks_ok = lambda t: isinstance(t, dict) and len(t) <= 60 and all(isinstance(k, str) and len(k) <= 60 and (v is False or (isinstance(v, str) and len(v) <= 40)) for k, v in t.items())


def check_op(o, docs):
    """Return None when the tap is allowed, or the reason it isn't."""
    if not (isinstance(o, dict) and isinstance(o.get('id'), str) and isinstance(o.get('ts'), (int, float)) and o.get('w') in ('set', 'upd', 'del') and isinstance(o.get('p'), str)): return 'shape'
    parts = o['p'].split('/')
    if len(parts) != 2 or not ID_OK.match(parts[1]): return 'path'
    col, did = parts; w = o['w']; d = o.get('d'); exists = o['p'] in docs
    if o['ts'] < (time.time() - MAX_OP_DAYS * DAY) * 1000: return 'too old'
    if w != 'del' and not isinstance(d, dict): return 'no data'
    if w != 'del' and len(json.dumps(d)) > 9000: return 'too big'
    if w == 'upd' and not exists and col in ('loops', 'asks', 'learned', 'days', 'weeks', 'checkins'): return 'missing'
    if col == 'loops':
        if w == 'upd':
            if not set(d) <= LOOP_UPD: return 'loop fields'
            if 'status' in d and d['status'] not in STATUS: return 'loop status'
            if 'stepTicks' in d and not ticks_ok(d['stepTicks']): return 'step ticks'
            if 'steps' in d and not (isinstance(d['steps'], list) and len(d['steps']) <= 8 and all(isinstance(s, dict) and set(s) <= {'id', 'text', 'minutes'} and scalar(s.get('id'), 40) and scalar(s.get('text'), 200) for s in d['steps'])): return 'steps'
            return None if all(scalar(v) for k, v in d.items() if k not in ('stepTicks', 'steps')) else 'loop values'
        if w == 'set':
            if exists or not set(d) <= LOOP_NEW or d.get('by') != 'page' or d.get('status') != 'open': return 'new loop'
            return None if isinstance(d.get('title'), str) and 0 < len(d['title']) <= 200 and all(scalar(v) for v in d.values()) else 'new loop values'
        return 'loops cannot be deleted from the phone'
    if col == 'asks':
        if w != 'upd' or not set(d) <= ASK_UPD: return 'ask fields'
        if 'status' in d and d['status'] not in ('open', 'answered', 'skipped'): return 'ask status'
        a = d.get('answer', '')
        if not (scalar(a) or (isinstance(a, list) and len(a) <= 12 and all(isinstance(x, str) and len(x) <= 300 for x in a))): return 'answer'
        return None if all(scalar(v) for k, v in d.items() if k != 'answer') else 'ask values'
    if col == 'learned':
        return None if w == 'upd' and set(d) <= LEARN_UPD and all(scalar(v) for v in d.values()) else 'learned fields'
    if col == 'checkins':
        if w == 'del' or not YMD.match(did): return 'check-in'
        return None if len(d) <= 40 and all(isinstance(k, str) and len(k) <= 40 and scalar(v) for k, v in d.items()) else 'check-in values'
    if col == 'readings':
        if w == 'del': return None
        if w != 'set' or exists or not set(d) <= {'sys', 'dia', 'pulse', 'weight', 'at', 'day', 'by', 'note'}: return 'reading'
        num = lambda k, lo, hi: k not in d or (isinstance(d[k], (int, float)) and not isinstance(d[k], bool) and lo <= d[k] <= hi)
        return None if num('sys', 50, 280) and num('dia', 30, 200) and num('pulse', 25, 250) and num('weight', 50, 800) and scalar(d.get('at'), 40) and scalar(d.get('day'), 12) and scalar(d.get('note')) else 'reading values'
    if col == 'weeks':
        if not YMD.match(did): return 'week'
        if w == 'upd': return None if set(d) <= {'ticks', 'updatedAt'} and ticks_ok(d.get('ticks', {})) and scalar(d.get('updatedAt')) else 'week ticks'
        if w == 'set' and not exists:
            items = d.get('items')
            ok = (set(d) <= {'week', 'items', 'ticks', 'madeBy', 'updatedAt'} and isinstance(items, list) and len(items) <= 20
                  and all(isinstance(x, dict) and set(x) <= {'id', 'label', 'when', 'area', 'note'} and all(scalar(v, 200) for v in x.values()) for x in items) and ticks_ok(d.get('ticks', {})))
            return None if ok else 'new week'
        return 'week'
    if col == 'inbox':
        if w == 'del': return None
        if w != 'set' or exists or not set(d) <= {'kind', 'text', 'value', 'ref', 'at', 'day', 'handled'}: return 'note'
        return None if d.get('kind') in ('capture', 'answer') and d.get('handled') is False and scalar(d.get('text', ''), 4000) and all(scalar(d.get(k)) for k in ('value', 'ref', 'at', 'day')) else 'note values'
    if col == 'days':
        if w != 'upd' or not YMD.match(did) or not set(d) <= {'ticks', 'question'}: return 'day'
        q = d.get('question', {})
        return None if ticks_ok(d.get('ticks', {})) and isinstance(q, dict) and set(q) <= {'answered', 'answeredAt'} and all(scalar(v, 100) for v in q.values()) else 'day values'
    if col == 'meta' and did == 'next':
        return None if w == 'set' and set(d) <= {'loopId', 'title', 'forDate', 'pickedAt', 'by'} and all(scalar(v) for v in d.values()) else 'pick'
    return 'that part of the page cannot be changed from the phone'


def export_problems(docs):
    """A half-empty or misnamed export would make good taps look like bad ones, so look before touching anything."""
    cols = {}
    for p in docs: cols[p.split('/')[0]] = cols.get(p.split('/')[0], 0) + 1
    problems = []
    if not docs: problems.append('the export folder holds no documents')
    for need in ('loops', 'days', 'areas', 'meta'):
        if docs and not cols.get(need): problems.append(f'no documents under {need}/')
    if docs and 'meta/config' not in docs: problems.append('meta/config is missing (expected the file meta/config.json)')
    if any(not YMD.match(p.split('/')[1]) for p in docs if p.startswith('days/')): problems.append('files under days/ should be named by date, like 2026-11-10.json')
    return cols, problems


def cmd_check(a):
    docs = load_export(a.export); cols, problems = export_problems(docs)
    if 'meta/app' not in docs: problems.append('meta/app is missing: the phone app has not been set up')
    try: key = read_key(a.key_file); fp = key.fp
    except SystemExit as err: problems.append(str(err)); fp = ''
    app = docs.get('meta/app', {}).get('data', {})
    if fp and app.get('fp') and app['fp'] != fp: problems.append('the key does not match the fingerprint in meta/app')
    print(json.dumps({'ok': not problems, 'collections': cols, 'problems': problems}))
    sys.exit(0 if not problems else 3)


def merge(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict): merge(a[k], v)
        else: a[k] = copy.deepcopy(v)
    return a


def fetch_envelopes(key, relay, site):
    envs, notes = {}, []
    code, body = get_retry(f'{relay}{key.topic}/json?poll=1&since=12h')
    if code == 200:
        for line in body.splitlines():
            try:
                m = json.loads(line)
                if m.get('event') == 'message':
                    e = json.loads(m.get('message') or '')
                    if valid_env(e, key.fp): envs[e['id']] = e
            except Exception: pass
    else: notes.append(f'the relay did not answer ({code})')
    code, body = get_retry(f'{site}data/sync.json?t={int(time.time())}', tries=3)
    if code == 200:
        try:
            newest = 0
            for e in json.loads(body).get('events', []):
                if valid_env(e, key.fp):
                    envs.setdefault(e['id'], e)
                    if e['k'] == 's': newest = max(newest, e['ts'])
            days = (time.time() - newest / 1000) / 86400 if newest else 0
            if days > 2.2: notes.append(f"the site's sealed copy last received an edition {days:.0f} days ago")
        except Exception: notes.append('the site\'s sealed copy was unreadable')
    elif code != 404: notes.append(f'the site\'s sealed copy did not answer ({code})')
    return list(envs.values()), notes


def open_groups(key, envs, kind):
    groups = {}
    for e in envs:
        if e['k'] == kind: groups.setdefault(e['g'], {})[e['i']] = e
    out = []
    for g, parts in groups.items():
        n = next(iter(parts.values()))['n']
        if len(parts) != n: continue
        try: out.append((g, b''.join(key.aes.decrypt(b64d(parts[i]['iv']), b64d(parts[i]['ct']), aad(parts[i])) for i in range(n))))
        except Exception: pass   # not sealed with this key, or damaged
    return out


def cmd_collect(a):
    key = read_key(a.key_file); docs = load_export(a.export)
    cols, problems = export_problems(docs)
    if problems: print(json.dumps({'ok': False, 'problems': problems, 'collections': cols})); sys.exit(3)
    sync = copy.deepcopy(docs.get('meta/sync', {}).get('data', {})); folded = sync.get('folded', {}) if isinstance(sync.get('folded'), dict) else {}
    envs, notes = fetch_envelopes(key, a.relay, a.site)
    ops = []
    for g, raw in open_groups(key, envs, 'o'):
        try: o = json.loads(raw.decode())
        except Exception: continue
        if isinstance(o, dict) and o.get('id') == g and g not in folded: ops.append(o)
    ops.sort(key=lambda o: (o.get('ts', 0), o.get('id', '')))
    work = {p: copy.deepcopy(v['data']) for p, v in docs.items()}
    changed, deleted, applied, rejected, held, touched, replaced = set(), set(), [], [], [], {}, set()
    now = time.time()
    for o in ops:
        # A check-in or a week's list first made on the phone may already exist here (made on the page the same day).
        # Then the phone's whole-document write becomes an addition, so neither side's taps are lost.
        if isinstance(o, dict) and o.get('w') == 'set' and isinstance(o.get('d'), dict) and o.get('p') in work:
            if str(o['p']).startswith('checkins/'): o = dict(o, w='upd')
            elif str(o['p']).startswith('weeks/'): o = dict(o, w='upd', d={k: v for k, v in o['d'].items() if k in ('ticks', 'updatedAt')})
        why = check_op(o, work)
        if why == 'missing' and o['ts'] > (now - HOLD_DAYS * DAY) * 1000:
            held.append({'id': o.get('id'), 'p': o.get('p')}); continue      # its document isn't in this export: leave it for the next run
        if why: rejected.append({'id': o.get('id'), 'p': o.get('p'), 'why': why}); folded[o['id']] = int(now); continue
        p = o['p']
        if o['w'] == 'set': work[p] = copy.deepcopy(o['d']); deleted.discard(p); changed.add(p); replaced.add(p)
        elif o['w'] == 'upd': merge(work[p], o['d']); changed.add(p); touched.setdefault(p, set()).update(o['d'].keys())
        elif p in work: del work[p]; changed.discard(p); deleted.add(p)
        applied.append(o); folded[o['id']] = int(now)
    cut = now - KEEP_FOLDED_DAYS * DAY
    sync['folded'] = {k: v for k, v in folded.items() if isinstance(v, (int, float)) and v > cut}
    sync['collectedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    os.makedirs(a.out, exist_ok=True); manifest = []
    def put(path, data, mode, **extra):
        # mode says how to save it: "set" = write the whole document from "file"; "merge" = only the fields the taps
        # changed, whole, from "patch_file" (same result as "file" if nothing else changed meanwhile); "delete".
        col, did = path.split('/'); f = os.path.join(a.out, 'changed', col, did + '.json'); os.makedirs(os.path.dirname(f), exist_ok=True)
        json.dump(data, open(f, 'w'), ensure_ascii=False)
        entry = {'collection': col, 'doc_id': did, 'mode': mode, 'file': os.path.abspath(f), 'version': docs.get(path, {}).get('version'), 'existed': path in docs}
        if mode == 'merge':
            pf = os.path.join(a.out, 'patch', col, did + '.json'); os.makedirs(os.path.dirname(pf), exist_ok=True)
            json.dump({k: data[k] for k in sorted(touched.get(path, ())) if k in data}, open(pf, 'w'), ensure_ascii=False)
            entry['patch_file'] = os.path.abspath(pf)
        manifest.append(dict(entry, **extra))
    for p in sorted(changed): put(p, work[p], 'merge' if (p in docs and p not in replaced) else 'set')
    for p in sorted(deleted):
        if p in docs: put(p, dict(docs[p]['data'], deleted=True, handled=True), 'delete', deleted=True)
    put('meta/sync', sync, 'set')
    json.dump(manifest, open(os.path.join(a.out, 'changed.json'), 'w'), indent=1)
    json.dump(applied, open(os.path.join(a.out, 'ops.json'), 'w'), ensure_ascii=False, indent=1)
    json.dump(rejected, open(os.path.join(a.out, 'rejected.json'), 'w'), indent=1)
    kinds = {}
    for o in applied: kinds[o['p'].split('/')[0]] = kinds.get(o['p'].split('/')[0], 0) + 1
    json.dump(held, open(os.path.join(a.out, 'held.json'), 'w'), indent=1)
    print(json.dumps({'ok': True, 'taps': len(applied), 'byPart': kinds, 'rejected': len(rejected), 'held': len(held), 'documentsToSave': len(manifest), 'notes': notes}))


def cmd_publish(a):
    key = read_key(a.key_file); docs = load_export(a.export)
    cols, problems = export_problems(docs)
    if problems: print(json.dumps({'ok': False, 'problems': problems, 'collections': cols})); sys.exit(3)
    now = datetime.datetime.now(datetime.timezone.utc)
    keep = {}
    for p, v in docs.items():
        col = p.split('/')[0]; d = v['data']
        if col not in COLLECTIONS or p in NEVER_PUBLISH or d.get('deleted') is True: continue
        if col == 'inbox' and d.get('handled') is not False: continue
        if col == 'loops' and d.get('status') in ('done', 'dropped'):
            when = d.get('doneAt') or d.get('droppedAt') or d.get('updatedAt') or ''
            try:
                if (now - datetime.datetime.fromisoformat(str(when).replace('Z', '+00:00'))).days > 14: continue
            except Exception: pass
        keep[p] = d
    newest = lambda col, n: set(sorted([p for p in keep if p.startswith(col + '/')], reverse=True)[n:])
    drop = newest('days', 7) | newest('checkins', 14) | newest('weeks', 2)
    readings = sorted([p for p in keep if p.startswith('readings/')], key=lambda p: str(keep[p].get('at', '')), reverse=True)
    drop |= set(readings[60:])
    for p in drop: keep.pop(p, None)
    folded = docs.get('meta/sync', {}).get('data', {}).get('folded', {})
    folded = dict(folded) if isinstance(folded, dict) else {}
    # What this run's collect brought in must be in the page's meta/sync by now. If the save was missed or garbled,
    # still tell the devices (so nothing shows twice) and say so, so it can be saved again.
    not_saved = 0
    try:
        mine = json.load(open(os.path.join(a.out, 'changed', 'meta', 'sync.json'))).get('folded', {})
        not_saved = len(set(mine) - set(folded)); folded.update(mine)
    except Exception: pass
    cutf = now.timestamp() - TELL_FOLDED_DAYS * DAY
    tell = sorted(k for k, v in folded.items() if isinstance(v, (int, float)) and v > cutf)
    sid = 'S' + now.strftime('%Y%m%d%H%M%S') + secrets.token_hex(3)
    base = {'v': 1, 'sid': sid, 'asOf': now.isoformat(timespec='milliseconds').replace('+00:00', 'Z'), 'folded': tell, 'docs': keep}
    packed = gzip.compress(json.dumps(base, ensure_ascii=False, separators=(',', ':')).encode(), 9)
    envs = seal_group(key, 's', packed, sid, int(now.timestamp() * 1000))
    os.makedirs(a.out, exist_ok=True)
    left, code, rounds = post_all(f'{a.relay}{key.topic}', envs)
    if left:
        why = ('the relay turned every connection away: its daily limit for shared addresses was used up' if code == 429
               else 'the relay could not be reached' if code == 0 else f'the relay answered {code}')
        summary = {'ok': False, 'sent': len(envs) - len(left), 'of': len(envs), 'connections': rounds, 'why': why}
        json.dump(summary, open(os.path.join(a.out, 'published.json'), 'w'))
        print(json.dumps(summary)); sys.exit(2)
    summary = {'ok': True, 'edition': sid, 'asOf': base['asOf'], 'documents': len(keep), 'bytes': len(packed), 'parts': len(envs), 'connections': rounds}
    if not_saved: summary['syncNotSaved'] = not_saved      # meta/sync in the page is missing this many of the taps collected this run
    json.dump(summary, open(os.path.join(a.out, 'published.json'), 'w'))
    print(json.dumps(summary))


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name, fn in (('check', cmd_check), ('collect', cmd_collect), ('publish', cmd_publish)):
        sp = sub.add_parser(name); sp.set_defaults(fn=fn)
        sp.add_argument('--export', required=True); sp.add_argument('--key-file', required=True); sp.add_argument('--out', required=(name != 'check'))
        sp.add_argument('--relay', default=RELAY); sp.add_argument('--site', default=SITE)
    a = ap.parse_args()
    a.relay = a.relay.rstrip('/') + '/'; a.site = a.site.rstrip('/') + '/'
    a.fn(a)
