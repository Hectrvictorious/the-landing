# The Landing

A one-page daily app. It lives at **https://hectrvictorious.github.io/the-landing/** and installs on a phone as
its own app: its own icon, no address bar, and it opens with no signal.

Nothing personal is in this repository. The page's words and numbers arrive at run time, sealed.

## How it works

- The page itself is written once and runs in two places: inside Claude, where it reads a private database, and
  here as an app, where `site/app.js` gives it the same kind of database kept on the device.
- Each morning an agent writes the day's edition into the private database, then seals a copy and posts it to a
  public relay (ntfy.sh). The app picks it up the next time it is opened.
- Every tap in the app is saved on the device first, then sent back through the relay, sealed. The next morning the
  agent opens those, checks each one against a short list of things a tap may change, and applies them.
- "Sealed" means AES-GCM with a 256-bit key. The key exists only on the owner's devices and in his private Claude
  page. It reaches a device in the link that sets it up, after the `#`, and that part of a link never reaches a server.
  The relay, GitHub and anyone reading this repository see only ciphertext.
- The relay forgets a message after about 12 hours, so the workflow keeps a sealed copy of the newest editions and
  the recent taps in `data/sync.json`. That file is published with the site but never committed, so there is no
  history of it here.

## What's in here

- `site/` — the app. `index.html` and `page.js` are the page (built, see below). `app.js` is the device database,
  the sealing and the relay. `sw.js`, `manifest.json` and the icons make it installable and let it open offline.
- `tools/build_app.py` — rebuilds `site/index.html` and `site/page.js` from the page's source and stamps a new build.
- `tools/landing_sync.py` — the agent's side: `collect` brings the phone's taps in, `publish` sends an edition out.
- `tools/merge_sync.py` — the workflow's side: refreshes the sealed copy. It never sees the key.
- `.github/workflows/site.yml` — publishes the site on every push, and every half hour refreshes the sealed copy.

## Updates reach the phone by themselves

Push to `main` and the workflow publishes. The next time the app is opened (or brought back to the screen), the
service worker picks up the new build and the page reloads once. Nobody reinstalls anything.

## Linking a device

Open the private page in Claude on that device, go to Horizon, and tap **Open the phone app**. Then use the
browser's menu to add it to the home screen. To remove a device, open Horizon in the app and tap **Unlink this device**.

## Starting over with a new key

Generate 32 random bytes (base64url), store them in the private page's settings, and change `SYNC_TOPIC` and
`SYNC_FP` in the workflow: the fingerprint is the first 8 hex digits of the key's SHA-256, and the topic is `tl`
followed by the first 22 hex digits of the SHA-256 of `topic:` plus the key text. Link the devices again. Old
messages become unreadable.

## If GitHub emails that the scheduled workflow was disabled

It does that after 60 quiet days. Open the Actions tab and enable it again.
