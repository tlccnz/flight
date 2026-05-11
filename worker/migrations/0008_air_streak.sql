-- Run via: wrangler d1 execute flight --file=migrations/0008_air_streak.sql --remote

ALTER TABLE aircraft ADD COLUMN air_streak INTEGER NOT NULL DEFAULT 0;
