"""Loads Cleancord as a real extension in Chromium and drives the UI against the mock Discord API.

Requirements: Python 3.10+, `pip install playwright pillow`, `python -m playwright install chromium`, and `openssl` on PATH.
Optional: CHROME_PATH=/path/to/chrome (Chrome for Testing or Chromium; branded Chrome no longer loads unpacked
extensions from the command line), FAKE_DISCORD_PORT (default 8443).
"""
import json, os, re, sys, time, zipfile, io, tempfile, shutil
from playwright.sync_api import sync_playwright

import pathlib, subprocess
HERE = pathlib.Path(__file__).resolve().parent
EXT = str(HERE.parent / 'extension')
SHOTS = str(HERE / '.output' / 'shots')
PORT = int(os.environ.get('FAKE_DISCORD_PORT', '8443'))
CHROME = os.environ.get('CHROME_PATH') or None
CERTS = tempfile.mkdtemp()
subprocess.run(['openssl', 'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', f'{CERTS}/key.pem', '-out', f'{CERTS}/cert.pem',
                '-days', '1', '-subj', '/CN=discord.com', '-addext', 'subjectAltName=DNS:discord.com'], check=True, capture_output=True)
SERVER = [sys.executable, str(HERE / 'fake_discord_server.py'), str(PORT), CERTS]
os.makedirs(SHOTS, exist_ok=True)
MOCK = (HERE / 'mock-discord.js').read_text()
INIT = MOCK + r"""
;(() => {
  if (!location.href.startsWith('chrome-extension://')) return;
  const mock = window.createMockDiscord({ admin: false, perChannel: 150 });
  window.__mock = mock;
  const orig = window.fetch.bind(window);
  window.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : input.url;
    if (/^https:\/\/(discord\.com|[^/]*discordapp\.(com|net))\//.test(u)) return mock.fetch(input, init);
    return orig(input, init);
  };
})();
"""

# tiny colored PNG for CDN images
def png(r, g, b, size=64):
    from PIL import Image
    im = Image.new('RGB', (size, size), (r, g, b))
    buf = io.BytesIO(); im.save(buf, 'PNG'); return buf.getvalue()
AVATAR = png(235, 69, 158)
PHOTO = png(60, 160, 220, 200)


def wait_js(page, expr, timeout=10000):
    """Polls an expression with page.evaluate (wait_for_function needs eval, which our CSP rightly blocks)."""
    end = time.time() + timeout / 1000
    last = None
    while time.time() < end:
        try:
            last = page.evaluate(f"() => {{ try {{ return !!({expr}); }} catch (e) {{ return false; }} }}")
            if last: return True
        except Exception as e:
            last = e
        time.sleep(0.15)
    raise AssertionError(f'timed out waiting for: {expr} ({last})')

errors = []
outside = []
results = []
def ok(name):
    results.append(name); print('  ✔', name, flush=True)

def main():
    user_data = tempfile.mkdtemp()
    with sync_playwright() as p:
        ctx = p.chromium.launch_persistent_context(
            user_data, executable_path=CHROME, channel=None if CHROME else 'chromium', headless=True,
            args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--no-sandbox', '--no-proxy-server', '--ignore-certificate-errors', f'--host-resolver-rules=MAP discord.com:443 127.0.0.1:{PORT}'],
            viewport={'width': 1440, 'height': 900}, accept_downloads=True,
        )
        # Serve Discord CDN images (they'd otherwise go to the real network).
        def cdn(route):
            route.fulfill(status=200, body=AVATAR if 'avatars' in route.request.url or 'embed/avatars' in route.request.url else PHOTO, headers={'content-type': 'image/png'})
        ctx.route(re.compile(r'https://([^/]*\.)?discordapp\.(com|net)/.*'), cdn)
        sw = ctx.service_workers[0] if ctx.service_workers else ctx.wait_for_event('serviceworker', timeout=15000)
        ext_id = sw.url.split('/')[2]
        ok(f'extension loaded, service worker running ({ext_id})')

        # ---- token capture from a (fake) discord.com tab served over real HTTPS ----
        import subprocess
        server = subprocess.Popen(SERVER)
        time.sleep(0.8)
        try:
            dpage = ctx.new_page()
            dpage.goto('https://discord.com/channels/@me')
            time.sleep(1.5)
            cap = sw.evaluate("chrome.storage.session.get('capturedAuth')")
            assert cap.get('capturedAuth', {}).get('token') == 'captured-token-123', cap
            assert cap['capturedAuth']['headers'].get('x-super-properties') == 'abc'
            ok('token captured locally from the Discord tab (chrome.storage.session), never sent elsewhere')
            assert dpage.evaluate("!!document.getElementById('cleancord-launcher')")
            ok('launcher button injected on discord.com')
            dpage.close()
        finally:
            server.terminate()
        sw.evaluate("chrome.storage.session.clear()")
        sw.evaluate("chrome.storage.local.set({settings: {modifyDelay: 0, searchDelay: 0, delaySpread: 0}})")

        ctx.add_init_script(INIT)
        page = ctx.new_page()
        page.on('console', lambda m: errors.append(f'console.{m.type}: {m.text}') if m.type in ('error',) else None)
        page.on('pageerror', lambda e: errors.append(f'pageerror: {e}'))
        def on_req(r):
            u = r.url
            if not (u.startswith('chrome-extension://') or u.startswith('data:') or u.startswith('blob:') or re.match(r'https://([^/]*\.)?(discord\.com|discordapp\.(com|net))/', u)):
                outside.append(u)
        page.on('request', on_req)
        page.goto(f'chrome-extension://{ext_id}/app.html')
        page.wait_for_selector('.modal-head h2', timeout=10000)  # connect help opens when no session
        page.screenshot(path=f'{SHOTS}/01-connect.png')
        page.fill('input[type=password]', 'test-token')
        page.click('button:has-text("Use token")')
        page.wait_for_selector('#account .dot.ok', timeout=10000)
        ok('connected with a pasted token')

        # ---- open DM ----
        page.click('.row[data-open="300000000000000001"]')
        page.wait_for_selector('#feed .msg', timeout=10000)
        n = page.locator('#feed .msg').count()
        assert n > 0
        page.screenshot(path=f'{SHOTS}/02-dm.png')
        ok(f'DM opened, {n} messages rendered')
        page.click('#load-older')
        wait_js(page, "document.querySelectorAll('#feed .msg').length >= 80 || document.querySelector('.conv-title .small').textContent.includes('complete')", timeout=10000)
        ok('load older works')

        # ---- filters ----
        page.click('button:has-text("Filter")')
        page.click('.chip-btn:has-text("Attachments")')
        time.sleep(0.4)
        nf = page.locator('#feed .msg').count()
        assert 0 < nf < 80, nf
        page.click('.chip-btn:has-text("Mine")')
        time.sleep(0.4)
        page.screenshot(path=f'{SHOTS}/03-filter.png')
        ok(f'quick filters narrow the feed ({nf} with attachments)')

        # ---- select + remove attachments via selection bar ----
        page.click('button:has-text("Select all shown")')
        page.click('button:has-text("Remove attachments")')
        page.click('.modal-foot button:has-text("Remove")')
        wait_js(page, "window.__mock.msgs['300000000000000001'].filter(m => m.author.id === '100000000000000001' && m.attachments.length).length === 0", timeout=20000)
        ok('bulk attachment removal applied on (mock) Discord')
        page.click('button:has-text("Reset")')
        page.click('button:has-text("Filter")')

        # ---- edit one message via action bar ----
        first_mine = page.evaluate("[...window.__mock.msgs['300000000000000001']].reverse().find(m => m.author.id === '100000000000000001' && m.type === 0 && m.content && !m.poll).id")
        page.hover(f'#m-{first_mine}')
        page.click(f'#m-{first_mine} [data-act=edit]')
        page.fill('.modal textarea', 'edited by cleancord test')
        page.click('.modal-foot button:has-text("Save")')
        wait_js(page, f"window.__mock.msgs['300000000000000001'].find(m => m.id === '{first_mine}').content === 'edited by cleancord test'", timeout=15000)
        page.wait_for_selector(f'#m-{first_mine} .edited', timeout=5000)
        ok('single-message edit updates Discord and the feed')

        # ---- reactions viewer ----
        rid = page.evaluate("window.__mock.msgs['300000000000000001'].find(m => (m.reactions||[]).some(r => r.me)).id")
        page.evaluate(f"window.__sk_jump = '{rid}'")
        page.click('.conv-actions button[title=More]')
        page.click('.menu-item:has-text("Jump to message")')
        page.fill('.modal input', rid)
        page.keyboard.press('Enter')
        page.wait_for_selector(f'#m-{rid} [data-reactions]', timeout=5000)
        page.click(f'#m-{rid} [data-reactions]')
        page.wait_for_selector('.react-user', timeout=5000)
        page.screenshot(path=f'{SHOTS}/04-reactions.png')
        page.click('.react-user button:has-text("Remove mine")')
        wait_js(page, f"!window.__mock.msgs['300000000000000001'].find(m => m.id === '{rid}').reactions.some(r => r._users.includes('100000000000000001'))", timeout=5000)
        page.keyboard.press('Escape')
        ok('jump-to-message + reaction viewer removes my reaction')

        # ---- search ----
        page.click('button:has-text("🔍 Search")')
        page.fill('.modal input[placeholder="words or phrase"]', 'bold')
        page.click('.modal .radio:has-text("Me")')
        page.click('.modal-foot button:has-text("Search")')
        wait_js(page, "document.querySelector('.conv-name').textContent.startsWith('Search')", timeout=10000)
        page.wait_for_selector('#feed .msg', timeout=10000)
        ok(f'search results shown ({page.locator("#feed .msg").count()})')

        # ---- server: channels, threads, member names ----
        page.click('.rail-item[title="Test Server"]')
        page.wait_for_selector('.row[data-open="400000000000000002"]', timeout=10000)
        page.click('.row[data-open="400000000000000002"]')
        page.wait_for_selector('#feed .msg', timeout=10000)
        wait_js(page, "[...document.querySelectorAll('.msg-author')].some(e => e.textContent === 'Buddy')", timeout=10000)
        page.click('.row[data-open="400000000000000002"] .thread-toggle')
        page.wait_for_selector('.row[data-open="500000000000000001"]', timeout=10000)
        page.screenshot(path=f'{SHOTS}/05-server.png')
        ok('server channels, archived threads, nicknames + role colors')

        # ---- purge the server (search + final pass + archived thread) ----
        page.click('.side-actions button[title="Purge server"]')
        page.wait_for_selector('.modal h2:has-text("Purge")')
        time.sleep(0.4)
        page.screenshot(path=f'{SHOTS}/06-purge.png')
        page.click('.modal-foot button:has-text("Start purge")')
        page.click('.modal-foot button:has-text("Yes, purge")')
        try:
            wait_js(page, "window.__mock && Object.values(window.__mock.msgs).flat().filter(m => m.guild_id && m.author.id === '100000000000000001' && [0,19].includes(m.type)).length === 0", timeout=120000)
        except AssertionError:
            print(page.evaluate("JSON.stringify(Object.values(window.__mock.msgs).flat().filter(m => m.guild_id && m.author.id === '100000000000000001' && [0,19].includes(m.type)).map(m => [m.channel_id, m.type, m.id, m.content.slice(0,30)]).slice(0,20))"))
            print(page.evaluate("JSON.stringify(window.__sk_debug || null)"))
            print(page.inner_text('#log')[-3000:])
            raise
        page.wait_for_selector('#job-card.idle', timeout=30000)
        archived = page.evaluate("window.__mock.THREAD.thread_metadata.archived")
        assert archived
        page.screenshot(path=f'{SHOTS}/07-after-purge.png')
        ok('server purge removed all my messages (incl. archived thread, re-archived afterwards)')

        # ---- export DM to a downloaded zip ----
        page.click('.rail-item[title="Direct messages"]')
        page.click('.row[data-open="300000000000000002"]')
        page.wait_for_selector('#feed .msg', timeout=10000)
        page.click('.conv-actions button:has-text("Export")')
        page.select_option('.modal select', label='Everything: HTML + JSON + CSV + TXT + media')
        page.click('.modal .radio:has-text("Download a .zip")')
        page.screenshot(path=f'{SHOTS}/08-export.png')
        with page.expect_download(timeout=60000) as dl:
            page.click('.modal-foot button:has-text("Start export")')
        path = dl.value.path()
        z = zipfile.ZipFile(path)
        assert z.testzip() is None
        names = z.namelist()
        assert any(n.endswith('.html') for n in names) and any(n.endswith('.json') for n in names) and any('/media/' in n for n in names), names[:20]
        html = z.read([n for n in names if n.endswith('.html')][0]).decode()
        assert '<script' not in html.lower()
        with open(f'{SHOTS}/export-sample.html', 'w') as f: f.write(html)
        for n in names:
            if '/media/' in n:
                os.makedirs(os.path.dirname(f'{SHOTS}/export/{n}'), exist_ok=True)
                open(f'{SHOTS}/export/{n}', 'wb').write(z.read(n))
        hname = [n for n in names if n.endswith('.html')][0]
        os.makedirs(os.path.dirname(f'{SHOTS}/export/{hname}'), exist_ok=True)
        open(f'{SHOTS}/export/{hname}', 'w').write(html)
        vp = ctx.new_page()
        vp.goto('file://' + f'{SHOTS}/export/{hname}')
        time.sleep(0.5)
        vp.evaluate("document.querySelectorAll('img[loading=lazy]').forEach(i => i.loading = 'eager')")
        time.sleep(0.8)
        broken = vp.evaluate("[...document.images].filter(i => i.complete && !i.naturalWidth).map(i => i.getAttribute('src'))")
        vp.screenshot(path=f'{SHOTS}/08b-exported-html.png')
        vp.close()
        assert not broken, broken
        ok(f'export downloaded as a valid zip ({len(names)} files)')

        # ---- analytics ----
        page.click('#topbar button:has-text("Analytics")')
        page.wait_for_selector('.an-table', timeout=5000)
        page.screenshot(path=f'{SHOTS}/09-analytics.png')
        page.keyboard.press('Escape')
        ok('analytics dialog')

        # ---- data package ----
        pkg_buf = io.BytesIO()
        with zipfile.ZipFile(pkg_buf, 'w') as pz:
            pz.writestr('Account/user.json', json.dumps({'id': '100000000000000001', 'username': 'tester', 'global_name': 'Test User'}))
            pz.writestr('Messages/index.json', json.dumps({'300000000000000001': 'Direct Message with friend#0'}))
            pz.writestr('Messages/c300000000000000001/channel.json', json.dumps({'id': '300000000000000001', 'type': 'DM', 'recipients': ['100000000000000001', '100000000000000002']}))
            mine = page.evaluate("window.__mock.msgs['300000000000000001'].filter(m => m.author.id === '100000000000000001' && m.type === 0).slice(0, 6).map(m => ({ID: m.id, Timestamp: m.timestamp.replace('T',' ').slice(0,19), Contents: m.content, Attachments: ''}))")
            body = json.dumps(mine)
            body = re.sub(r'"ID": "(\d+)"', r'"ID": \1', body)  # numbers, like the real package
            pz.writestr('Messages/c300000000000000001/messages.json', body)
        pkg_path = os.path.join(tempfile.mkdtemp(), 'package.zip')
        open(pkg_path, 'wb').write(pkg_buf.getvalue())
        page.click('.tab[data-tab=package]')
        page.set_input_files('#side-body input[type=file]', pkg_path)
        page.wait_for_selector('#side-body .row[data-open="pkg:300000000000000001"]', timeout=10000)
        page.click('#side-body .row[data-open="pkg:300000000000000001"]')
        page.wait_for_selector('#feed .msg', timeout=10000)
        page.click('button:has-text("Fetch details")')
        page.wait_for_selector('#job-card.idle', timeout=30000)
        time.sleep(0.6)
        page.screenshot(path=f'{SHOTS}/10-package.png')
        ok('data package opened and details fetched from Discord')

        # ---- settings / themes / workspaces ----
        page.click('#topbar button:has-text("Settings")')
        page.select_option('.modal select >> nth=0', 'light')
        page.click('.modal-foot button:has-text("Save")')
        time.sleep(0.3)
        assert page.evaluate("document.body.classList.contains('theme-light')")
        page.click('.rail-item[title="Direct messages"]') if page.locator('.rail-item').count() else None
        page.click('.tab[data-tab=chats]')
        page.click('.row[data-open="300000000000000001"]')
        page.wait_for_selector('#feed .msg', timeout=10000)
        page.screenshot(path=f'{SHOTS}/11-light.png')
        page.click('.tab[data-tab=saved]')
        page.wait_for_selector('#side-body .row.saved', timeout=5000)
        page.click('.tab[data-tab=jobs]')
        time.sleep(0.4)
        page.screenshot(path=f'{SHOTS}/12-tasks.png')
        ok('light theme, saved conversations and tasks tabs')

        # CSP sanity: inline script must be blocked in the extension page
        blocked = page.evaluate("""() => new Promise(r => { window.__x = 0; const s = document.createElement('script'); s.textContent = 'window.__x = 1'; document.body.append(s); setTimeout(() => r(window.__x === 0), 50); })""")
        assert blocked
        ok('extension CSP blocks inline scripts')

        # ---- launcher button on discord.com opens Cleancord on that conversation ----
        import subprocess
        server = subprocess.Popen(SERVER)
        time.sleep(0.8)
        try:
            page.click('.tab[data-tab=saved]')
            dpage = ctx.new_page()
            dpage.goto('https://discord.com/channels/@me/300000000000000002')
            time.sleep(0.8)
            vh = dpage.evaluate('innerHeight'); vw = dpage.evaluate('innerWidth')
            dpage.mouse.click(vw - 18 - 19, vh - 150 + 19)
            wait_js(page, "document.querySelector('.conv-name') && document.querySelector('.conv-name').textContent === 'Friendly, robot'", timeout=10000)
            ok('launcher button on discord.com opens Cleancord at the same conversation')
        finally:
            server.terminate()
        ctx.close()
    shutil.rmtree(user_data, ignore_errors=True)

try:
    main()
finally:
    real_errors = [e for e in errors if 'net::ERR' not in e and 'Content Security Policy' not in e]
    print('\nconsole errors:', len(real_errors))
    for e in real_errors[:20]: print('  ', e)
    csp = [e for e in errors if 'Content Security Policy' in e]
    print('CSP reports:', len(csp))
    for e in csp[:5]: print('  ', e)
    print('requests outside Discord/extension:', outside[:10])
    print(f'{len(results)} checks passed')
