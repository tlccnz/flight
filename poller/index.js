// Plane Finder flights.json array field positions:
// [0]=hex [1]=lat [2]=lon [3]=heading [4]=alt_ft [5]=speed_kts
// [6]=squawk [10]=rx_ts [14]=on_ground [16]=callsign

const RECEIVER_URL = process.env.RECEIVER_URL || 'http://10.10.30.227:8754/flights.json';
const WORKER_URL   = process.env.WORKER_URL;
const API_KEY      = process.env.API_KEY;
const NTFY_URL     = process.env.NTFY_URL; // e.g. http://10.10.20.85:2586/flight-alerts
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

async function sendNtfy(notification) {
  if (!NTFY_URL) return;

  const { label, callsign, event } = notification;
  const title   = event === 'airborne' ? `✈️ ${label} is airborne` : `🛬 ${label} has landed`;
  const message = callsign && callsign !== label ? `Callsign: ${callsign}` : ' ';

  try {
    await fetch(NTFY_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, message, priority: 3 }),
      signal: AbortSignal.timeout(5000),
    });
  } catch (err) {
    console.error(`[ntfy] ${err.message}`);
  }
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

  const raw = Array.isArray(data) ? data : Object.values(data);
  const positions = raw
    .map(parse)
    .filter((p) => p.hex && p.lat != null && p.lon != null);

  if (positions.length === 0) return;

  let body;
  try {
    const res = await fetch(`${WORKER_URL}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': API_KEY },
      body: JSON.stringify(positions),
      signal: AbortSignal.timeout(10000),
    });
    body = await res.json();
    console.log(`[${new Date().toISOString()}] ${positions.length} positions → ${JSON.stringify(body)}`);
  } catch (err) {
    console.error(`[poll] worker error: ${err.message}`);
    return;
  }

  if (body.notifications?.length) {
    for (const n of body.notifications) {
      console.log(`[ntfy] ${n.event}: ${n.label} (${n.callsign})`);
      await sendNtfy(n);
    }
  }
}

poll();
setInterval(poll, POLL_MS);
