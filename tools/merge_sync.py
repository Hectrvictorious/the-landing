#!/usr/bin/env python3
"""Keep site/data/sync.json, the sealed copy of the app's messages, current. No history is kept.

The newest edition and the owner's taps travel through a public relay (ntfy.sh) as encrypted envelopes. The relay
forgets a message after about 12 hours, so the site's workflow runs this every half hour: it starts from the copy
the live site is serving, adds whatever is new on the relay, and trims the result. The file is published with the
site but never committed, so the repository holds no record of past messages.

This script never sees the key. It only checks each envelope's shape and key fingerprint.

Usage: merge_sync.py site/data/sync.json     (env SYNC_TOPIC, SYNC_FP, SITE_URL; RELAY_URL for tests)
Exit 3 means the live copy could not be read; the workflow then leaves the site as it is."""
import json, os, re, subprocess, sys, time

OUT = sys.argv[1] if len(sys.argv) > 1 else 'site/data/sync.json'
TOPIC = os.environ.get('SYNC_TOPIC', '').strip()
FP = os.environ.get('SYNC_FP', '').strip()
SITE = os.environ.get('SITE_URL', '').strip().rstrip('/') + '/'
RELAY = os.environ.get('RELAY_URL', 'https://ntfy.sh/').strip().rstrip('/') + '/'
UA = 'the-landing archive (personal use)'
B64 = re.compile(r'^[A-Za-z0-9_-]+$')
DAY = 86400
KEEP_STATES = 3          # newest complete editions kept
KEEP_OP_DAYS = 6         # taps are folded into an edition within a day; this is slack
MAX_BYTES = 3_000_000

if not re.fullmatch(r'[A-Za-z0-9_-]{8,64}', TOPIC) or not re.fullmatch(r'[0-9a-f]{8}', FP):
    print('SYNC_TOPIC / SYNC_FP not set; nothing to do', file=sys.stderr); sys.exit(0)


def valid(e):
    return (isinstance(e, dict) and e.get('v') == 1 and e.get('fp') == FP and e.get('k') in ('o', 's')
            and isinstance(e.get('g'), str) and 8 <= len(e['g']) <= 40 and B64.match(e['g'])
            and isinstance(e.get('i'), int) and isinstance(e.get('n'), int) and 1 <= e['n'] <= 400 and 0 <= e['i'] < e['n']
            and e.get('id') == f"{e['g']}.{e['i']}" and isinstance(e.get('ts'), int)
            and isinstance(e.get('iv'), str) and len(e['iv']) <= 24 and B64.match(e['iv'])
            and isinstance(e.get('ct'), str) and len(e['ct']) <= 8000 and B64.match(e['ct']))


def curl(url, timeout=40):
    r = subprocess.run(['curl', '-sS', '-L', '-m', str(timeout), '-A', UA, '-w', '\n%{http_code}', url], capture_output=True, text=True, timeout=timeout + 20)
    if r.returncode != 0: return None, r.stderr.strip()[:200]
    body, _, code = r.stdout.rpartition('\n')
    return int(code or 0), body


# 1. Start from the copy the live site is serving (nothing is kept in the repository).
events = []
if SITE != '/':
    code, body = curl(SITE + 'data/sync.json?t=' + str(int(time.time())))
    if code == 200:
        try:
            j = json.loads(body); events = [e for e in (j.get('events', []) if isinstance(j, dict) else []) if valid(e)]
        except Exception as err:
            print('live copy unreadable, starting over:', err, file=sys.stderr)
    elif code == 404:
        print('no live copy yet; starting one')
    else:
        print('could not read the live copy:', code, body, file=sys.stderr); sys.exit(3)
have = {e['id'] for e in events}
live_ids = sorted(have)

# 2. Add what is new on the relay. The relay limits each address, and build machines share theirs, so a refusal
#    gets a few more tries; if it still says no, the copy simply stays as it is until the next run.
for attempt in range(4):
    code, body = curl(f'{RELAY}{TOPIC}/json?poll=1&since=12h')
    if code == 200 or (code and code != 429 and code < 500): break
    time.sleep(6)
added = 0
if code != 200:
    print('relay did not answer:', code, (body or '')[:200], file=sys.stderr)
else:
    for line in body.splitlines():
        try:
            m = json.loads(line)
            if m.get('event') != 'message': continue
            e = json.loads(m.get('message') or '')
        except Exception:
            continue
        if not valid(e) or e['id'] in have: continue
        keep = {k: e[k] for k in ('v', 'fp', 'id', 'k', 'ts', 'g', 'i', 'n', 'iv', 'ct')}
        keep['rt'] = int(m.get('time') or time.time())
        events.append(keep); have.add(e['id']); added += 1

# 3. Trim: the newest complete editions, editions still arriving, and recent taps.
now = time.time()
age = lambda e: now - (e.get('rt') or e['ts'] / 1000)
groups = {}
for e in events: groups.setdefault(e['g'], []).append(e)
complete = lambda g: len({e['i'] for e in groups[g]}) == groups[g][0]['n']
states = sorted([g for g in groups if groups[g][0]['k'] == 's'], key=lambda g: groups[g][0]['ts'])
keep_g = set([g for g in states if complete(g)][-KEEP_STATES:])
keep_g |= {g for g in states if not complete(g) and min(age(e) for e in groups[g]) < 6 * 3600}
keep_g |= {g for g in groups if groups[g][0]['k'] == 'o' and min(age(e) for e in groups[g]) < KEEP_OP_DAYS * DAY}
events = sorted([e for e in events if e['g'] in keep_g], key=lambda e: (e['ts'], e['g'], e['i']))
while events and sum(len(e['ct']) for e in events) > MAX_BYTES:
    first_op = next((e['g'] for e in events if e['k'] == 'o'), None)
    if first_op is None: break
    events = [e for e in events if e['g'] != first_op]

os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
with open(OUT, 'w') as fh:
    json.dump({'v': 1, 'note': 'Sealed messages for The Landing. Only the owner’s devices can read them.', 'events': events}, fh, separators=(',', ':'))
same = sorted(e['id'] for e in events) == live_ids
print(('unchanged' if same else 'changed') + f': +{added} new, {len(events)} kept ({sum(1 for g in keep_g if groups[g][0]["k"] == "s")} editions)')
