// Cleancord background service worker.
//
// What this file does, and nothing else:
//  1. Watches the requests YOUR open Discord tab already makes to discord.com/api and copies the
//     Authorization header into chrome.storage.session (held in memory, wiped when the browser closes,
//     unreadable by web pages or content scripts). It never sends it anywhere.
//  2. Opens the Cleancord page when you click the toolbar icon or the launcher button on discord.com.
//
// This worker makes no network requests at all.

const API_URLS = [
  'https://discord.com/api/*',
  'https://ptb.discord.com/api/*',
  'https://canary.discord.com/api/*',
];
// Extra headers the Discord client sends; replaying them makes Cleancord's requests look like the normal client.
const FORWARD_HEADERS = ['x-super-properties', 'x-discord-locale', 'x-discord-timezone'];
const DISCORD_ORIGIN = /^https:\/\/((ptb|canary)\.)?discord\.com$/;

let lastToken = null;
let lastWrite = 0;

chrome.storage.session.setAccessLevel?.({ accessLevel: 'TRUSTED_CONTEXTS' }).catch(() => {});

chrome.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    // Only requests made by the Discord web app itself (not by this extension or other sites).
    if (!details.initiator || !DISCORD_ORIGIN.test(details.initiator)) return;
    let token = null;
    const headers = {};
    for (const h of details.requestHeaders || []) {
      const name = h.name.toLowerCase();
      if (name === 'authorization') token = h.value;
      else if (FORWARD_HEADERS.includes(name)) headers[name] = h.value;
    }
    if (!token || token.startsWith('Bot ')) return;
    const now = Date.now();
    if (token === lastToken && now - lastWrite < 60_000) return;
    lastToken = token;
    lastWrite = now;
    chrome.storage.session.set({ capturedAuth: { token, headers, at: now } });
  },
  { urls: API_URLS, types: ['xmlhttprequest'] },
  ['requestHeaders', 'extraHeaders'],
);

function parseDiscordUrl(url) {
  if (!url) return null;
  const m = /^https:\/\/((ptb|canary)\.)?discord\.com\/channels\/(@me|\d+)(?:\/(\d+))?(?:\/(\d+))?/.exec(url);
  if (!m) return null;
  return { guild: m[3], channel: m[4] || '', message: m[5] || '' };
}

async function openApp(fromUrl) {
  const base = chrome.runtime.getURL('app.html');
  const t = parseDiscordUrl(fromUrl);
  const hash = t ? `#open=${t.guild}/${t.channel}${t.message ? '/' + t.message : ''}` : '';
  try {
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['TAB'] });
    const existing = contexts.find((c) => c.documentUrl && c.documentUrl.startsWith(base) && c.tabId >= 0);
    if (existing) {
      await chrome.tabs.update(existing.tabId, hash ? { active: true, url: base + hash } : { active: true });
      if (existing.windowId >= 0) await chrome.windows.update(existing.windowId, { focused: true });
      return;
    }
  } catch (_) { /* fall through and open a new tab */ }
  await chrome.tabs.create({ url: base + hash });
}

chrome.action.onClicked.addListener((tab) => openApp(tab && tab.url));

chrome.runtime.onMessage.addListener((msg, sender) => {
  if (msg && msg.type === 'cleancord:open' && sender.tab) openApp(sender.tab.url);
});
