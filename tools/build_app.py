#!/usr/bin/env python3
"""Build the phone app's shell (site/index.html and site/page.js) from the Landing page's source.

The page is written once and runs in two places: inside Claude (where it talks to a private database) and here,
as an installable app (where site/app.js gives it the same kind of database on the device). This script takes the
page's HTML, moves its script into its own file so the app can run under a strict content security policy, adds the
app's manifest and icons, and stamps a new build so phones pick the update up by themselves.

Usage: tools/build_app.py path/to/page.html
The page's source carries no personal data; everything personal arrives sealed, at run time."""
import datetime, pathlib, re, sys

root = pathlib.Path(__file__).resolve().parent.parent
src = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
build = datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%S')

m = re.search(r'<script>\n(.*?)</script>\s*</body>', src, re.S)
if not m: sys.exit('could not find the page script')
script = m.group(1)
html = src[:m.start()] + '<script src="app.js"></script>\n<script src="page.js"></script>\n</body>' + src[m.end():]
if '<script>' in html: sys.exit('an inline script is left in the page; the app does not allow those')

csp = ("default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; "
       "font-src 'self' https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self' https://ntfy.sh; "
       "manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; object-src 'none'")
head = '\n'.join([
    '<meta http-equiv="Content-Security-Policy" content="' + csp + '">',
    '<meta name="robots" content="noindex, nofollow">',
    '<meta name="landing-build" content="' + build + '">',
    '<meta name="theme-color" content="#1f433a">',
    '<meta name="mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    '<meta name="apple-mobile-web-app-title" content="Landing">',
    '<link rel="manifest" href="manifest.json">',
    '<link rel="icon" type="image/png" sizes="32x32" href="favicon-32.png">',
    '<link rel="apple-touch-icon" href="apple-touch-icon.png">',
])
if '<meta name="color-scheme"' not in html: sys.exit('page head changed; update this script')
html = html.replace('<meta name="color-scheme"', head + '\n<meta name="color-scheme"', 1)

(root / 'site' / 'index.html').write_text(html, encoding='utf-8')
(root / 'site' / 'page.js').write_text(script, encoding='utf-8')
sw = (root / 'site' / 'sw.js').read_text(encoding='utf-8')
sw2, n = re.subn(r"const BUILD = '[^']*';", "const BUILD = '" + build + "';", sw, count=1)
if n != 1: sys.exit('could not stamp sw.js')
(root / 'site' / 'sw.js').write_text(sw2, encoding='utf-8')
print('built', build, '| index.html', len(html), '| page.js', len(script))
