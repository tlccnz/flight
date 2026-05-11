-- Run via: wrangler d1 execute flight --file=migrations/0006_sighting_count.sql --remote

ALTER TABLE aircraft ADD COLUMN sighting_count INTEGER NOT NULL DEFAULT 0;

-- Backfill from transitions (landing + overhead = 1 sighting each)
UPDATE aircraft SET sighting_count = (
  SELECT COUNT(*) FROM transitions
  WHERE transitions.hex = aircraft.hex
    AND transitions.type IN ('landing', 'overhead')
);
