/**
 * vu-movie — database layer.
 *
 * Deliberate design choices (they came from the deployment requirements):
 *
 *  1. LAZY: no pool is created at import time. Importing this file during
 *     `docker build` (or `npm ci` postinstall) can never try to reach Postgres.
 *  2. DUMMY URL SAFE: if DATABASE_URL is empty or unreachable we do NOT crash.
 *     The app logs a loud WARNING and runs with an in-memory store, so the UI
 *     and the stream proxy keep working. Set REQUIRE_DB=true to make the
 *     container fail fast instead (useful when you *want* persistence).
 *  3. MIGRATIONS AT STARTUP: initDatabase() applies every file in ./migrations
 *     (plain SQL, tracked in schema_migrations) BEFORE the HTTP listener opens.
 *     That is what guarantees "tables exist during startup".
 *
 * All SQL used by the app lives in this file next to the memory fallback so the
 * two paths can never drift apart.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { log, logError } from './log.js';
import { getConfig } from './config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = process.env.MIGRATIONS_DIR || path.resolve(__dirname, '../../migrations');

/**
 * Log a warning when a single query takes longer than this (DB_SLOW_QUERY_MS).
 * The first reads after a container start are cold (Postgres cache empty, NAS
 * disks spun down); a one-off `select * from streams …` over many jsonb rows is
 * expected to cross a few hundred milliseconds once and then be fast.
 */
const SLOW_QUERY_MS = Number(process.env.DB_SLOW_QUERY_MS) > 0 ? Number(process.env.DB_SLOW_QUERY_MS) : 1500;

/** 'uninitialised' | 'connecting' | 'postgres' | 'memory' */
let state = 'uninitialised';
let pool = null;
let lastError = null;
let pgModule = null;

/** In-memory fallback store — small on purpose: streams, cache, titles, settings. */
const mem = {
  streams: new Map(),
  titles: new Map(),
  playlistAdditions: new Map(),
  cache: new Map(),
  settings: new Map(),
};

export function dbState() {
  return { state, lastError, hasPool: Boolean(pool) };
}

export function isPostgres() {
  return state === 'postgres';
}

/** Import 'pg' only when a pool is actually needed (keeps build-time imports clean). */
async function getPg() {
  if (!pgModule) {
    pgModule = await import('pg');
    log.debug('db', 'pg module loaded lazily');
  }
  return pgModule.default || pgModule;
}

async function createPool() {
  const cfg = getConfig();
  const url = cfg.db.url;
  if (!url || /build:build@127\.0\.0\.1/.test(url)) {
    // The documented build-time dummy URL. Never dial it — that would hang a build.
    log.warn('db', 'DATABASE_URL is empty or the documented build-time dummy — staying in memory mode',
      { url: url ? url.replace(/:[^:@/]*@/, ':***@') : '(empty)' });
    return null;
  }
  const { Pool } = await getPg();
  const p = new Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 8000,
    application_name: 'vu-movie',
  });
  p.on('error', (err) => logError('db', 'idle postgres client error (pool will recover)', err));
  log.info('db', 'postgres pool created (lazy)',
    { url: url.replace(/:[^:@/]*@/, ':***@'), max: p.options?.max });
  return p;
}

export async function query(text, params = []) {
  if (!pool) {
    if (state === 'uninitialised' || state === 'connecting') await connect();
    if (!pool) throw new Error('database unavailable (memory mode)');
  }
  const started = Date.now();
  try {
    const res = await pool.query(text, params);
    const ms = Date.now() - started;
    // 500 ms used to be the bar, which made the first dashboard load after a
    // start (cold Postgres cache + cold NAS disks, right after ffmpeg had also
    // taken ~20 s to answer) look like a database problem when it is just I/O
    // warming up. Anything above this line is worth a log entry; tune it with
    // DB_SLOW_QUERY_MS.
    if (ms > SLOW_QUERY_MS) {
      log.warn('db', 'slow query', { ms, rows: res?.rowCount ?? null, thresholdMs: SLOW_QUERY_MS, sql: text.slice(0, 120) });
    } else if (ms > SLOW_QUERY_MS / 3) {
      log.debug('db', 'query took a while (warm-cache noise is normal right after a restart)', { ms, sql: text.slice(0, 120) });
    }
    return res;
  } catch (err) {
    logError('db', 'query failed', err, { sql: text.slice(0, 160), params: params.length });
    throw err;
  }
}

/** Explicit connect (called from initDatabase, or lazily on first query). */
export async function connect() {
  if (pool || state === 'memory') return pool;
  state = 'connecting';
  pool = await createPool();
  if (!pool) { state = 'memory'; return null; }
  try {
    await pool.query('select 1');
    state = 'postgres';
    lastError = null;
    log.info('db', 'postgres connection ok');
  } catch (err) {
    lastError = String(err?.message || err);
    logError('db', 'initial connection failed — falling back to memory store', err);
    try { await pool.end(); } catch { /* ignore */ }
    pool = null;
    state = 'memory';
  }
  return pool;
}

/** Apply every migrations/*.sql file exactly once, inside a transaction each. */
export async function runMigrations() {
  if (!pool) return { applied: [], skipped: true };
  await pool.query(`create table if not exists schema_migrations (
    id text primary key,
    applied_at timestamptz not null default now()
  )`);

  let files = [];
  try {
    files = fs.readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith('.sql')).sort();
  } catch (err) {
    logError('db', `migrations directory ${MIGRATIONS_DIR} not readable`, err);
    return { applied: [], error: 'migrations dir unreadable' };
  }
  if (files.length === 0) log.warn('db', `no migration files found in ${MIGRATIONS_DIR}`);

  const done = new Set((await pool.query('select id from schema_migrations')).rows.map((r) => r.id));
  const applied = [];

  for (const file of files) {
    if (done.has(file)) { log.debug('db', `migration already applied: ${file}`); continue; }
    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    const client = await pool.connect();
    try {
      await client.query('begin');
      await client.query(sql);
      await client.query('insert into schema_migrations (id) values ($1)', [file]);
      await client.query('commit');
      applied.push(file);
      log.info('db', `migration applied: ${file}`, { bytes: sql.length });
    } catch (err) {
      await client.query('rollback').catch(() => {});
      logError('db', `migration FAILED: ${file} (rolled back — schema unchanged)`, err);
      throw err;
    } finally {
      client.release();
    }
  }
  return { applied, skipped: false };
}

/**
 * Startup entry point: connect (with retry/backoff while Postgres boots on the
 * NAS) and make sure the schema exists. Never throws unless REQUIRE_DB=true.
 */
export async function initDatabase() {
  const cfg = getConfig();
  const deadline = Date.now() + cfg.db.waitForDbMs;
  let attempt = 0;

  while (Date.now() < deadline) {
    attempt += 1;
    if (state === 'memory' && !cfg.db.url) break; // no URL configured at all: don't spin
    const p = await connect();
    if (p) break;
    if (!cfg.db.url) break;
    const wait = Math.min(2000 * attempt, 8000);
    log.warn('db', `postgres not ready (attempt ${attempt}) — retrying in ${wait} ms`);
    await new Promise((r) => setTimeout(r, wait));
  }

  if (!pool) {
    if (cfg.db.required) {
      throw new Error(`Postgres is required (REQUIRE_DB=true) but unavailable: ${lastError || 'no DATABASE_URL'}`);
    }
    log.warn('db', 'RUNNING WITHOUT POSTGRES — streams/settings/cache live in memory only and are lost on restart');
    return { mode: 'memory', applied: [] };
  }

  const res = await runMigrations();
  const tables = await pool.query(
    // information_schema stores 'BASE TABLE' upper-case — comparing against
    // 'base table' matched nothing, so this always logged "tables": 0 and a
    // healthy schema looked empty in the boot log and in /api/health.
    `select count(*)::int as n from information_schema.tables
      where table_schema = 'public' and table_type = 'BASE TABLE'`,
  );
  log.info('db', 'schema ready', { tables: tables.rows[0]?.n, appliedNow: res.applied.length });
  return { mode: 'postgres', ...res };
}

export async function closeDatabase() {
  if (pool) {
    await pool.end().catch((err) => logError('db', 'error closing pool', err));
    pool = null;
    state = 'uninitialised';
    log.info('db', 'postgres pool closed');
  }
}

/* ------------------------------------------------------------------ *
 * Repository. Every function works with or without Postgres.
 * ------------------------------------------------------------------ */

const nowIso = () => new Date().toISOString();

export const repo = {
  /* ---------------- streams ---------------- */
  async saveStream(rec) {
    const row = { ...rec, updated_at: nowIso() };
    mem.streams.set(rec.id, row);
    if (!pool) return row;
    await query(
      `insert into streams (id, token, title, year, kind, poster, description, source_id, upstream,
                            profile, subtitle_id, playlist_name, created_at, expires_at, payload, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       on conflict (id) do update set
         title = excluded.title, poster = excluded.poster, description = excluded.description,
         source_id = excluded.source_id, upstream = excluded.upstream, profile = excluded.profile,
         subtitle_id = excluded.subtitle_id, playlist_name = excluded.playlist_name,
         expires_at = excluded.expires_at, payload = excluded.payload, updated_at = now()`,
      [row.id, row.token, row.title ?? null, row.year ?? null, row.kind ?? null, row.poster ?? null,
        row.description ?? null, row.source_id ?? null, JSON.stringify(row.upstream ?? {}),
        JSON.stringify(row.profile ?? {}), row.subtitle_id ?? null, row.playlist_name ?? null,
        row.created_at ?? nowIso(), row.expires_at ?? null, JSON.stringify(row.payload ?? {}), row.updated_at],
    ).catch((err) => logError('db', 'saveStream failed — kept in memory only', err));
    return row;
  },

  async getStream(id) {
    if (pool) {
      const res = await query('select * from streams where id = $1 or token = $1', [id])
        .catch(() => null);
      if (res?.rows?.length) {
        const r = res.rows[0];
        return {
          ...r,
          upstream: parseJson(r.upstream, {}),
          profile: parseJson(r.profile, {}),
          payload: parseJson(r.payload, {}),
        };
      }
    }
    return [...mem.streams.values()].find((s) => s.id === id || s.token === id) || null;
  },

  async listStreams(limit = 200) {
    if (pool) {
      const res = await query('select * from streams order by created_at desc limit $1', [limit]).catch(() => null);
      if (res) {
        return res.rows.map((r) => ({
          ...r,
          upstream: parseJson(r.upstream, {}),
          profile: parseJson(r.profile, {}),
          payload: parseJson(r.payload, {}),
        }));
      }
    }
    return [...mem.streams.values()].sort((a, b) => String(b.created_at).localeCompare(String(a.created_at))).slice(0, limit);
  },

  async deleteStream(id) {
    // getStream() accepts the opaque token as a handle too (DELETE /api/streams/:id
    // and the VLC/Enigma2 URLs hand out tokens), so the delete must match both —
    // `delete ... where id = $1` silently deleted nothing for a token.
    for (const [key, rec] of mem.streams) {
      if (key === id || rec.id === id || rec.token === id) mem.streams.delete(key);
    }
    if (pool) await query('delete from streams where id = $1 or token = $1', [id]).catch((err) => logError('db', 'deleteStream failed', err));
  },

  /* ---------------- append-only playlist-addition history ---------------- */
  async recordPlaylistAdditions(events = []) {
    const rows = (Array.isArray(events) ? events : [events]).filter((event) => event?.eventId && event?.streamId && event?.title)
      .map((event) => ({
        eventId: String(event.eventId),
        streamId: String(event.streamId),
        title: String(event.title),
        year: Number(event.year) || null,
        kind: event.kind === 'series' ? 'series' : 'movie',
        poster: event.poster ? String(event.poster) : null,
        description: event.description ? String(event.description) : null,
        sourceId: event.sourceId ? String(event.sourceId) : null,
        tmdbId: event.tmdbId ? String(event.tmdbId) : null,
        imdbId: event.imdbId ? String(event.imdbId) : null,
        genres: Array.isArray(event.genres) ? event.genres.map(String) : [],
        addedAt: event.addedAt || nowIso(),
      }));
    if (!rows.length) return 0;

    for (const row of rows) mem.playlistAdditions.set(row.eventId, row);
    if (pool) {
      // PostgreSQL allows 65,535 bind parameters. Small batches keep a config
      // history backfill safe even after years of playlist additions.
      for (let start = 0; start < rows.length; start += 400) {
        const batch = rows.slice(start, start + 400);
        const params = [];
        const values = batch.map((row, index) => {
          const offset = index * 12;
          params.push(
            row.eventId, row.streamId, row.title, row.year, row.kind, row.poster,
            row.description, row.sourceId, row.tmdbId, row.imdbId,
            JSON.stringify(row.genres), row.addedAt,
          );
          return `($${offset + 1},$${offset + 2},$${offset + 3},$${offset + 4},$${offset + 5},$${offset + 6},$${offset + 7},$${offset + 8},$${offset + 9},$${offset + 10},$${offset + 11}::jsonb,$${offset + 12})`;
        });
        await query(
          `insert into playlist_additions (event_id, stream_id, title, year, kind, poster, description, source_id, tmdb_id, imdb_id, genres, added_at)
           values ${values.join(',')}
           on conflict (event_id) do nothing`,
          params,
        ).catch((err) => logError('db', 'recordPlaylistAdditions failed — kept in memory/config only', err));
      }
    }
    return rows.length;
  },

  async listPlaylistAdditions() {
    const persisted = [];
    if (pool) {
      const res = await query('select * from playlist_additions order by added_at asc, event_id asc').catch(() => null);
      if (res) {
        persisted.push(...res.rows.map((row) => ({
          eventId: row.event_id,
          streamId: row.stream_id,
          title: row.title,
          year: row.year,
          kind: row.kind,
          poster: row.poster,
          description: row.description,
          sourceId: row.source_id,
          tmdbId: row.tmdb_id,
          imdbId: row.imdb_id,
          genres: parseJson(row.genres, []),
          addedAt: row.added_at instanceof Date ? row.added_at.toISOString() : row.added_at,
        })));
      }
    }
    const byId = new Map([...persisted, ...mem.playlistAdditions.values()].map((event) => [event.eventId, event]));
    return [...byId.values()].sort((a, b) => String(a.addedAt).localeCompare(String(b.addedAt)));
  },

  /* ---------------- titles / metadata ---------------- */
  async saveTitle(t) {
    const key = t.key || `${t.title}|${t.year || ''}|${t.kind || ''}`.toLowerCase();
    const row = { ...t, key, updated_at: nowIso() };
    mem.titles.set(key, row);
    if (pool) {
      await query(
        `insert into titles (key, title, year, kind, tmdb_id, imdb_id, poster, description, rating, payload, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         on conflict (key) do update set poster = excluded.poster, description = excluded.description,
           rating = excluded.rating, payload = excluded.payload, updated_at = now()`,
        [key, t.title ?? null, t.year ?? null, t.kind ?? null, t.tmdb_id ?? null, t.imdb_id ?? null,
          t.poster ?? null, t.description ?? null, t.rating ?? null, JSON.stringify(t.payload ?? {}), row.updated_at],
      ).catch((err) => logError('db', 'saveTitle failed', err));
    }
    return row;
  },

  async getTitle(key) {
    if (pool) {
      const res = await query('select * from titles where key = $1', [key]).catch(() => null);
      if (res?.rows?.length) return res.rows[0];
    }
    return mem.titles.get(key) || null;
  },

  /* ---------------- generic cache (search results, metadata) ---------------- */
  async cacheGet(key) {
    if (pool) {
      const res = await query('select payload, expires_at from api_cache where key = $1', [key]).catch(() => null);
      if (res?.rows?.length) {
        const row = res.rows[0];
        if (!row.expires_at || new Date(row.expires_at).getTime() > Date.now()) return parseJson(row.payload, null);
        query('delete from api_cache where key = $1', [key]).catch(() => {});
        return null;
      }
    }
    const hit = mem.cache.get(key);
    if (!hit) return null;
    if (hit.expires && hit.expires < Date.now()) { mem.cache.delete(key); return null; }
    return hit.value;
  },

  async cacheSet(key, value, ttlSeconds = 3600) {
    const expires = ttlSeconds > 0 ? Date.now() + ttlSeconds * 1000 : null;
    mem.cache.set(key, { value, expires });
    if (pool) {
      await query(
        `insert into api_cache (key, payload, expires_at, updated_at) values ($1,$2,$3,now())
         on conflict (key) do update set payload = excluded.payload, expires_at = excluded.expires_at, updated_at = now()`,
        [key, JSON.stringify(value ?? null), expires ? new Date(expires) : null],
      ).catch((err) => logError('db', 'cacheSet failed', err));
    }
    return value;
  },

  /* ---------------- settings (key/value) ---------------- */
  async setSetting(key, value) {
    mem.settings.set(key, value);
    if (pool) {
      await query(
        `insert into settings (key, value, updated_at) values ($1,$2,now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, JSON.stringify(value ?? null)],
      ).catch((err) => logError('db', 'setSetting failed', err));
    }
  },

  async getSetting(key, fallback = null) {
    if (pool) {
      const res = await query('select value from settings where key = $1', [key]).catch(() => null);
      if (res?.rows?.length) return parseJson(res.rows[0].value, fallback);
    }
    return mem.settings.has(key) ? mem.settings.get(key) : fallback;
  },

  /* ---------------- bouquets ---------------- */
  async saveBouquet(b) {
    if (!pool) return b;
    await query(
      `insert into bouquets (name, entries, pushed_at, payload, updated_at) values ($1,$2,$3,$4,now())
       on conflict (name) do update set entries = excluded.entries, pushed_at = excluded.pushed_at,
         payload = excluded.payload, updated_at = now()`,
      [b.name, b.entries ?? 0, b.pushed_at ?? null, JSON.stringify(b.payload ?? {})],
    ).catch((err) => logError('db', 'saveBouquet failed', err));
    return b;
  },
};

function parseJson(value, fallback) {
  if (value == null) return fallback;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return fallback; }
}
