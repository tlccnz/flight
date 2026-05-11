-- Run via: wrangler d1 execute flight --file=migrations/0003_notable_flag.sql --remote

ALTER TABLE aircraft ADD COLUMN is_notable INTEGER NOT NULL DEFAULT 0;
