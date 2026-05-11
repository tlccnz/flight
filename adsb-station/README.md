# NZWN ADS-B Station

A tablet dashboard for monitoring local aircraft via a personal ADS-B receiver, with a persistent sighting database.

## Hardware

| Device | Details |
|--------|---------|
| ADS-B receiver | Plane Finder (Pi24) at `10.10.30.227:8754` |
| NAS (server) | Synology DS920+ at `10.10.20.85` |
| Local airport | NZWN (Wellington International) |

## Stack

- **Backend** — Node.js 20, Express, better-sqlite3, Docker
- **Frontend** — Vanilla HTML/CSS/JS, Leaflet.js (map)
- **Database** — SQLite at `/data/adsb.db` (mounted volume)

## Project structure

```
adsb-station/
├── docker-compose.yml
├── data/                  ← SQLite DB (created on first run, persists across restarts)
├── server/
│   ├── Dockerfile
│   ├── package.json
│   └── server.js          ← ADS-B poller + SQLite ingestion + REST API
└── dashboard/
    └── index.html         ← Tablet UI (served as static files by Express)
```

## Deployment

Copy the project to the NAS, then from the `adsb-station/` directory:

```bash
docker-compose up -d
```

Dashboard available at: `http://10.10.20.85:3000`

To view logs:
```bash
docker-compose logs -f
```

To stop:
```bash
docker-compose down
```

## API endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/live` | Aircraft visible in the last 30 seconds |
| GET | `/api/aircraft?q=` | All aircraft, optionally filtered by hex or callsign |
| GET | `/api/aircraft/:hex` | Detail for one aircraft — stats, callsigns, recent positions |
| GET | `/api/aircraft/:hex/track?from=&to=` | Position track for map overlay |
| GET | `/api/stats` | Summary counts (live, today, all time, total positions) |

## Database schema

### `aircraft`
One row per unique ICAO hex address.

| Column | Type | Notes |
|--------|------|-------|
| `hex` | TEXT PK | ICAO 24-bit address (e.g. `c8722b`) |
| `first_seen` | INTEGER | Unix timestamp |
| `last_seen` | INTEGER | Unix timestamp, updated on every poll |
| `total_positions` | INTEGER | Running count |

### `positions`
One row per poll hit per aircraft (every 5 seconds).

| Column | Type | Notes |
|--------|------|-------|
| `id` | INTEGER PK | |
| `hex` | TEXT | FK → aircraft.hex |
| `ts` | INTEGER | Server unix timestamp |
| `callsign` | TEXT | Flight number (e.g. `ANZ423`), nullable |
| `lat` | REAL | NULL when receiver has no position fix |
| `lon` | REAL | NULL when receiver has no position fix |
| `alt_ft` | INTEGER | Altitude in feet |
| `speed_kts` | INTEGER | Ground speed in knots |
| `heading` | REAL | Track/heading in degrees |
| `squawk` | TEXT | 4-digit squawk code |
| `on_ground` | INTEGER | 1 = on ground, 0 = airborne |

Indexes: `(hex)`, `(ts)`, `(hex, ts)`, `(last_seen)` on aircraft.

## Data source

Plane Finder local feed: `http://10.10.30.227:8754/flights.json?time={ms}`

Response is a JSON object keyed by ICAO hex. Each value is an array:

```
[hex, lat, lon, heading, alt_ft, speed_kts, squawk, ?, ?, ?, rx_ts, ?, ?, ?, on_ground, ?, callsign]
 [0]  [1]  [2]    [3]     [4]      [5]       [6]                     [10]          [14]      [16]
```

`lat=0, lon=0` indicates no position fix — stored as NULL.

## Storage estimate

~8 GB/year at 10 aircraft average, 5-second poll interval (option C — every position stored).
