-- Run via: wrangler d1 execute flight --file=migrations/0004_transitions.sql --remote

CREATE TABLE IF NOT EXISTS transitions (
  id       INTEGER PRIMARY KEY AUTOINCREMENT,
  hex      TEXT    NOT NULL,
  ts       INTEGER NOT NULL,
  type     TEXT    NOT NULL,  -- 'takeoff', 'landing', 'overhead'
  callsign TEXT,
  alt_ft   INTEGER
);

CREATE INDEX IF NOT EXISTS idx_transitions_ts     ON transitions (ts DESC);
CREATE INDEX IF NOT EXISTS idx_transitions_hex_ts ON transitions (hex, ts DESC);
