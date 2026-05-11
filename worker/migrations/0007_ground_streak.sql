-- Run via: wrangler d1 execute flight --file=migrations/0007_ground_streak.sql --remote

ALTER TABLE aircraft ADD COLUMN ground_streak INTEGER NOT NULL DEFAULT 0;
