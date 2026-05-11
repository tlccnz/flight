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

  const now     = Math.floor(Date.now() / 1000);
  const seconds = { day: 86400, week: 7 * 86400, month: 30 * 86400, year: 365 * 86400 };
  const since   = now - (seconds[period] || 86400);
  const label   = { day: 'Last 24 Hours', week: 'Last 7 Days', month: 'Last 30 Days', year: 'Last 365 Days' }[period] || 'Last 24 Hours';

  // Chart bucketing: bucket index = floor((ts - since) / bucketSize)
  const bucketSize  = { day: 300, week: 86400, month: 86400, year: 30 * 86400 }[period] || 300;
  const numBuckets  = { day: 288, week: 7,      month: 30,   year: 12          }[period] || 288;

  const [heroRow, chartRows, opRows, typeRows, mostSeenRows, aircraftRows, watchRows] = await Promise.all([
    env.DB.prepare(`
      SELECT
        (SELECT COUNT(*) FROM aircraft) as total_aircraft,
        (SELECT COUNT(DISTINCT hex) FROM positions WHERE ts >= ?) as period_aircraft,
        (SELECT COUNT(*) FROM transitions WHERE ts >= ? AND type = 'takeoff') as period_takeoffs,
        (SELECT COUNT(*) FROM transitions WHERE ts >= ? AND type = 'landing') as period_landings
    `).bind(since, since, since).first(),

    env.DB.prepare(`
      SELECT type, CAST((ts - ?) / ? AS INTEGER) as bucket, COUNT(*) as cnt
      FROM transitions
      WHERE ts >= ?
      GROUP BY type, bucket
      ORDER BY bucket
    `).bind(since, bucketSize, since).all(),

    env.DB.prepare(`
      SELECT a.operator, COUNT(DISTINCT p.hex) as count
      FROM positions p JOIN aircraft a ON a.hex = p.hex
      WHERE p.ts >= ? AND a.operator IS NOT NULL
      GROUP BY a.operator ORDER BY count DESC LIMIT 8
    `).bind(since).all(),

    env.DB.prepare(`
      SELECT a.aircraft_type, a.manufacturer, COUNT(DISTINCT p.hex) as count
      FROM positions p JOIN aircraft a ON a.hex = p.hex
      WHERE p.ts >= ? AND a.aircraft_type IS NOT NULL
      GROUP BY a.aircraft_type ORDER BY count DESC LIMIT 8
    `).bind(since).all(),

    env.DB.prepare(`
      SELECT a.hex, a.registration, a.aircraft_type, a.manufacturer, a.operator, COUNT(p.id) as count
      FROM positions p JOIN aircraft a ON a.hex = p.hex
      WHERE p.ts >= ?
      GROUP BY a.hex ORDER BY count DESC LIMIT 5
    `).bind(since).all(),

    env.DB.prepare(`
      SELECT hex, registration, aircraft_type, manufacturer, operator, country,
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

  // Build pivoted chart: array of {bucket, takeoffs, landings, overhead}
  const chart = Array.from({ length: numBuckets }, (_, i) => ({ bucket: i, takeoffs: 0, landings: 0, overhead: 0 }));
  for (const row of (chartRows.results || [])) {
    if (row.bucket >= 0 && row.bucket < numBuckets) {
      const key = row.type === 'takeoff' ? 'takeoffs' : row.type === 'landing' ? 'landings' : 'overhead';
      chart[row.bucket][key] += row.cnt;
    }
  }

  const maxOp      = Math.max(...(opRows.results      || []).map(r => r.count), 1);
  const maxType    = Math.max(...(typeRows.results     || []).map(r => r.count), 1);
  const maxSeen    = Math.max(...(mostSeenRows.results || []).map(r => r.count), 1);

  return new Response(JSON.stringify({
    period,
    label,
    since,
    bucketSize,
    hero:          heroRow,
    chart,
    top_operators: (opRows.results      || []).map(r => ({ ...r, pct: Math.round(r.count / maxOp   * 100) })),
    top_types:     (typeRows.results    || []).map(r => ({ ...r, pct: Math.round(r.count / maxType * 100) })),
    most_seen:     (mostSeenRows.results|| []).map(r => ({ ...r, pct: Math.round(r.count / maxSeen * 100) })),
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

  // Fetch current state for all aircraft in this batch (single query)
  const hexList     = [...new Set(positions.map(p => p.hex))];
  const placeholders = hexList.map(() => '?').join(',');
  const { results: acRows } = await env.DB.prepare(
    `SELECT hex, prev_on_ground, last_airborne_date, is_notable, registration, operator
     FROM aircraft WHERE hex IN (${placeholders})`
  ).bind(...hexList).all();
  const acMap = Object.fromEntries(acRows.map(r => [r.hex, r]));

  const notifications = [];
  const stateStmts    = [];

  for (const p of positions) {
    const ac = acMap[p.hex];
    if (!ac) continue;

    const isAirborne  = !p.on_ground;
    const wasAirborne = ac.prev_on_ground === 0;
    const wasGround   = ac.prev_on_ground === 1;
    const firstSeen   = ac.prev_on_ground === null;
    const inWatchlist = !!watchmap[p.hex];
    const label       = watchmap[p.hex] || ac.registration || p.hex;
    const callsign    = p.callsign || p.hex;

    // Detect and record state transition
    let transType = null;
    if (isAirborne && wasGround)        transType = 'takeoff';
    else if (!isAirborne && wasAirborne) transType = 'landing';
    else if (isAirborne && firstSeen)    transType = 'overhead';

    if (transType) {
      stateStmts.push(
        env.DB.prepare(`INSERT INTO transitions (hex, ts, type, callsign, alt_ft) VALUES (?, ?, ?, ?, ?)`)
          .bind(p.hex, p.ts, transType, p.callsign ?? null, p.alt_ft ?? null)
      );
    }

    // Notifications + prev_on_ground update
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
    } else {
      stateStmts.push(
        env.DB.prepare(`UPDATE aircraft SET prev_on_ground = ? WHERE hex = ?`).bind(p.on_ground ? 1 : 0, p.hex)
      );
    }
  }

  // Batch state updates in chunks of 100 (D1 limit)
  for (let i = 0; i < stateStmts.length; i += 100) {
    await env.DB.batch(stateStmts.slice(i, i + 100));
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
