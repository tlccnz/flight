-- Run via: wrangler d1 execute flight --file=migrations/0001_enrichment_columns.sql --remote

ALTER TABLE aircraft ADD COLUMN manufacturer  TEXT;
ALTER TABLE aircraft ADD COLUMN country       TEXT;
ALTER TABLE aircraft ADD COLUMN icao_type     TEXT;
ALTER TABLE aircraft ADD COLUMN enriched      INTEGER NOT NULL DEFAULT 0;
-- enriched: 0=pending, 1=done, -1=not found
