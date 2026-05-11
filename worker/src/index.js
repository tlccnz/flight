export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'POST' && url.pathname === '/ingest') {
      return handleIngest(request, env);
    }

    return new Response('flight ingest API', { status: 200 });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(runEnrichment(env));
  },
};

// ── Ingest ────────────────────────────────────────────────────────────────────

async function handleIngest(request, env) {
  if (request.headers.get('X-API-Key') !== env.API_KEY) {
    return new Response('Unauthorized', { status: 401 });
  }

  let positions;
  try {
    positions = await request.json();
  } catch {
    return new Response('Invalid JSON', { status: 400 });
  }

  if (!Array.isArray(positions) || positions.length === 0) {
    return new Response('No positions', { status: 400 });
  }

  const stmts = positions.flatMap((p) => [
    // Upsert aircraft row — track first/last seen and running position count
    env.DB.prepare(`
      INSERT INTO aircraft (hex, first_seen, last_seen, total_positions, enriched)
      VALUES (?, ?, ?, 1, 0)
      ON CONFLICT(hex) DO UPDATE SET
        last_seen       = MAX(last_seen, excluded.last_seen),
        total_positions = total_positions + 1
    `).bind(p.hex, p.ts, p.ts),

    // Insert position — silently skip exact duplicates (same hex+ts)
    env.DB.prepare(`
      INSERT OR IGNORE INTO positions
        (hex, ts, callsign, lat, lon, alt_ft, speed_kts, heading, squawk, on_ground)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).bind(
      p.hex,
      p.ts,
      p.callsign ?? null,
      p.lat ?? null,
      p.lon ?? null,
      p.alt_ft ?? null,
      p.speed_kts ?? null,
      p.heading ?? null,
      p.squawk ?? null,
      p.on_ground ? 1 : 0,
    ),
  ]);

  await env.DB.batch(stmts);

  return new Response(JSON.stringify({ ok: true, count: positions.length }), {
    headers: { 'Content-Type': 'application/json' },
  });
}

// ── Enrichment ────────────────────────────────────────────────────────────────

async function runEnrichment(env) {
  const rows = await env.DB.prepare(`
    SELECT hex FROM aircraft WHERE enriched = 0 LIMIT 10
  `).all();

  if (!rows.results.length) return;

  for (const { hex } of rows.results) {
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
    return; // transient error — will retry next cron run
  }

  await env.DB.prepare(`
    UPDATE aircraft SET
      registration  = ?,
      aircraft_type = ?,
      icao_type     = ?,
      operator      = ?,
      manufacturer  = ?,
      country       = ?,
      enriched      = 1
    WHERE hex = ?
  `).bind(
    data.Registration    ?? null,
    data.Type            ?? null,
    data.ICAOTypeCode    ?? null,
    data.RegisteredOwners ?? null,
    data.Manufacturer    ?? null,
    data.Country         ?? null,
    hex,
  ).run();
}
