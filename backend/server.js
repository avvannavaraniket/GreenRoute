const express = require("express");
const cors = require("cors");
const path = require("path");
const fs = require("fs");

const PORT = Number(process.env.PORT) || 5000;
const EARTH_RADIUS_KM = 6371;
const FUEL_PER_KM = 0.2;
const CO2_PER_FUEL = 2.6;
const OSRM_BASE =
  process.env.OSRM_URL || "https://router.project-osrm.org";

const app = express();
app.use(
  cors({
    origin: true,
    methods: ["GET", "POST", "OPTIONS"],
    allowedHeaders: ["Content-Type"],
  })
);
app.use(express.json());

const BANGALORE_AREAS = [
  "Koramangala",
  "Indiranagar",
  "HSR Layout",
  "Whitefield",
  "Jayanagar",
  "Malleshwaram",
  "Marathahalli",
  "Electronic City",
  "Hebbal",
  "BTM Layout",
  "JP Nagar",
  "Bellandur",
  "Yeshwanthpur",
  "Domlur",
  "Banashankari",
];

function loadBins() {
  const raw = fs.readFileSync(path.join(__dirname, "bins.json"), "utf8");
  return JSON.parse(raw);
}

/** Canonical bin set used by /route (updated by each /bins request). */
let activeBins = loadBins();

function ensureBinArea(bin) {
  if (bin.area) return bin;
  return { ...bin, area: "Bengaluru Urban" };
}

function generateRandomBins(count) {
  const centerLat = 12.9716;
  const centerLng = 77.5946;
  const bins = [];
  for (let i = 0; i < count; i++) {
    const area = BANGALORE_AREAS[i % BANGALORE_AREAS.length];
    bins.push({
      id: `BLR-${String(i + 1).padStart(3, "0")}`,
      name: `Smart Bin · ${area} ${i + 1}`,
      area,
      lat: centerLat + (Math.random() - 0.5) * 0.11,
      lng: centerLng + (Math.random() - 0.5) * 0.13,
      fill: randomIntInclusive(12, 98),
    });
  }
  return bins;
}

function resolveBinsForRequest(count, refresh) {
  const n = Math.min(50, Math.max(1, parseInt(count, 10) || 30));
  const fileBins = loadBins().map(ensureBinArea);
  
  let baseBins = [];
  if (n <= fileBins.length) {
    baseBins = fileBins.slice(0, n);
  } else {
    if (activeBins.length === n) {
      baseBins = activeBins;
    } else {
      baseBins = [...fileBins, ...generateRandomBins(n - fileBins.length)];
    }
  }

  if (refresh) {
    activeBins = baseBins.map(b => ({
      ...b,
      fill: randomIntInclusive(12, 98),
      growthRate: randomIntInclusive(2, 8)
    }));
  } else {
    activeBins = baseBins;
  }
  return activeBins;
}

/**
 * Haversine distance between two lat/lng points in kilometers.
 */
function haversineKm(lat1, lng1, lat2, lng2) {
  const toRad = (deg) => (deg * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

function randomIntInclusive(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function enrichBinWithPrediction(bin) {
  const growthRate = bin.growthRate || randomIntInclusive(2, 8);
  const predictedFill = Math.min(100, bin.fill + growthRate * 4);
  
  let timeToOverflow = -1;
  const remaining = 100 - bin.fill;
  if (remaining > 0 && growthRate > 0) {
    timeToOverflow = Number((remaining / growthRate).toFixed(1));
  } else if (remaining <= 0) {
    timeToOverflow = 0;
  }
  
  const explanation = timeToOverflow >= 0 
    ? `Overflow in ${timeToOverflow} hrs (growth: ${growthRate}%/hr)` 
    : "Already overflowing";

  // Smart priority combining fill, risk, and time
  const priorityScore = Math.floor(bin.fill + (predictedFill > 90 ? 20 : 0) + (100 - Math.min(100, timeToOverflow || 100)));

  return {
    ...bin,
    growthRate,
    predictedFill,
    willExceedSoon: predictedFill > 90,
    timeToOverflow,
    explanation,
    priorityScore
  };
}

function computeBaselineSequence(truckLat, truckLng, candidates) {
  let d = 0;
  let cLat = truckLat;
  let cLng = truckLng;
  for (const b of candidates) {
    d += haversineKm(cLat, cLng, b.lat, b.lng);
    cLat = b.lat;
    cLng = b.lng;
  }
  if (candidates.length > 0) {
    d += haversineKm(cLat, cLng, truckLat, truckLng);
  }
  return d;
}

/**
 * Nearest-neighbor route.
 */
function buildNearestNeighborRoute(truckLat, truckLng, candidates) {
  if (candidates.length === 0) {
    return { route: [], distanceKm: 0 };
  }

  const remaining = [...candidates];
  const route = [];
  let currentLat = truckLat;
  let currentLng = truckLng;
  let distanceKm = 0;

  while (remaining.length > 0) {
    let bestIdx = 0;
    let bestDist = haversineKm(
      currentLat,
      currentLng,
      remaining[0].lat,
      remaining[0].lng
    );

    for (let i = 1; i < remaining.length; i++) {
      const d = haversineKm(
        currentLat,
        currentLng,
        remaining[i].lat,
        remaining[i].lng
      );
      if (d < bestDist) {
        bestDist = d;
        bestIdx = i;
      }
    }

    const next = remaining.splice(bestIdx, 1)[0];
    route.push(next);
    distanceKm += bestDist;
    currentLat = next.lat;
    currentLng = next.lng;
  }

  // Close loop back to depot
  if (route.length > 0) {
    distanceKm += haversineKm(currentLat, currentLng, truckLat, truckLng);
  }

  return { route, distanceKm };
}

function computeMetrics(distanceKm) {
  const fuelUsed = distanceKm * FUEL_PER_KM;
  const co2 = fuelUsed * CO2_PER_FUEL;
  return {
    distance: Math.round(distanceKm * 1000) / 1000,
    fuelUsed: Math.round(fuelUsed * 1000) / 1000,
    co2: Math.round(co2 * 1000) / 1000,
  };
}

/**
 * Build OSRM coordinate path: lng,lat;lng,lat;...
 * @param {{ lat: number, lng: number }[]} orderedPoints truck first, then bins
 */
function buildOsrmCoordinatePath(orderedPoints) {
  return orderedPoints.map((p) => `${p.lng},${p.lat}`).join(";");
}

/**
 * Straight-line geometry as GeoJSON-style [lng, lat][] (fallback).
 */
function straightLineGeometryLngLat(orderedPoints) {
  return orderedPoints.map((p) => [p.lng, p.lat]);
}

/**
 * Fetch driving route from OSRM (public demo server). Returns geometry [lng,lat][] and distance in meters.
 */
async function fetchOsrmDrivingRoute(orderedPoints) {
  const path = buildOsrmCoordinatePath(orderedPoints);
  const url = `${OSRM_BASE}/route/v1/driving/${path}?overview=full&geometries=geojson`;
  const res = await fetch(url, { headers: { Accept: "application/json" } });
  if (!res.ok) {
    throw new Error(`OSRM HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.code !== "Ok" || !data.routes?.[0]?.geometry?.coordinates) {
    throw new Error(data.message || "OSRM returned no route");
  }
  const r = data.routes[0];
  return {
    geometryLngLat: r.geometry.coordinates,
    distanceMeters: r.distance,
  };
}

app.get("/bins", (req, res) => {
  const count = req.query.count;
  const refresh =
    req.query.refresh === "1" ||
    req.query.refresh === "true" ||
    req.query.refresh === "yes";
  const raw = resolveBinsForRequest(count, refresh);
  const enriched = raw.map(ensureBinArea).map(enrichBinWithPrediction);
  res.json(enriched);
});

app.post("/simulate", (req, res) => {
  activeBins = activeBins.map((bin) => {
    const growth = bin.growthRate || randomIntInclusive(2, 8);
    const newFill = Math.min(100, bin.fill + growth);
    return { ...bin, fill: newFill, growthRate: growth };
  });
  const enriched = activeBins.map(ensureBinArea).map(enrichBinWithPrediction);
  res.json(enriched);
});

app.get("/route", async (req, res) => {
  const bins = activeBins.length ? activeBins : loadBins();
  const truckLat = parseFloat(req.query.lat);
  const truckLng = parseFloat(req.query.lng);
  const minFill = parseFloat(req.query.minFill);
  const truckCount = parseInt(req.query.trucks, 10) || 1;

  const centerLat = 12.9716;
  const centerLng = 77.5946;
  const lat = Number.isFinite(truckLat) ? truckLat : centerLat;
  const lng = Number.isFinite(truckLng) ? truckLng : centerLng;
  const threshold = Number.isFinite(minFill) ? minFill : 80;

  const enrichedBins = bins.map(ensureBinArea).map(enrichBinWithPrediction);
  const candidates = enrichedBins.filter((b) => b.fill >= threshold); // Use strictly >= for slider UI logic

  if (candidates.length === 0) {
    return res.json({
      routes: [],
      metrics: computeMetrics(0),
      baselineMetrics: computeMetrics(0),
      routingSource: "none",
    });
  }

  const baselineDist = computeBaselineSequence(lat, lng, candidates);
  const baselineMetrics = computeMetrics(baselineDist);

  // Group geographically (simple east-west split) for multiple trucks
  candidates.sort((a, b) => a.lng - b.lng);
  const chunkQty = Math.min(truckCount, candidates.length);
  const chunkSize = Math.ceil(candidates.length / chunkQty);

  const finalRoutes = [];
  let totalDistanceKm = 0;
  let bestRoutingSource = "osrm";

  for (let t = 0; t < chunkQty; t++) {
    const subset = candidates.slice(t * chunkSize, (t + chunkSize));
    const { route, distanceKm: haversineKm } = buildNearestNeighborRoute(lat, lng, subset);
    const orderedPoints = [{ lat, lng }, ...route.map((b) => ({ lat: b.lat, lng: b.lng })), { lat, lng }];
    
    let routeGeom = [];
    let routeDist = haversineKm;

    try {
      const osrm = await fetchOsrmDrivingRoute(orderedPoints);
      routeDist = osrm.distanceMeters / 1000;
      routeGeom = osrm.geometryLngLat;
    } catch (err) {
      console.warn("[route] OSRM failed, using straight-line fallback:", err.message);
      routeGeom = straightLineGeometryLngLat(orderedPoints);
      bestRoutingSource = "straight_line";
    }

    totalDistanceKm += routeDist;
    finalRoutes.push({ route, geometry: routeGeom });
  }

  return res.json({
    routes: finalRoutes,
    metrics: computeMetrics(totalDistanceKm),
    baselineMetrics,
    routingSource: bestRoutingSource,
    routeType: "closed_loop"
  });
});

const frontendDir = path.join(__dirname, "..", "frontend");
app.use(express.static(frontendDir));

app.listen(PORT, () => {
  console.log(`Smart Waste Optimizer API listening on http://localhost:${PORT}`);
  console.log(`Open UI at http://localhost:${PORT}/ (same server as API)`);
});
