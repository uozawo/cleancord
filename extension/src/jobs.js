// Long-running tasks (load all, purge, bulk edit, export) with pause / resume / cancel and
// checkpoints saved to the workspace so they can be resumed after Cleancord is closed.

import { CancelledError } from './api.js';
import { StorageFullError } from './db.js';
import { uid } from './util.js';

export class Job {
  constructor({ id, type, title, params = {}, state = {}, stats = {}, resumable = false, ws }) {
    this.id = id || uid();
    this.type = type;
    this.title = title;
    this.params = params;
    this.state = state;
    this.stats = stats;
    this.resumable = resumable;
    this.ws = ws;
    this.status = 'queued';
    this.progress = { done: 0, total: 0, label: '' };
    this.cancelled = false;
    this.paused = false;
    this.pauseReason = '';
    this._resume = null;
    this._listeners = new Set();
    this.error = null;
    this._paramsSaved = false;
  }

  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  emit() { for (const fn of this._listeners) fn(this); }

  async gate() {
    if (this.cancelled) throw new CancelledError();
    while (this.paused) {
      await new Promise((r) => { this._resume = r; });
      if (this.cancelled) throw new CancelledError();
    }
  }
  pause(reason = '') {
    if (this.status !== 'running') return;
    this.paused = true;
    this.pauseReason = reason;
    this.status = 'paused';
    this.emit();
  }
  resume() {
    if (!this.paused) return;
    this.paused = false;
    this.pauseReason = '';
    this.status = 'running';
    const r = this._resume;
    this._resume = null;
    if (r) r();
    this.emit();
  }
  cancel() {
    this.cancelled = true;
    if (this.paused) { this.paused = false; const r = this._resume; this._resume = null; if (r) r(); }
    this.emit();
  }
  setProgress(done, total, label) {
    this.progress = { done, total: total ?? this.progress.total, label: label ?? this.progress.label };
    this.emit();
  }
  bump(stat, n = 1) {
    this.stats[stat] = (this.stats[stat] || 0) + n;
    this.emit();
  }
  async save() {
    if (!this.resumable || !this.ws) return;
    // Params don't change once a task runs; write them only on the first checkpoint (they can be large).
    await this.ws.putJob({
      id: this.id, type: this.type, title: this.title, params: this.params, state: this.state,
      stats: this.stats, progress: this.progress, savedAt: Date.now(),
    }, { withParams: !this._paramsSaved });
    this._paramsSaved = true;
  }
}

export class JobManager {
  constructor({ log }) {
    this.log = log;
    this.handlers = new Map();
    this.queue = [];
    this.current = null;
    this.history = [];
    this._listeners = new Set();
  }
  register(type, handler) { this.handlers.set(type, handler); }
  on(fn) { this._listeners.add(fn); return () => this._listeners.delete(fn); }
  emit() { for (const fn of this._listeners) fn(this); }

  // Returns a promise that settles when the job finishes.
  start(job) {
    return new Promise((resolve, reject) => {
      job.on(() => this.emit());
      this.queue.push({ job, resolve, reject });
      this.emit();
      this._next();
    });
  }

  async _next() {
    if (this.current || !this.queue.length) return;
    const { job, resolve, reject } = this.queue.shift();
    this.current = job;
    const handler = this.handlers.get(job.type);
    job.status = 'running';
    this.emit();
    this.log('info', `▶ ${job.title}`);
    try {
      if (!handler) throw new Error(`Unknown task type: ${job.type}`);
      for (;;) {
        try {
          await job.save(); // inside the retry loop so a full disk pauses the task here too
          const result = await handler(job);
          job.status = 'done';
          if (job.resumable && job.ws) await job.ws.deleteJob(job.id);
          this.log('ok', `✔ ${job.title} finished`);
          resolve(result);
          break;
        } catch (e) {
          if (e instanceof StorageFullError) {
            this.log('error', 'Browser storage is full. Free some space (delete saved conversations), then press Resume.');
            job.status = 'running';
            job.pause('Storage full');
            await job.gate();
            continue; // retry the handler from its last checkpoint
          }
          throw e;
        }
      }
    } catch (e) {
      if (e instanceof CancelledError) {
        job.status = 'cancelled';
        if (job.resumable && job.ws) await job.ws.deleteJob(job.id).catch(() => {});
        this.log('warn', `■ ${job.title} cancelled`);
        resolve(null);
      } else {
        job.status = 'error';
        job.error = e;
        this.log('error', `✖ ${job.title}: ${e.message}`);
        reject(e);
      }
    } finally {
      this.history.unshift(job);
      this.history = this.history.slice(0, 30);
      this.current = null;
      this.emit();
      this._next();
    }
  }

  cancelAll() {
    for (const q of this.queue) { q.job.status = 'cancelled'; q.resolve(null); }
    this.queue = [];
    if (this.current) this.current.cancel();
    this.emit();
  }
}
