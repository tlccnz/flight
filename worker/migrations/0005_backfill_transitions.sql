-- Run via: wrangler d1 execute flight --file=migrations/0005_backfill_transitions.sql --remote
-- One-time backfill of transitions from existing positions (last 24h)

-- Takeoffs (on_ground flips 1→0) and landings (0→1)
INSERT INTO transitions (hex, ts, type, callsign, alt_ft)
SELECT hex, ts, type, callsign, alt_ft FROM (
  SELECT
    hex, ts, callsign, alt_ft,
    CASE
      WHEN on_ground = 0 AND LAG(on_ground) OVER (PARTITION BY hex ORDER BY ts) = 1 THEN 'takeoff'
      WHEN on_ground = 1 AND LAG(on_ground) OVER (PARTITION BY hex ORDER BY ts) = 0 THEN 'landing'
    END as type
  FROM positions
  WHERE ts >= (CAST(strftime('%s', 'now') AS INTEGER) - 86400)
)
WHERE type IS NOT NULL;

-- Overhead: first airborne position for aircraft never seen on the ground in this window
INSERT INTO transitions (hex, ts, type, callsign, alt_ft)
SELECT e.hex, p.ts, 'overhead', p.callsign, p.alt_ft
FROM (
  SELECT hex, MIN(ts) as min_ts
  FROM positions
  WHERE ts >= (CAST(strftime('%s', 'now') AS INTEGER) - 86400) AND on_ground = 0
  GROUP BY hex
) e
JOIN positions p ON p.hex = e.hex AND p.ts = e.min_ts
WHERE NOT EXISTS (
  SELECT 1 FROM positions g
  WHERE g.hex = e.hex
    AND g.ts >= (CAST(strftime('%s', 'now') AS INTEGER) - 86400)
    AND g.on_ground = 1
    AND g.ts < e.min_ts
);
