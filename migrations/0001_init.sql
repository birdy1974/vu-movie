-- vu-movie — initial schema (applied automatically at startup, see src/core/db.js)
--
-- Everything the app persists lives here. The memory fallback in db.js keeps the
-- same shapes, so switching to Postgres later never changes application code.

-- Generated streams: one row per scraped title, ready to play.
create table if not exists streams (
  id            text primary key,             -- short public id (used in URLs)
  token         text not null unique,         -- unguessable token for /s/:token/...
  title         text,
  year          integer,
  kind          text,                         -- movie | series
  poster        text,
  description   text,
  source_id     text,                         -- which recipe/provider resolved it
  upstream      jsonb not null default '{}',  -- { url, kind, headers, candidates[] }
  profile       jsonb not null default '{}',  -- transcoding profile chosen by the user
  subtitle_id   text,
  playlist_name text,
  created_at    timestamptz not null default now(),
  expires_at    timestamptz,
  payload       jsonb not null default '{}',
  updated_at    timestamptz not null default now()
);
create index if not exists streams_created_idx on streams (created_at desc);
create index if not exists streams_token_idx on streams (token);

-- Title metadata (poster/plot/rating) so the UI does not refetch on every visit.
create table if not exists titles (
  key          text primary key,
  title        text,
  year         integer,
  kind         text,
  tmdb_id      text,
  imdb_id      text,
  poster       text,
  description  text,
  rating       numeric,
  payload      jsonb not null default '{}',
  updated_at   timestamptz not null default now()
);

-- Generic TTL cache: search results, site recipes responses, provider lookups.
create table if not exists api_cache (
  key        text primary key,
  payload    jsonb,
  expires_at timestamptz,
  updated_at timestamptz not null default now()
);
create index if not exists api_cache_expires_idx on api_cache (expires_at);

-- Subtitle files we downloaded (so the UI can re-offer them without re-downloading).
create table if not exists subtitle_files (
  id           text primary key,
  stream_id    text references streams (id) on delete cascade,
  language     text,
  provider     text,
  release_name text,
  filename     text,
  path         text,
  score        numeric,
  offset_ms    integer not null default 0,
  pushed_to    text,
  created_at   timestamptz not null default now()
);
create index if not exists subtitle_files_stream_idx on subtitle_files (stream_id);

-- Providers the user added himself (URL templates) — the built-ins live in code.
create table if not exists subtitle_providers (
  id         text primary key,
  name       text not null,
  kind       text not null default 'custom',
  config     jsonb not null default '{}',
  enabled    boolean not null default true,
  created_at timestamptz not null default now()
);

-- Enigma2 bouquets we pushed, with entry counts for the dashboard.
create table if not exists bouquets (
  name       text primary key,
  entries    integer not null default 0,
  pushed_at  timestamptz,
  payload    jsonb not null default '{}',
  updated_at timestamptz not null default now()
);

-- Application settings edited from the UI (API keys, defaults, etc.).
create table if not exists settings (
  key        text primary key,
  value      jsonb,
  updated_at timestamptz not null default now()
);

-- Optional durable job history (jobs also live in memory for live progress).
create table if not exists jobs (
  id         text primary key,
  type       text not null,
  title      text,
  status     text not null default 'queued',
  progress   numeric not null default 0,
  message    text,
  payload    jsonb not null default '{}',
  error      text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);
create index if not exists jobs_created_idx on jobs (created_at desc);
