const NOTABLE_KEYWORDS = [
  'air force', 'rnzaf', 'navy', 'rnzn', 'army', 'military', 'defence', 'defense',
  'police', 'government', 'customs', 'coastguard', 'coast guard', 'border',
];

function isNotable(data) {
  const hay = [data.RegisteredOwners, data.Type, data.Manufacturer]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return NOTABLE_KEYWORDS.some((kw) => hay.includes(kw));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.headers.get('X-API-Key') !== env.API_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }

    if (request.method === 'POST' && url.pathname === '/ingest') {
      return handleIngest(request, env);
    }

    if (url.pathname === '/watchlist') {
      return handleWatchlist(request, env);
    }

    return new Response('flight ingest API', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEnrichment(env));
  },
};

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

  // Fetch watchlist once per ingest batch
  const { results: watchRows } = await env.DB.prepare(
    `SELECT hex, label FROM watchlist`
  ).all();
  const watchmap = Object.fromEntries(watchRows.map((r) => [r.hex, r.label]));

  const todayNZ = new Date().toLocaleDateString('en-NZ', {
    timeZone: 'Pacific/Auckland',
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).split('/').reverse().join('-'); // YYYY-MM-DD

  const posStmts = positions.flatMap((p) => [
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

  const notifications = [];

  // Check watchlist and notable aircraft for state changes
  const toCheck = positions.filter((p) => watchmap[p.hex] || !p.on_ground);

  for (const p of toCheck) {
    const ac = await env.DB.prepare(
      `SELECT prev_on_ground, last_airborne_date, is_notable, registration, operator FROM aircraft WHERE hex = ?`
    ).bind(p.hex).first();

    if (!ac) continue;

    const inWatchlist = !!watchmap[p.hex];
    const label = watchmap[p.hex] || ac.registration || p.hex;
    const callsign = p.callsign || p.hex;
    const isAirborne = !p.on_ground;
    const wasAirborne = ac.prev_on_ground === 0;
    const stateStmts = [];

    if (inWatchlist) {
      if (isAirborne && ac.last_airborne_date !== todayNZ) {
        notifications.push({ hex: p.hex, label, callsign, event: 'airborne' });
        stateStmts.push(
          env.DB.prepare(
            `UPDATE aircraft SET last_airborne_date = ?, prev_on_ground = 0 WHERE hex = ?`
          ).bind(todayNZ, p.hex)
        );
      } else if (!isAirborne && wasAirborne) {
        notifications.push({ hex: p.hex, label, callsign, event: 'landed' });
        stateStmts.push(
          env.DB.prepare(`UPDATE aircraft SET prev_on_ground = 1 WHERE hex = ?`).bind(p.hex)
        );
      } else {
        stateStmts.push(
          env.DB.prepare(`UPDATE aircraft SET prev_on_ground = ? WHERE hex = ?`)
            .bind(p.on_ground ? 1 : 0, p.hex)
        );
      }
    } else if (ac.is_notable && isAirborne && ac.last_airborne_date !== todayNZ) {
      // Notable but not watchlisted — notify airborne once per day
      const notableLabel = ac.registration || p.hex;
      const detail = ac.operator ? ` (${ac.operator})` : '';
      notifications.push({
        hex: p.hex,
        label: notableLabel,
        callsign,
        event: 'notable',
        detail,
      });
      stateStmts.push(
        env.DB.prepare(
          `UPDATE aircraft SET last_airborne_date = ?, prev_on_ground = 0 WHERE hex = ?`
        ).bind(todayNZ, p.hex)
      );
    } else if (!inWatchlist) {
      stateStmts.push(
        env.DB.prepare(`UPDATE aircraft SET prev_on_ground = ? WHERE hex = ?`)
          .bind(p.on_ground ? 1 : 0, p.hex)
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
  const { results } = await env.DB.prepare(
    `SELECT hex FROM aircraft WHERE enriched = 0 LIMIT 10`
  ).all();

  for (const { hex } of results) {
    await enrichAircraft(hex, env);
  }
}

async function enrichAircraft(hex, env) {
  let data;
  try {
    const res = await fetch(`https://hexdb.io/api/v1/aircraft/${hex}`, {
      signal: AbortSignal.timeout(5000),
    });
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
    data.Registration      ?? null,
    data.Type              ?? null,
    data.ICAOTypeCode      ?? null,
    data.RegisteredOwners  ?? null,
    data.Manufacturer      ?? null,
    data.Country           ?? null,
    isNotable(data) ? 1 : 0,
    hex,
  ).run();
}
