# Smart Waste Optimizer

Bangalore demo: Express API with nearest-neighbor routing for high-fill bins, Leaflet map, and impact metrics.

## Prerequisites

- [Node.js](https://nodejs.org/) (v18+ recommended)

## Recommended: one command (API + UI)

```bash
cd backend
npm install
node server.js
```

Open **http://localhost:5000/** — the same server serves the static UI and the API, so there are no CORS or wrong-URL issues.

- `GET /bins?count=30&refresh=true` — returns `count` bins (max 50). With `refresh=true`, generates a new random Bangalore cluster; without it, uses `bins.json` (padding with random bins if `count` exceeds the file). Response includes `area`, `predictedFill`, `willExceedSoon`. The active set is what `/route` uses.
- `GET /route?lat=&lng=&minFill=80` — nearest-neighbor over bins with `fill > minFill`, then OSRM road geometry (see below). Defaults: Bangalore center, `minFill=80`.

## Alternative: separate static server

```bash
# Terminal 1
cd backend && npm install && node server.js

# Terminal 2
cd frontend && npx serve .
```

The UI detects port **5000** (same origin) or uses **http://localhost:5000** when served from another port or opened as a file.

## How it works

- **Haversine** is used only to order stops (**nearest neighbor** on bins with `fill > minFill` from the query string).
- **Road geometry** comes from the public **OSRM** demo API (`router.project-osrm.org`): the backend requests a single driving route through all ordered waypoints and returns GeoJSON coordinates. **Distance / fuel / CO₂** use OSRM’s road distance (meters → km). If OSRM fails, the API falls back to a straight vertex path and Haversine distance.
- Override OSRM base URL: `OSRM_URL=https://your-osrm.example` when starting the server.
- **Metrics:** `fuelUsed = distance × 0.2`, `co2 = fuelUsed × 2.6`.
