-- gregorian schema v1 (locked in design doc §"SQLite schema (M1)").
-- Idempotent: safe to run on every open behind a user_version gate.

-- a scheduled template that spawns occurrences; null for one-off/ad-hoc events
CREATE TABLE IF NOT EXISTS recurrence_rule (
  id            TEXT PRIMARY KEY,
  cron_spec     TEXT NOT NULL,              -- croner pattern
  engine        TEXT NOT NULL,              -- 'claude' | 'codex'
  model         TEXT,                       -- engine-scoped model id
  cwd           TEXT NOT NULL,
  prompt        TEXT NOT NULL,
  mentions      TEXT,                       -- JSON array of skill/doc refs
  created_at    TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS event (
  id              TEXT PRIMARY KEY,
  title           TEXT NOT NULL,
  engine          TEXT NOT NULL,
  model           TEXT,
  cwd             TEXT NOT NULL,
  prompt          TEXT,                     -- null for pure ad-hoc (discovered)
  mentions        TEXT,                     -- JSON array
  schedule_kind   TEXT NOT NULL,            -- 'once' | 'adhoc'  (recurring => many 'once')
  scheduled_at    TEXT,                     -- concrete time for 'once'; null for 'adhoc'
  recurrence_rule_id TEXT REFERENCES recurrence_rule(id),
  status          TEXT NOT NULL,            -- scheduled|running|done|failed|missed
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_event_status ON event(status);
CREATE INDEX IF NOT EXISTS idx_event_scheduled_at ON event(scheduled_at);

CREATE TABLE IF NOT EXISTS run (
  id              TEXT PRIMARY KEY,
  event_id        TEXT NOT NULL REFERENCES event(id),
  engine          TEXT NOT NULL,
  session_id      TEXT NOT NULL,            -- the join key (pre-assigned for claude)
  role            TEXT NOT NULL,            -- 'run' | 'summarizer'
  transcript_path TEXT,
  transcript_offset INTEGER DEFAULT 0,      -- bytes ingested (dedup / re-attach)
  started_at      TEXT,
  ended_at        TEXT,
  exit_code       INTEGER,
  diff_stat       TEXT,                     -- null for ad-hoc (no before-snapshot)
  minutes         TEXT,
  status          TEXT NOT NULL             -- running|done|failed
  -- NOTE: `error TEXT` (named failure reason) is added by migration v2 in store.ts, not here —
  -- this file is the frozen v1 snapshot (append migrations, never edit v1).
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_session ON run(session_id);  -- watcher dedup
-- NOTE: idx_event_recurrence (event.recurrence_rule_id) is also added by migration v2.
