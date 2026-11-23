"""Records the README screenshots and GIFs by driving the real extension against a fictional demo Discord.

Usage:  CHROME_PATH=/path/to/chrome-for-testing python3 scripts/demo/record.py [scene ...]
Needs:  pip install playwright pillow, plus ffmpeg on PATH. Output goes to docs/media/.
No real Discord account, person or message is involved: all data comes from demo-discord.js and art.py.
"""
import io, json, math, os, pathlib, re, shutil, subprocess, sys, tempfile, time, zipfile
from contextlib import contextmanager
from playwright.sync_api import sync_playwright

HERE = pathlib.Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import art  # noqa: E402

REPO = HERE.parent.parent
EXT = str(REPO / 'extension')
OUT = REPO / 'docs' / 'media'
OUT.mkdir(parents=True, exist_ok=True)
CHROME = os.environ.get('CHROME_PATH') or None
W, H = 1280, 800

GLUE = r"""
;(() => {
  if (!location.href.startsWith('chrome-extension://')) return;
  const orig = window.fetch.bind(window);
  const mock = window.createDemoDiscord({ cdnFetch: (u) => orig(u, { credentials: 'omit' }) });
  window.__mock = mock;
  window.fetch = (input, init) => {
    const u = typeof input === 'string' ? input : input.url;
    return /^https:\/\/(discord\.com|[^/]*discordapp\.(com|net))\//.test(u) ? mock.fetch(input, init) : orig(input, init);
  };
})();
"""
CURSOR = r"""
;(() => {
  const mount = () => {
    if (document.getElementById('__demo_cursor')) return;
    const c = document.createElement('div');
    c.id = '__demo_cursor';
    c.innerHTML = '<svg width="26" height="26" viewBox="0 0 24 24"><path d="M5 3l13.5 8.6-6.2 1.3 3.6 7.4-2.8 1.3-3.5-7.4L5 18.6z" fill="#fff" stroke="#111" stroke-width="1.5" stroke-linejoin="round"/></svg>';
    Object.assign(c.style, { position: 'fixed', left: '-60px', top: '-60px', zIndex: 2147483647, pointerEvents: 'none', filter: 'drop-shadow(0 2px 3px rgba(0,0,0,.45))' });
    document.documentElement.appendChild(c);
    addEventListener('mousemove', (e) => { c.style.left = (e.clientX - 5) + 'px'; c.style.top = (e.clientY - 3) + 'px'; }, true);
    addEventListener('mousedown', (e) => {
      const r = document.createElement('div');
      Object.assign(r.style, { position: 'fixed', left: (e.clientX - 18) + 'px', top: (e.clientY - 18) + 'px', width: '36px', height: '36px', borderRadius: '50%',
        border: '3px solid rgba(16,185,129,.9)', zIndex: 2147483646, pointerEvents: 'none', transition: 'transform .45s ease-out, opacity .45s ease-out' });
      document.documentElement.appendChild(r);
      requestAnimationFrame(() => { r.style.transform = 'scale(1.6)'; r.style.opacity = '0'; });
      setTimeout(() => r.remove(), 500);
    }, true);
  };
  if (document.readyState === 'loading') addEventListener('DOMContentLoaded', mount); else mount();
})();
"""
INIT = (HERE / 'demo-discord.js').read_text() + GLUE + CURSOR


def gif(inputs, segments, out, width=900, fps=10, hold=1.6):
    """inputs: list of video paths; segments: list of (input_index, start, end, speed)."""
    parts = []
    font = next((f for f in art.FONT_PATHS if os.path.exists(f)), None)
    for i, (src, a, b, speed) in enumerate(segments):
        label = ''
        if speed != 1 and font:
            # Long waits (Cleancord waits 2 s between deletions) are sped up, and labelled as such.
            label = (f",drawtext=fontfile={font}:text='{speed}x faster':x=w-tw-28:y=h-th-28:fontsize=26:fontcolor=white"
                     f":box=1:boxcolor=0x10b981@0.92:boxborderw=12")
        parts.append(f'[{src}:v]trim=start={a:.2f}:end={b:.2f},setpts=(PTS-STARTPTS)/{speed}{label}[s{i}]')
    concat = ''.join(f'[s{i}]' for i in range(len(segments)))
    fc = ';'.join(parts) + f';{concat}concat=n={len(segments)}:v=1:a=0,tpad=stop_mode=clone:stop_duration={hold},fps={fps},' \
        f'scale={width}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=160:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle'
    cmd = ['ffmpeg', '-y', '-loglevel', 'error']
    for v in inputs:
        cmd += ['-i', str(v)]
    cmd += ['-filter_complex', fc, str(out)]
    subprocess.run(cmd, check=True)
    print(f'  → {out.name} ({out.stat().st_size / 1e6:.1f} MB)')


class Scene:
    def __init__(self, p, theme='dark', settings=None):
        self.tmp = tempfile.mkdtemp()
        self.vdir = os.path.join(self.tmp, 'video')
        self.ctx = p.chromium.launch_persistent_context(
            os.path.join(self.tmp, 'profile'), executable_path=CHROME, channel=None if CHROME else 'chromium', headless=True,
            args=[f'--disable-extensions-except={EXT}', f'--load-extension={EXT}', '--no-sandbox', '--no-proxy-server', '--hide-scrollbars'],
            viewport={'width': W, 'height': H}, record_video_dir=self.vdir, record_video_size={'width': W, 'height': H},
            accept_downloads=True, device_scale_factor=1,
        )
        self.ctx.route(re.compile(r'https://([^/]*\.)?discordapp\.(com|net)/.*'), self._cdn)
        sw = self.ctx.service_workers[0] if self.ctx.service_workers else self.ctx.wait_for_event('serviceworker', timeout=15000)
        self.ext_id = sw.url.split('/')[2]
        sw.evaluate("chrome.storage.session.set({capturedAuth: {token: 'demo-session', headers: {}, at: Date.now()}})")
        sw.evaluate(f"chrome.storage.local.set({{settings: {json.dumps({'theme': theme, 'settingsVersion': 2, **(settings or {})})}, showLauncher: true}})")
        self.ctx.add_init_script(INIT)
        self.pages = []
        self.marks = []
        self.pos = (W / 2, H / 2)

    def _cdn(self, route):
        from urllib.parse import urlparse
        u = urlparse(route.request.url)
        route.fulfill(status=200, body=art.cdn_bytes(u.path), headers={'content-type': 'image/png', 'cache-control': 'max-age=3600'})

    def new_page(self, url=None):
        page = self.ctx.new_page()
        rec = {'page': page, 't0': time.monotonic(), 'start': 0.0, 'fast': []}
        self.pages.append(rec)
        self.page, self.rec = page, rec
        if url:
            page.goto(url)
        return page

    def open_app(self):
        page = self.new_page(f'chrome-extension://{self.ext_id}/app.html')
        page.wait_for_selector('#account .dot.ok', timeout=15000)
        page.wait_for_selector('.rail-item[title="Cozy Pixel Club"]', timeout=15000)
        time.sleep(0.8)
        self.rec['start'] = self.now()
        return page

    def now(self):
        return time.monotonic() - self.rec['t0']

    @contextmanager
    def fast(self, speed=8):
        a = self.now()
        yield
        self.rec['fast'].append((a, self.now(), speed))

    # ---- human-like input ----
    def move(self, target, duration=None):
        page = self.page
        if isinstance(target, tuple):
            x, y = target
        else:
            loc = page.locator(target).first if isinstance(target, str) else target
            loc.scroll_into_view_if_needed()
            b = loc.bounding_box()
            x, y = b['x'] + b['width'] / 2, b['y'] + b['height'] / 2
        x0, y0 = self.pos
        dist = math.hypot(x - x0, y - y0)
        duration = duration if duration is not None else min(0.9, 0.25 + dist / 1400)
        steps = max(6, int(duration * 60))
        for i in range(1, steps + 1):
            t = i / steps
            e = t * t * (3 - 2 * t)
            page.mouse.move(x0 + (x - x0) * e, y0 + (y - y0) * e)
            time.sleep(duration / steps)
        self.pos = (x, y)

    def click(self, target, pause=0.45):
        self.move(target)
        time.sleep(0.12)
        self.page.mouse.down()
        time.sleep(0.06)
        self.page.mouse.up()
        time.sleep(pause)

    def type(self, text, delay=0.07):
        self.page.keyboard.type(text, delay=delay * 1000)

    def hide_cursor(self):
        self.page.evaluate("document.getElementById('__demo_cursor') && (document.getElementById('__demo_cursor').style.display = 'none')")

    def shot(self, name, clip=None):
        self.hide_cursor()
        self.page.screenshot(path=str(OUT / name), clip=clip)
        self.page.evaluate("document.getElementById('__demo_cursor') && (document.getElementById('__demo_cursor').style.display = '')")
        print(f'  → {name}')

    def finish(self, out_name, width=900, fps=10):
        ends = [r_end for r_end in [self.now()]]
        recs = self.pages
        for r in recs:
            r['end'] = time.monotonic() - r['t0']
        self.ctx.close()
        inputs, segments = [], []
        for idx, r in enumerate(recs):
            if r.get('skip'):
                continue
            inputs.append(r['page'].video.path())
            i = len(inputs) - 1
            cur = r['start']
            for (a, b, speed) in sorted(r['fast']):
                if a > cur:
                    segments.append((i, cur, a, 1))
                segments.append((i, a, b, speed))
                cur = b
            if r['end'] > cur:
                segments.append((i, cur, r['end'], 1))
        if out_name:
            gif(inputs, segments, OUT / out_name, width=width, fps=fps)
        shutil.rmtree(self.tmp, ignore_errors=True)
        del ends


# ------------------------------------------------------------------ scenes
G = '330000000000000005'  # #general
ART_CH = '330000000000000006'
OFF = '330000000000000007'
MIRA_DM = '350000000000000001'


def scene_overview(p):
    s = Scene(p)
    s.open_app()
    s.click('.rail-item[title="Cozy Pixel Club"]', pause=0.7)
    s.click(f'.row[data-open="{G}"]', pause=1.4)
    s.move('#feed .msg:has-text("Game night tonight") .embed', duration=0.6)
    time.sleep(0.6)
    s.click(f'.row[data-open="{ART_CH}"]', pause=1.0)
    s.click(f'.row[data-open="{ART_CH}"] .thread-toggle', pause=1.0)
    s.click('.row[data-open="340000000000000001"]', pause=1.3)
    s.click('.rail-item[title="Direct messages"]', pause=0.6)
    s.click(f'.row[data-open="{MIRA_DM}"]', pause=1.4)
    s.finish('demo-browse.gif')


def scene_search(p):
    s = Scene(p)
    s.open_app()
    s.click('.rail-item[title="Cozy Pixel Club"]', pause=0.5)
    s.click(f'.row[data-open="{G}"]', pause=0.9)
    s.click('.conv-actions button:has-text("Search")', pause=0.5)
    s.click('.modal input[placeholder="words or phrase"]', pause=0.2)
    s.type('pizza')
    s.click('.modal .radio:has-text("Whole server")', pause=0.3)
    s.click('.modal .radio:has-text("Me")', pause=0.4)
    time.sleep(0.3)
    s.click('.modal-foot button:has-text("Search")', pause=0.2)
    s.page.wait_for_selector('#feed .msg', timeout=20000)
    time.sleep(1.6)
    s.click('.conv-actions button:has-text("Filter")', pause=0.5)
    s.click('.chip-btn:has-text("Replies")', pause=1.4)
    s.click('.chip-btn:has-text("Replies")', pause=0.8)
    s.finish('demo-search.gif')


def scene_purge(p):
    s = Scene(p)
    s.open_app()
    s.click('.rail-item[title="Cozy Pixel Club"]', pause=0.5)
    s.click(f'.row[data-open="{OFF}"]', pause=1.0)
    s.click('.conv-actions button:has-text("Purge")', pause=0.8)
    s.shot('screenshot-purge.png')
    s.move('.modal .radio:has-text("Mine")')
    time.sleep(0.5)
    s.click('.modal-foot button:has-text("Start purge")', pause=0.8)
    s.click('.modal-foot button:has-text("Yes, purge")', pause=0.5)
    with s.fast(10):
        for _ in range(240):
            if s.page.evaluate("!!document.querySelector('#job-card.idle')") and s.page.evaluate(
                    f"!window.__mock.msgs['{OFF}'].some(m => m.author.id === '310000000000000001')"):
                break
            time.sleep(0.5)
    time.sleep(1.5)
    s.finish('demo-purge.gif')


def scene_edit(p):
    s = Scene(p)
    s.open_app()
    s.click('.rail-item[title="Direct messages"]', pause=0.4)
    s.click(f'.row[data-open="{MIRA_DM}"]', pause=1.0)
    s.click('.conv-actions button:has-text("Filter")', pause=0.4)
    s.click('#filterbar input[placeholder^="Message contains"]', pause=0.2)
    s.type('teh')
    time.sleep(0.8)
    s.click('button:has-text("Select all shown")', pause=0.6)
    s.click('#selbar button:has-text("Edit")', pause=0.6)
    s.click('.modal label.field:has(.field-label:text-is("Find")) input', pause=0.2)
    s.type('teh')
    s.click('.modal label.field:has(.field-label:text-is("Replace with")) input', pause=0.2)
    s.type('the')
    time.sleep(1.4)
    s.shot('screenshot-edit.png')
    s.click('.modal-foot button:has-text("Apply edits")', pause=0.3)
    with s.fast(8):
        for _ in range(120):
            if s.page.evaluate(f"!window.__mock.msgs['{MIRA_DM}'].some(m => / teh /.test(' ' + m.content + ' '))") and s.page.evaluate("!!document.querySelector('#job-card.idle')"):
                break
            time.sleep(0.4)
    s.click('#filterbar button:has-text("Reset")', pause=1.6)
    s.finish('demo-edit.gif')


def scene_export(p):
    s = Scene(p)
    s.open_app()
    s.click('.rail-item[title="Cozy Pixel Club"]', pause=0.5)
    s.click(f'.row[data-open="{G}"]', pause=1.0)
    s.click('.conv-actions button:has-text("Export")', pause=0.8)
    s.move('.modal select >> nth=0')
    s.page.select_option('.modal select >> nth=0', label='Full archive: HTML + all media')
    time.sleep(0.8)
    s.click('.modal .radio:has-text("Download a .zip")', pause=0.6)
    with s.page.expect_download(timeout=120000) as dl:
        s.click('.modal-foot button:has-text("Start export")', pause=0.2)
        with s.fast(6):
            time.sleep(0.1)
    path = dl.value.path()
    time.sleep(1.2)
    out = tempfile.mkdtemp()
    zipfile.ZipFile(path).extractall(out)
    pages = [h for h in pathlib.Path(out).rglob('*.html') if 'threads' not in h.parts and h.name != 'index.html' and h.name.startswith('general')]
    target = sorted(pages, key=lambda h: (len(h.name), h.name))[-1]
    v = s.new_page()
    s.pos = (W / 2, H / 2)
    v.goto(target.as_uri())
    time.sleep(0.6)
    v.evaluate("document.querySelectorAll('img[loading=lazy]').forEach(i => i.loading = 'eager')")
    v.evaluate("window.scrollTo(0, document.body.scrollHeight)")
    time.sleep(0.8)
    s.rec['start'] = s.now()
    s.shot('screenshot-export-html.png')
    for _ in range(26):
        v.mouse.wheel(0, -60)
        time.sleep(0.07)
    time.sleep(1.2)
    s.finish('demo-export.gif')
    shutil.rmtree(out, ignore_errors=True)


def package_zip(path):
    """A fictional Discord data package for the demo account."""
    me = {'id': '310000000000000001', 'username': 'alex.codes', 'global_name': 'Alex', 'discriminator': 0, 'avatar_hash': 'av01'}
    with zipfile.ZipFile(path, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('Account/user.json', json.dumps(me))
        z.writestr('Messages/index.json', json.dumps({
            '350000000000000001': 'Direct Message with mira.pix', '330000000000000007': 'off-topic in Cozy Pixel Club',
            '390000000000000001': 'speedruns in Old Speedrun Server', '350000000000000003': 'Weekend trip 🏕️',
        }))
        z.writestr('Servers/index.json', json.dumps({'320000000000000001': 'Cozy Pixel Club', '390000000000000000': 'Old Speedrun Server'}))
        chans = [
            ('350000000000000001', {'type': 'DM', 'recipients': ['310000000000000001', '310000000000000002']}),
            ('350000000000000003', {'type': 'GROUP_DM', 'name': 'Weekend trip 🏕️'}),
            ('330000000000000007', {'type': 0, 'name': 'off-topic', 'guild': {'id': '320000000000000001', 'name': 'Cozy Pixel Club'}}),
            ('390000000000000001', {'type': 0, 'name': 'speedruns', 'guild': {'id': '390000000000000000', 'name': 'Old Speedrun Server'}}),
        ]
        for cid, info in chans:
            z.writestr(f'Messages/c{cid}/channel.json', json.dumps({'id': cid, **info}))
    return path


def scene_package(p):
    s = Scene(p)
    page = s.open_app()
    # The package lists the demo account's real (fake) message IDs so "Fetch details" can match them.
    mine = page.evaluate("""(() => { const out = {}; for (const [cid, list] of Object.entries(window.__mock.msgs)) {
        out[cid] = list.filter(m => m.author.id === '310000000000000001' && (m.type === 0 || m.type === 19)).map(m => ({ID: m.id, Timestamp: m.timestamp.replace('T', ' ').slice(0, 19), Contents: m.content, Attachments: ''})); } return out; })()""")
    tmp = tempfile.mkdtemp()
    path = package_zip(os.path.join(tmp, 'package.zip'))
    with zipfile.ZipFile(path, 'a') as z:
        for cid in ('350000000000000001', '350000000000000003', '330000000000000007'):
            body = re.sub(r'"ID": "(\d+)"', r'"ID": \1', json.dumps(mine.get(cid, [])))
            z.writestr(f'Messages/c{cid}/messages.json', body)
        old = [{'ID': 1100000000000000000 + i * 4194304 * 1000 * 60 * 60 * 24, 'Timestamp': f'2023-0{1 + i % 8}-1{i % 9} 20:0{i % 9}:00', 'Contents': t, 'Attachments': ''}
               for i, t in enumerate(['new PB on level 3!', 'route notes are in the doc', 'gg', 'anyone racing tonight?', 'that skip is insane'])]
        z.writestr('Messages/c390000000000000001/messages.json', json.dumps(old))
    s.click('.tab[data-tab=package]', pause=0.8)
    with page.expect_file_chooser() as fc:
        s.click('button:has-text("Open package ZIP")', pause=0.1)
    fc.value.set_files(path)
    page.wait_for_selector('#side-body .row[data-open="pkg:390000000000000001"]', timeout=15000)
    time.sleep(1.0)
    s.click('#side-body .row[data-open="pkg:390000000000000001"]', pause=1.2)
    s.click('#side-body .row[data-open="pkg:350000000000000001"]', pause=1.0)
    s.click('.conv-actions button:has-text("Fetch details")', pause=0.3)
    with s.fast(6):
        for _ in range(60):
            if page.evaluate("!!document.querySelector('#job-card.idle')"):
                break
            time.sleep(0.3)
    time.sleep(1.4)
    s.shot('screenshot-package.png')
    s.finish('demo-package.gif')
    shutil.rmtree(tmp, ignore_errors=True)


def scene_stills(p):
    for theme, channel, name, anchor in (('dark', G, 'screenshot-feed.png', 'forest_tileset.png'), ('light', ART_CH, 'screenshot-light.png', None)):
        s = Scene(p, theme=theme)
        s.open_app()
        s.click('.rail-item[title="Cozy Pixel Club"]', pause=0.5)
        s.click(f'.row[data-open="{channel}"]', pause=2.0)
        if anchor:
            s.page.evaluate(f"""(() => {{ const el = [...document.querySelectorAll('#feed .msg')].find((e) => e.querySelector('img[alt="{anchor}"]'));
              const w = document.querySelector('.feed-wrap'); el.scrollIntoView({{ block: 'start' }}); w.scrollTop -= 40; }})()""")
            time.sleep(0.6)
        s.shot(name)
        s.finish(None)


def banner(p):
    """1280x640 banner (also the right size for GitHub's social preview)."""
    shot = (OUT / 'screenshot-feed.png').as_uri()
    logo = (OUT / 'logo.png').as_uri()
    html = f"""<!DOCTYPE html><html><head><meta charset="utf-8"><style>
    body {{ margin:0; width:1280px; height:640px; overflow:hidden; font-family:'Inter','Segoe UI',sans-serif;
      background: radial-gradient(1200px 600px at 0% 0%, #0f3d36 0%, #101418 55%, #0b0d10 100%); color:#fff; }}
    .wrap {{ display:flex; align-items:center; height:100%; padding: 0 0 0 72px; gap: 40px; }}
    .left {{ width: 470px; flex:none; }}
    .brand {{ display:flex; align-items:center; gap:18px; }}
    .brand img {{ width:84px; height:84px; border-radius:20px; box-shadow: 0 10px 30px rgba(16,185,129,.35); }}
    h1 {{ font-size:64px; margin:0; letter-spacing:-1.5px; font-weight:800; }}
    p {{ font-size:25px; line-height:1.4; color:#c9d4dc; margin:26px 0 30px; font-weight:500; }}
    .pills {{ display:flex; flex-wrap:wrap; gap:10px; }}
    .pill {{ font-size:16px; padding:8px 14px; border-radius:999px; background:rgba(255,255,255,.07); border:1px solid rgba(255,255,255,.14); color:#e6eef3; font-weight:600; }}
    .pill b {{ color:#34d399; }}
    .shot {{ flex:none; width: 860px; border-radius:14px; overflow:hidden; box-shadow: 0 30px 80px rgba(0,0,0,.6), 0 0 0 1px rgba(255,255,255,.08);
      transform: perspective(1600px) rotateY(-9deg) rotateX(2deg); transform-origin: left center; }}
    .bar {{ height:30px; background:#1b1e23; display:flex; align-items:center; gap:7px; padding-left:14px; }}
    .bar i {{ width:11px; height:11px; border-radius:50%; background:#3a3f47; display:block; }}
    .shot img {{ display:block; width:100%; }}
    </style></head><body><div class="wrap"><div class="left">
      <div class="brand"><img src="{logo}"><h1>Cleancord</h1></div>
      <p>Search, export and clean up your Discord messages. Privately, right in your browser.</p>
      <div class="pills"><span class="pill"><b>✓</b> Bulk delete & purge</span><span class="pill"><b>✓</b> HTML / JSON / CSV export</span>
      <span class="pill"><b>✓</b> No servers, no tracking</span><span class="pill"><b>✓</b> Open source</span></div>
    </div><div class="shot"><div class="bar"><i></i><i></i><i></i></div><img src="{shot}"></div></div></body></html>"""
    tmp = tempfile.mkdtemp()
    f = pathlib.Path(tmp) / 'banner.html'
    f.write_text(html)
    b = p.chromium.launch(executable_path=CHROME, headless=True, args=['--no-sandbox'])
    pg = b.new_page(viewport={'width': 1280, 'height': 640})
    pg.goto(f.as_uri())
    time.sleep(0.5)
    pg.screenshot(path=str(OUT / 'banner.png'))
    b.close()
    shutil.rmtree(tmp, ignore_errors=True)
    print('  → banner.png')


SCENES = {'stills': scene_stills, 'overview': scene_overview, 'search': scene_search, 'purge': scene_purge, 'edit': scene_edit,
          'export': scene_export, 'package': scene_package, 'banner': banner}

if __name__ == '__main__':
    wanted = sys.argv[1:] or list(SCENES)
    with sync_playwright() as p:
        for name in wanted:
            print(f'▶ {name}')
            SCENES[name](p)
