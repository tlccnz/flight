# ADS-B Station — Project Context for Claude

## What this is

A personal tablet dashboard showing live and historical aircraft data from a home ADS-B receiver, deployed on a Synology NAS. Part of a broader plan for a tablet home dashboard (weather + aviation tabs).

## Current version: v0.2

### Completed
- Node.js backend polling Plane Finder receiver every 5s
- SQLite database storing every position (option C — full history)
- REST API: `/api/live`, `/api/aircraft`, `/api/aircraft/:hex`, `/api/aircraft/:hex/track`, `/api/stats`, `/api/patterns`
- Dashboard with Live, Map, History, Stats, Settings tabs
- Apple-aesthetic UI (light/dark mode, system font, #007AFF accent)
- Leaflet map with CartoDB tiles (Positron light / DarkMatter dark), aircraft markers, track overlay
- Aircraft enrichment via hexdb.io — registration, type, operator cached in SQLite
- Stats & Patterns tab: summary cards, hourly activity chart, top operators/types, alerts
- Alerts: aero club active, new aircraft types, new individual aircraft, rare visitors
- Aero Club Watch: separate localStorage list (`adsb_aero`), shown in Settings + Stats alerts
- Watchlist stored in localStorage (`adsb_wl`)
- Docker deployment on Synology DS920+

## Infrastructure

| Thing | Value |
|-------|-------|
| ADS-B receiver | `10.10.30.227:8754` (Plane Finder / Pi24) |
| NAS IP | `10.10.20.85` |
| Server port | `3001` (external) → `3000` (container) |
| Data feed URL | `http://10.10.30.227:8754/flights.json?time={ms}` |
| Airport | NZWN — Wellington International (`-41.3272, 174.8053`) |
| DB path (in container) | `/data/adsb.db` |

## Network constraints

- ADS-B receiver is on VLAN 10.10.30.x
- NAS and dashboard clients are on 10.10.20.x
- Only port 8754 is open between the VLANs
- The NAS backend polls the receiver server-to-server (no browser CORS issue)
- Dashboard uses relative API URLs (`/api/...`) since it's served by Express; falls back to `http://10.10.20.85:3000` if opened from `file://`

## Data format

Plane Finder `flights.json` returns an object keyed by ICAO hex. Each value is an array:

```
index: [0]=hex [1]=lat [2]=lon [3]=heading [4]=alt_ft [5]=speed_kts
       [6]=squawk [10]=rx_ts [14]=on_ground(bool) [16]=callsign
```

- `lat=0, lon=0` → no position fix → store as NULL
- `on_ground` is a boolean in the JSON (`true`/`false`)
- `callsign` may be empty string → store as NULL
- `speed_kts=65535` (0xFFFF) → sentinel for no data → store as NULL

## Database schema

### `aircraft` table
```sql
hex TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER,
total_positions INTEGER,
registration TEXT, aircraft_type TEXT, operator TEXT,
enriched INTEGER DEFAULT 0  -- 0=pending, 1=done, -1=not found
```

### `positions` table
```sql
id INTEGER PK, hex TEXT, ts INTEGER,
callsign TEXT, lat REAL, lon REAL,
alt_ft INTEGER, speed_kts INTEGER, heading REAL,
squawk TEXT, on_ground INTEGER
```
Indexes: `idx_pos_hex`, `idx_pos_ts`, `idx_pos_hex_ts`, `idx_ac_last`

## Enrichment

- Source: `https://hexdb.io/api/v1/aircraft/{hex}` (free, no auth)
- Fields used: `Registration`, `Type`, `RegisteredOwners`
- Runs every 15s, processes up to 5 pending aircraft at a time
- `enriched = -1` if not found, won't retry
- Migration-safe: columns added via `ALTER TABLE` with try/catch

## Design decisions

### UI / Frontend
- **Apple aesthetic**: system-ui font, `#007AFF` blue, `#F2F2F7` light background, white cards, 12px border-radius, subtle shadows
- **No JS framework** — vanilla HTML/CSS/JS only
- **Dark mode** via `data-theme` attribute on `<html>`, CSS variables, persisted to localStorage
- **Map**: Leaflet 1.9.4 with CartoDB Positron (light) / DarkMatter (dark) tiles
- **Aircraft markers**: canvas-drawn SVG divIcon rotated to heading. Blue = normal, amber = watchlist, green = on ground
- **Map tile swap** on theme toggle handled in `applyTheme()`
- localStorage keys: `adsb_wl` (watchlist), `adsb_aero` (aero club), `adsb_cfg` (settings)

### Backend
- `better-sqlite3` (synchronous, no async complexity)
- WAL mode + NORMAL synchronous for performance
- All ingestion in a single transaction per poll cycle
- `liveCount` is an in-memory variable updated by the poller
- Node.js 20 built-in `fetch` used for both ADS-B polling and hexdb.io enrichment

### Deployment
- `docker-compose up -d --build` required when `server.js` changes (baked into image)
- `dashboard/index.html` is bind-mounted at `/dashboard` in the container — copy file only, no rebuild needed
- Named volume `adsb-data` for SQLite persistence

## API reference

| Endpoint | Description |
|----------|-------------|
| `GET /api/live` | Aircraft seen in last 30s with latest position + enrichment |
| `GET /api/aircraft?q=` | Aircraft list (search by hex, callsign, registration) |
| `GET /api/aircraft/:hex` | Full detail: stats, callsigns, enrichment, recent positions |
| `GET /api/aircraft/:hex/track` | Position history for map track |
| `GET /api/stats` | Live count, today, total aircraft, total positions |
| `GET /api/patterns` | Summary stats, hourly chart, top operators/types, alerts data |

## Planned future work

### Later
- **Weather tab** — pull from local Ambient Weather station
- **Cesium 3D track replay** — load Cesium on demand for 3D track view (not always-on map)
- **Notifications** — push alert when a watched/aero club aircraft is visible
- **Squawk alerts** — flag 7500/7600/7700 emergency codes
- **Runway inference** — detect active NZWN runway from approach headings + wind data

## Preferences and constraints

- Keep UI minimal — no feature creep beyond what's asked
- No TypeScript, no bundlers, no frameworks — plain Node.js and vanilla JS
- Tablet-first layout (iPad-sized viewport)
- Redeploy with `docker-compose up -d --build` after server changes

## Standing instructions — how to work on this codebase

- **Read before writing.** Before adding any HTML, CSS, or JS, grep for existing classes and functions that touch the same area. Never assume a class name is free to use — check what it does first.
- **Understand the full picture before making a change.** Read the relevant section of the file in full. Don't patch a small piece without knowing what surrounds it.
- **No incremental patching of broken code.** If something doesn't work, stop and diagnose the root cause. Don't layer fixes on top of a broken foundation.
- **Test logic mentally before writing.** Trace through the code path — DOM structure, function calls, variable scope — before committing to an approach.
- **One correct implementation, not several mediocre ones.** Getting it right the first time is the only acceptable standard.
