/**
 * Job queue.
 *
 * Everything long-running in vu-movie (scraping a page in Chromium, probing a
 * dozen candidate URLs, transcoding, downloading, pushing a bouquet) is a job.
 * The UI shows them on the dashboard, and they are what makes "backtracking"
 * possible when something fails: every job keeps a timestamped log.
 *
 * Two properties matter on a DS918+:
 *   • concurrency is limited (default: 1 transcode, 1 download, 3 light jobs) so
 *     the NAS never thrashes;
 *   • jobs are cancellable — a stuck Chromium page or ffmpeg process must never
 *     block the UI, so cancelling also kills the child process.
 */
import crypto from 'node:crypto';
import EventEmitter from 'node:events';
import { log } from './log.js';
import { getConfig } from './config.js';

export const jobEvents = new EventEmitter();
jobEvents.setMaxListeners(200);

const MAX_JOBS = 200;

/** Every queue registers itself here, so the API can search/cancel across all of them. */
const queues = [];

export class JobQueue {
  /**
   * @param {{name:string, concurrency?:number, historyLimit?:number}} opts
   */
  constructor({ name, concurrency = 2, historyLimit = MAX_JOBS }) {
    this.name = name;
    this.concurrency = Math.max(1, concurrency);
    this.historyLimit = historyLimit;
    this.jobs = new Map();
    this.queue = [];
    this.running = 0;
    this.counter = 0;
    this.createdAt = new Date().toISOString();
    queues.push(this);
  }

  /**
   * Create a job and schedule it.
   *
   * @param {{type:string,title:string,meta?:object}} spec
   * @param {(job:object, ctx:object) => Promise<any>} fn
   * @returns {object} the job record (raw — use .id or this.public(job))
   */
  submit(spec, fn) {
    return this.add(spec, fn);
  }

  add(spec, fn) {
    const job = {
      id: `${this.name}-${Date.now().toString(36)}-${(this.counter += 1).toString(36)}`,
      queue: this.name,
      type: spec.type || 'task',
      title: spec.title || spec.type || 'task',
      meta: spec.meta || {},
      status: 'queued',
      progress: 0,
      message: 'queued',
      error: null,
      result: null,
      logs: [],
      createdAt: new Date().toISOString(),
      startedAt: null,
      finishedAt: null,
      cancelRequested: false,
      handle: null,
      _abort: new AbortController(),
    };

    this.jobs.set(job.id, job);
    this.#trim();

    const ctx = {
      signal: job._abort.signal,
      progress: (pct, message) => this.update(job, { progress: pct, message }),
      message: (message) => this.update(job, { message }),
      log: (message, data) => this.note(job, message, data),
      note: (message, data) => this.note(job, message, data),
      setHandle: (handle) => { job.handle = handle; if (job.cancelRequested) killHandle(handle); return handle; },
      isCancelled: () => job.cancelRequested,
      cancelled: () => job.cancelRequested,
      job,
    };

    this.queue.push({ job, fn, ctx });
    this.#notify(job, 'created');
    setImmediate(() => this.#pump());
    return job;
  }

  #pump() {
    while (this.running < this.concurrency && this.queue.length) {
      const item = this.queue.shift();
      this.running += 1;
      this.#run(item).finally(() => {
        this.running -= 1;
        setImmediate(() => this.#pump());
      });
    }
  }

  async #run({ job, fn, ctx }) {
    if (job.cancelRequested) {
      this.update(job, { status: 'cancelled', message: 'cancelled before it started', finishedAt: new Date().toISOString() });
      return;
    }
    job.status = 'running';
    job.startedAt = new Date().toISOString();
    job.message = 'running';
    this.#notify(job, 'started');
    log.info(job.type, `job started: ${job.title}`, { jobId: job.id, queue: this.name });
    const t0 = Date.now();
    try {
      const result = await fn(job, ctx);
      if (job.cancelRequested) {
        this.update(job, { status: 'cancelled', message: 'cancelled', result: result ?? null, finishedAt: new Date().toISOString() });
        log.warn(job.type, `job cancelled after ${Date.now() - t0} ms: ${job.title}`, { jobId: job.id });
      } else {
        this.update(job, {
          status: 'done', progress: 100, message: 'done', result: result ?? null,
          finishedAt: new Date().toISOString(),
        });
        log.info(job.type, `job done in ${((Date.now() - t0) / 1000).toFixed(1)} s: ${job.title}`, { jobId: job.id });
      }
    } catch (err) {
      const message = err?.message || String(err);
      if (job.cancelRequested || err?.name === 'AbortError') {
        this.update(job, { status: 'cancelled', message: 'cancelled', finishedAt: new Date().toISOString() });
        log.warn(job.type, `job aborted: ${job.title}`, { jobId: job.id, error: message });
      } else {
        this.update(job, { status: 'failed', error: message, message: `failed: ${message}`, finishedAt: new Date().toISOString() });
        log.error(job.type, `job failed: ${job.title} — ${message}`, { jobId: job.id, stack: err?.stack });
      }
    } finally {
      job.handle = null;
    }
  }

  update(job, patch) {
    Object.assign(job, patch);
    this.#notify(job, 'update');
    return job;
  }

  note(job, message, data) {
    const entry = { at: new Date().toISOString(), message, data: data || null };
    job.logs.push(entry);
    if (job.logs.length > 200) job.logs.shift();
    job.message = message;
    this.#notify(job, 'log');
    return entry;
  }

  /** Cancel a job. Returns {ok, id, status|error}. */
  cancel(id) {
    const job = this.jobs.get(id);
    if (!job) return { ok: false, error: `job ${id} not found in the ${this.name} queue` };
    if (['done', 'failed', 'cancelled'].includes(job.status)) {
      return { ok: false, error: `job already ${job.status}`, status: job.status, id };
    }
    job.cancelRequested = true;
    try { job._abort.abort(); } catch { /* already aborted */ }
    killHandle(job.handle);

    const idx = this.queue.findIndex((q) => q.job.id === job.id);
    if (idx >= 0) {
      this.queue.splice(idx, 1);
      this.update(job, { status: 'cancelled', message: 'cancelled', finishedAt: new Date().toISOString() });
      return { ok: true, id, status: 'cancelled' };
    }
    this.update(job, { message: 'cancelling…' });
    log.warn(job.type, `cancel requested: ${job.title}`, { jobId: job.id });
    return { ok: true, id, status: 'cancelling' };
  }

  /** Public (JSON-safe) view of one job. */
  get(id) {
    const job = this.jobs.get(id);
    return job ? this.public(job) : null;
  }

  /** Internal record — do not hand this to JSON.stringify (it holds an AbortController). */
  raw(id) {
    return this.jobs.get(id) || null;
  }

  list({ limit = 50, status } = {}) {
    let all = [...this.jobs.values()].sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
    if (status) all = all.filter((j) => j.status === status);
    return all.slice(0, limit).map((j) => this.public(j));
  }

  stats() {
    const out = { name: this.name, concurrency: this.concurrency, queued: this.queue.length, running: this.running, total: this.jobs.size };
    for (const job of this.jobs.values()) out[job.status] = (out[job.status] || 0) + 1;
    return out;
  }

  /** Serialisable view (no AbortController, bounded log tail). */
  public(job) {
    return {
      id: job.id, queue: job.queue, type: job.type, title: job.title, status: job.status,
      progress: job.progress, message: job.message, error: job.error,
      createdAt: job.createdAt, startedAt: job.startedAt, finishedAt: job.finishedAt,
      meta: job.meta, result: job.result,
      logs: job.logs.slice(-25),
      cancellable: !['done', 'failed', 'cancelled'].includes(job.status),
    };
  }

  #trim() {
    if (this.jobs.size <= this.historyLimit) return;
    const finished = [...this.jobs.values()]
      .filter((j) => ['done', 'failed', 'cancelled'].includes(j.status))
      .sort((a, b) => String(a.finishedAt).localeCompare(String(b.finishedAt)));
    while (this.jobs.size > this.historyLimit && finished.length) this.jobs.delete(finished.shift().id);
  }

  #notify(job, event) {
    jobEvents.emit('job', { event, job: this.public(job) });
  }
}

function killHandle(handle) {
  if (!handle) return;
  try {
    if (typeof handle.kill === 'function') {
      log.debug('jobs', `killing child process (pid ${handle.pid ?? '?'}) for a cancelled job`);
      handle.kill('SIGTERM');
      setTimeout(() => { try { handle.kill('SIGKILL'); } catch { /* gone */ } }, 5000).unref?.();
    }
  } catch (err) {
    log.warn('jobs', `could not kill the child process: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Shared queues
// ---------------------------------------------------------------------------
/** Scraping / probing / bouquet pushes: network bound, a few in parallel is fine. */
export const jobs = new JobQueue({ name: 'job', concurrency: 3 });

/**
 * Transcoding: exactly `transcode.maxConcurrent` (default 1) — the J3455 can
 * only encode one 1080p H.264 stream in real time. The live relay runs its own
 * ffmpeg per stream (outside this queue) so playback is never blocked behind a
 * download; this queue exists for explicit transcode/download jobs.
 */
export function transcodeConcurrency() {
  return Math.max(1, Number(getConfig().transcode.maxConcurrent) || 1);
}
export const transcodeQueue = new JobQueue({ name: 'transcode', concurrency: transcodeConcurrency() });

export function allQueues() {
  return [...queues];
}

export function cancelJob(id) {
  for (const q of queues) {
    const res = q.cancel(id);
    if (res.ok) return res;
    if (res.status) return res; // found but already finished
  }
  return { ok: false, error: `job ${id} not found` };
}

export function findJob(id) {
  for (const q of queues) {
    const job = q.get(id);
    if (job) return job;
  }
  return null;
}

export function listAllJobs(limit = 50) {
  const all = [];
  for (const q of queues) all.push(...q.list({ limit }));
  return all
    .sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
    .slice(0, limit);
}

export function jobStats() {
  const out = {};
  for (const q of queues) out[q.name] = q.stats();
  return out;
}

/** Random URL-safe id used for stream tokens and similar. */
export function shortId(bytes = 6) {
  return crypto.randomBytes(bytes).toString('base64url');
}
