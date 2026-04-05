/* ========== API ========== */
function getConfiguredApiPort() {
  const m = document.querySelector('meta[name="sw-api-port"]');
  const c = m && m.getAttribute("content");
  if (c && String(c).trim()) return String(c).trim();
  return "5000";
}

function getApiBase() {
  const { protocol, hostname, port } = window.location;
  if (protocol === "file:") {
    return `http://localhost:${getConfiguredApiPort()}`;
  }
  if (port === "5000" || port === "5001") {
    return "";
  }
  const h = hostname || "localhost";
  return `http://${h}:${getConfiguredApiPort()}`;
}

const API_BASE = getApiBase();
const BANGALORE = [12.9716, 77.5946];
const DEFAULT_ZOOM = 13;

/* ========== State ========== */
const state = {
  bins: [],
  binCount: 30,
  truckCount: 1,
  minFill: 80,
  truckLat: BANGALORE[0],
  truckLng: BANGALORE[1],
  mapPickMode: false,
  routeIds: new Set(),
  lastMetrics: { distance: 0, fuelUsed: 0, co2: 0 },
};

let map;
let markersLayer;
let routeLines = [];
let truckMarker = null;
let barChart = null;
let pieChart = null;

/* ========== Toasts ========== */
function toast(message, type = "info") {
  const root = document.getElementById("toast-root");
  if (!root) return;
  const el = document.createElement("div");
  el.className = `toast toast--${type}`;
  el.textContent = message;
  root.appendChild(el);
  requestAnimationFrame(() => el.classList.add("toast--show"));
  setTimeout(() => {
    el.classList.remove("toast--show");
    setTimeout(() => el.remove(), 320);
  }, 4200);
}

/* ========== Animated numbers ========== */
function animateNumberEl(el, endValue, decimals) {
  if (!el || !Number.isFinite(endValue)) return;
  const start = parseFloat(el.textContent) || 0;
  const duration = 600;
  const t0 = performance.now();

  function frame(t) {
    const p = Math.min(1, (t - t0) / duration);
    const eased = 1 - (1 - p) ** 3;
    const v = start + (endValue - start) * eased;
    el.textContent = decimals > 0 ? v.toFixed(decimals) : String(Math.round(v));
    if (p < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}

function animateStatChip(el, target) {
  if (!el) return;
  const end = Number(target) || 0;
  const start = parseInt(el.textContent, 10) || 0;
  const duration = 500;
  const t0 = performance.now();
  function frame(t) {
    const p = Math.min(1, (t - t0) / duration);
    const eased = 1 - (1 - p) ** 3;
    el.textContent = String(Math.round(start + (end - start) * eased));
    if (p < 1) requestAnimationFrame(frame);
    else el.textContent = String(end);
  }
  requestAnimationFrame(frame);
}

function updateStatCards() {
  const bins = state.bins;
  const minFill = state.minFill;
  const total = bins.length;
  const pickup = bins.filter((b) => b.fill > minFill).length;
  const overflow = bins.filter((b) => b.willExceedSoon).length;

  animateStatChip(document.getElementById("stat-total"), total);
  animateStatChip(document.getElementById("stat-priority"), pickup);
  animateStatChip(document.getElementById("stat-overflow"), overflow);
}

function updateMetricDisplays(metrics, baselineMetrics) {
  state.lastMetrics = { ...metrics };
  const distEl = document.querySelector("#metric-distance .num");
  const fuelEl = document.querySelector("#metric-fuel .num");
  const co2El = document.querySelector("#metric-co2 .num");
  animateNumberEl(distEl, metrics.distance, 3);
  animateNumberEl(fuelEl, metrics.fuelUsed, 3);
  animateNumberEl(co2El, metrics.co2, 3);

  if (baselineMetrics) {
    const sDist = Math.max(0, baselineMetrics.distance - metrics.distance);
    const sFuel = Math.max(0, baselineMetrics.fuelUsed - metrics.fuelUsed);
    const sCo2 = Math.max(0, baselineMetrics.co2 - metrics.co2);

    const sdEl = document.getElementById("savings-distance");
    const sfEl = document.getElementById("savings-fuel");
    const scEl = document.getElementById("savings-co2");

    if (sdEl) sdEl.hidden = sDist <= 0.01;
    if (sfEl) sfEl.hidden = sFuel <= 0.01;
    if (scEl) scEl.hidden = sCo2 <= 0.01;

    animateNumberEl(document.querySelector("#savings-distance .num"), sDist, 3);
    animateNumberEl(document.querySelector("#savings-fuel .num"), sFuel, 3);
    animateNumberEl(document.querySelector("#savings-co2 .num"), sCo2, 3);
  }
}

function resetMetricDisplays() {
  const distEl = document.querySelector("#metric-distance .num");
  const fuelEl = document.querySelector("#metric-fuel .num");
  const co2El = document.querySelector("#metric-co2 .num");
  if (distEl) distEl.textContent = "0.000";
  if (fuelEl) fuelEl.textContent = "0.000";
  if (co2El) co2El.textContent = "0.000";
  
  const sdEl = document.getElementById("savings-distance");
  const sfEl = document.getElementById("savings-fuel");
  const scEl = document.getElementById("savings-co2");
  if (sdEl) sdEl.hidden = true;
  if (sfEl) sfEl.hidden = true;
  if (scEl) scEl.hidden = true;

  state.lastMetrics = { distance: 0, fuelUsed: 0, co2: 0 };
}

/* ========== Map helpers ========== */
function binLabel(bin) {
  return bin.name || bin.id;
}

function fillBucketColor(fill) {
  if (fill > 80) return "#ef4444";
  if (fill >= 50) return "#eab308";
  return "#22c55e";
}

function initMap() {
  map = L.map("map", { zoomControl: true }).setView(BANGALORE, DEFAULT_ZOOM);
  L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
    attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OSM</a>',
  }).addTo(map);

  markersLayer = L.layerGroup().addTo(map);

  const truckIcon = L.divIcon({
    className: "truck-marker-wrap",
    html: '<div class="truck-marker" title="Truck start">🚛</div>',
    iconSize: [44, 44],
    iconAnchor: [22, 22],
  });

  truckMarker = L.marker(BANGALORE, { draggable: true, icon: truckIcon, zIndexOffset: 1000 }).addTo(
    map
  );
  truckMarker.bindTooltip("Drag to set depot / truck start", { direction: "top", offset: [0, -10] });

  truckMarker.on("dragend", () => {
    const ll = truckMarker.getLatLng();
    state.truckLat = ll.lat;
    state.truckLng = ll.lng;
    syncTruckInputs();
  });

  map.on("click", (e) => {
    if (!state.mapPickMode) return;
    state.truckLat = e.latlng.lat;
    state.truckLng = e.latlng.lng;
    truckMarker.setLatLng(e.latlng);
    syncTruckInputs();
    setMapPickMode(false);
    toast("Start location updated from map", "success");
  });
}

function syncTruckInputs() {
  const la = document.getElementById("input-lat");
  const ln = document.getElementById("input-lng");
  if (la) la.value = state.truckLat.toFixed(5);
  if (ln) ln.value = state.truckLng.toFixed(5);
}

function readTruckFromInputs() {
  const la = parseFloat(document.getElementById("input-lat")?.value);
  const ln = parseFloat(document.getElementById("input-lng")?.value);
  if (Number.isFinite(la) && Number.isFinite(ln)) {
    state.truckLat = la;
    state.truckLng = ln;
    truckMarker.setLatLng([la, ln]);
    return true;
  }
  return false;
}

function setMapPickMode(on) {
  state.mapPickMode = on;
  const wrap = document.getElementById("map-wrap");
  const btn = document.getElementById("btn-map-pick");
  if (wrap) wrap.classList.toggle("map-wrap--pick", on);
  if (btn) btn.classList.toggle("is-active", on);
  if (on) toast("Click the map to place the truck", "info");
}

function setMapLoading(show) {
  const el = document.getElementById("map-loading");
  const panelLoad = document.getElementById("panel-loading");
  if (el) el.hidden = !show;
  if (panelLoad) panelLoad.hidden = !show;
}

function setRouteLoading(show) {
  const el = document.getElementById("route-loading");
  if (el) el.hidden = !show;
}

function clearRouteLine() {
  routeLines.forEach(l => {
    if (map && map.hasLayer(l)) map.removeLayer(l);
  });
  routeLines = [];
}

/* ========== Render bins ========== */
function renderBins(bins, opts = { fit: true }) {
  state.bins = bins;
  markersLayer.clearLayers();
  const routeIds = state.routeIds;

  bins.forEach((bin) => {
    const fill = bin.fill;
    const color = fillBucketColor(fill);
    const isRisk = bin.willExceedSoon;
    const onRoute = routeIds.has(bin.id);
    const high = fill > 80;
    let radius = high ? 13 : isRisk ? 11 : 8;
    if (onRoute) radius += 3;

    let stroke = "#1e293b";
    if (onRoute) stroke = "#22d3ee";
    else if (isRisk) stroke = "#a855f7";
    else if (high) stroke = "#fecaca";

    const marker = L.circleMarker([bin.lat, bin.lng], {
      radius,
      color: stroke,
      weight: onRoute ? 4 : isRisk ? 3 : 2,
      fillColor: color,
      fillOpacity: isRisk ? 0.95 : 0.88,
      className: onRoute ? "marker--route" : isRisk ? "marker--overflow" : "",
    });

    const tip = `${binLabel(bin)} · ${fill}% fill`;
    marker.bindTooltip(tip, { sticky: true, direction: "top", opacity: 0.95 });

    const area = bin.area || "Bengaluru Urban";
    const pred = typeof bin.predictedFill === "number" ? bin.predictedFill : "—";
    const explain = bin.explanation || "";
    const prio = bin.priorityScore || 0;

    marker.bindPopup(
      `<div class="popup-bin">
        <strong>${binLabel(bin)}</strong>
        <div class="popup-bin__meta">${area}</div>
        <ul class="popup-bin__list">
          <li><span>Fill</span><b>${fill}%</b></li>
          <li><span>Predicted</span><b>${pred}%</b></li>
          <li><span>Priority</span><b>${prio}</b></li>
        </ul>
        ${explain ? `<div style="margin-top: 0.5rem; font-size: 0.75rem; color: var(--text-muted); background: rgba(0,0,0,0.2); padding: 0.4rem; border-radius: 4px;">🎯 ${explain}</div>` : ""}
      </div>`,
      { minWidth: 220 }
    );

    marker.addTo(markersLayer);
  });

  updateAlertsUI(bins);

  const bounds = bins.map((b) => [b.lat, b.lng]);
  if (opts.fit && bounds.length) {
    map.flyToBounds(bounds, { padding: [48, 48], maxZoom: 13, duration: 0.75 });
  }
  requestAnimationFrame(() => map.invalidateSize());
  updateStatCards();
  if (isAnalyticsTabVisible()) updateAnalyticsCharts();
}

function updateAlertsUI(bins) {
  const panel = document.getElementById("alerts-panel");
  const list = document.getElementById("alerts-list");
  if (!panel || !list) return;

  const risky = bins.filter(b => b.willExceedSoon).sort((a,b) => b.priorityScore - a.priorityScore);
  
  if (risky.length === 0) {
    panel.hidden = true;
    list.innerHTML = "";
    return;
  }

  panel.hidden = false;
  list.innerHTML = risky.slice(0, 4).map(b => `
    <div class="alert-item">
      <div>
        <div class="alert-title">${binLabel(b)}</div>
        <div class="alert-desc">${b.explanation || 'At risk of overflow'}</div>
      </div>
      <strong>${b.fill}%</strong>
    </div>
  `).join("");
}

function isAnalyticsTabVisible() {
  const el = document.getElementById("tab-analytics");
  return el && !el.hidden && !el.classList.contains("is-hidden");
}

/* ========== API calls ========== */
async function loadBinsFromApi(refresh) {
  const params = new URLSearchParams();
  params.set("count", String(state.binCount));
  if (refresh) params.set("refresh", "true");
  const res = await fetch(`${API_BASE}/bins?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Bins HTTP ${res.status}`);
  return res.json();
}

async function fetchRouteFromApi() {
  const params = new URLSearchParams({
    lat: String(state.truckLat),
    lng: String(state.truckLng),
    minFill: String(state.minFill),
    trucks: String(state.truckCount),
  });
  const res = await fetch(`${API_BASE}/route?${params}`, { cache: "no-store" });
  if (!res.ok) throw new Error(`Route HTTP ${res.status}`);
  return res.json();
}

async function simulateFutureApi() {
  const res = await fetch(`${API_BASE}/simulate`, { method: "POST", cache: "no-store" });
  if (!res.ok) throw new Error(`Simulate HTTP ${res.status}`);
  return res.json();
}

/* ========== Route drawing ========== */
function geometryLngLatToLeaflet(latlngsLngLat) {
  if (!Array.isArray(latlngsLngLat)) return [];
  return latlngsLngLat.map(([lng, lat]) => [lat, lng]);
}

function drawRoutesFromGeometries(routesData, truckLatLng) {
  clearRouteLine();
  if (!routesData || !routesData.length) return;

  const allBounds = L.latLngBounds();

  routesData.forEach((routeData, idx) => {
    const { route, geometry } = routeData;
    if (!route || route.length === 0) return;

    let latlngs = geometryLngLatToLeaflet(geometry);
    if (latlngs.length < 2) {
      latlngs = [truckLatLng, ...route.map((b) => [b.lat, b.lng])];
    }
    
    latlngs.forEach(ll => allBounds.extend(ll));

    const line = L.polyline(latlngs, {
      color: idx === 0 ? "#2563eb" : "#fb923c",
      weight: 5,
      opacity: 0.15,
      lineCap: "round",
      lineJoin: "round",
      smoothFactor: 1,
      className: `route-line route-line-truck${idx % 2}`,
    }).addTo(map);
    
    routeLines.push(line);

    requestAnimationFrame(() => {
      if (map.hasLayer(line)) line.setStyle({ opacity: 1, weight: 5 });
    });
  });

  try {
    if (allBounds.isValid()) {
      map.flyToBounds(allBounds, { padding: [56, 56], maxZoom: 15, duration: 1.05 });
    }
  } catch (_) {
    map.flyTo(truckLatLng, DEFAULT_ZOOM, { duration: 0.55 });
  }
}

/* ========== Charts ========== */
function updateAnalyticsCharts() {
  const bins = state.bins;
  const barCanvas = document.getElementById("chart-bar");
  const pieCanvas = document.getElementById("chart-pie");
  if (!barCanvas || !pieCanvas || typeof Chart === "undefined") return;

  const bands = [0, 0, 0, 0];
  bins.forEach((b) => {
    const f = b.fill;
    if (f < 25) bands[0]++;
    else if (f < 50) bands[1]++;
    else if (f < 75) bands[2]++;
    else bands[3]++;
  });

  if (barChart) barChart.destroy();
  barChart = new Chart(barCanvas.getContext("2d"), {
    type: "bar",
    data: {
      labels: ["0–25%", "25–50%", "50–75%", "75–100%"],
      datasets: [
        {
          label: "Bins",
          data: bands,
          backgroundColor: ["#4ade80", "#86efac", "#fbbf24", "#f87171"],
          borderRadius: 8,
          borderSkipped: false,
        },
      ],
    },
    options: {
      responsive: true,
      plugins: { legend: { display: false } },
      scales: {
        x: {
          ticks: { color: "#94a3b8" },
          grid: { color: "rgba(148,163,184,0.12)" },
        },
        y: {
          beginAtZero: true,
          ticks: { color: "#94a3b8", precision: 0 },
          grid: { color: "rgba(148,163,184,0.12)" },
        },
      },
    },
  });

  let low = 0;
  let med = 0;
  let high = 0;
  let crit = 0;
  bins.forEach((b) => {
    if (b.willExceedSoon) crit++;
    else if (b.fill > 80) high++;
    else if (b.fill >= 50) med++;
    else low++;
  });

  if (pieChart) pieChart.destroy();
  pieChart = new Chart(pieCanvas.getContext("2d"), {
    type: "doughnut",
    data: {
      labels: ["Low", "Medium", "High", "Pred. overflow"],
      datasets: [
        {
          data: [low, med, high, crit],
          backgroundColor: ["#22c55e", "#eab308", "#ef4444", "#a855f7"],
          borderWidth: 0,
        },
      ],
    },
    options: {
      responsive: true,
      cutout: "58%",
      plugins: {
        legend: {
          position: "bottom",
          labels: { color: "#cbd5e1", boxWidth: 12, font: { size: 11 } },
        },
      },
    },
  });
}

/* ========== Tabs ========== */
function setupTabs() {
  const buttons = document.querySelectorAll(".tabs__btn");
  const live = document.getElementById("tab-live");
  const analytics = document.getElementById("tab-analytics");

  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const tab = btn.getAttribute("data-tab");
      buttons.forEach((b) => {
        b.classList.toggle("is-active", b === btn);
        b.setAttribute("aria-selected", b === btn ? "true" : "false");
      });
      if (tab === "live") {
        live.classList.remove("is-hidden");
        live.hidden = false;
        analytics.classList.add("is-hidden");
        analytics.hidden = true;
      } else {
        analytics.classList.remove("is-hidden");
        analytics.hidden = false;
        live.classList.add("is-hidden");
        live.hidden = true;
        updateAnalyticsCharts();
        requestAnimationFrame(() => {
          setTimeout(() => {
            if (barChart) barChart.resize();
            if (pieChart) pieChart.resize();
          }, 80);
        });
      }
    });
  });
}

/* ========== Optimize button loading state ========== */
function setOptimizeLoading(loading) {
  const btn = document.getElementById("btn-optimize");
  const text = btn?.querySelector(".btn-primary__text");
  const spin = btn?.querySelector(".btn-primary__spinner");
  if (!btn) return;
  btn.disabled = loading;
  if (text) text.hidden = loading;
  if (spin) spin.hidden = !loading;
}

/* ========== Bootstrap ========== */
async function bootstrap() {
  initMap();
  syncTruckInputs();
  resetMetricDisplays();
  setupTabs();

  const statusEl = document.getElementById("route-status");
  const btnOptimize = document.getElementById("btn-optimize");
  const btnRefresh = document.getElementById("btn-refresh-bins");
  const btnApply = document.getElementById("btn-apply-coords");
  const btnPick = document.getElementById("btn-map-pick");
  const btnSimulate = document.getElementById("btn-simulate");
  const btnReport = document.getElementById("btn-report-garbage");
  
  const slider = document.getElementById("slider-min-fill");
  const sliderVal = document.getElementById("slider-min-fill-val");
  const selectCount = document.getElementById("select-bin-count");
  const selectTruckCount = document.getElementById("select-truck-count");

  // citizen modal
  const reportModal = document.getElementById("report-modal");
  const btnCloseModal = document.getElementById("btn-close-modal");
  const btnSubmitReport = document.getElementById("btn-submit-report");

  state.binCount = parseInt(selectCount.value, 10) || 30;
  if(selectTruckCount) state.truckCount = parseInt(selectTruckCount.value, 10) || 1;

  if (selectTruckCount) {
    selectTruckCount.addEventListener("change", () => {
      state.truckCount = parseInt(selectTruckCount.value, 10) || 1;
    });
  }

  selectCount.addEventListener("change", async () => {
    state.binCount = parseInt(selectCount.value, 10) || 30;
    setMapLoading(true);
    try {
      state.routeIds = new Set();
      clearRouteLine();
      resetMetricDisplays();
      const bins = await loadBinsFromApi(false);
      if (!Array.isArray(bins) || !bins.length) throw new Error("No bins");
      renderBins(bins);
      toast(`Loaded ${state.binCount} bins`, "info");
    } catch (e) {
      console.error(e);
      toast("Could not reload bins for new count", "error");
    } finally {
      setMapLoading(false);
    }
  });

  slider.addEventListener("input", () => {
    state.minFill = parseInt(slider.value, 10);
    if (sliderVal) sliderVal.textContent = String(state.minFill);
    updateStatCards();
  });

  btnApply.addEventListener("click", () => {
    if (readTruckFromInputs()) {
      toast("Truck position applied", "success");
    } else {
      toast("Enter valid latitude and longitude", "error");
    }
  });

  btnPick.addEventListener("click", () => {
    setMapPickMode(!state.mapPickMode);
  });

  btnRefresh.addEventListener("click", async () => {
    state.binCount = parseInt(selectCount.value, 10) || 30;
    setMapLoading(true);
    btnRefresh.disabled = true;
    try {
      state.routeIds = new Set();
      clearRouteLine();
      resetMetricDisplays();
      const bins = await loadBinsFromApi(true);
      if (!Array.isArray(bins) || !bins.length) throw new Error("No bins");
      renderBins(bins);
      toast("Bin data refreshed", "success");
    } catch (e) {
      console.error(e);
      toast("Could not refresh bins", "error");
    } finally {
      setMapLoading(false);
      btnRefresh.disabled = false;
    }
  });

  if (btnSimulate) {
    btnSimulate.addEventListener("click", async () => {
      setMapLoading(true);
      btnSimulate.disabled = true;
      try {
        state.routeIds = new Set();
        clearRouteLine();
        resetMetricDisplays();
        const bins = await simulateFutureApi();
        renderBins(bins);
        toast("Simulated time passage (+ growth)", "info");
      } catch (e) {
        toast("Simulation failed", "error");
      } finally {
        setMapLoading(false);
        btnSimulate.disabled = false;
      }
    });
  }

  if (btnReport) {
    btnReport.addEventListener("click", () => reportModal.hidden = false);
    btnCloseModal.addEventListener("click", () => reportModal.hidden = true);
    btnSubmitReport.addEventListener("click", () => {
      reportModal.hidden = true;
      document.getElementById("report-text").value = "";
      toast("Thank you! Citizen report submitted for AI review.", "success");
    });
  }

  statusEl.textContent = "";
  setMapLoading(true);
  btnOptimize.disabled = true;

  try {
    const bins = await loadBinsFromApi(false);
    if (!Array.isArray(bins) || !bins.length) throw new Error("No bins");
    renderBins(bins);
    statusEl.textContent = "Adjust controls, then optimize route.";
    toast("Dashboard loaded", "success");
  } catch (e) {
    console.error(e);
    statusEl.textContent =
      "API unreachable. Run the backend and open http://localhost:5000/ (or :5001).";
    toast("API error — check server", "error");
    setMapLoading(false);
    btnOptimize.disabled = false;
    return;
  }

  setMapLoading(false);
  btnOptimize.disabled = false;

  map.whenReady(() => setTimeout(() => map.invalidateSize(), 120));

  btnOptimize.addEventListener("click", async () => {
    readTruckFromInputs();
    setOptimizeLoading(true);
    setRouteLoading(true);
    statusEl.textContent = "Planning route…";
    try {
      const data = await fetchRouteFromApi();
      const { routes, metrics, baselineMetrics, routingSource } = data;
      const truckLatLng = [state.truckLat, state.truckLng];

      let allRouteBins = [];
      if (routes) {
        routes.forEach(r => allRouteBins.push(...(r.route || [])));
      }
      
      state.routeIds = new Set(allRouteBins.map((b) => b.id));
      renderBins(state.bins, { fit: false });
      updateMetricDisplays(metrics, baselineMetrics);

      if (allRouteBins.length === 0) {
        statusEl.textContent = `No bins above ${state.minFill}% — widen threshold or refresh data.`;
        clearRouteLine();
        toast("No pickups in queue for this threshold", "info");
      } else {
        drawRoutesFromGeometries(routes, truckLatLng);
        const via =
          routingSource === "osrm"
            ? "OSRM roads"
            : routingSource === "straight_line"
              ? "Fallback path"
              : "";
        statusEl.textContent = `${allRouteBins.length} stops (${routes.length} trucks) · ${via}`.trim();
        toast("Route optimized successfully", "success");
      }
    } catch (e) {
      console.error(e);
      statusEl.textContent = "Route request failed.";
      toast("Route API error", "error");
    } finally {
      setRouteLoading(false);
      setOptimizeLoading(false);
    }
  });
}

bootstrap();

