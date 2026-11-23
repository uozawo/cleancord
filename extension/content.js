// Cleancord launcher: adds a small draggable button to discord.com that opens Cleancord for the
// conversation you're looking at. It does not read messages, tokens or anything else on the page.
(() => {
  if (window.__cleancordLauncher) return;
  window.__cleancordLauncher = true;

  let host = null;

  const ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true"><path fill="currentColor" d="M15.5 2.5a1.5 1.5 0 0 1 2.1 0l3.9 3.9a1.5 1.5 0 0 1 0 2.1l-7.2 7.2-6-6zM7.2 10.8l6 6-1.9 1.9a3 3 0 0 1-2.1.9H4.5L3 21.1a.9.9 0 0 1-1.3-1.3L3.2 18.3v-4.7a3 3 0 0 1 .9-2.1z"/></svg>';

  function mount(pos) {
    if (host) return;
    host = document.createElement('div');
    host.id = 'cleancord-launcher';
    const root = host.attachShadow({ mode: 'closed' });
    root.innerHTML = `
      <style>
        :host { all: initial; }
        button {
          position: fixed; right: 18px; z-index: 2147483000;
          width: 38px; height: 38px; border-radius: 50%; border: 0; cursor: pointer;
          background: #5865f2; color: #fff; display: grid; place-items: center;
          box-shadow: 0 4px 14px rgba(0,0,0,.35); opacity: .78; transition: opacity .15s, transform .15s;
          touch-action: none;
        }
        button:hover { opacity: 1; transform: scale(1.06); }
        button.drag { cursor: grabbing; transition: none; }
      </style>
      <button type="button" title="Open Cleancord for this conversation (drag to move)">${ICON}</button>`;
    const btn = root.querySelector('button');
    btn.style.top = `${Math.min(Math.max(pos ?? window.innerHeight - 150, 40), window.innerHeight - 50)}px`;

    let startY = 0, startTop = 0, moved = false;
    btn.addEventListener('pointerdown', (e) => {
      startY = e.clientY; startTop = parseFloat(btn.style.top); moved = false;
      btn.setPointerCapture(e.pointerId);
    });
    btn.addEventListener('pointermove', (e) => {
      if (!btn.hasPointerCapture(e.pointerId)) return;
      const dy = e.clientY - startY;
      if (Math.abs(dy) > 4) { moved = true; btn.classList.add('drag'); }
      if (moved) btn.style.top = `${Math.min(Math.max(startTop + dy, 8), window.innerHeight - 46)}px`;
    });
    btn.addEventListener('pointerup', (e) => {
      btn.releasePointerCapture(e.pointerId);
      btn.classList.remove('drag');
      if (moved) chrome.storage.local.set({ launcherTop: parseFloat(btn.style.top) });
      else chrome.runtime.sendMessage({ type: 'cleancord:open' });
    });
    document.documentElement.appendChild(host);
  }

  function unmount() {
    if (host) host.remove();
    host = null;
  }

  chrome.storage.local.get({ showLauncher: true, launcherTop: null }, (v) => {
    if (v.showLauncher) mount(v.launcherTop);
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.showLauncher) return;
    if (changes.showLauncher.newValue) chrome.storage.local.get({ launcherTop: null }, (v) => mount(v.launcherTop));
    else unmount();
  });
})();
