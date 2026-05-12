# Flight — Project Context for Claude

## What this is

A cloud-based ADS-B flight tracking system for NZWN (Wellington International Airport). Captures aircraft position data from a local Pi24 receiver, stores it in Cloudflare D1, enriches aircraft metadata, and serves a browser dashboard with stats, charts, and push notifications via ntfy.sh.

## Repository

`tlccnz/flight` on GitHub (SSH: `git@github.com:tlccnz/flight.git`)

## Infrastructure

| Thing | Value |
|-------|-------|
| ADS-B receiver | `10.10.30.227:8754/flights.json` (Plane Finder / Pi24) |
| NAS | Synology DS920+ at `10.10.20.85` |
| Cloudflare Worker | `https://flight.mason-kevinc.workers.dev` |
| D1 database | `flight` (ID: `61f77d76-83cf-41f1-ae38-ef7a600cea7e`) |
| ntfy topic | `https://ntfy.sh/flight-alerts-f655e44d4857d71e` |
| Airport | NZWN — Wellington International |

## Stack

- **Cloudflare Worker** (`worker/`) — ingest API, stats API, dashboard HTML, scheduled enrichment
- **Node.js poller** (`poller/`) — polls receiver every 15s, POSTs to Worker, delivers ntfy notifications
- **Cloudflare D1** — SQLite-compatible cloud database
- **ntfy.sh** — push notifications to phone
- **Design system** — Stitch (Manrope font, `border-radius: 2rem` cards, CSS custom properties)

## Deployment

```bash
# Worker (from worker/ directory)
wrangler deploy

# D1 migrations
wrangler d1 execute flight --file=migrations/000N_name.sql --remote

# Poller (on NAS, requires sudo)
sudo docker-compose -f ~/docker/flight/docker-compose.yml up -d --build
```

Always commit + deploy after every change. Never leave local-only.

## Data format

Plane Finder `flights.json` returns an object keyed by ICAO hex. Each value is an array:
```
[0]=hex [1]=lat [2]=lon [3]=heading [4]=alt_ft [5]=speed_kts
[6]=squawk [10]=rx_ts [14]=on_ground(bool) [16]=callsign
```
- `speed_kts=65535` (0xFFFF) → sentinel for no data → store as NULL
- `on_ground` is unreliable — transponders frequently report wrong value
- `alt_ft` is frequently 0 or negative even when airborne — do not use for logic

## D1 Schema

### `aircraft`
```sql
hex TEXT PRIMARY KEY, first_seen INTEGER, last_seen INTEGER,
total_positions INTEGER, registration TEXT, aircraft_type TEXT,
icao_type TEXT, operator TEXT, manufacturer TEXT, country TEXT,
is_notable INTEGER DEFAULT 0, enriched INTEGER DEFAULT 0,
last_airborne_date TEXT, prev_on_ground INTEGER,
ground_streak INTEGER DEFAULT 0, air_streak INTEGER DEFAULT 0,
sighting_count INTEGER DEFAULT 0
```
- `enriched`: 0=pending, 1=done, -1=not found in hexdb.io

### `positions`
```sql
id INTEGER PK AUTOINCREMENT, hex TEXT, ts INTEGER,
callsign TEXT, lat REAL, lon REAL, alt_ft INTEGER,
speed_kts INTEGER, heading INTEGER, squawk TEXT, on_ground INTEGER,
UNIQUE(hex, ts)
```

### `watchlist`
```sql
hex TEXT PRIMARY KEY, label TEXT
```

### `transitions`
```sql
id INTEGER PK AUTOINCREMENT, hex TEXT, ts INTEGER,
type TEXT,  -- 'takeoff', 'landing', 'overhead'
callsign TEXT, alt_ft INTEGER
```

## Sighting logic

A **sighting** = one visit to the area. Counted as `landing` + `overhead` transitions only. Takeoffs don't count (they're departures from an existing visit).

### State machine (per aircraft, per ingest)

**Airborne debounce:** requires 2 consecutive `on_ground=0` readings before accepting as airborne.
- `air_streak` increments each poll while airborne (capped at 2)
- At `air_streak >= 2`: record transition (takeoff if was on ground, overhead if first ever seen)
- Resets to 0 on first on-ground reading

**Ground debounce:** requires 2 consecutive `on_ground=1` readings before confirming landing.
- `ground_streak` increments each poll while on ground (capped at 2)
- At `ground_streak === 2` AND `ground_streak` was previously 1 (i.e. `groundStreak===1`): record landing
- Aircraft first seen on ground: jump straight to streak=2, no landing recorded
- Resets to 0 on first airborne reading

**Overhead vs takeoff:**
- `prev_on_ground === null`: first ever sighting airborne → `overhead`
- `ground_streak >= 1`: was on ground → `takeoff`

**Landing guard:** only fire if `groundStreak === 1` at confirmation time (ensures it started from airborne state).

## Notifications

Worker returns `notifications[]` in ingest response. Poller delivers them to ntfy.
- **airborne**: watchlist aircraft goes airborne (once per day per aircraft)
- **landed**: watchlist aircraft landing confirmed (requires debounce)
- **notable**: notable aircraft (military/government/police) first seen airborne today

Priority: 2 (low). ntfy topic has no friendly name (not a supported feature).

## Enrichment

- Source: `https://hexdb.io/api/v1/aircraft/{hex}`
- Fields: Registration, Type, ICAOTypeCode, RegisteredOwners (operator), Manufacturer, Country
- Scheduled: cron every 5 min, up to 10 aircraft per run
- Also enriches up to 5 new airborne aircraft immediately on ingest
- `enriched = -1` if 404 — won't retry automatically
- Manual update via `wrangler d1 execute flight --command="UPDATE aircraft SET ..."` for unknown aircraft

## Known aircraft manually enriched

Several NZ-registered aircraft not in hexdb.io, updated manually:
- `c80a2a` ZK-JKH — Cessna A185F
- `c82b55` ZK-LFW — Beechcraft King Air 200C
- `c827e4` ZK-ZUG — Gippsland Aeronautics GA8
- `c81456` ZK-TWR — Piper PA-38 Tomahawk
- `c80de3` ZK-WAC — Piper PA-38 Tomahawk
- `c80429` ZK-EKE — Cessna 172N
- `c82aa1` ZK-FDT — Beechcraft King Air B200 (New Zealand Flying Doctors Service)

## Watchlist

Current watchlist (GA aircraft only — A320s removed):
- ZK-TWR, ZK-WAC, ZK-TAW (Piper PA-38 Tomahawk)
- ZK-EKE (Cessna 172N)

## Dashboard

Single-file HTML (`worker/src/dashboard.html`), imported as text module. Auto-refreshes every 15s.

- **Hero cards**: Total Aircraft | Aircraft (period) | Takeoffs | Landings
- **Chart**: Day = line graph, 5-min buckets, 3 series (takeoffs/landings/overhead); Week/Month/Year = stacked bar
- **Top Operators** + **Top Aircraft Types** (manufacturer prepended to type)
- **Most Frequently Seen**: top 5 all-time by sighting_count
- **Watchlist**: status badges (Airborne/Ground)
- **All Aircraft**: manufacturer before type in column order
- Column order: Reg | Manufacturer | Type | Operator | Country | Last Seen | Visits

## Notable keyword detection

```js
['air force','rnzaf','navy','rnzn','army','military','defence','defense',
 'police','government','customs','coastguard','coast guard','border']
```
Checked against operator + type + manufacturer fields on enrichment.

## Data quality notes

- `on_ground` flag from transponders is unreliable — common to see wrong values during taxi/approach
- `alt_ft` frequently reports 0 or negative for airborne aircraft — do not filter on altitude
- Touch-and-go training circuits produce rapid landing/takeoff sequences — these are real
- Air NZ regional fleet (ZK-NE*, ZK-MV*) does many movements per day at NZWN
- False transitions from noisy transponders are the main data quality challenge — solved via debounce

## Poller environment variables

```
RECEIVER_URL=http://10.10.30.227:8754/flights.json
WORKER_URL=https://flight.mason-kevinc.workers.dev
API_KEY=289d176c97499df7b960672cdaf33ed411a7397ce3df560fd0c18ea0d67ed256
POLL_MS=15000
NTFY_URL=https://ntfy.sh/flight-alerts-f655e44d4857d71e
```

## Migrations (applied)

| File | Description |
|------|-------------|
| `0001_enrichment_columns.sql` | manufacturer, country, icao_type, enriched |
| `0002_watchlist_and_state.sql` | watchlist table, last_airborne_date, prev_on_ground |
| `0003_notable_flag.sql` | is_notable on aircraft |
| `0004_transitions.sql` | transitions table + indexes |
| `0005_backfill_transitions.sql` | one-time backfill (data later wiped) |
| `0006_sighting_count.sql` | sighting_count on aircraft |
| `0007_ground_streak.sql` | ground_streak on aircraft |
| `0008_air_streak.sql` | air_streak on aircraft |

## Standing instructions

- Read before writing. Read relevant files in full before any edit.
- Always deploy + commit + push after every change.
- Always run migrations with `--remote` flag.
- When wiping transition data: `DELETE FROM transitions; UPDATE aircraft SET sighting_count=0, prev_on_ground=NULL, ground_streak=0, air_streak=0, last_airborne_date=NULL;`
- NAS Docker commands require `sudo`.
- Do not use altitude data for any logic — it is unreliable from this receiver.
