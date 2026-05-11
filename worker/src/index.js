import DASHBOARD_HTML from './dashboard.html';

const NOTABLE_KEYWORDS = [
  'air force', 'rnzaf', 'navy', 'rnzn', 'army', 'military', 'defence', 'defense',
  'police', 'government', 'customs', 'coastguard', 'coast guard', 'border',
];

function isNotable(data) {
  const hay = [data.RegisteredOwners, data.Type, data.Manufacturer]
    .filter(Boolean).join(' ').toLowerCase();
  return NOTABLE_KEYWORDS.some(kw => hay.includes(kw));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // ── Public routes ────────────────────────────────────────────────────────
    if (request.method === 'GET' && url.pathname === '/') {
      return new Response(DASHBOARD_HTML, {
        headers: { 'Content-Type': 'text/html;charset=utf-8' },
      });
    }
    if (request.method === 'GET' && url.pathname === '/stats') {
      return handleStats(request, env);
    }

    // ── Protected routes ─────────────────────────────────────────────────────
    if (request.headers.get('X-API-Key') !== env.API_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }
    if (request.method === 'POST' && url.pathname === '/ingest') return handleIngest(request, env);
    if (url.pathname === '/watchlist') return handleWatchlist(request, env);

    return new Response('flight API', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEnrichment(env));
  },
};

// ── Stats ─────────────────────────────────────────────────────────────────────

async function handleStats(request, env) {
  const url    = new URL(request.url);
  const period = url.searchParams.get('period') || 'day';

  const seconds = { day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 };
  const since   = Math.floor(Date.now() / 1000) - (seconds[period] || 86400);
  const label   = { day: 'Last 24 Hours', week: 'Last 7 Days', month: 'Last 30 Days', year: 'Last 365 Days' }[period] || 'Last 24 Hours';

  // NZ offset: NZST = UTC+12 = 43200s (close enough year-round; 1h off during NZDT Oct–Apr)
  const NZ_OFFSET = 43200;

  const [heroRow, hourlyRows, opRows, typeRows, aircraftRows, watchRows] = await Promise.all([
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM aircraft) as total_aircraft,
        (SELECT COUNT(DISTINCT hex) FROM positions WHERE ts >= ?) as period_aircraft,
        (SELECT COUNT(*) FROM positions WHERE ts >= ?) as period_positions,
        (SELECT COUNT(DISTINCT a.operator) FROM aircraft a
          JOIN positions p ON p.hex = a.hex
          WHERE p.ts >= ? AND a.operator IS NOT NULL) as period_operators
    `).bind(since, since, since).first(),

    env.DB.prepare(`
      SELECT CAST(((ts + ?) % 86400) / 3600 AS INTEGER) as hour_nz, COUNT(*) as cnt
      FROM positions GROUP BY hour_nz ORDER BY hour_nz
    `).bind(NZ_OFFSET).all(),

    env.DB.prepare(`
      SELECT a.operator, COUNT(DISTINCT p.hex) as count
      FROM positions p JOIN aircraft a ON a.hex = p.hex
      WHERE p.ts >= ? AND a.operator IS NOT NULL
      GROUP BY a.operator ORDER BY count DESC LIMIT 8
    `).bind(since).all(),

    env.DB.prepare(`
      SELECT a.aircraft_type, COUNT(DISTINCT p.hex) as count
      FROM positions p JOIN aircraft a ON a.hex = p.hex
      WHERE p.ts >= ? AND a.aircraft_type IS NOT NULL
      GROUP BY a.aircraft_type ORDER BY count DESC LIMIT 8
    `).bind(since).all(),

    env.DB.prepare(`
      SELECT hex, registration, aircraft_type, operator, country,
             first_seen, last_seen, total_positions, is_notable
      FROM aircraft ORDER BY last_seen DESC LIMIT 500
    `).all(),

    env.DB.prepare(`
      SELECT w.hex, w.label, a.registration, a.aircraft_type, a.operator,
             a.last_seen, a.total_positions,
             (SELECT on_ground FROM positions WHERE hex = w.hex ORDER BY ts DESC LIMIT 1) as on_ground,
             (SELECT callsign FROM positions WHERE hex = w.hex AND callsign IS NOT NULL ORDER BY ts DESC LIMIT 1) as callsign
      FROM watchlist w LEFT JOIN aircraft a ON a.hex = w.hex
      ORDER BY COALESCE(a.last_seen, 0) DESC
    `).all(),
  ]);

  // Fill all 24 hours with zeros for missing hours
  const hourMap = Object.fromEntries((hourlyRows.results || []).map(r => [r.hour_nz, r.cnt]));
  const hourly  = Array.from({ length: 24 }, (_, h) => ({ hour: h, count: hourMap[h] || 0 }));

  // Add percentage for bar charts
  const maxOp   = Math.max(...(opRows.results || []).map(r => r.count), 1);
  const maxType = Math.max(...(typeRows.results || []).map(r => r.count), 1);

  return new Response(JSON.stringify({
    period,
    label,
    hero:          heroRow,
    hourly,
    top_operators: (opRows.results   || []).map(r => ({ ...r, pct: Math.round(r.count / maxOp   * 100) })),
    top_types:     (typeRows.results || []).map(r => ({ ...r, pct: Math.round(r.count / maxType * 100) })),
    aircraft:      aircraftRows.results || [],
    watchlist:     watchRows.results    || [],
  }), {
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });
}

// ── Ingest ────────────────────────────────────────────────────────────────────

async function handleIngest(request, env) {
  let positions;
  try {
    positions = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!Array.isArray(positions) || positions.length === 0) {
    return new Response('No positions', { status: 400 });
  }

  const { results: watchRows } = await env.DB.prepare(`SELECT hex, label FROM watchlist`).all();
  const watchmap = Object.fromEntries(watchRows.map(r => [r.hex, r.label]));

  const todayNZ = new Date().toLocaleDateString('en-NZ', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).split('/').reverse().join('-');

  const posStmts = positions.flatMap(p => [
    env.DB.prepare(`
      INSERT INTO aircraft (hex, first_seen, last_seen, total_positions, enriched)
      VALUES (?, ?, ?, 1, 0)
      ON CONFLICT(hex) DO UPDATE SET
        last_seen       = MAX(last_seen, excluded.last_seen),
        total_positions = total_positions + 1
    `).bind(p.hex, p.ts, p.ts),

    env.DB.prepare(`
      INSERT OR IGNORE INTO positions
        (hex, ts, callsign, lat, lon, alt_ft, speed_kts, heading, squawk, on_ground)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      p.hex, p.ts,
      p.callsign ?? null, p.lat ?? null, p.lon ?? null,
      p.alt_ft ?? null, p.speed_kts ?? null, p.heading ?? null,
      p.squawk ?? null, p.on_ground ? 1 : 0,
    ),
  ]);

  await env.DB.batch(posStmts);

  // Immediately enrich new airborne aircraft (up to 5 per batch)
  const newAirborne = positions.filter(p => !p.on_ground);
  let enrichedCount = 0;
  for (const p of newAirborne) {
    if (enrichedCount >= 5) break;
    const ac = await env.DB.prepare(`SELECT enriched FROM aircraft WHERE hex = ?`).bind(p.hex).first();
    if (ac?.enriched === 0) { await enrichAircraft(p.hex, env); enrichedCount++; }
  }

  // Check watchlist and notable aircraft for state changes
  const notifications = [];
  const toCheck = positions.filter(p => watchmap[p.hex] || !p.on_ground);

  for (const p of toCheck) {
    const ac = await env.DB.prepare(
      `SELECT prev_on_ground, last_airborne_date, is_notable, registration, operator FROM aircraft WHERE hex = ?`
    ).bind(p.hex).first();

    if (!ac) continue;

    const inWatchlist = !!watchmap[p.hex];
    const label       = watchmap[p.hex] || ac.registration || p.hex;
    const callsign    = p.callsign || p.hex;
    const isAirborne  = !p.on_ground;
    const wasAirborne = ac.prev_on_ground === 0;
    const stateStmts  = [];

    if (inWatchlist) {
      if (isAirborne && ac.last_airborne_date !== todayNZ) {
        notifications.push({ hex: p.hex, label, callsign, event: 'airborne' });
        stateStmts.push(
          env.DB.prepare(`UPDATE aircraft SET last_airborne_date = ?, prev_on_ground = 0 WHERE hex = ?`).bind(todayNZ, p.hex)
        );
      } else if (!isAirborne && wasAirborne) {
        notifications.push({ hex: p.hex, label, callsign, event: 'landed' });
        stateStmts.push(
          env.DB.prepare(`UPDATE aircraft SET prev_on_ground = 1 WHERE hex = ?`).bind(p.hex)
        );
      } else {
        stateStmts.push(
          env.DB.prepare(`UPDATE aircraft SET prev_on_ground = ? WHERE hex = ?`).bind(p.on_ground ? 1 : 0, p.hex)
        );
      }
    } else if (ac.is_notable && isAirborne && ac.last_airborne_date !== todayNZ) {
      const detail = ac.operator ? ` (${ac.operator})` : '';
      notifications.push({ hex: p.hex, label: ac.registration || p.hex, callsign, event: 'notable', detail });
      stateStmts.push(
        env.DB.prepare(`UPDATE aircraft SET last_airborne_date = ?, prev_on_ground = 0 WHERE hex = ?`).bind(todayNZ, p.hex)
      );
    } else if (!inWatchlist) {
      stateStmts.push(
        env.DB.prepare(`UPDATE aircraft SET prev_on_ground = ? WHERE hex = ?`).bind(p.on_ground ? 1 : 0, p.hex)
      );
    }

    if (stateStmts.length) await env.DB.batch(stateStmts);
  }

  return new Response(JSON.stringify({ ok: true, count: positions.length, notifications }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Watchlist ─────────────────────────────────────────────────────────────────

async function handleWatchlist(request, env) {
  if (request.method === 'GET') {
    const { results } = await env.DB.prepare(`SELECT hex, label FROM watchlist ORDER BY hex`).all();
    return new Response(JSON.stringify(results), { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'POST') {
    const { hex, label } = await request.json();
    if (!hex) return new Response('hex required', { status: 400 });
    await env.DB.prepare(
      `INSERT INTO watchlist (hex, label) VALUES (?, ?) ON CONFLICT(hex) DO UPDATE SET label = excluded.label`
    ).bind(hex.toLowerCase(), label ?? hex).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  if (request.method === 'DELETE') {
    const { hex } = await request.json();
    if (!hex) return new Response('hex required', { status: 400 });
    await env.DB.prepare(`DELETE FROM watchlist WHERE hex = ?`).bind(hex.toLowerCase()).run();
    return new Response(JSON.stringify({ ok: true }), { headers: { 'Content-Type': 'application/json' } });
  }

  return new Response('Method not allowed', { status: 405 });
}

// ── Enrichment ────────────────────────────────────────────────────────────────

async function runEnrichment(env) {
  const { results } = await env.DB.prepare(`SELECT hex FROM aircraft WHERE enriched = 0 LIMIT 10`).all();
  for (const { hex } of results) await enrichAircraft(hex, env);
}

async function enrichAircraft(hex, env) {
  let data;
  try {
    const res = await fetch(`https://hexdb.io/api/v1/aircraft/${hex}`, { signal: AbortSignal.timeout(5000) });
    if (res.status === 404) {
      await env.DB.prepare(`UPDATE aircraft SET enriched = -1 WHERE hex = ?`).bind(hex).run();
      return;
    }
    data = await res.json();
  } catch {
    return;
  }

  await env.DB.prepare(`
    UPDATE aircraft SET
      registration  = ?,
      aircraft_type = ?,
      icao_type     = ?,
      operator      = ?,
      manufacturer  = ?,
      country       = ?,
      is_notable    = ?,
      enriched      = 1
    WHERE hex = ?
  `).bind(
    data.Registration     ?? null,
    data.Type             ?? null,
    data.ICAOTypeCode     ?? null,
    data.RegisteredOwners ?? null,
    data.Manufacturer     ?? null,
    data.Country          ?? null,
    isNotable(data) ? 1 : 0,
    hex,
  ).run();
}
