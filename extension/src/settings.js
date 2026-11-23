// User settings, saved in chrome.storage.local (this browser profile only).

export const DEFAULT_SETTINGS = {
  theme: 'dark',            // dark | light | midnight
  density: 'cozy',          // cozy | compact
  focusMode: false,
  dateFormat: 'locale',     // locale | iso | mdy | dmy | ymd
  timeFormat: '24h',        // 24h | 12h
  timezone: 'local',        // local | utc
  modifyDelay: 2,           // seconds between delete/edit/reaction requests
  searchDelay: 1.5,         // seconds between search requests
  delaySpread: 0.6,         // random +/- seconds added to delays
  lookupMembers: true,      // fetch server nicknames + role colors
  memberCacheHours: 24,
  pageSize: 100,            // messages per feed page
  sortOrder: 'asc',         // asc (oldest first, like Discord) | desc
  hideSystem: false,
  showLauncher: true,       // button on discord.com
  finalPassCount: 100,      // newest messages re-checked after a search purge
  confirmDestructive: true,
  settingsVersion: 2,
};

export const S = { ...DEFAULT_SETTINGS };
const listeners = new Set();

export async function loadSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  Object.assign(S, DEFAULT_SETTINGS, settings || {});
  // Older versions defaulted to 1.2 s between changes. Move people still on that old default to 2 s;
  // anyone who picked a different value keeps it.
  if (settings && !settings.settingsVersion) {
    if (settings.modifyDelay === 1.2) S.modifyDelay = DEFAULT_SETTINGS.modifyDelay;
    S.settingsVersion = 2;
    await chrome.storage.local.set({ settings: { ...S } });
  }
  return S;
}

export async function saveSettings(patch) {
  Object.assign(S, patch);
  await chrome.storage.local.set({ settings: { ...S }, showLauncher: !!S.showLauncher });
  for (const fn of listeners) fn(S, patch);
}

export function onSettings(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}
