-- Append-only history of titles added to the playlist. Deliberately has no
-- foreign key to streams: deleting a stream must not erase recommendation input.
create table if not exists playlist_additions (
  event_id    text primary key,
  stream_id   text not null,
  title       text not null,
  year        integer,
  kind        text not null default 'movie',
  poster      text,
  description text,
  source_id   text,
  tmdb_id     text,
  imdb_id     text,
  genres      jsonb not null default '[]',
  added_at    timestamptz not null default now()
);
create index if not exists playlist_additions_added_idx on playlist_additions (added_at desc);
create index if not exists playlist_additions_title_idx on playlist_additions (lower(title));
