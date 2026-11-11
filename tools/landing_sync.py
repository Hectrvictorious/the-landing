#!/usr/bin/env python3
"""The agent's side of the phone app: bring the phone's taps in, and send the new edition out.

The page's notes live in a private database. The phone app can't reach it, so each morning the agent:

  collect   reads the sealed taps waiting on the relay and in the site's sealed copy, opens them with the key,
            checks each one against a short list of things a tap is allowed to change, and applies them to an
            export of the database. It writes the documents that changed, for the agent to save back.
  publish   takes a fresh export, packs it into one edition, seals it and posts it to the relay.

The key never leaves the agent's sandbox, the private database and the owner's devices.

Usage:
  landing_sync.py collect --export DIR --key-file FILE --out DIR
  landing_sync.py publish --export DIR --key-file FILE --out DIR
An export is one folder per collection (areas, loops, days, meta, ...) holding one JSON file per document, either
the document's fields or {id, data, version}. Needs: pip install cryptography."""
import argparse, base64, copy, datetime, gzip, hashlib, json, os, re, secrets, subprocess, sys, time

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

RELAY = 'https://ntfy.sh/'
SITE = 'https://hectrvictorious.github.io/the-landing/'
CHUNK = 2700
UA = 'the-landing agent (personal use)'
YMD = re.compile(r'^\d{4}-\d{2}-\d{2}$')
B64 = re.compile(r'^[A-Za-z0-9_-]+$')
COLLECTIONS = ['areas', 'stars', 'loops', 'days', 'feeds', 'inbox', 'asks', 'learned', 'checkins', 'readings', 'weeks', 'meta']
NEVER_PUBLISH = {'meta/app', 'meta/sync'}

b64e = lambda b: base64.urlsafe_b64encode(b).decode().rstrip('=')
b64d = lambda s: base64.urlsafe_b64decode(s + '=' * (-len(s) % 4))


class Key:
    def __init__(self, raw):
        raw = raw.strip(); b = b64d(raw)
        if len(b) != 32: sys.exit('the key file does not hold a 32-byte key')
        self.aes = AESGCM(b)
        self.fp = hashlib.sha256(b).hexdigest()[:8]
        self.topic = 'tl' + hashlib.sha256(('topic:' + raw).encode()).hexdigest()[:22]


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
    r = subprocess.run(['curl', '-sS', '-L', '-m', str(timeout), '-A', UA, '-w', '\n%{http_code}'] + args, capture_output=True, text=True, timeout=timeout + 20)
    if r.returncode != 0: return 0, r.stderr.strip()[:200]
    body, _, code = r.stdout.rpartition('\n')
    return int(code or 0), body


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
    if w != 'del' and not isinstance(d, dict): return 'no data'
    if w != 'del' and len(json.dumps(d)) > 9000: return 'too big'
    if col == 'loops':
        if w == 'upd':
            if not exists or not set(d) <= LOOP_UPD: return 'loop fields'
            if 'status' in d and d['status'] not in STATUS: return 'loop status'
            if 'stepTicks' in d and not ticks_ok(d['stepTicks']): return 'step ticks'
            if 'steps' in d and not (isinstance(d['steps'], list) and len(d['steps']) <= 8 and all(isinstance(s, dict) and set(s) <= {'id', 'text', 'minutes'} and scalar(s.get('id'), 40) and scalar(s.get('text'), 200) for s in d['steps'])): return 'steps'
            return None if all(scalar(v) for k, v in d.items() if k not in ('stepTicks', 'steps')) else 'loop values'
        if w == 'set':
            if exists or not set(d) <= LOOP_NEW or d.get('by') != 'page' or d.get('status') != 'open': return 'new loop'
            return None if isinstance(d.get('title'), str) and 0 < len(d['title']) <= 200 and all(scalar(v) for v in d.values()) else 'new loop values'
        return 'loops cannot be deleted from the phone'
    if col == 'asks':
        if w != 'upd' or not exists or not set(d) <= ASK_UPD: return 'ask fields'
        if 'status' in d and d['status'] not in ('open', 'answered', 'skipped'): return 'ask status'
        a = d.get('answer', '')
        if not (scalar(a) or (isinstance(a, list) and len(a) <= 12 and all(isinstance(x, str) and len(x) <= 300 for x in a))): return 'answer'
        return None if all(scalar(v) for k, v in d.items() if k != 'answer') else 'ask values'
    if col == 'learned':
        return None if w == 'upd' and exists and set(d) <= LEARN_UPD and all(scalar(v) for v in d.values()) else 'learned fields'
    if col == 'checkins':
        if w == 'del' or not YMD.match(did) or (w == 'upd' and not exists): return 'check-in'
        return None if len(d) <= 40 and all(isinstance(k, str) and len(k) <= 40 and scalar(v) for k, v in d.items()) else 'check-in values'
    if col == 'readings':
        if w == 'del': return None
        if w != 'set' or exists or not set(d) <= {'sys', 'dia', 'pulse', 'weight', 'at', 'day', 'by', 'note'}: return 'reading'
        num = lambda k, lo, hi: k not in d or (isinstance(d[k], (int, float)) and not isinstance(d[k], bool) and lo <= d[k] <= hi)
        return None if num('sys', 50, 280) and num('dia', 30, 200) and num('pulse', 25, 250) and num('weight', 50, 800) and scalar(d.get('at'), 40) and scalar(d.get('day'), 12) and scalar(d.get('note')) else 'reading values'
    if col == 'weeks':
        if not YMD.match(did): return 'week'
        if w == 'upd': return None if exists and set(d) <= {'ticks', 'updatedAt'} and ticks_ok(d.get('ticks', {})) and scalar(d.get('updatedAt')) else 'week ticks'
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
        if w != 'upd' or not exists or not YMD.match(did) or not set(d) <= {'ticks', 'question'}: return 'day'
        q = d.get('question', {})
        return None if ticks_ok(d.get('ticks', {})) and isinstance(q, dict) and set(q) <= {'answered', 'answeredAt'} and all(scalar(v, 100) for v in q.values()) else 'day values'
    if col == 'meta' and did == 'next':
        return None if w == 'set' and set(d) <= {'loopId', 'title', 'forDate', 'pickedAt', 'by'} and all(scalar(v) for v in d.values()) else 'pick'
    return 'that part of the page cannot be changed from the phone'


def merge(a, b):
    for k, v in b.items():
        if isinstance(v, dict) and isinstance(a.get(k), dict): merge(a[k], v)
        else: a[k] = copy.deepcopy(v)
    return a


def fetch_envelopes(key, relay, site):
    envs, notes = {}, []
    code, body = curl([f'{relay}{key.topic}/json?poll=1&since=12h'])
    if code == 200:
        for line in body.splitlines():
            try:
                m = json.loads(line)
                if m.get('event') == 'message':
                    e = json.loads(m.get('message') or '')
                    if valid_env(e, key.fp): envs[e['id']] = e
            except Exception: pass
    else: notes.append(f'the relay did not answer ({code})')
    code, body = curl([f'{site}data/sync.json?t={int(time.time())}'])
    if code == 200:
        try:
            for e in json.loads(body).get('events', []):
                if valid_env(e, key.fp): envs.setdefault(e['id'], e)
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
    key = Key(open(a.key_file).read()); docs = load_export(a.export)
    if not docs: sys.exit('the export folder holds no documents')
    sync = copy.deepcopy(docs.get('meta/sync', {}).get('data', {})); folded = sync.get('folded', {}) if isinstance(sync.get('folded'), dict) else {}
    envs, notes = fetch_envelopes(key, a.relay, a.site)
    ops = []
    for g, raw in open_groups(key, envs, 'o'):
        try: o = json.loads(raw.decode())
        except Exception: continue
        if isinstance(o, dict) and o.get('id') == g and g not in folded: ops.append(o)
    ops.sort(key=lambda o: (o.get('ts', 0), o.get('id', '')))
    work = {p: copy.deepcopy(v['data']) for p, v in docs.items()}
    changed, deleted, applied, rejected = set(), set(), [], []
    for o in ops:
        # A check-in or a week's list first made on the phone may already exist here (made on the page the same day).
        # Then the phone's whole-document write becomes an addition, so neither side's taps are lost.
        if isinstance(o, dict) and o.get('w') == 'set' and isinstance(o.get('d'), dict) and o.get('p') in work:
            if str(o['p']).startswith('checkins/'): o = dict(o, w='upd')
            elif str(o['p']).startswith('weeks/'): o = dict(o, w='upd', d={k: v for k, v in o['d'].items() if k in ('ticks', 'updatedAt')})
        why = check_op(o, work)
        if why: rejected.append({'id': o.get('id'), 'p': o.get('p'), 'why': why}); folded[o['id']] = int(time.time()); continue
        p = o['p']
        if o['w'] == 'set': work[p] = copy.deepcopy(o['d']); deleted.discard(p); changed.add(p)
        elif o['w'] == 'upd': merge(work[p], o['d']); changed.add(p)
        elif p in work: del work[p]; changed.discard(p); deleted.add(p)
        applied.append(o); folded[o['id']] = int(time.time())
    cut = time.time() - 10 * 86400
    sync['folded'] = {k: v for k, v in folded.items() if v > cut}
    sync['collectedAt'] = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec='seconds')
    os.makedirs(a.out, exist_ok=True); manifest = []
    def put(path, data, **extra):
        col, did = path.split('/'); f = os.path.join(a.out, 'changed', col, did + '.json'); os.makedirs(os.path.dirname(f), exist_ok=True)
        json.dump(data, open(f, 'w'), ensure_ascii=False)
        manifest.append(dict({'collection': col, 'doc_id': did, 'file': os.path.abspath(f), 'version': docs.get(path, {}).get('version'), 'existed': path in docs}, **extra))
    for p in sorted(changed): put(p, work[p])
    for p in sorted(deleted):
        if p in docs: put(p, dict(docs[p]['data'], deleted=True, handled=True), deleted=True)
    put('meta/sync', sync)
    json.dump(manifest, open(os.path.join(a.out, 'changed.json'), 'w'), indent=1)
    json.dump(applied, open(os.path.join(a.out, 'ops.json'), 'w'), ensure_ascii=False, indent=1)
    json.dump(rejected, open(os.path.join(a.out, 'rejected.json'), 'w'), indent=1)
    kinds = {}
    for o in applied: kinds[o['p'].split('/')[0]] = kinds.get(o['p'].split('/')[0], 0) + 1
    print(json.dumps({'taps': len(applied), 'byPart': kinds, 'rejected': len(rejected), 'documentsToSave': len(manifest), 'notes': notes}))


def cmd_publish(a):
    key = Key(open(a.key_file).read()); docs = load_export(a.export)
    if not any(p.startswith('days/') for p in docs): sys.exit('the export holds no edition; nothing to publish')
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
    sid = 'S' + now.strftime('%Y%m%d%H%M%S') + secrets.token_hex(3)
    base = {'v': 1, 'sid': sid, 'asOf': now.isoformat(timespec='milliseconds').replace('+00:00', 'Z'), 'folded': sorted(folded) if isinstance(folded, dict) else [], 'docs': keep}
    packed = gzip.compress(json.dumps(base, ensure_ascii=False, separators=(',', ':')).encode(), 9)
    envs = seal_group(key, 's', packed, sid, int(now.timestamp() * 1000))
    sent = 0
    for e in envs:
        for attempt in range(6):
            code, body = curl(['-X', 'POST', '-H', 'Content-Type: text/plain', '--data-binary', json.dumps(e, separators=(',', ':')), f'{a.relay}{key.topic}'])
            if code == 200: sent += 1; break
            time.sleep(20 if code == 429 else 4)
        else:
            print(json.dumps({'ok': False, 'sent': sent, 'of': len(envs), 'why': f'the relay answered {code}'})); sys.exit(2)
        time.sleep(0.4)
    os.makedirs(a.out, exist_ok=True)
    summary = {'ok': True, 'edition': sid, 'asOf': base['asOf'], 'documents': len(keep), 'bytes': len(packed), 'parts': len(envs)}
    json.dump(summary, open(os.path.join(a.out, 'published.json'), 'w'))
    print(json.dumps(summary))


if __name__ == '__main__':
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest='cmd', required=True)
    for name, fn in (('collect', cmd_collect), ('publish', cmd_publish)):
        sp = sub.add_parser(name); sp.set_defaults(fn=fn)
        sp.add_argument('--export', required=True); sp.add_argument('--key-file', required=True); sp.add_argument('--out', required=True)
        sp.add_argument('--relay', default=RELAY); sp.add_argument('--site', default=SITE)
    a = ap.parse_args()
    a.relay = a.relay.rstrip('/') + '/'; a.site = a.site.rstrip('/') + '/'
    a.fn(a)
