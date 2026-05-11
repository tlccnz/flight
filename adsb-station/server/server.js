'use strict';

const express  = require('express');
const Database = require('better-sqlite3');
const path     = require('path');

const ADSB_URL    = process.env.ADSB_URL || 'http://10.10.30.227:8754/flights.json';
const DB_PATH     = process.env.DB_PATH  || '/data/adsb.db';
const PORT        = parseInt(process.env.PORT || '3000', 10);
const POLL_MS     = 5000;

// ── Database setup ────────────────────────────────────────────────────────────

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS aircraft (
    hex             TEXT    PRIMARY KEY,
    first_seen      INTEGER NOT NULL,
    last_seen       INTEGER NOT NULL,
    total_positions INTEGER DEFAULT 0,
    registration    TEXT,
    aircraft_type   TEXT,
    operator        TEXT,
    enriched        INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS positions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    hex         TEXT    NOT NULL,
    ts          INTEGER NOT NULL,
    callsign    TEXT,
    lat         REAL,
    lon         REAL,
    alt_ft      INTEGER,
    speed_kts   INTEGER,
    heading     REAL,
    squawk      TEXT,
    on_ground   INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_pos_hex    ON positions(hex);
  CREATE INDEX IF NOT EXISTS idx_pos_ts     ON positions(ts);
  CREATE INDEX IF NOT EXISTS idx_pos_hex_ts ON positions(hex, ts);
  CREATE INDEX IF NOT EXISTS idx_ac_last    ON aircraft(last_seen);
`);

// Migration: add enrichment columns for databases created before this version
['registration TEXT', 'aircraft_type TEXT', 'operator TEXT', 'enriched INTEGER DEFAULT 0'].forEach(col => {
  try { db.exec(`ALTER TABLE aircraft ADD COLUMN ${col}`); } catch {}
});

const stmtUpsert = db.prepare(`
  INSERT INTO aircraft (hex, first_seen, last_seen, total_positions)
  VALUES (?, ?, ?, 1)
  ON CONFLICT(hex) DO UPDATE SET
    last_seen       = excluded.last_seen,
    total_positions = total_positions + 1
`);

const stmtInsert = db.prepare(`
  INSERT INTO positions (hex, ts, callsign, lat, lon, alt_ft, speed_kts, heading, squawk, on_ground)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`);

const ingest = db.transaction((records) => {
  for (const r of records) {
    stmtUpsert.run(r.hex, r.ts, r.ts);
    stmtInsert.run(r.hex, r.ts, r.callsign, r.lat, r.lon, r.alt_ft, r.speed_kts, r.heading, r.squawk, r.on_ground);
  }
});

// ── Enrichment (hexdb.io) ─────────────────────────────────────────────────────

const stmtEnrich = db.prepare(
  `UPDATE aircraft SET registration=?, aircraft_type=?, operator=?, enriched=1 WHERE hex=?`
);
const stmtEnrichFail = db.prepare(`UPDATE aircraft SET enriched=-1 WHERE hex=?`);

async function enrichAircraft(hex) {
  try {
    const res = await fetch(`https://hexdb.io/api/v1/aircraft/${hex}`);
    if (!res.ok) { stmtEnrichFail.run(hex); return; }
    const d = await res.json();
    stmtEnrich.run(d.Registration || null, d.Type || null, d.RegisteredOwners || null, hex);
  } catch (e) {
    console.warn(`\nEnrichment failed for ${hex}:`, e.message);
  }
}

async function enrichPending() {
  const rows = db.prepare(
    `SELECT hex FROM aircraft WHERE COALESCE(enriched, 0) = 0 LIMIT 5`
  ).all();
  for (const { hex } of rows) {
    await enrichAircraft(hex);
    if (rows.length > 1) await new Promise(r => setTimeout(r, 300));
  }
}

// ── Poller ────────────────────────────────────────────────────────────────────

// Plane Finder flights.json array field positions:
// [0]=hex [1]=lat [2]=lon [3]=heading [4]=alt_ft [5]=speed_kts
// [6]=squawk [10]=rx_ts [14]=on_ground [16]=callsign

let liveCount = 0;

function parsePayload(raw) {
  const now = Math.floor(Date.now() / 1000);
  const records = [];

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return records;

  for (const [hex, arr] of Object.entries(raw)) {
    if (!Array.isArray(arr)) continue;

    const rawLat = arr[1];
    const rawLon = arr[2];
    // 0,0 means no position fix — store as NULL
    const hasPos = rawLat !== 0 || rawLon !== 0;

    records.push({
      hex,
      lat:       hasPos ? rawLat        : null,
      lon:       hasPos ? rawLon        : null,
      heading:   arr[3]  ?? null,
      alt_ft:    arr[4]  ?? null,
      speed_kts: (arr[5] != null && arr[5] !== 65535) ? arr[5] : null,
      squawk:    arr[6]  || null,
      on_ground: arr[14] === true ? 1 : 0,
      callsign:  arr[16] || null,
      ts:        now,
    });
  }

  return records;
}

async function poll() {
  try {
    const res = await fetch(`${ADSB_URL}?time=${Date.now()}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = await res.json();
    const records = parsePayload(raw);
    if (records.length) ingest(records);
    liveCount = records.length;
    process.stdout.write(`\r[${new Date().toISOString()}] ${String(liveCount).padStart(3)} aircraft visible`);
  } catch (err) {
    console.error(`\nPoll error: ${err.message}`);
  }
}

poll();
const pollTimer = setInterval(poll, POLL_MS);
enrichPending().catch(() => {});
setInterval(() => enrichPending().catch(() => {}), 15000);

// ── API ───────────────────────────────────────────────────────────────────────

const app = express();

// Allow cross-origin requests (tablet on same LAN may use direct IP)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

app.use(express.json());

// Serve dashboard static files
app.use(express.static(path.join(__dirname, '../dashboard')));

// GET /api/live
// Returns all aircraft seen within the last 30 seconds with their latest position.
app.get('/api/live', (req, res) => {
  const cutoff = Math.floor(Date.now() / 1000) - 30;
  const rows = db.prepare(`
    SELECT
      a.hex, a.first_seen, a.last_seen, a.total_positions,
      a.registration, a.aircraft_type, a.operator,
      p.callsign, p.lat, p.lon, p.alt_ft, p.speed_kts,
      p.heading, p.squawk, p.on_ground
    FROM aircraft a
    JOIN positions p ON p.id = (
      SELECT id FROM positions WHERE hex = a.hex ORDER BY ts DESC LIMIT 1
    )
    WHERE a.last_seen >= ?
    ORDER BY p.alt_ft DESC NULLS LAST
  `).all(cutoff);
  res.json(rows);
});

// GET /api/aircraft?q=
// Returns aircraft list ordered by last seen, optionally filtered by hex or callsign.
app.get('/api/aircraft', (req, res) => {
  const q = req.query.q ? `%${req.query.q.toUpperCase()}%` : null;

  const rows = q
    ? db.prepare(`
        SELECT DISTINCT
          a.hex, a.first_seen, a.last_seen, a.total_positions,
          a.registration, a.aircraft_type, a.operator,
          (SELECT GROUP_CONCAT(DISTINCT callsign) FROM positions
           WHERE hex = a.hex AND callsign IS NOT NULL AND callsign != '') AS callsigns
        FROM aircraft a
        LEFT JOIN positions p ON p.hex = a.hex
        WHERE UPPER(a.hex) LIKE ? OR UPPER(p.callsign) LIKE ? OR UPPER(COALESCE(a.registration,'')) LIKE ?
        GROUP BY a.hex
        ORDER BY a.last_seen DESC
        LIMIT 200
      `).all(q, q, q)
    : db.prepare(`
        SELECT
          a.hex, a.first_seen, a.last_seen, a.total_positions,
          a.registration, a.aircraft_type, a.operator,
          (SELECT GROUP_CONCAT(DISTINCT callsign) FROM positions
           WHERE hex = a.hex AND callsign IS NOT NULL AND callsign != '') AS callsigns
        FROM aircraft a
        ORDER BY a.last_seen DESC
        LIMIT 200
      `).all();

  res.json(rows);
});

// GET /api/aircraft/:hex
// Full detail for one aircraft: stats + distinct callsigns + 50 most recent positions.
app.get('/api/aircraft/:hex', (req, res) => {
  const hex = req.params.hex.toLowerCase();
  const aircraft = db.prepare(`SELECT * FROM aircraft WHERE hex = ?`).get(hex);
  if (!aircraft) return res.status(404).json({ error: 'Not found' });

  const callsigns = db.prepare(`
    SELECT DISTINCT callsign FROM positions
    WHERE hex = ? AND callsign IS NOT NULL AND callsign != ''
    ORDER BY callsign
  `).all(hex).map(r => r.callsign);

  const maxAlt = db.prepare(
    `SELECT MAX(alt_ft) AS n FROM positions WHERE hex = ?`
  ).get(hex).n;

  const maxSpeed = db.prepare(
    `SELECT MAX(speed_kts) AS n FROM positions WHERE hex = ?`
  ).get(hex).n;

  const recent = db.prepare(`
    SELECT ts, callsign, lat, lon, alt_ft, speed_kts, heading, squawk, on_ground
    FROM positions WHERE hex = ?
    ORDER BY ts DESC LIMIT 50
  `).all(hex);

  res.json({ ...aircraft, callsigns, max_alt: maxAlt, max_speed: maxSpeed, recent });
});

// GET /api/aircraft/:hex/track?from=&to=
// All positions with lat/lon for drawing a map track.
// Optionally scoped to a unix timestamp range.
app.get('/api/aircraft/:hex/track', (req, res) => {
  const hex    = req.params.hex.toLowerCase();
  const from   = req.query.from ? Number(req.query.from) : null;
  const to     = req.query.to   ? Number(req.query.to)   : null;

  let sql = `SELECT ts, lat, lon, alt_ft, callsign
             FROM positions WHERE hex = ? AND lat IS NOT NULL`;
  const params = [hex];
  if (from) { sql += ` AND ts >= ?`; params.push(from); }
  if (to)   { sql += ` AND ts <= ?`; params.push(to); }
  sql += ` ORDER BY ts ASC`;

  res.json(db.prepare(sql).all(...params));
});

// GET /api/patterns
app.get('/api/patterns', (req, res) => {
  const now  = Math.floor(Date.now() / 1000);
  const h24  = now - 86400;
  const d7   = now - 7  * 86400;
  const d30  = now - 30 * 86400;

  // Unique aircraft count summary
  const todayCount = db.prepare(
    `SELECT COUNT(DISTINCT hex) AS n FROM positions WHERE ts >= ?`
  ).get(h24).n;
  const weekCount = db.prepare(
    `SELECT COUNT(DISTINCT hex) AS n FROM positions WHERE ts >= ?`
  ).get(d7).n;
  const typeCount = db.prepare(
    `SELECT COUNT(DISTINCT aircraft_type) AS n FROM aircraft WHERE aircraft_type IS NOT NULL`
  ).get().n;
  const operatorCount = db.prepare(
    `SELECT COUNT(DISTINCT operator) AS n FROM aircraft WHERE operator IS NOT NULL AND operator != ''`
  ).get().n;

  // Hourly activity: distinct aircraft per local hour, last 7 days
  const hourly = db.prepare(`
    SELECT CAST(strftime('%H', datetime(ts, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
           COUNT(DISTINCT hex) AS aircraft
    FROM positions WHERE ts >= ?
    GROUP BY hour ORDER BY hour
  `).all(d7);

  // Day-of-week activity: 0=Sun…6=Sat, last 30 days
  const daily = db.prepare(`
    SELECT CAST(strftime('%w', datetime(ts, 'unixepoch', 'localtime')) AS INTEGER) AS dow,
           COUNT(DISTINCT hex) AS aircraft
    FROM positions WHERE ts >= ?
    GROUP BY dow ORDER BY dow
  `).all(d30);

  // Top operators by number of distinct aircraft seen
  const topOperators = db.prepare(`
    SELECT operator, COUNT(*) AS count
    FROM aircraft WHERE operator IS NOT NULL AND operator != ''
    GROUP BY operator ORDER BY count DESC LIMIT 8
  `).all();

  // Top aircraft types
  const topTypes = db.prepare(`
    SELECT aircraft_type, COUNT(*) AS count
    FROM aircraft WHERE aircraft_type IS NOT NULL AND aircraft_type != ''
    GROUP BY aircraft_type ORDER BY count DESC LIMIT 8
  `).all();

  // New individual aircraft first seen in last 24h
  const newAircraft = db.prepare(`
    SELECT hex, registration, aircraft_type, operator, first_seen
    FROM aircraft WHERE first_seen >= ?
    ORDER BY first_seen DESC LIMIT 15
  `).all(h24);

  // New aircraft types — type whose earliest example is within last 7 days
  const newTypes = db.prepare(`
    SELECT aircraft_type, MIN(first_seen) AS first_seen,
           COUNT(*) AS count, MAX(registration) AS example_reg
    FROM aircraft WHERE aircraft_type IS NOT NULL
    GROUP BY aircraft_type
    HAVING MIN(first_seen) >= ?
    ORDER BY first_seen DESC LIMIT 10
  `).all(d7);

  // Rare visitors: ≤20 total positions, seen in last 2h, first seen >7 days ago
  const rareVisitors = db.prepare(`
    SELECT hex, registration, aircraft_type, operator, total_positions, last_seen
    FROM aircraft
    WHERE last_seen >= ? AND total_positions <= 20 AND first_seen <= ?
    ORDER BY last_seen DESC LIMIT 10
  `).all(now - 7200, d7);

  // Operator metrics: today / 7d avg / 30d avg / all-time distinct aircraft
  const operatorMetrics = db.prepare(`
    SELECT a.operator,
      COUNT(DISTINCT CASE WHEN p.ts >= ${h24} THEN p.hex END)  AS today,
      ROUND(CAST(COUNT(DISTINCT CASE WHEN p.ts >= ${d7}  THEN p.hex END) AS REAL) / 7,  1) AS avg7d,
      ROUND(CAST(COUNT(DISTINCT CASE WHEN p.ts >= ${d30} THEN p.hex END) AS REAL) / 30, 1) AS avg30d,
      COUNT(DISTINCT p.hex) AS total
    FROM aircraft a
    JOIN positions p ON p.hex = a.hex
    WHERE a.operator IS NOT NULL AND a.operator != ''
    GROUP BY a.operator ORDER BY total DESC LIMIT 15
  `).all();

  // Type metrics: same shape as operator metrics
  const typeMetrics = db.prepare(`
    SELECT a.aircraft_type,
      COUNT(DISTINCT CASE WHEN p.ts >= ${h24} THEN p.hex END)  AS today,
      ROUND(CAST(COUNT(DISTINCT CASE WHEN p.ts >= ${d7}  THEN p.hex END) AS REAL) / 7,  1) AS avg7d,
      ROUND(CAST(COUNT(DISTINCT CASE WHEN p.ts >= ${d30} THEN p.hex END) AS REAL) / 30, 1) AS avg30d,
      COUNT(DISTINCT p.hex) AS total
    FROM aircraft a
    JOIN positions p ON p.hex = a.hex
    WHERE a.aircraft_type IS NOT NULL AND a.aircraft_type != ''
    GROUP BY a.aircraft_type ORDER BY total DESC LIMIT 15
  `).all();

  // Top aircraft by intensity (total_positions) — also compute days_seen for each
  const topAircraft = db.prepare(`
    WITH top50 AS (
      SELECT hex, registration, aircraft_type, operator, total_positions
      FROM aircraft ORDER BY total_positions DESC LIMIT 50
    )
    SELECT t.*,
      (SELECT COUNT(DISTINCT strftime('%Y-%m-%d', datetime(ts, 'unixepoch', 'localtime')))
       FROM positions WHERE hex = t.hex) AS days_seen
    FROM top50 t
  `).all();

  // Aero club hourly: only computed if hex list provided
  const rawHexes = (req.query.hexes || '').split(',').filter(h => /^[0-9a-f]{1,6}$/i.test(h));
  let aeroclubHourly = [];
  if (rawHexes.length) {
    const ph = rawHexes.map(() => '?').join(',');
    aeroclubHourly = db.prepare(`
      SELECT CAST(strftime('%H', datetime(ts, 'unixepoch', 'localtime')) AS INTEGER) AS hour,
             COUNT(DISTINCT hex) AS aircraft
      FROM positions WHERE ts >= ? AND hex IN (${ph})
      GROUP BY hour ORDER BY hour
    `).all(d7, ...rawHexes);
  }

  res.json({
    summary: { todayCount, weekCount, typeCount, operatorCount },
    hourly, daily, topOperators, topTypes, newAircraft, newTypes, rareVisitors,
    operatorMetrics, typeMetrics, topAircraft, aeroclubHourly,
  });
});

// GET /api/aircraft/by?field=operator|aircraft_type&value=...
app.get('/api/aircraft/by', (req, res) => {
  const { field, value } = req.query;
  if (!['operator', 'aircraft_type'].includes(field)) return res.status(400).json({ error: 'invalid field' });
  const rows = db.prepare(`
    SELECT hex, registration, aircraft_type, operator, total_positions, last_seen
    FROM aircraft WHERE ${field} = ?
    ORDER BY last_seen DESC LIMIT 50
  `).all(value);
  res.json(rows);
});

// PUT /api/aircraft/:hex — manually set registration, type, operator
app.put('/api/aircraft/:hex', (req, res) => {
  const { hex } = req.params;
  const { registration, aircraft_type, operator } = req.body;
  db.prepare(`UPDATE aircraft SET registration=?, aircraft_type=?, operator=?, enriched=-1 WHERE hex=?`)
    .run(registration || null, aircraft_type || null, operator || null, hex);
  res.json({ ok: true });
});

// GET /api/stats
// Summary counts for the dashboard header.
app.get('/api/stats', (req, res) => {
  const dayAgo = Math.floor(Date.now() / 1000) - 86400;
  res.json({
    live:            liveCount,
    today:           db.prepare(`SELECT COUNT(DISTINCT hex) AS n FROM positions WHERE ts >= ?`).get(dayAgo).n,
    total_aircraft:  db.prepare(`SELECT COUNT(*) AS n FROM aircraft`).get().n,
    total_positions: db.prepare(`SELECT COUNT(*) AS n FROM positions`).get().n,
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`\nADS-B Station v0.1`);
  console.log(`Listening on  : http://0.0.0.0:${PORT}`);
  console.log(`Polling       : ${ADSB_URL}`);
  console.log(`Database      : ${DB_PATH}\n`);
});

process.on('SIGTERM', () => {
  clearInterval(pollTimer);
  db.close();
  process.exit(0);
});
