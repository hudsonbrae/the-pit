-- The Pit: database schema. Paste this whole file into Supabase → SQL Editor → Run.
-- Safe to run more than once.
--
-- Only the game server talks to these tables, using the service-role key.
-- Row Level Security is switched on with no policies, so the public "anon" key
-- (and anyone holding it) can read or write nothing.

create table if not exists rooms (
  code            text primary key,
  mode            text not null check (mode in ('sim', 'real')),
  ticker          text not null,
  host_token      text not null,
  created_at      timestamptz not null default now(),
  last_active_at  timestamptz not null default now()
);

-- One row per player per room: their simulated cash and position.
create table if not exists players (
  room_code    text not null references rooms(code) on delete cascade,
  token        text not null,          -- SHA-256 of the random id kept in the player's browser
  pid          text not null,          -- short public id inside the room (p1, p2, ...)
  name         text not null,
  color        text not null,
  cash         double precision not null,
  shares       integer not null,
  cost         double precision not null default 0,
  start_value  double precision not null,
  updated_at   timestamptz not null default now(),
  primary key (room_code, token)
);

-- Lessons each AI trader has written for itself, per room, newest first.
create table if not exists trader_lessons (
  room_code   text not null references rooms(code) on delete cascade,
  agent_id    text not null,
  lessons     jsonb not null default '[]'::jsonb,
  updated_at  timestamptz not null default now(),
  primary key (room_code, agent_id)
);

-- Every headline and floor check, with the desk's read and token usage.
create table if not exists news_log (
  id            bigint generated always as identity primary key,
  room_code     text not null references rooms(code) on delete cascade,
  no            integer,
  kind          text not null,
  origin        text,                 -- LIVE or PLAYER
  by_name       text,
  headline      text not null,
  source        text,
  url           text,
  published_at  timestamptz,
  impact        double precision,
  read          text,
  model         text,
  tokens_in     integer,
  tokens_out    integer,
  created_at    timestamptz not null default now()
);
create index if not exists news_log_room on news_log (room_code, created_at desc);

-- Standings snapshots, written when a host resets a room.
create table if not exists leaderboards (
  id           bigint generated always as identity primary key,
  room_code    text not null references rooms(code) on delete cascade,
  name         text not null,
  pnl          double precision not null,
  is_ai        boolean not null default false,
  recorded_at  timestamptz not null default now()
);

alter table rooms          enable row level security;
alter table players        enable row level security;
alter table trader_lessons enable row level security;
alter table news_log       enable row level security;
alter table leaderboards   enable row level security;

-- ---- Added in the maximum-potential pass (safe to run on an existing project) ----

alter table rooms add column if not exists seed bigint;

-- Each AI trader's measured track record (scored calls, calibration, P&L), per room.
create table if not exists trader_stats (
  room_code   text not null references rooms(code) on delete cascade,
  agent_id    text not null,
  stats       jsonb not null,
  lab         text,                    -- the room's AI configuration when last saved (for experiments)
  updated_at  timestamptz not null default now(),
  primary key (room_code, agent_id)
);

-- The day's AI usage, so the daily caps survive a restart.
create table if not exists ai_usage_daily (
  day         text primary key,        -- YYYY-MM-DD (UTC)
  rounds      integer not null default 0,
  small       integer not null default 0,
  tokens_in   bigint not null default 0,
  tokens_out  bigint not null default 0,
  cost_usd    double precision not null default 0,
  updated_at  timestamptz not null default now()
);

alter table trader_stats   enable row level security;
alter table ai_usage_daily enable row level security;

-- ---- Added in the "go beyond" pass ----

-- All-time records across every room (server/legends.ts). Holder is a display name, never a token.
create table if not exists legends (
  key        text primary key,
  holder     text not null,
  value      double precision not null,
  detail     text,
  room_code  text,
  at         timestamptz not null default now()
);

alter table legends enable row level security;
