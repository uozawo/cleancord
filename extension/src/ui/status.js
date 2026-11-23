// Top bar (account, workspace, storage) and the right-hand status panel (current task + log).

import { app } from '../state.js';
import { S, saveSettings } from '../settings.js';
import { h, $, esc, avatarUrl, userName, humanBytes, fmtNum, copyText, fill } from '../util.js';
import { toast } from './dom.js';
import * as dialogs from './dialogs.js';

export function applyTheme() {
  const root = document.body;
  root.classList.remove('theme-dark', 'theme-light', 'theme-midnight');
  root.classList.add(`theme-${S.theme}`);
  root.classList.toggle('compact', S.density === 'compact');
  root.classList.toggle('focus', !!S.focusMode);
  const fb = $('#btn-focus');
  if (fb) fb.classList.toggle('on', !!S.focusMode);
}

export function mount() {
  const top = $('#topbar');
  fill(top, 
    h('div', { class: 'brand' }, h('img', { src: 'icons/icon32.png', alt: '' }), h('span', null, 'Cleancord')),
    h('button', { class: 'account', id: 'account', onclick: () => dialogs.showAccount() }),
    h('div', { class: 'ws', id: 'ws' }),
    h('div', { class: 'storage', id: 'storage', title: 'Browser storage used by Cleancord' }, h('div', { class: 'storage-bar' }, h('div', { class: 'storage-fill' })), h('span', { class: 'storage-text' })),
    h('div', { class: 'spacer' }),
    h('button', { class: 'btn ghost sm', onclick: () => dialogs.showAnalytics(), title: 'Mention counts and activity for the loaded messages' }, '📊 Analytics'),
    h('button', { class: 'btn ghost sm', id: 'btn-focus', title: 'Hide the side panels', onclick: () => saveSettings({ focusMode: !S.focusMode }) }, '⤢ Focus'),
    h('button', { class: 'btn ghost sm', onclick: () => dialogs.showSettings() }, '⚙ Settings'),
    h('button', { class: 'btn ghost sm', onclick: () => dialogs.showHelp() }, '? Help'),
  );
  const panel = $('#status');
  fill(panel, 
    h('div', { class: 'panel-title' }, 'Current task'),
    h('div', { id: 'job-card', class: 'job-card idle' }),
    h('div', { class: 'panel-title row' }, h('span', null, 'Activity log'),
      h('span', null,
        h('button', { class: 'link-btn', onclick: () => copyText(app.logLines.map((l) => `${new Date(l.t).toLocaleTimeString()} [${l.level}] ${l.msg}`).join('\n')).then(() => toast('Log copied')) }, 'Copy'),
        ' · ',
        h('button', { class: 'link-btn', onclick: () => { app.logLines = []; $('#log').replaceChildren(); } }, 'Clear'))),
    h('div', { id: 'log', class: 'log' }),
  );
  renderAccount();
  renderJob();
}

export function renderAccount(invalid = false) {
  const el = $('#account');
  if (!el) return;
  const me = app.me;
  if (me) {
    fill(el, h('img', { class: 'av', src: avatarUrl(me, 32), alt: '' }), h('span', null, userName(me)), h('span', { class: 'dot ok', title: app.authSource === 'manual' ? 'Using a pasted token' : 'Session picked up from your Discord tab' }));
  } else {
    fill(el, h('span', { class: 'dot ' + (invalid ? 'bad' : 'off') }), h('span', null, invalid ? 'Session expired' : 'Not connected'));
  }
}

export async function renderWorkspace() {
  const el = $('#ws');
  if (!el) return;
  fill(el, 
    h('span', { class: 'muted' }, 'Workspace'),
    h('button', { class: 'btn ghost sm', title: app.ws ? `Workspace: ${app.ws.name}` : '', onclick: () => dialogs.showWorkspaces() }, '🗂 ', h('span', { class: 'ws-name' }, app.ws ? app.ws.name : '…')),
  );
}

export async function updateStorage() {
  const el = $('#storage');
  if (!el || !navigator.storage || !navigator.storage.estimate) return;
  try {
    const { usage = 0, quota = 0 } = await navigator.storage.estimate();
    const pct = quota ? Math.min(100, (usage / quota) * 100) : 0;
    $('.storage-fill', el).style.width = `${Math.max(pct, 1)}%`;
    $('.storage-fill', el).classList.toggle('warn', pct > 85);
    $('.storage-text', el).textContent = humanBytes(usage);
    el.title = `Cleancord is using ${humanBytes(usage)} of ${humanBytes(quota)} available browser storage`;
  } catch { /* ignore */ }
}

let jobRaf = 0;
export function renderJob() {
  if (jobRaf) return;
  jobRaf = requestAnimationFrame(() => { jobRaf = 0; drawJob(); });
}

// The card is rebuilt only when another task starts or it is paused/resumed; progress ticks update
// it in place. Rebuilding on every tick swallowed clicks on Pause/Stop and restarted the bar animation.
let cardKey = '';
function drawJob() {
  const card = $('#job-card');
  if (!card) return;
  const job = app.jobs && app.jobs.current;
  const queued = app.jobs ? app.jobs.queue.length : 0;
  if (!job) {
    cardKey = '';
    card.className = 'job-card idle';
    fill(card, h('div', { class: 'muted' }, 'Nothing running.'), queued ? h('div', null, `${queued} queued`) : null);
    return;
  }
  const key = `${job.id}:${job.paused}`;
  if (key !== cardKey) {
    cardKey = key;
    fill(card,
      h('div', { class: 'job-title' }),
      h('div', { class: 'progress' }, h('div', { class: 'progress-fill' })),
      h('div', { class: 'job-label' }),
      h('div', { class: 'chips' }),
      h('div', { class: 'job-btns' },
        job.paused
          ? h('button', { class: 'btn sm primary', onclick: () => job.resume() }, '▶ Resume')
          : h('button', { class: 'btn sm', onclick: () => job.pause('by you') }, '⏸ Pause'),
        h('button', { class: 'btn sm danger', onclick: () => job.cancel() }, '■ Stop')),
      h('div', { class: 'muted job-queued' }));
  }
  const { done, total, label } = job.progress;
  const pct = total ? Math.min(100, (done / total) * 100) : null;
  card.className = `job-card ${job.status}`;
  $('.job-title', card).textContent = job.title;
  $('.progress', card).classList.toggle('indeterminate', pct === null);
  $('.progress-fill', card).style.width = pct === null ? '30%' : `${pct}%`;
  $('.job-label', card).textContent = `${job.paused ? `Paused${job.pauseReason ? ': ' + job.pauseReason : ''}` : label || ''}${total ? ` · ${fmtNum(done)} / ${fmtNum(total)}` : ''}`;
  const chips = $('.chips', card);
  fill(chips, Object.entries(job.stats || {}).filter(([, v]) => v).map(([k, v]) => h('span', { class: `chip stat-${k}` }, `${k} ${fmtNum(v)}`)));
  chips.hidden = !chips.childElementCount;
  const q = $('.job-queued', card);
  q.textContent = queued ? `${queued} more queued` : '';
  q.hidden = !queued;
}

export function appendLog(line) {
  const log = $('#log');
  if (!log) return;
  const el = h('div', { class: `log-line ${line.level}` }, h('span', { class: 'log-t' }, new Date(line.t).toLocaleTimeString()), h('span', null, line.msg));
  log.append(el);
  while (log.childElementCount > 500) log.firstChild.remove();
  if (log.scrollHeight - log.scrollTop - log.clientHeight < 80) log.scrollTop = log.scrollHeight;
}

export { esc };
