/**
 * vu-movie — structured logger.
 *
 * Every module logs through here so that behaviour can be traced end-to-end:
 *   log.info('scraper', 'cinejoy: 3 candidates found', { ms: 412 })
 *
 * Features
 *  - levels: debug < info < warn < error (LOG_LEVEL env / config)
 *  - in-memory ring buffer (last N entries) served by the /api/logs UI + SSE tail
 *  - colourised console output with component column, ISO timestamp
 *  - logError() helper that unwraps Error.cause chains — most upstream failures
 *    in this app are "fetch failed → ECONNRESET → TLS alert", so the full chain matters
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const COLORS = {
  debug: '\x1b[90m', info: '\x1b[36m', warn: '\x1b[33m', error: '\x1b[31m',
  dim: '\x1b[90m', reset: '\x1b[0m', bold: '\x1b[1m',
};

/** Ring buffer size — keep small; this runs on a NAS with 4 GB RAM. */
const MAX_ENTRIES = Number(process.env.LOG_BUFFER || 1000);

let threshold = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] ?? LEVELS.info;
const ring = [];
const subscribers = new Set();
let seq = 0;

export function setLogLevel(level) {
  const next = LEVELS[String(level).toLowerCase()];
  if (next) {
    threshold = next;
    info('log', `log level set to ${level}`);
  } else {
    warn('log', `ignoring unknown log level "${level}"`);
  }
}

export function getLogLevel() {
  return Object.keys(LEVELS).find((k) => LEVELS[k] === threshold) || 'info';
}

/** Subscribe to new entries (used by the SSE endpoint). Returns an unsubscribe fn. */
export function subscribeLogs(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}

/** Recent entries, newest last. Supports the filters the UI exposes. */
export function getRecentLogs({ level, component, search, limit = 300 } = {}) {
  const min = LEVELS[String(level || 'debug').toLowerCase()] ?? LEVELS.debug;
  return ring
    .filter((e) => (LEVELS[e.level] ?? 0) >= min)
    .filter((e) => !component || component === 'all' || e.component === component)
    .filter((e) => !search || JSON.stringify(e).toLowerCase().includes(String(search).toLowerCase()))
    .slice(-limit);
}

/** Components seen so far — the UI builds its filter dropdown from this. */
export function knownComponents() {
  return [...new Set(ring.map((e) => e.component))].sort();
}

function push(entry) {
  ring.push(entry);
  if (ring.length > MAX_ENTRIES) ring.splice(0, ring.length - MAX_ENTRIES);
  for (const fn of subscribers) {
    try { fn(entry); } catch { /* a broken subscriber must never break logging */ }
  }
}

/** Pretty, aligned console line. Fields are appended as compact JSON. */
function format(entry) {
  const tag = entry.level.toUpperCase().padEnd(5);
  const comp = entry.component.padEnd(9);
  const fields = entry.fields && Object.keys(entry.fields).length
    ? ' ' + JSON.stringify(entry.fields)
    : '';
  const stack = entry.stack ? `\n${entry.stack}` : '';
  return `${COLORS.dim}${entry.time}${COLORS.reset} ${COLORS[entry.level]}${tag}${COLORS.reset} ${COLORS.bold}${comp}${COLORS.reset} ${entry.message}${fields}${stack}`;
}

function write(level, component, message, fields) {
  if (LEVELS[level] < threshold) return null;
  const entry = {
    seq: ++seq,
    time: new Date().toISOString().replace('T', ' ').slice(0, 23),
    epoch: Date.now(),
    level,
    component: String(component || 'app'),
    message: String(message ?? ''),
    fields: fields ?? undefined,
  };
  push(entry);
  const line = format(entry);
  if (level === 'error' || level === 'warn') console.error(line); else console.log(line);
  return entry;
}

export const log = {
  debug: (c, m, f) => write('debug', c, m, f),
  info: (c, m, f) => write('info', c, m, f),
  warn: (c, m, f) => write('warn', c, m, f),
  error: (c, m, f) => write('error', c, m, f),
};

/** Flatten an Error (including .cause chains and AggregateError) into loggable text. */
export function errorText(err) {
  if (!err) return 'unknown error';
  const parts = [];
  let cur = err;
  const seen = new Set();
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const code = cur.code ? ` [${cur.code}]` : '';
    parts.push(`${cur.name || 'Error'}${code}: ${cur.message || cur}`);
    cur = cur.cause;
  }
  return parts.join(' <- ');
}

/** Log an error with its causes and (optional) the failing command/URL context. */
export function logError(component, message, err, fields = {}) {
  return log.error(component, message, {
    ...fields,
    error: errorText(err),
    ...(err?.stack ? { stack: String(err.stack).split('\n').slice(0, 4).join(' | ') } : {}),
  });
}

/** Truncate long strings (URLs/HTML) so logs stay readable. */
export function truncate(value, max = 220) {
  const s = typeof value === 'string' ? value : JSON.stringify(value);
  if (!s) return '';
  return s.length > max ? `${s.slice(0, max)}…(${s.length})` : s;
}

/** Convenience for building a component-scoped logger in every module. */
export function scoped(component) {
  return {
    debug: (m, f) => log.debug(component, m, f),
    info: (m, f) => log.info(component, m, f),
    warn: (m, f) => log.warn(component, m, f),
    error: (m, f) => log.error(component, m, f),
    logError: (m, e, f) => logError(component, m, e, f),
  };
}

export default log;
