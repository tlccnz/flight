-- Run via: wrangler d1 execute flight --file=migrations/0002_watchlist_and_state.sql --remote

CREATE TABLE IF NOT EXISTS watchlist (
  hex   TEXT PRIMARY KEY,
  label TEXT
);

ALTER TABLE aircraft ADD COLUMN last_airborne_date TEXT;
ALTER TABLE aircraft ADD COLUMN prev_on_ground     INTEGER;
