-- Run via: wrangler d1 execute flight --file=schema.sql --remote

CREATE TABLE IF NOT EXISTS aircraft (
  hex             TEXT    PRIMARY KEY,
  first_seen      INTEGER NOT NULL,
  last_seen       INTEGER NOT NULL,
  total_positions INTEGER NOT NULL DEFAULT 0,
  registration    TEXT,
  aircraft_type   TEXT,
  operator        TEXT
);

CREATE TABLE IF NOT EXISTS positions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  hex        TEXT    NOT NULL,
  ts         INTEGER NOT NULL,
  callsign   TEXT,
  lat        REAL,
  lon        REAL,
  alt_ft     INTEGER,
  speed_kts  INTEGER,
  heading    INTEGER,
  squawk     TEXT,
  on_ground  INTEGER NOT NULL DEFAULT 0,
  UNIQUE(hex, ts)
);

CREATE INDEX IF NOT EXISTS idx_positions_hex_ts ON positions (hex, ts DESC);
CREATE INDEX IF NOT EXISTS idx_positions_ts     ON positions (ts DESC);
