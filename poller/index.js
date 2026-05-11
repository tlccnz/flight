// Plane Finder flights.json array field positions:
// [0]=hex [1]=lat [2]=lon [3]=heading [4]=alt_ft [5]=speed_kts
// [6]=squawk [10]=rx_ts [14]=on_ground [16]=callsign

const RECEIVER_URL = process.env.RECEIVER_URL || 'http://10.10.30.227:8754/flights.json';
const WORKER_URL   = process.env.WORKER_URL;   // required — your deployed worker URL
const API_KEY      = process.env.API_KEY;       // required — matches worker secret
const POLL_MS      = parseInt(process.env.POLL_MS || '30000', 10);

if (!WORKER_URL || !API_KEY) {
  console.error('WORKER_URL and API_KEY env vars are required');
  process.exit(1);
}

function parse(raw) {
  const speed = raw[5];
  return {
    hex:       (raw[0] ?? '').toLowerCase(),
    lat:       raw[1] ?? null,
    lon:       raw[2] ?? null,
    heading:   raw[3] ?? null,
    alt_ft:    raw[4] ?? null,
    speed_kts: (speed === 65535 || speed == null) ? null : speed,
    squawk:    raw[6] ?? null,
    ts:        raw[10] ?? Math.floor(Date.now() / 1000),
    on_ground: raw[14] ? 1 : 0,
    callsign:  raw[16]?.trim() || null,
  };
}

async function poll() {
  let data;
  try {
    const res = await fetch(RECEIVER_URL, { signal: AbortSignal.timeout(5000) });
    data = await res.json();
  } catch (err) {
    console.error(`[poll] receiver error: ${err.message}`);
    return;
  }

  const raw = Array.isArray(data) ? data : (data?.aircraft ?? []);
  const positions = raw
    .map(parse)
    .filter((p) => p.hex && p.lat != null && p.lon != null);

  if (positions.length === 0) return;

  try {
    const res = await fetch(`${WORKER_URL}/ingest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key': API_KEY,
      },
      body: JSON.stringify(positions),
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json();
    console.log(`[${new Date().toISOString()}] ${positions.length} positions → ${JSON.stringify(body)}`);
  } catch (err) {
    console.error(`[poll] worker error: ${err.message}`);
  }
}

poll();
setInterval(poll, POLL_MS);
