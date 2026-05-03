import { useState, useEffect, useRef, useReducer, useCallback } from "react";
import {
  Play, Pause, Anchor, Plane, AlertTriangle, Hexagon, Radar,
  Crosshair, Power, Activity, Camera, Target, Image as ImageIcon,
  Waves, Zap, Ship
} from "lucide-react";

/* ═══════════════════════════════════════════════════════════════════════════
   BLACK SHEEP WALL — Phase 2
   New since 1.1:
   - Polygon-clipped sweep paths (real coverage planning)
   - Subsurface units: SUBMARINE (mobile), MINE (stationary) — sonar-only
   - Three-state contact confidence: UNKNOWN / POSSIBLE / CONFIRMED
   - AIS overlay on confirmed neutral vessels
   - GPS jam zones (deployable; UAV holds + alerts when inside)
   - Multi-ISR deployment
   - Drag-box now tracks correctly during edge-pan
   ═══════════════════════════════════════════════════════════════════════════ */

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  WORLD_W: 6400, WORLD_H: 4000,

  USV_SPEED: 0.45, UAV_SPEED: 2.2,
  ENEMY_SPEED: 0.35, COMMERCIAL_SPEED: 0.1,
  SUBMARINE_SPEED: 0.22,

  UAV_ORBIT_RADIUS: 90, UAV_ORBIT_ANGULAR_SPEED: 0.012,
  UAV_BATTERY_DRAIN: 0.04, UAV_CHARGE_RATE: 0.18,
  UAV_LOW_BATTERY: 28, UAV_FULL_BATTERY: 95, UAV_DOCK_RANGE: 8,

  USV_BATTERY_DRAIN: 0.008, USV_SOLAR_RATE: 0.04, USV_LOW_BATTERY: 40,

  USV_SENSOR_RANGE: 180, UAV_SENSOR_RANGE: 240, SONAR_RANGE: 130,
  FOG_REVEAL_RANGE: 260,

  CONFIDENCE_RATE: 0.9, CONFIDENCE_DECAY: 0.15,
  POSSIBLE_THRESHOLD: 35, CONFIRMED_THRESHOLD: 75,
  // Mines are stationary so detection is faster once sonar reaches them
  MINE_DETECTION_BOOST: 1.4,

  TICK_MS: 50,
  EDGE_PAN_ZONE: 36, EDGE_PAN_SPEED: 16,

  JAM_ZONE_RADIUS: 280,
  PATROL_LANES: 6,
  TRACK_STANDOFF: 90,

  // Phase 4: First Island Chain — Taiwan, Phils, Guam, Japan, Korea, E China Sea
  // Lon span 116°-148° (32°) → 6400 world units; Lat 5°-42° (37°) → 4000 world
  GEO_LON_MIN: 116, GEO_LON_MAX: 148,
  GEO_LAT_MIN:   5, GEO_LAT_MAX:  42,

  AIS_TICK_MS: 1000,        // simulated AIS update cadence (real time)
  AIS_VESSEL_COUNT: 64,     // synthetic fleet size
  // UAV mission abort math
  UAV_RETURN_BATTERY_MARGIN: 8, // % safety pad
};

const COLORS = {
  bg: "#08100c", surface: "#0d1612", surfaceHi: "#121e18",
  border: "#1f3329", borderHi: "#2d4a3c",
  ocean1: "#0d1f29", ocean2: "#15303d", land: "#1f2e25", landHi: "#2d4032",
  grid: "#1f3a3a",
  phosphor: "#b8ff5e", phosphorDim: "#6ba33a",
  amber: "#ffb84a", amberDim: "#a87a2e",
  hostile: "#ff4757", hostileDim: "#a82a36",
  neutral: "#5fb3d4", neutralDim: "#3a6b80",
  subsurface: "#c66bff", subsurfaceDim: "#7a3ea3",
  ais: "#29e0d4", aisDim: "#1a8a83",
  text: "#c8d4cc", textDim: "#6b7d72",
};

// ─── HELPERS ─────────────────────────────────────────────────────────────────
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const norm = (a) => {
  const m = Math.hypot(a.x, a.y);
  return m === 0 ? { x: 0, y: 0 } : { x: a.x / m, y: a.y / m };
};
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const angleOf = (dx, dy) => Math.atan2(dy, dx);
const rad2deg = (r) => (r * 180) / Math.PI;
const isUnderwater = (u) => u.type === "SUBMARINE" || u.type === "MINE";

// ─── GEO PROJECTION ──────────────────────────────────────────────────────────
// Linear Mercator approximation — accurate enough for the ~15°×25° viewport.
const geoToWorld = (lat, lon) => ({
  x: ((lon - CONFIG.GEO_LON_MIN) / (CONFIG.GEO_LON_MAX - CONFIG.GEO_LON_MIN)) * CONFIG.WORLD_W,
  y: ((CONFIG.GEO_LAT_MAX - lat)  / (CONFIG.GEO_LAT_MAX - CONFIG.GEO_LAT_MIN)) * CONFIG.WORLD_H,
});
const worldToGeo = (x, y) => ({
  lon: CONFIG.GEO_LON_MIN + (x / CONFIG.WORLD_W) * (CONFIG.GEO_LON_MAX - CONFIG.GEO_LON_MIN),
  lat: CONFIG.GEO_LAT_MAX - (y / CONFIG.WORLD_H) * (CONFIG.GEO_LAT_MAX - CONFIG.GEO_LAT_MIN),
});

// AIS vessel type code → label
const decodeAISType = (code) => {
  const n = parseInt(code) || 0;
  if (n >= 70 && n <= 79) return "CARGO";
  if (n >= 80 && n <= 89) return "TANKER";
  if (n >= 60 && n <= 69) return "PASSENGER";
  if (n >= 40 && n <= 49) return "HSC";
  if (n === 30)            return "FISHING";
  if (n === 31 || n === 32) return "TUG";
  if (n === 35 || n === 36 || n === 37) return "SAILING";
  if (n >= 20 && n <= 29)  return "WIG";
  if (n === 50 || n === 51 || n === 52 || n === 55) return "SPECIAL";
  if (n >= 90 && n <= 99)  return "OTHER";
  return "UNKNOWN";
};

// ─── PHASE 4: SYNTHETIC AIS FLEET ──────────────────────────────────────────
// Realistic shipping lanes through First Island Chain chokepoints.
// Each route is a polyline in (lon, lat). Vessels move along them on a 0..1
// parameter and loop. Speed varies by vessel type. Fleet is ~60 ships.

// Country-prefix MMSI codes (real ITU MID assignments)
const FLAG_DATA = [
  { flag: "PAN", mid: 357, names: ["PACIFIC HORIZON","ATLAS PIONEER","NEPTUNE STAR","BLUE EVEREST","ORIENT ENVOY"] },
  { flag: "LBR", mid: 636, names: ["EVER GIVEN","MAERSK ANTARES","CMA CGM TRIDENT","COSCO HARMONY","HAFNIA SAPPHIRE"] },
  { flag: "MSH", mid: 538, names: ["NORDIC ORION","STAR CHALLENGER","BBC EUROPE","AMAZON RIVER","KING ROBERT"] },
  { flag: "SGP", mid: 563, names: ["NEPTUNE GALAXY","APL TEMASEK","KEPPEL VICTORY","JURONG PRIDE","HARBOUR EAGLE"] },
  { flag: "HKG", mid: 477, names: ["VICTORIA HARBOUR","ORIENT OVERSEAS","HKG NAVIGATOR","KOWLOON STAR","PEARL RIVER"] },
  { flag: "JPN", mid: 431, names: ["MOL TRIUMPH","NYK ALTAIR","K-LINE PIONEER","SAKURA EXPRESS","FUJI VENTURE"] },
  { flag: "CHN", mid: 412, names: ["COSCO SHANGHAI","CHINA MERCHANTS","SHENZHEN BAY","HUANG HE STAR","XIN HONG KONG"] },
  { flag: "KOR", mid: 440, names: ["HMM ALGECIRAS","SM BUSAN","KMTC INCHEON","HANJIN BLUE","DAEHAN VICTORY"] },
  { flag: "PHL", mid: 548, names: ["MANILA STAR","CEBU PACIFIC","DAVAO PRIDE","LUZON EXPRESS","VISAYAN SEA"] },
  { flag: "TWN", mid: 416, names: ["EVERGREEN MARINE","YANG MING SUN","WAN HAI VICTORY","KEELUNG STAR","TAIPEI EXPRESS"] },
  { flag: "USA", mid: 366, names: ["USNS MERCY","MAERSK DENVER","HORIZON PACIFIC","AMERICAN HIGHWAY","MATSON KAUAI"] },
  { flag: "MLT", mid: 256, names: ["VALLETTA SPIRIT","GOZO STAR","LUQA EXPRESS","COMINO BRIDGE","MALTESE FALCON"] },
];

// Shipping route definitions — (lon, lat) polylines through real chokepoints.
// Each route is bidirectional (vessels can be assigned either direction).
const SHIPPING_ROUTES = [
  // Singapore → Tokyo via S China Sea, Luzon Strait, E China Sea
  { name: "SIN-TYO", waypoints: [
    {lon: 117.0, lat: 7.5}, {lon: 118.5, lat: 12.0}, {lon: 120.5, lat: 18.5},
    {lon: 122.0, lat: 21.5}, {lon: 124.0, lat: 25.0}, {lon: 128.0, lat: 28.5},
    {lon: 134.0, lat: 33.5}, {lon: 139.5, lat: 35.0},
  ]},
  // Tokyo → Busan via Tsushima Strait
  { name: "TYO-PUS", waypoints: [
    {lon: 139.5, lat: 35.0}, {lon: 135.0, lat: 33.5}, {lon: 132.0, lat: 33.0},
    {lon: 130.0, lat: 33.5}, {lon: 129.2, lat: 35.1},
  ]},
  // Shanghai → Yokohama via E China Sea
  { name: "SHA-YOK", waypoints: [
    {lon: 121.5, lat: 31.0}, {lon: 124.0, lat: 30.5}, {lon: 128.0, lat: 31.0},
    {lon: 132.0, lat: 32.5}, {lon: 136.5, lat: 34.5}, {lon: 139.7, lat: 35.4},
  ]},
  // Manila → Hong Kong
  { name: "MNL-HKG", waypoints: [
    {lon: 121.0, lat: 14.5}, {lon: 119.0, lat: 16.5}, {lon: 117.0, lat: 19.5},
    {lon: 114.2, lat: 22.3},
  ]},
  // Kaohsiung → Yokohama via Miyako Strait
  { name: "KHH-YOK", waypoints: [
    {lon: 120.3, lat: 22.5}, {lon: 122.5, lat: 24.0}, {lon: 125.0, lat: 25.5},
    {lon: 128.0, lat: 27.5}, {lon: 132.0, lat: 31.0}, {lon: 136.0, lat: 34.0},
    {lon: 139.7, lat: 35.4},
  ]},
  // Busan → Shanghai (Yellow Sea)
  { name: "PUS-SHA", waypoints: [
    {lon: 129.2, lat: 35.1}, {lon: 126.5, lat: 34.5}, {lon: 124.0, lat: 33.5},
    {lon: 122.5, lat: 32.0}, {lon: 121.5, lat: 31.0},
  ]},
  // Singapore → Kaohsiung via S China Sea (passes Spratlys area)
  { name: "SIN-KHH", waypoints: [
    {lon: 117.0, lat: 7.5}, {lon: 116.5, lat: 12.0}, {lon: 117.5, lat: 16.0},
    {lon: 119.0, lat: 19.0}, {lon: 120.3, lat: 22.5},
  ]},
  // Manila → Guam (Philippine Sea crossing)
  { name: "MNL-GUM", waypoints: [
    {lon: 121.0, lat: 14.5}, {lon: 125.0, lat: 13.8}, {lon: 130.0, lat: 13.5},
    {lon: 135.0, lat: 13.4}, {lon: 144.7, lat: 13.5},
  ]},
  // Yokohama → Guam (S to Marianas)
  { name: "YOK-GUM", waypoints: [
    {lon: 139.7, lat: 35.4}, {lon: 141.0, lat: 30.0}, {lon: 142.5, lat: 24.0},
    {lon: 144.0, lat: 18.0}, {lon: 144.7, lat: 13.5},
  ]},
  // Coastal Japan (Honshu E coast)
  { name: "JPN-COAST", waypoints: [
    {lon: 141.5, lat: 41.0}, {lon: 141.8, lat: 38.0}, {lon: 141.0, lat: 35.5},
    {lon: 139.7, lat: 35.0}, {lon: 137.0, lat: 34.5}, {lon: 134.5, lat: 34.0},
  ]},
  // Taiwan Strait — N–S
  { name: "TWN-STR", waypoints: [
    {lon: 119.5, lat: 25.5}, {lon: 119.0, lat: 24.0}, {lon: 119.5, lat: 22.5},
    {lon: 120.5, lat: 21.0},
  ]},
  // Manila → Cebu coastal
  { name: "MNL-CEB", waypoints: [
    {lon: 121.0, lat: 14.5}, {lon: 122.5, lat: 13.0}, {lon: 124.0, lat: 11.0},
    {lon: 124.0, lat: 10.3},
  ]},
];

const pointAlongRoute = (waypoints, t) => {
  // t in [0,1) — distribute along total length, with reflection so vessels
  // travel a → b → a → b smoothly (no teleport at end)
  const reflect = (Math.sin(t * Math.PI * 2 - Math.PI / 2) + 1) / 2; // 0..1..0
  const segments = waypoints.length - 1;
  const f = reflect * segments;
  const i = Math.min(Math.floor(f), segments - 1);
  const lf = f - i;
  const a = waypoints[i], b = waypoints[i + 1];
  return {
    lon: a.lon + (b.lon - a.lon) * lf,
    lat: a.lat + (b.lat - a.lat) * lf,
  };
};

const generateAISFleet = () => {
  const fleet = [];
  const types = ["CARGO", "CARGO", "CARGO", "TANKER", "TANKER", "BULK", "CONTAINER", "CONTAINER", "PASSENGER", "FISHING"];
  const dests = {
    "SIN-TYO": ["TOKYO","YOKOHAMA"], "TYO-PUS": ["BUSAN"], "SHA-YOK": ["YOKOHAMA"],
    "MNL-HKG": ["HONG KONG"], "KHH-YOK": ["YOKOHAMA"], "PUS-SHA": ["SHANGHAI"],
    "SIN-KHH": ["KAOHSIUNG"], "MNL-GUM": ["APRA HARBOR"], "YOK-GUM": ["APRA HARBOR"],
    "JPN-COAST": ["KOBE","NAGOYA"], "TWN-STR": ["KEELUNG","KAOHSIUNG"],
    "MNL-CEB": ["CEBU CITY"],
  };
  let idx = 0;
  while (fleet.length < CONFIG.AIS_VESSEL_COUNT) {
    const route = SHIPPING_ROUTES[idx % SHIPPING_ROUTES.length];
    const flagInfo = FLAG_DATA[Math.floor(Math.random() * FLAG_DATA.length)];
    const name = flagInfo.names[Math.floor(Math.random() * flagInfo.names.length)] +
                 ` ${Math.floor(Math.random() * 99 + 1)}`;
    const tail = Math.floor(Math.random() * 1000000).toString().padStart(6, "0");
    const mmsi = `${flagInfo.mid}${tail}`;
    const type = types[Math.floor(Math.random() * types.length)];
    // Speed: container ~0.0008/tick (slow loop), tanker slower, fishing slowest
    const baseSpeed = type === "CONTAINER" ? 0.00045 :
                      type === "PASSENGER" ? 0.00060 :
                      type === "FISHING"   ? 0.00018 :
                      type === "TANKER"    ? 0.00030 : 0.00038;
    const sog = type === "CONTAINER" ? 18 + Math.random() * 4 :
                type === "PASSENGER" ? 22 + Math.random() * 4 :
                type === "FISHING"   ? 6  + Math.random() * 3 :
                type === "TANKER"    ? 11 + Math.random() * 3 :
                                       12 + Math.random() * 4;
    const initialT = Math.random();
    const start = pointAlongRoute(route.waypoints, initialT);
    const wp = geoToWorld(start.lat, start.lon);
    fleet.push({
      mmsi, name,
      lat: start.lat, lon: start.lon, wx: wp.x, wy: wp.y,
      cog: 0, sog, heading: 0,
      type, flag: flagInfo.flag,
      dest: (dests[route.name] || ["—"])[0],
      imo: `IMO${Math.floor(Math.random() * 9000000 + 1000000)}`,
      route: route.waypoints,
      routeName: route.name,
      routePos: initialT,
      routeSpeed: baseSpeed,
    });
    idx++;
  }
  return fleet;
};

// ─── PHASE 2: PROPER POLYGON-CLIPPED SWEEP PATH ──────────────────────────────
// Standard scan-line: for each horizontal line, find polygon-edge intersections,
// Standard ray-casting point-in-polygon test
const pointInPolygon = (pt, poly) => {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x, yi = poly[i].y;
    const xj = poly[j].x, yj = poly[j].y;
    if (((yi > pt.y) !== (yj > pt.y)) &&
        (pt.x < ((xj - xi) * (pt.y - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
};

// pair them into interior segments, alternate left-to-right / right-to-left.
const lineXIntersects = (y, poly) => {
  const xs = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length];
    const cross = (a.y <= y && b.y > y) || (b.y <= y && a.y > y);
    if (cross) {
      const t = (y - a.y) / (b.y - a.y);
      xs.push(a.x + t * (b.x - a.x));
    }
  }
  return xs.sort((a, b) => a - b);
};

const polygonSweepPath = (poly, lanes = CONFIG.PATROL_LANES) => {
  if (poly.length < 3) return [];
  const ys = poly.map((p) => p.y);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const stepY = (maxY - minY) / lanes;
  const path = [];
  let dir = 1; // 1 = L→R, -1 = R→L
  for (let i = 0; i <= lanes; i++) {
    const y = minY + i * stepY + 0.001; // offset avoids vertex degenerate cases
    const xs = lineXIntersects(y, poly);
    if (xs.length < 2) continue;
    // Pair consecutive intersections; each pair is one interior segment
    const segs = [];
    for (let j = 0; j + 1 < xs.length; j += 2) {
      segs.push([xs[j], xs[j + 1]]);
    }
    if (dir === -1) segs.reverse();
    for (const [x0, x1] of segs) {
      if (dir === 1) path.push({ x: x0, y }, { x: x1, y });
      else path.push({ x: x1, y }, { x: x0, y });
    }
    dir *= -1;
  }
  return path;
};

const polygonCentroid = (poly) => {
  let x = 0, y = 0;
  poly.forEach((p) => { x += p.x; y += p.y; });
  return { x: x / poly.length, y: y / poly.length };
};

// ─── PHASE 4: VORONOI PATROL PARTITIONING ─────────────────────────────────
// Distribute N seeds inside the polygon, then build a coarse polygonal Voronoi
// region per seed by rasterizing → tracing each region's boundary as a polygon
// → running the existing polygonSweepPath on it.
const placeVoronoiSeeds = (poly, n) => {
  if (n <= 1) return [polygonCentroid(poly)];
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rx = (maxX - minX) * 0.28, ry = (maxY - minY) * 0.28;
  const seeds = [];
  for (let i = 0; i < n; i++) {
    const angle = (i / n) * Math.PI * 2 - Math.PI / 2;
    let sx = cx + Math.cos(angle) * rx;
    let sy = cy + Math.sin(angle) * ry;
    // Snap inside polygon: if outside, fall back to centroid offset
    if (!pointInPolygon({ x: sx, y: sy }, poly)) { sx = cx; sy = cy; }
    seeds.push({ x: sx, y: sy });
  }
  return seeds;
};

// Rasterize polygon → for each cell, find nearest seed → build per-seed cell list.
// Then return per-seed bounding-box approximation as a sub-polygon.
// This is intentionally coarse; gives clean lawn-mower lanes per region.
const voronoiSubPolygons = (poly, seeds, gridStep = 50) => {
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  // Per-seed accumulators: track min/max x per row to build a polygon
  const perSeed = seeds.map(() => ({ rows: new Map() }));
  for (let y = minY; y <= maxY; y += gridStep) {
    for (let x = minX; x <= maxX; x += gridStep) {
      if (!pointInPolygon({ x, y }, poly)) continue;
      let bestI = 0, bestD = Infinity;
      for (let i = 0; i < seeds.length; i++) {
        const d = (seeds[i].x - x) ** 2 + (seeds[i].y - y) ** 2;
        if (d < bestD) { bestD = d; bestI = i; }
      }
      const rowKey = Math.round(y);
      const row = perSeed[bestI].rows.get(rowKey);
      if (!row) perSeed[bestI].rows.set(rowKey, { y, minX: x, maxX: x });
      else { row.minX = Math.min(row.minX, x); row.maxX = Math.max(row.maxX, x); }
    }
  }
  // Convert per-seed row maps → polygon (left edge top-down, right edge bottom-up)
  return perSeed.map(({ rows }) => {
    if (rows.size === 0) return [];
    const sorted = [...rows.values()].sort((a, b) => a.y - b.y);
    const left = sorted.map((r) => ({ x: r.minX, y: r.y }));
    const right = sorted.slice().reverse().map((r) => ({ x: r.maxX, y: r.y }));
    return [...left, ...right];
  });
};

// ─── FACTORIES ───────────────────────────────────────────────────────────────
let _idCounter = 1;
const newId = (p) => `${p}-${_idCounter++}`;

const createISRUnit = (x, y, n = 1) => {
  const usvId = newId("usv");
  return [
    { id: usvId, type: "USV", faction: "friendly", x, y, heading: 0, battery: 92,
      state: "idle", goal: null, label: `ISR-${n}`, patrolPath: null, patrolIdx: 0,
      engageTargetId: null, aisEngageMMSI: null },
    { id: newId("uav"), type: "UAV", faction: "friendly", x, y, heading: 0, battery: 88,
      state: "orbiting", parentId: usvId, orbitAngle: 0, label: "α",
      missionGoal: null, missionAborted: false },
    { id: newId("uav"), type: "UAV", faction: "friendly", x, y, heading: 0, battery: 100,
      state: "docked", parentId: usvId, orbitAngle: Math.PI, label: "β",
      missionGoal: null, missionAborted: false },
  ];
};

const createCommercialVessel = (x, y) => ({
  id: newId("com"), type: "COMMERCIAL", faction: "neutral",
  x, y, heading: Math.random() * Math.PI * 2, battery: 100, state: "transit",
  goal: { x: x + (Math.random() - 0.5) * 1500, y: y + (Math.random() - 0.5) * 1500 },
  label: `MV-${Math.floor(Math.random() * 900 + 100)}`,
  // Phase 2: AIS data fields
  mmsi: `${Math.floor(Math.random() * 900000000 + 100000000)}`,
  imo: `IMO${Math.floor(Math.random() * 9000000 + 1000000)}`,
  flag: ["KOR", "PAN", "LBR", "MSH", "SGP", "HKG"][Math.floor(Math.random() * 6)],
  vesselType: ["TANKER", "CARGO", "BULK", "CONT"][Math.floor(Math.random() * 4)],
});

const createEnemyVessel = (x, y) => ({
  id: newId("hos"), type: "ENEMY", faction: "hostile",
  x, y, heading: Math.random() * Math.PI * 2, battery: 100, state: "transit",
  goal: { x: x + (Math.random() - 0.5) * 1200, y: y + (Math.random() - 0.5) * 1200 },
  label: `UNK-${Math.floor(Math.random() * 99 + 10)}`,
});

// Phase 2: subsurface
const createSubmarine = (x, y) => ({
  id: newId("sub"), type: "SUBMARINE", faction: "hostile",
  x, y, heading: Math.random() * Math.PI * 2, battery: 100, state: "transit",
  goal: { x: x + (Math.random() - 0.5) * 1200, y: y + (Math.random() - 0.5) * 1200 },
  label: `SS-${Math.floor(Math.random() * 99 + 10)}`,
});

const createMine = (x, y) => ({
  id: newId("min"), type: "MINE", faction: "hostile",
  x, y, heading: 0, battery: 100, state: "moored",
  goal: null, label: `MIN-${Math.floor(Math.random() * 99 + 10)}`,
});

const createJamZone = (x, y) => ({
  id: newId("jam"), x, y, radius: CONFIG.JAM_ZONE_RADIUS,
  label: `JAM-${Math.floor(Math.random() * 99 + 10)}`,
});

const makeInitialState = () => {
  const isr = createISRUnit(2400, 1900, 1);
  return {
    units: [...isr],
    detections: {},
    alerts: [],
    patrolAreas: [],
    jamZones: [],
    aisShips: [],
    selectedIds: [],
    fogReveal: [],
    simSpeed: 1, paused: false, simTime: 0,
    isrCount: 1,
  };
};

// ─── SIM TICK ────────────────────────────────────────────────────────────────
// Phase 2: UAV checks for jam zones; underwater detection routed to sonar only.
const tickUnit = (u, units, jamZones, dt) => {
  const next = { ...u };

  if (u.type === "UAV") {
    const parent = units.find((x) => x.id === u.parentId);
    if (!parent) return next;

    const isAirborne = u.state !== "docked";
    const inJam = isAirborne && jamZones.some((jz) => dist(u, jz) < jz.radius);

    // Battery math: how much do we need to fly back to USV at current speed/drain?
    // ticks_to_return = distance / UAV_SPEED   (per dt unit)
    // battery_to_return = ticks * UAV_BATTERY_DRAIN
    const distToHome = Math.hypot(parent.x - u.x, parent.y - u.y);
    const ticksToReturn = distToHome / CONFIG.UAV_SPEED;
    const batteryToReturn = ticksToReturn * CONFIG.UAV_BATTERY_DRAIN
                          + CONFIG.UAV_RETURN_BATTERY_MARGIN;

    if (u.state === "orbiting") {
      if (inJam) {
        next.state = "jammed";
        next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);
        return next;
      }
      next.orbitAngle = u.orbitAngle + CONFIG.UAV_ORBIT_ANGULAR_SPEED * dt;
      next.x = parent.x + Math.cos(next.orbitAngle) * CONFIG.UAV_ORBIT_RADIUS;
      next.y = parent.y + Math.sin(next.orbitAngle) * CONFIG.UAV_ORBIT_RADIUS;
      next.heading = next.orbitAngle + Math.PI / 2;
      next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);
      if (next.battery < CONFIG.UAV_LOW_BATTERY) next.state = "returning";
    } else if (u.state === "mission") {
      // Phase 4: UAV controllable — fly to missionGoal, then orbit it briefly,
      // OR abort if battery gets close to return-threshold.
      if (inJam) {
        next.state = "jammed";
        next.missionAborted = true;
        next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);
        return next;
      }
      if (u.battery <= batteryToReturn) {
        // Abort — not enough battery to continue mission and return safely
        next.state = "returning";
        next.missionAborted = true;
        next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);
        return next;
      }
      const goal = u.missionGoal;
      if (!goal) {
        next.state = "returning";
        next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);
        return next;
      }
      const dx = goal.x - u.x, dy = goal.y - u.y;
      const d = Math.hypot(dx, dy);
      if (d < 12) {
        // Reached: orbit the goal point indefinitely until abort
        const ang = (u.orbitAngle || 0) + CONFIG.UAV_ORBIT_ANGULAR_SPEED * dt;
        next.orbitAngle = ang;
        next.x = goal.x + Math.cos(ang) * 30;
        next.y = goal.y + Math.sin(ang) * 30;
        next.heading = ang + Math.PI / 2;
      } else {
        const v = norm({ x: dx, y: dy });
        next.x = u.x + v.x * CONFIG.UAV_SPEED * dt;
        next.y = u.y + v.y * CONFIG.UAV_SPEED * dt;
        next.heading = angleOf(dx, dy);
      }
      next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);
    } else if (u.state === "jammed") {
      // RTB; jam zone forced abort — preserve missionAborted flag
      const dx = parent.x - u.x, dy = parent.y - u.y;
      const d = Math.hypot(dx, dy);
      next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);
      if (d < CONFIG.UAV_DOCK_RANGE) {
        next.state = "docked"; next.x = parent.x; next.y = parent.y;
        next.missionGoal = null; next.missionAborted = false;
      } else {
        const v = norm({ x: dx, y: dy });
        next.x = u.x + v.x * CONFIG.UAV_SPEED * dt;
        next.y = u.y + v.y * CONFIG.UAV_SPEED * dt;
        next.heading = angleOf(dx, dy);
      }
    } else if (u.state === "returning") {
      const dx = parent.x - u.x, dy = parent.y - u.y;
      const d = Math.hypot(dx, dy);
      next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);
      if (d < CONFIG.UAV_DOCK_RANGE) {
        next.state = "docked"; next.x = parent.x; next.y = parent.y;
        next.missionGoal = null; next.missionAborted = false;
      } else {
        const v = norm({ x: dx, y: dy });
        next.x = u.x + v.x * CONFIG.UAV_SPEED * dt;
        next.y = u.y + v.y * CONFIG.UAV_SPEED * dt;
        next.heading = angleOf(dx, dy);
      }
    } else if (u.state === "docked") {
      next.x = parent.x; next.y = parent.y;
      next.battery = Math.min(100, u.battery + CONFIG.UAV_CHARGE_RATE * dt);
    }
    return next;
  }

  if (u.type === "USV") {
    if (u.state === "charging") {
      next.battery = Math.min(100, u.battery + CONFIG.USV_SOLAR_RATE * dt);
      if (next.battery > 80) next.state = "idle";
      return next;
    }

    // Phase 2.1: USV in jam zone → backtrack radially away from center.
    // Preserves goal/patrolPath so the USV resumes once clear.
    const inJam = jamZones.find((jz) => dist(u, jz) < jz.radius);
    if (inJam) {
      const dx = u.x - inJam.x, dy = u.y - inJam.y;
      const d = Math.hypot(dx, dy) || 1;
      const v = { x: dx / d, y: dy / d };
      next.x = u.x + v.x * CONFIG.USV_SPEED * dt;
      next.y = u.y + v.y * CONFIG.USV_SPEED * dt;
      next.heading = angleOf(v.x, v.y);
      next.state = "jammed";
      next.battery = Math.max(0, u.battery - CONFIG.USV_BATTERY_DRAIN * dt);
      return next;
    }

    // Phase 2.1 + 3: TRACK — deployed unit or live AIS ship
    if (u.engageTargetId || u.aisEngageMMSI) {
      let tgtPos = null;
      let tgtLabel = null;
      if (u.engageTargetId) {
        const tgt = units.find((x) => x.id === u.engageTargetId);
        if (tgt) { tgtPos = tgt; tgtLabel = tgt.label; }
        else next.engageTargetId = null;
      }
      // aisShips not available in tickUnit (no closure), handled via goal injection in reducer
      // If no valid target found, idle
      if (!tgtPos && !u.aisEngageMMSI) { next.state = "idle"; }
      else if (tgtPos) {
        const dx = tgtPos.x - u.x, dy = tgtPos.y - u.y;
        const d = Math.hypot(dx, dy);
        if (d > CONFIG.TRACK_STANDOFF) {
          const vv = norm({ x: dx, y: dy });
          next.x = u.x + vv.x * CONFIG.USV_SPEED * dt;
          next.y = u.y + vv.y * CONFIG.USV_SPEED * dt;
        }
        next.heading = angleOf(dx, dy);
        next.state = "tracking";
        next.battery = Math.max(0, u.battery - CONFIG.USV_BATTERY_DRAIN * dt);
        if (next.battery < CONFIG.USV_LOW_BATTERY) next.state = "charging";
        return next;
      }
      // aisEngageMMSI: goal is injected by reducer each tick; fall through to goal logic below
    }

    let target = u.goal;
    if (u.patrolPath && u.patrolPath.length > 0) {
      target = u.patrolPath[u.patrolIdx % u.patrolPath.length];
    }
    if (target) {
      const dx = target.x - u.x, dy = target.y - u.y;
      const d = Math.hypot(dx, dy);
      if (d < 6) {
        if (u.patrolPath) next.patrolIdx = (u.patrolIdx + 1) % u.patrolPath.length;
        else { next.goal = null; next.state = "idle"; }
      } else {
        const v = norm({ x: dx, y: dy });
        next.x = u.x + v.x * CONFIG.USV_SPEED * dt;
        next.y = u.y + v.y * CONFIG.USV_SPEED * dt;
        next.heading = angleOf(dx, dy);
        next.state = u.patrolPath ? "patrolling" : "moving";
      }
    } else if (!u.patrolPath) next.state = "idle";
    next.battery = Math.max(0, u.battery - CONFIG.USV_BATTERY_DRAIN * dt);
    if (next.battery < CONFIG.USV_LOW_BATTERY) next.state = "charging";
    return next;
  }

  // MINE — stationary
  if (u.type === "MINE") return next;

  // SUBMARINE / ENEMY / COMMERCIAL — autonomous wander
  if (u.goal) {
    const dx = u.goal.x - u.x, dy = u.goal.y - u.y;
    const d = Math.hypot(dx, dy);
    if (d < 10) {
      next.goal = {
        x: clamp(u.x + (Math.random() - 0.5) * 1800, 100, CONFIG.WORLD_W - 100),
        y: clamp(u.y + (Math.random() - 0.5) * 1800, 100, CONFIG.WORLD_H - 100),
      };
    } else {
      const speed = u.type === "ENEMY" ? CONFIG.ENEMY_SPEED :
                    u.type === "SUBMARINE" ? CONFIG.SUBMARINE_SPEED :
                    CONFIG.COMMERCIAL_SPEED;
      const v = norm({ x: dx, y: dy });
      next.x = u.x + v.x * speed * dt;
      next.y = u.y + v.y * speed * dt;
      next.heading = angleOf(dx, dy);
    }
  }
  return next;
};

const applyUAVRotation = (units) =>
  units.map((u) => {
    if (u.type !== "UAV" || u.state !== "docked") return u;
    if (u.battery < CONFIG.UAV_FULL_BATTERY) return u;
    const sibling = units.find(
      (x) => x.type === "UAV" && x.parentId === u.parentId && x.id !== u.id
    );
    if (!sibling || sibling.state === "returning" || sibling.state === "docked") {
      return { ...u, state: "orbiting", orbitAngle: Math.random() * Math.PI * 2 };
    }
    return u;
  });

// Phase 2: detection branches on surface vs subsurface
const updateDetections = (units, detections, dt) => {
  const friendlies = units.filter((u) => u.faction === "friendly");
  const targets = units.filter((u) => u.faction !== "friendly");
  const next = { ...detections };

  targets.forEach((t) => {
    let inRange = false;
    if (isUnderwater(t)) {
      // Subsurface — sonar only (towed by USV; not when charging)
      inRange = friendlies.some(
        (f) => f.type === "USV" && f.state !== "charging" && dist(f, t) < CONFIG.SONAR_RANGE
      );
    } else {
      // Surface — UAV cameras (long) + USV surface sensors (medium)
      const sensorRange = (f) =>
        f.type === "UAV" ? CONFIG.UAV_SENSOR_RANGE : CONFIG.USV_SENSOR_RANGE;
      inRange = friendlies.some(
        (f) => f.state !== "docked" && f.state !== "charging" &&
               f.state !== "jammed" && dist(f, t) < sensorRange(f)
      );
    }
    const cur = next[t.id]?.confidence || 0;
    const rate = t.type === "MINE" ? CONFIG.CONFIDENCE_RATE * CONFIG.MINE_DETECTION_BOOST
                                   : CONFIG.CONFIDENCE_RATE;
    if (inRange) {
      next[t.id] = { confidence: Math.min(100, cur + rate * dt), lastSeen: 0 };
    } else if (cur > 0) {
      next[t.id] = {
        confidence: Math.max(0, cur - CONFIG.CONFIDENCE_DECAY * dt),
        lastSeen: (next[t.id]?.lastSeen || 0) + dt,
      };
    }
  });
  return next;
};

// Phase 2: nuanced alerts per type & confidence level. Dedup via eventId.
const generateAlerts = (units, detections, prevAlerts, jamEvents, simTime) => {
  const alerts = [...prevAlerts];
  const has = (eid) => alerts.find((a) => a.eventId === eid);

  units.forEach((u) => {
    const det = detections[u.id];
    if (!det) return;

    if (u.type === "MINE") {
      if (det.confidence > CONFIG.POSSIBLE_THRESHOLD && !has(`mine-pos-${u.id}`)) {
        alerts.unshift({ id: newId("alt"), eventId: `mine-pos-${u.id}`,
          kind: "MINE", severity: "med",
          title: `POSSIBLE MINE — ${u.label}`,
          body: "Sonar return suggests submerged threat.",
          unitId: u.id, time: simTime });
      }
      if (det.confidence > CONFIG.CONFIRMED_THRESHOLD && !has(`mine-conf-${u.id}`)) {
        alerts.unshift({ id: newId("alt"), eventId: `mine-conf-${u.id}`,
          kind: "MINE", severity: "high",
          title: `CONFIRMED MINE — ${u.label}`,
          body: "Submerged mine confirmed. Maintain standoff.",
          unitId: u.id, time: simTime });
      }
    } else if (u.type === "SUBMARINE") {
      if (det.confidence > CONFIG.CONFIRMED_THRESHOLD && !has(`sub-${u.id}`)) {
        alerts.unshift({ id: newId("alt"), eventId: `sub-${u.id}`,
          kind: "SUBSURFACE", severity: "high",
          title: `SUBSURFACE CONTACT — ${u.label}`,
          body: "Submerged hostile confirmed.",
          unitId: u.id, time: simTime });
      }
    } else if (u.faction === "hostile") {
      if (det.confidence > CONFIG.CONFIRMED_THRESHOLD && !has(`hos-${u.id}`)) {
        alerts.unshift({ id: newId("alt"), eventId: `hos-${u.id}`,
          kind: "DETECT", severity: "high",
          title: `HOSTILE CONFIRMED — ${u.label}`,
          body: "Enemy vessel inside sensor envelope.",
          unitId: u.id, time: simTime });
      }
    }
  });

  jamEvents.forEach((je) => {
    if (!has(`jam-${je.unitId}`)) {
      const isUSV = je.unitType === "USV";
      alerts.unshift({ id: newId("alt"), eventId: `jam-${je.unitId}`,
        kind: "GPS.JAM", severity: isUSV ? "med" : "high",
        title: `GPS DENIAL — ${je.unitLabel}`,
        body: isUSV
          ? "USV in GPS-denied envelope. Backtracking to safe waters."
          : "UAV in GPS-denied envelope. RTB to USV.",
        unitId: je.unitId, time: simTime });
    }
  });

  // Phase 4: UAV mission abort alerts
  units.forEach((u) => {
    if (u.type !== "UAV") return;
    if (u.missionAborted && u.state === "returning" && !has(`uav-abort-${u.id}-${Math.floor(simTime/10)}`)) {
      alerts.unshift({ id: newId("alt"),
        eventId: `uav-abort-${u.id}-${Math.floor(simTime/10)}`,
        kind: "MISSION.ABORT", severity: "med",
        title: `UAV ${u.label} ABORTING`,
        body: "Insufficient battery to complete mission. Returning to USV.",
        unitId: u.id, time: simTime });
    }
  });

  return alerts.slice(0, 30);
};

// ─── REDUCER ─────────────────────────────────────────────────────────────────
const clearOrdersForUSVs = (state, usvIds) => ({
  units: state.units.map((u) =>
    usvIds.includes(u.id)
      ? { ...u, goal: null, patrolPath: null, patrolIdx: 0,
          engageTargetId: null, aisEngageMMSI: null, state: "idle" }
      : u
  ),
  patrolAreas: state.patrolAreas.filter(
    (pa) => !pa.unitIds.some((id) => usvIds.includes(id))
  ),
});

const reducer = (state, action) => {
  switch (action.type) {
    case "TICK": {
      const dt = state.simSpeed;
      // Inject AIS-tracking goal into USVs before tick (so tickUnit sees it as goal)
      const preUnits = state.units.map((u) => {
        if (u.type !== "USV" || !u.aisEngageMMSI) return u;
        const ship = state.aisShips.find((s) => s.mmsi === u.aisEngageMMSI);
        if (!ship) return { ...u, aisEngageMMSI: null, state: "idle" };
        const standoffPt = {
          x: ship.wx + (u.x - ship.wx) / Math.max(1, Math.hypot(u.x - ship.wx, u.y - ship.wy)) * CONFIG.TRACK_STANDOFF,
          y: ship.wy + (u.y - ship.wy) / Math.max(1, Math.hypot(u.x - ship.wx, u.y - ship.wy)) * CONFIG.TRACK_STANDOFF,
        };
        return { ...u, goal: standoffPt, state: "tracking" };
      });
      let units = preUnits.map((u) => tickUnit(u, preUnits, state.jamZones, dt));
      units = applyUAVRotation(units);
      const detections = updateDetections(units, state.detections, dt);
      // Phase 2.1: track jam events for both UAVs and USVs
      const jamEvents = units
        .filter((u) => u.faction === "friendly" && u.state === "jammed")
        .map((u) => ({ unitId: u.id, unitLabel: u.label, unitType: u.type }));
      const newSimTime = state.simTime + dt * 0.05;
      const alerts = generateAlerts(units, detections, state.alerts, jamEvents, newSimTime);
      const newReveals = units
        .filter((u) => u.faction === "friendly" && u.state !== "docked" && u.state !== "jammed")
        .map((u) => ({ x: u.x, y: u.y, r: CONFIG.FOG_REVEAL_RANGE }));
      return { ...state, units, detections, alerts, fogReveal: newReveals, simTime: newSimTime };
    }
    case "TOGGLE_PAUSE": return { ...state, paused: !state.paused };
    case "SET_SPEED": return { ...state, simSpeed: action.speed };
    case "SELECT": return { ...state, selectedIds: action.ids };

    case "MOVE_SELECTED": {
      const selected = state.units.filter((u) => state.selectedIds.includes(u.id));
      const usvIds = selected.filter((u) => u.type === "USV").map((u) => u.id);
      const uavIds = selected.filter((u) => u.type === "UAV").map((u) => u.id);
      if (usvIds.length === 0 && uavIds.length === 0) return state;

      let units = state.units;
      let patrolAreas = state.patrolAreas;

      if (usvIds.length > 0) {
        const cleared = clearOrdersForUSVs({ ...state, units, patrolAreas }, usvIds);
        units = cleared.units;
        patrolAreas = cleared.patrolAreas;
        units = units.map((u) =>
          usvIds.includes(u.id) ? { ...u, goal: action.target, state: "moving" } : u
        );
      }

      // UAV mission dispatch — only viable if airborne (orbiting/mission/returning)
      if (uavIds.length > 0) {
        units = units.map((u) => {
          if (!uavIds.includes(u.id)) return u;
          if (u.state === "docked" || u.state === "jammed") return u;
          return { ...u, state: "mission", missionGoal: action.target,
                   missionAborted: false, orbitAngle: 0 };
        });
      }
      return { ...state, units, patrolAreas };
    }
    case "ENGAGE_TARGET": {
      const usvIds = state.units
        .filter((u) => state.selectedIds.includes(u.id) && u.type === "USV")
        .map((u) => u.id);
      if (usvIds.length === 0) return state;
      const cleared = clearOrdersForUSVs(state, usvIds);
      const units = cleared.units.map((u) =>
        usvIds.includes(u.id)
          ? { ...u, engageTargetId: action.targetId, state: "tracking" }
          : u
      );
      return { ...state, units, patrolAreas: cleared.patrolAreas };
    }
    case "HOLD_SELECTED": {
      const usvIds = state.units
        .filter((u) => state.selectedIds.includes(u.id) && u.type === "USV")
        .map((u) => u.id);
      if (usvIds.length === 0) return state;
      const cleared = clearOrdersForUSVs(state, usvIds);
      return { ...state, units: cleared.units, patrolAreas: cleared.patrolAreas };
    }
    case "ADD_PATROL": {
      const { polygon, unitIds } = action;
      const usvs = state.units.filter((u) => unitIds.includes(u.id) && u.type === "USV");
      if (usvs.length === 0) return state;
      const usvIds = usvs.map((u) => u.id);
      const cleared = clearOrdersForUSVs(state, usvIds);

      // Single USV → original behavior. Multiple → Voronoi-partition the polygon.
      const id = newId("pat");
      let assignments;
      let regions = null;
      if (usvs.length === 1) {
        const path = polygonSweepPath(polygon);
        assignments = [{ usvId: usvs[0].id, path, region: polygon }];
      } else {
        const seeds = placeVoronoiSeeds(polygon, usvs.length);
        const subPolys = voronoiSubPolygons(polygon, seeds);
        // Match seeds to nearest USVs by current position to minimize transit
        const remainingUSVs = [...usvs];
        assignments = seeds.map((seed, idx) => {
          let bestI = 0, bestD = Infinity;
          remainingUSVs.forEach((u, i) => {
            const d = (u.x - seed.x) ** 2 + (u.y - seed.y) ** 2;
            if (d < bestD) { bestD = d; bestI = i; }
          });
          const usv = remainingUSVs.splice(bestI, 1)[0];
          const region = subPolys[idx];
          const path = region.length >= 3 ? polygonSweepPath(region, 4) : [seed];
          return { usvId: usv.id, path, region };
        });
        regions = assignments.map((a) => a.region).filter((r) => r.length >= 3);
      }

      const units = cleared.units.map((u) => {
        const a = assignments.find((x) => x.usvId === u.id);
        if (!a) return u;
        return { ...u, patrolPath: a.path, patrolIdx: 0, state: "patrolling", goal: null };
      });
      return {
        ...state, units,
        patrolAreas: [...cleared.patrolAreas, {
          id, polygon, unitIds: usvIds,
          path: assignments[0].path,    // legacy field
          assignments,                   // Phase 4: per-USV regions + paths
          regions,                       // optional sub-polygons for rendering
        }],
      };
    }

    // Phase 2: spawn actions
    case "SPAWN_ENEMY":
      return { ...state, units: [...state.units, createEnemyVessel(action.x, action.y)] };
    case "SPAWN_COMMERCIAL":
      return { ...state, units: [...state.units, createCommercialVessel(action.x, action.y)] };
    case "SPAWN_SUBMARINE":
      return { ...state, units: [...state.units, createSubmarine(action.x, action.y)] };
    case "SPAWN_MINE":
      return { ...state, units: [...state.units, createMine(action.x, action.y)] };
    case "SPAWN_ISR": {
      const n = state.isrCount + 1;
      return { ...state, isrCount: n, units: [...state.units, ...createISRUnit(action.x, action.y, n)] };
    }
    case "SPAWN_JAM_ZONE":
      return { ...state, jamZones: [...state.jamZones, createJamZone(action.x, action.y)] };
    case "REMOVE_JAM_ZONE":
      return { ...state, jamZones: state.jamZones.filter((j) => j.id !== action.id) };

    case "SET_AIS_SHIPS":
      return { ...state, aisShips: action.ships };
    case "ENGAGE_AIS_TARGET": {
      const usvIds = state.units
        .filter((u) => state.selectedIds.includes(u.id) && u.type === "USV")
        .map((u) => u.id);
      if (usvIds.length === 0) return state;
      const cleared = clearOrdersForUSVs(state, usvIds);
      const units = cleared.units.map((u) =>
        usvIds.includes(u.id)
          ? { ...u, aisEngageMMSI: action.mmsi, state: "tracking" }
          : u
      );
      return { ...state, units, patrolAreas: cleared.patrolAreas };
    }

    case "DISMISS_ALERT":
      return { ...state, alerts: state.alerts.filter((a) => a.id !== action.id) };
    case "ADD_ALERT":
      return {
        ...state,
        alerts: [{
          id: newId("alt"), eventId: `custom-${newId("ev")}`,
          kind: action.kind, severity: action.severity,
          title: action.title, body: action.body, time: state.simTime,
        }, ...state.alerts].slice(0, 30),
      };
    default: return state;
  }
};

// ─── LANDMASSES — FIRST ISLAND CHAIN ─────────────────────────────────────────
// Hand-tuned silhouettes positioned in world coords (6400 × 4000)
// Geo: 116°E–148°E, 5°N–42°N. Each degree ≈ 200 world units (lon), 108 (lat)
const LAND = [
  // ── Mainland China east coast (left edge) ──
  "M 0 0 L 1850 0 L 1820 200 L 1740 380 L 1660 540 L 1580 720 L 1480 920 L 1380 1120 L 1250 1300 L 1100 1500 L 950 1700 L 800 1900 L 700 2100 L 600 2350 L 500 2600 L 400 2900 L 300 3200 L 200 3500 L 100 3800 L 0 4000 Z",
  // ── Korean Peninsula ──
  "M 1820 250 L 1900 280 L 1960 380 L 2010 480 L 2030 600 L 2010 720 L 1980 820 L 1950 920 L 1900 1010 L 1840 1060 L 1780 1080 L 1730 1050 L 1700 980 L 1690 880 L 1700 760 L 1730 640 L 1770 520 L 1800 400 Z",
  // Jeju
  "M 1820 1130 Q 1870 1120 1880 1160 Q 1860 1190 1810 1180 Q 1790 1160 1820 1130 Z",
  // ── Japan: Honshu (main) ──
  "M 2700 700 L 2820 680 L 2940 700 L 3060 750 L 3180 820 L 3280 900 L 3370 1000 L 3440 1110 L 3500 1230 L 3530 1350 L 3540 1460 L 3500 1530 L 3420 1560 L 3320 1540 L 3220 1490 L 3120 1420 L 3020 1330 L 2920 1230 L 2820 1130 L 2740 1020 L 2680 900 L 2670 800 Z",
  // Hokkaido
  "M 3120 380 L 3300 360 L 3460 410 L 3580 500 L 3620 620 L 3580 730 L 3460 770 L 3300 750 L 3160 690 L 3070 580 L 3070 470 Z",
  // Kyushu
  "M 2380 1340 L 2480 1320 L 2570 1360 L 2630 1440 L 2620 1540 L 2560 1620 L 2470 1640 L 2380 1610 L 2330 1530 L 2330 1420 Z",
  // Shikoku
  "M 2680 1280 L 2820 1260 L 2900 1310 L 2880 1380 L 2780 1410 L 2680 1380 L 2640 1330 Z",
  // Okinawa
  "M 2580 1820 Q 2640 1810 2660 1860 Q 2640 1920 2580 1910 Q 2550 1880 2580 1820 Z",
  // Miyako/Ishigaki
  "M 2480 2010 Q 2520 2000 2535 2030 Q 2520 2060 2475 2055 Q 2460 2035 2480 2010 Z",
  // ── Taiwan ──
  "M 2200 2150 L 2270 2130 L 2310 2200 L 2330 2310 L 2320 2440 L 2290 2540 L 2250 2580 L 2210 2560 L 2190 2480 L 2180 2360 L 2185 2240 Z",
  // ── Philippines ──
  // Luzon
  "M 2400 2700 L 2510 2680 L 2580 2720 L 2620 2810 L 2640 2920 L 2620 3030 L 2570 3100 L 2500 3110 L 2440 3070 L 2390 2980 L 2380 2860 L 2390 2780 Z",
  // Mindoro
  "M 2470 3140 Q 2530 3130 2545 3180 Q 2520 3220 2470 3210 Q 2455 3180 2470 3140 Z",
  // Samar/Leyte
  "M 2620 3170 L 2700 3160 L 2740 3220 L 2730 3290 L 2680 3320 L 2630 3290 L 2610 3230 Z",
  // Palawan (long thin)
  "M 2150 3220 L 2240 3210 L 2330 3260 L 2400 3340 L 2430 3420 L 2400 3460 L 2330 3450 L 2240 3400 L 2160 3330 L 2130 3270 Z",
  // Mindanao
  "M 2540 3380 L 2700 3360 L 2820 3400 L 2870 3470 L 2860 3560 L 2790 3620 L 2680 3640 L 2570 3620 L 2490 3560 L 2470 3470 L 2500 3410 Z",
  // ── Guam (small dot, far east) ──
  "M 3540 3000 Q 3580 2990 3590 3015 Q 3580 3035 3545 3030 Q 3530 3015 3540 3000 Z",
  // Saipan
  "M 3530 2880 Q 3560 2872 3568 2895 Q 3558 2912 3530 2908 Q 3520 2892 3530 2880 Z",
  // ── Borneo (south west) ──
  "M 1700 3500 L 1900 3480 L 2080 3520 L 2200 3580 L 2270 3680 L 2240 3800 L 2120 3880 L 1960 3920 L 1800 3920 L 1660 3870 L 1580 3780 L 1580 3660 L 1640 3560 Z",
];

// ─── UNIT GLYPH (Phase 2: subs/mines + 3-state confidence + AIS) ─────────────
const UnitGlyph = ({ unit, selected, detected, onClick, onContextMenu }) => {
  const isFriendly = unit.faction === "friendly";
  const isHostile = unit.faction === "hostile";
  const submerged = isUnderwater(unit);

  const baseColor = isFriendly ? COLORS.phosphor :
                    submerged ? COLORS.subsurface :
                    isHostile ? COLORS.hostile : COLORS.neutral;
  const dimColor = isFriendly ? COLORS.phosphorDim :
                   submerged ? COLORS.subsurfaceDim :
                   isHostile ? COLORS.hostileDim : COLORS.neutralDim;

  if (!isFriendly && (!detected || detected.confidence < CONFIG.POSSIBLE_THRESHOLD)) return null;

  const confidence = detected?.confidence ?? 100;
  const isPossible = !isFriendly && confidence < CONFIG.CONFIRMED_THRESHOLD;
  const color = isPossible ? dimColor : baseColor;

  const headingDeg = rad2deg(unit.heading || 0);
  let glyph;
  let rotateGlyph = true;

  if (unit.type === "USV") {
    glyph = (
      <g>
        <rect x="-10" y="-7" width="20" height="14" fill="none" stroke={color} strokeWidth="1.5" />
        <line x1="0" y1="-7" x2="0" y2="-12" stroke={color} strokeWidth="1.5" />
        <line x1="-6" y1="0" x2="6" y2="0" stroke={color} strokeWidth="1" />
      </g>
    );
  } else if (unit.type === "UAV") {
    const dim = unit.state === "docked" ? 0.4 : unit.state === "jammed" ? 0.6 : 1;
    const onMission = unit.state === "mission";
    const aborting = unit.missionAborted && unit.state === "returning";
    const uavColor = onMission ? COLORS.amber : aborting ? COLORS.hostile : color;
    glyph = (
      <g opacity={dim}>
        <path d="M 0 -8 L 7 6 L 0 3 L -7 6 Z" fill={uavColor} stroke={uavColor} strokeWidth="1" />
        {aborting && (
          <text y="-12" textAnchor="middle" fontSize="6"
                fontFamily="'JetBrains Mono', monospace"
                fill={COLORS.hostile} fontWeight="700">!</text>
        )}
      </g>
    );
  } else if (unit.type === "COMMERCIAL") {
    glyph = (
      <g>
        <circle r="9" fill="none" stroke={color} strokeWidth="1.5" />
        <line x1="-5" y1="0" x2="5" y2="0" stroke={color} strokeWidth="1" />
        <line x1="0" y1="-5" x2="0" y2="5" stroke={color} strokeWidth="1" />
      </g>
    );
  } else if (unit.type === "ENEMY") {
    glyph = (
      <g>
        <path d="M 0 -10 L 10 0 L 0 10 L -10 0 Z" fill="none" stroke={color} strokeWidth="2" />
        <path d="M 0 -5 L 5 0 L 0 5 L -5 0 Z" fill={color} />
      </g>
    );
  } else if (unit.type === "SUBMARINE") {
    glyph = (
      <g>
        <path d="M -13 0 L -10 -4 L 10 -4 L 13 0 L 10 4 L -10 4 Z"
              fill="none" stroke={color} strokeWidth="1.5" />
        <rect x="-3" y="-7" width="6" height="3" fill={color} />
        <line x1="-13" y1="0" x2="13" y2="0" stroke={color} strokeWidth="0.8" opacity="0.5" />
      </g>
    );
  } else if (unit.type === "MINE") {
    rotateGlyph = false;
    glyph = (
      <g>
        <circle r="9" fill="none" stroke={color} strokeWidth="1.5" />
        <line x1="-6.5" y1="-6.5" x2="6.5" y2="6.5" stroke={color} strokeWidth="1.5" />
        <line x1="-6.5" y1="6.5" x2="6.5" y2="-6.5" stroke={color} strokeWidth="1.5" />
        <line x1="0" y1="-9" x2="0" y2="-13" stroke={color} strokeWidth="1.2" />
        <line x1="9" y1="0" x2="13" y2="0" stroke={color} strokeWidth="1.2" />
        <line x1="0" y1="9" x2="0" y2="13" stroke={color} strokeWidth="1.2" />
        <line x1="-9" y1="0" x2="-13" y2="0" stroke={color} strokeWidth="1.2" />
      </g>
    );
  }

  return (
    <g transform={`translate(${unit.x},${unit.y})`}
       style={{ cursor: "pointer" }}
       onMouseDown={(e) => { e.stopPropagation(); onClick && onClick(unit, e); }}
       onContextMenu={(e) => {
         if (onContextMenu) {
           e.preventDefault(); e.stopPropagation();
           onContextMenu(unit, e);
         }
       }}>
      {/* selection ring */}
      {selected && (
        <g>
          <circle r="22" fill="none" stroke={baseColor} strokeWidth="1" strokeDasharray="3 3" opacity="0.9">
            <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="6s" repeatCount="indefinite" />
          </circle>
          <circle r="26" fill="none" stroke={baseColor} strokeWidth="0.5" opacity="0.4" />
        </g>
      )}
      {/* uncertainty halo for POSSIBLE */}
      {isPossible && (
        <circle r="18" fill="none" stroke={dimColor} strokeWidth="1" strokeDasharray="2 4" opacity="0.7" />
      )}

      <g transform={rotateGlyph ? `rotate(${headingDeg + 90})` : ""} opacity={isPossible ? 0.75 : 1}>
        {glyph}
      </g>

      {/* label */}
      <text x="14" y="-10" fontSize="9" fontFamily="'JetBrains Mono', monospace"
            fill={selected ? baseColor : color}
            opacity={isFriendly || !isPossible ? 1 : 0.8}>
        {unit.label}{isPossible ? "?" : ""}
      </text>

      {/* Phase 2: confidence tag (POSSIBLE/CONFIRMED) for non-friendly */}
      {!isFriendly && (
        <text x="14" y="0" fontSize="6.5" fontFamily="'JetBrains Mono', monospace"
              fill={isPossible ? COLORS.amber : color}
              letterSpacing="0.1em">
          {isPossible ? "POSSIBLE" : "CONFIRMED"}
        </text>
      )}

      {/* Phase 2: AIS overlay on confirmed neutrals */}
      {unit.type === "COMMERCIAL" && !isPossible && (
        <g>
          <text x="14" y="9" fontSize="6.5" fontFamily="'JetBrains Mono', monospace"
                fill={COLORS.textDim} letterSpacing="0.05em">
            AIS {unit.mmsi}
          </text>
          <text x="14" y="17" fontSize="6.5" fontFamily="'JetBrains Mono', monospace"
                fill={COLORS.textDim}>
            {unit.vesselType} · {unit.flag}
          </text>
        </g>
      )}

      {/* Subsurface "depth" indicator */}
      {submerged && !isPossible && (
        <text x="-30" y="3" fontSize="6" fontFamily="'JetBrains Mono', monospace"
              fill={COLORS.subsurfaceDim}>
          ~{Math.floor(20 + Math.abs(unit.x * 13 + unit.y * 7) % 60)}m
        </text>
      )}
    </g>
  );
};

// ─── JAM ZONE GLYPH ──────────────────────────────────────────────────────────
const JamZoneGlyph = ({ zone, onClick }) => (
  <g style={{ cursor: "pointer" }} onMouseDown={(e) => { e.stopPropagation(); onClick(zone, e); }}>
    <circle cx={zone.x} cy={zone.y} r={zone.radius}
            fill={COLORS.hostile} fillOpacity="0.06"
            stroke={COLORS.hostile} strokeWidth="1.5"
            strokeDasharray="10 4 2 4" opacity="0.85">
      <animate attributeName="stroke-dashoffset" from="0" to="40" dur="2s" repeatCount="indefinite" />
    </circle>
    <circle cx={zone.x} cy={zone.y} r={zone.radius - 8}
            fill="none" stroke={COLORS.hostile} strokeWidth="0.5"
            strokeDasharray="3 5" opacity="0.4" />
    <g transform={`translate(${zone.x},${zone.y})`}>
      <text textAnchor="middle" y="-6" fontSize="11" fontFamily="'JetBrains Mono', monospace"
            fill={COLORS.hostile} fontWeight="700" letterSpacing="0.2em">
        GPS DENIED
      </text>
      <text textAnchor="middle" y="8" fontSize="8" fontFamily="'JetBrains Mono', monospace"
            fill={COLORS.hostileDim}>
        {zone.label}
      </text>
    </g>
  </g>
);

// ─── AIS SHIP GLYPH — real-world AIS contacts ────────────────────────────────
// Rendered separately from deployed units; never on minimap.
const AISShipGlyph = ({ ship, tracking, onContextMenu }) => {
  const headingRad = ((ship.heading || ship.cog || 0) * Math.PI) / 180;
  const headingDeg = ship.heading || ship.cog || 0;
  return (
    <g transform={`translate(${ship.wx},${ship.wy})`}
       style={{ cursor: "context-menu" }}
       onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); onContextMenu(ship, e); }}>
      {tracking && (
        <circle r="18" fill="none" stroke={COLORS.ais} strokeWidth="1" opacity="0.8">
          <animate attributeName="r" values="18;24;18" dur="2s" repeatCount="indefinite" />
        </circle>
      )}
      {/* Ship silhouette — direction arrow */}
      <g transform={`rotate(${headingDeg})`}>
        <polygon points="0,-10 6,6 0,3 -6,6" fill={COLORS.ais} opacity="0.85" />
      </g>
      {/* Name + type */}
      <text x="11" y="-6" fontSize="8" fontFamily="'JetBrains Mono', monospace"
            fill={COLORS.ais} opacity="0.9">
        {ship.name?.slice(0, 14) || ship.mmsi}
      </text>
      <text x="11" y="3" fontSize="6.5" fontFamily="'JetBrains Mono', monospace"
            fill={COLORS.aisDim}>
        {ship.type} · {ship.sog?.toFixed(1) || "0"}kn · {ship.flag || "—"}
      </text>
      <text x="11" y="11" fontSize="6" fontFamily="'JetBrains Mono', monospace"
            fill={COLORS.aisDim} opacity="0.7">
        MMSI {ship.mmsi}
      </text>
    </g>
  );
};

// ─── MAP VIEW ────────────────────────────────────────────────────────────────
const MapView = ({ state, dispatch, tool, setTool, deployType, setHover, setCursorWorld, cam, setCam }) => {
  const svgRef = useRef(null);
  const cursorScreenRef = useRef(null);
  const camRef = useRef(cam);
  camRef.current = cam;
  const [dragBox, setDragBox] = useState(null);
  const dragBoxRef = useRef(null);
  dragBoxRef.current = dragBox;
  const [panStart, setPanStart] = useState(null);
  const [patrolPoints, setPatrolPoints] = useState([]);
  const [hoverWorld, setHoverWorld] = useState(null);

  const screenToWorld = useCallback((sx, sy) => {
    const svg = svgRef.current;
    if (!svg) return { x: 0, y: 0 };
    const pt = svg.createSVGPoint();
    pt.x = sx; pt.y = sy;
    const ctm = svg.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const wp = pt.matrixTransform(ctm.inverse());
    return { x: wp.x, y: wp.y };
  }, []);

  // Edge-pan rAF loop. Also re-syncs hover & dragBox when camera scrolls.
  useEffect(() => {
    let raf;
    const tick = () => {
      const cs = cursorScreenRef.current;
      const svg = svgRef.current;
      if (cs && svg) {
        const rect = svg.getBoundingClientRect();
        const z = CONFIG.EDGE_PAN_ZONE;
        const lx = cs.x - rect.left, rx = rect.right - cs.x;
        const ty = cs.y - rect.top, by = rect.bottom - cs.y;
        let fx = 0, fy = 0;
        if (lx < z && lx >= -2) fx = -((z - Math.max(0, lx)) / z);
        else if (rx < z && rx >= -2) fx = ((z - Math.max(0, rx)) / z);
        if (ty < z && ty >= -2) fy = -((z - Math.max(0, ty)) / z);
        else if (by < z && by >= -2) fy = ((z - Math.max(0, by)) / z);
        if (fx !== 0 || fy !== 0) {
          const c = camRef.current;
          const dx = (fx * CONFIG.EDGE_PAN_SPEED) / c.zoom;
          const dy = (fy * CONFIG.EDGE_PAN_SPEED) / c.zoom;
          setCam((cur) => ({ ...cur, x: cur.x + dx, y: cur.y + dy }));
          const wp = screenToWorld(cs.x, cs.y);
          setHoverWorld(wp); setHover(wp); setCursorWorld(wp);
          // Phase 1.1 fix: keep drag-box endpoint glued to cursor during edge-pan
          if (dragBoxRef.current) {
            setDragBox((db) => db && { ...db, x1: wp.x, y1: wp.y });
          }
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [screenToWorld, setCam, setHover, setCursorWorld]);

  const onMouseDown = (e) => {
    if (e.button === 2) return;
    const wp = screenToWorld(e.clientX, e.clientY);
    if (e.button === 1 || (e.button === 0 && e.altKey)) {
      setPanStart({ sx: e.clientX, sy: e.clientY, camX: cam.x, camY: cam.y });
      return;
    }
    if (tool === "select") {
      setDragBox({ x0: wp.x, y0: wp.y, x1: wp.x, y1: wp.y });
    } else if (tool === "patrol") {
      setPatrolPoints([...patrolPoints, wp]);
    } else if (tool === "deploy") {
      const a = {
        ENEMY: "SPAWN_ENEMY", COMMERCIAL: "SPAWN_COMMERCIAL",
        SUBMARINE: "SPAWN_SUBMARINE", MINE: "SPAWN_MINE",
        ISR: "SPAWN_ISR", JAM: "SPAWN_JAM_ZONE",
      }[deployType];
      if (a) dispatch({ type: a, x: wp.x, y: wp.y });
      setTool("select");
    }
  };

  const onMouseMove = (e) => {
    cursorScreenRef.current = { x: e.clientX, y: e.clientY };
    const wp = screenToWorld(e.clientX, e.clientY);
    setHoverWorld(wp); setHover(wp); setCursorWorld(wp);

    if (panStart) {
      const svg = svgRef.current;
      if (!svg) return;
      const rect = svg.getBoundingClientRect();
      const vbW = CONFIG.WORLD_W / cam.zoom, vbH = CONFIG.WORLD_H / cam.zoom;
      const dx = ((e.clientX - panStart.sx) / rect.width) * vbW;
      const dy = ((e.clientY - panStart.sy) / rect.height) * vbH;
      setCam({ ...cam, x: panStart.camX - dx, y: panStart.camY - dy });
    }
    if (dragBox) setDragBox((db) => db && { ...db, x1: wp.x, y1: wp.y });
  };

  const onMouseUp = () => {
    if (dragBox) {
      const xMin = Math.min(dragBox.x0, dragBox.x1), xMax = Math.max(dragBox.x0, dragBox.x1);
      const yMin = Math.min(dragBox.y0, dragBox.y1), yMax = Math.max(dragBox.y0, dragBox.y1);
      const isClick = Math.abs(dragBox.x1 - dragBox.x0) < 4 && Math.abs(dragBox.y1 - dragBox.y0) < 4;
      if (isClick) dispatch({ type: "SELECT", ids: [] });
      else {
        const ids = state.units
          .filter((u) => u.faction === "friendly" && u.x >= xMin && u.x <= xMax && u.y >= yMin && u.y <= yMax)
          .map((u) => u.id);
        dispatch({ type: "SELECT", ids });
      }
      setDragBox(null);
    }
    setPanStart(null);
  };

  const onMouseLeave = () => {
    cursorScreenRef.current = null;
    setHover(null); setDragBox(null); setPanStart(null);
  };

  const onContextMenu = (e) => {
    e.preventDefault();
    const wp = screenToWorld(e.clientX, e.clientY);
    if (tool === "patrol" && patrolPoints.length >= 3) {
      dispatch({ type: "ADD_PATROL", polygon: patrolPoints, unitIds: state.selectedIds });
      setPatrolPoints([]); setTool("select");
      return;
    }
    if (tool === "patrol") { setPatrolPoints([]); setTool("select"); return; }
    if (state.selectedIds.length > 0) dispatch({ type: "MOVE_SELECTED", target: wp });
  };

  const onWheel = (e) => {
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
    const wp = screenToWorld(e.clientX, e.clientY);
    const newZoom = clamp(cam.zoom * factor, 0.3, 3);
    const newVbW = CONFIG.WORLD_W / newZoom, newVbH = CONFIG.WORLD_H / newZoom;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    setCam({ x: wp.x - px * newVbW, y: wp.y - py * newVbH, zoom: newZoom });
  };

  const onClickUnit = (u, e) => {
    if (u.faction !== "friendly") return;
    if (e.shiftKey) {
      const next = state.selectedIds.includes(u.id)
        ? state.selectedIds.filter((id) => id !== u.id)
        : [...state.selectedIds, u.id];
      dispatch({ type: "SELECT", ids: next });
    } else if (u.type === "USV") {
      const ids = [u.id, ...state.units.filter((x) => x.parentId === u.id).map((x) => x.id)];
      dispatch({ type: "SELECT", ids });
    } else dispatch({ type: "SELECT", ids: [u.id] });
  };

  // Phase 2.1: right-click → TRACK
  // Allowed targets: detected non-friendly OR a friendly USV that's not already selected
  const onUnitContextMenu = (u, e) => {
    if (state.selectedIds.length === 0) return;
    if (u.faction === "friendly") {
      // ISR-to-ISR track: only USVs, only if target isn't in current selection
      if (u.type !== "USV") return;
      if (state.selectedIds.includes(u.id)) return;
      dispatch({ type: "ENGAGE_TARGET", targetId: u.id });
      return;
    }
    const det = state.detections[u.id];
    if (!det || det.confidence < CONFIG.POSSIBLE_THRESHOLD) return;
    dispatch({ type: "ENGAGE_TARGET", targetId: u.id });
  };

  // Phase 3: right-click on AIS ship → TRACK via MMSI
  const onAISContextMenu = (ship, e) => {
    if (state.selectedIds.length === 0) return;
    dispatch({ type: "ENGAGE_AIS_TARGET", mmsi: ship.mmsi });
  };

  const sensorCircles = state.units
    .filter((u) => u.faction === "friendly" && u.state !== "docked" && u.state !== "jammed")
    .map((u) => ({
      id: u.id, x: u.x, y: u.y,
      r: u.type === "UAV" ? CONFIG.UAV_SENSOR_RANGE : CONFIG.USV_SENSOR_RANGE,
      sonar: u.type === "USV" ? CONFIG.SONAR_RANGE : 0,
    }));

  const vbW = CONFIG.WORLD_W / cam.zoom;
  const vbH = CONFIG.WORLD_H / cam.zoom;

  return (
    <svg ref={svgRef}
      style={{
        background: COLORS.ocean1, userSelect: "none",
        display: "block", width: "100%", height: "100%",
        cursor: tool === "patrol" ? "crosshair" : tool === "deploy" ? "copy" : "default",
      }}
      viewBox={`${cam.x} ${cam.y} ${vbW} ${vbH}`}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove}
      onMouseUp={onMouseUp} onMouseLeave={onMouseLeave}
      onContextMenu={onContextMenu} onWheel={onWheel}
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <radialGradient id="ocean-grad" cx="50%" cy="50%" r="70%">
          <stop offset="0%" stopColor={COLORS.ocean2} />
          <stop offset="100%" stopColor={COLORS.ocean1} />
        </radialGradient>
        <pattern id="grid" width="100" height="100" patternUnits="userSpaceOnUse">
          <path d="M 100 0 L 0 0 0 100" fill="none" stroke={COLORS.grid} strokeWidth="0.5" />
        </pattern>
        <pattern id="grid-major" width="500" height="500" patternUnits="userSpaceOnUse">
          <path d="M 500 0 L 0 0 0 500" fill="none" stroke={COLORS.borderHi} strokeWidth="0.8" />
        </pattern>
        <mask id="fog-mask">
          <rect x="0" y="0" width={CONFIG.WORLD_W} height={CONFIG.WORLD_H} fill="white" />
          {state.fogReveal.map((r, i) => (
            <radialGradient key={i} id={`reveal-${i}`}>
              <stop offset="0%" stopColor="black" />
              <stop offset="65%" stopColor="black" />
              <stop offset="100%" stopColor="white" />
            </radialGradient>
          ))}
          {state.fogReveal.map((r, i) => (
            <circle key={i} cx={r.x} cy={r.y} r={r.r} fill={`url(#reveal-${i})`} />
          ))}
        </mask>
        {/* Sensor glow gradients — subtle brightness boost in monitored areas */}
        {sensorCircles.map((s) => (
          <radialGradient key={`sg-${s.id}`} id={`sg-${s.id}`}>
            <stop offset="0%" stopColor={COLORS.phosphor} stopOpacity="0.07" />
            <stop offset="80%" stopColor={COLORS.phosphor} stopOpacity="0.03" />
            <stop offset="100%" stopColor={COLORS.phosphor} stopOpacity="0" />
          </radialGradient>
        ))}
        <pattern id="patrol-hatch" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
          <line x1="0" y1="0" x2="0" y2="8" stroke={COLORS.phosphor} strokeWidth="0.6" opacity="0.4" />
        </pattern>
      </defs>

      <rect x="0" y="0" width={CONFIG.WORLD_W} height={CONFIG.WORLD_H} fill="url(#ocean-grad)" />
      <rect x="0" y="0" width={CONFIG.WORLD_W} height={CONFIG.WORLD_H} fill="url(#grid)" />
      <rect x="0" y="0" width={CONFIG.WORLD_W} height={CONFIG.WORLD_H} fill="url(#grid-major)" />

      <g>{LAND.map((d, i) => (
        <path key={i} d={d} fill={COLORS.land} stroke={COLORS.borderHi} strokeWidth="1" />
      ))}</g>

      <g fontFamily="'JetBrains Mono', monospace" fontSize="10" fill={COLORS.textDim} opacity="0.5">
        {Array.from({ length: 8 }, (_, i) => (
          <text key={`x${i}`} x={i * 500} y="20">{`E${(i * 5).toString().padStart(2, "0")}°`}</text>
        ))}
        {Array.from({ length: 5 }, (_, i) => (
          <text key={`y${i}`} x="8" y={i * 500 + 10}>{`N${(40 - i * 2).toString().padStart(2, "0")}°`}</text>
        ))}
      </g>

      {/* Patrol areas with proper sweep paths (Voronoi sub-regions when N USVs) */}
      <g>{state.patrolAreas.map((pa) => {
        const c = polygonCentroid(pa.polygon);
        const assigns = pa.assignments || [{ path: pa.path, region: pa.polygon }];
        return (
          <g key={pa.id}>
            {/* Outer polygon (the user-drawn boundary) */}
            <polygon points={pa.polygon.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="url(#patrol-hatch)" stroke={COLORS.phosphor} strokeWidth="1.5"
              strokeDasharray="6 3" opacity="0.7" />
            {/* Per-USV sub-region outlines (only when partitioned) */}
            {pa.assignments && pa.assignments.length > 1 &&
              pa.assignments.map((a, i) => a.region.length >= 3 && (
                <polygon key={`reg-${i}`}
                  points={a.region.map((p) => `${p.x},${p.y}`).join(" ")}
                  fill="none" stroke={COLORS.phosphor} strokeWidth="0.6"
                  strokeDasharray="2 3" opacity="0.4" />
              ))}
            {/* Sweep paths — one per assignment */}
            {assigns.map((a, i) => a.path && a.path.length > 0 && (
              <polyline key={`path-${i}`}
                points={a.path.map((p) => `${p.x},${p.y}`).join(" ")}
                fill="none" stroke={COLORS.phosphor} strokeWidth="1.2"
                strokeDasharray="3 4" opacity="0.7" />
            ))}
            {/* Vertices of user-drawn polygon */}
            {pa.polygon.map((v, i) => (
              <circle key={i} cx={v.x} cy={v.y} r="3" fill={COLORS.phosphor} opacity="0.9" />
            ))}
            <text x={c.x} y={c.y} textAnchor="middle" fontSize="11"
                  fontFamily="'JetBrains Mono', monospace"
                  fill={COLORS.phosphor} opacity="0.55" letterSpacing="0.25em">
              {pa.assignments && pa.assignments.length > 1
                ? `PATROL × ${pa.assignments.length}`
                : "PATROL"}
            </text>
          </g>
        );
      })}</g>

      {/* Phase 2: jam zones */}
      <g>{state.jamZones.map((jz) => (
        <JamZoneGlyph key={jz.id} zone={jz}
          onClick={(z, e) => { if (e.shiftKey) dispatch({ type: "REMOVE_JAM_ZONE", id: z.id }); }} />
      ))}</g>

      {/* Movement waypoints — USV goals */}
      <g>{state.units.filter((u) => u.goal && u.faction === "friendly").map((u) => (
        <g key={`goal-${u.id}`}>
          <line x1={u.x} y1={u.y} x2={u.goal.x} y2={u.goal.y}
            stroke={COLORS.phosphor} strokeWidth="0.8" strokeDasharray="4 4" opacity="0.5" />
          <g transform={`translate(${u.goal.x},${u.goal.y})`}>
            <circle r="6" fill="none" stroke={COLORS.phosphor} strokeWidth="1" opacity="0.8" />
            <circle r="2" fill={COLORS.phosphor} />
          </g>
        </g>
      ))}</g>

      {/* Phase 4: UAV mission goals */}
      <g>{state.units
        .filter((u) => u.type === "UAV" && u.missionGoal && u.state === "mission")
        .map((u) => (
          <g key={`m-${u.id}`}>
            <line x1={u.x} y1={u.y} x2={u.missionGoal.x} y2={u.missionGoal.y}
              stroke={COLORS.amber} strokeWidth="1" strokeDasharray="6 3" opacity="0.65">
              <animate attributeName="stroke-dashoffset" from="0" to="-9"
                dur="0.8s" repeatCount="indefinite" />
            </line>
            <g transform={`translate(${u.missionGoal.x},${u.missionGoal.y})`}>
              <circle r="10" fill="none" stroke={COLORS.amber} strokeWidth="1.2" opacity="0.85" />
              <line x1="-14" y1="0" x2="-7" y2="0" stroke={COLORS.amber} strokeWidth="1.2" />
              <line x1="14" y1="0" x2="7" y2="0" stroke={COLORS.amber} strokeWidth="1.2" />
              <line x1="0" y1="-14" x2="0" y2="-7" stroke={COLORS.amber} strokeWidth="1.2" />
              <line x1="0" y1="14" x2="0" y2="7" stroke={COLORS.amber} strokeWidth="1.2" />
              <text y="-18" textAnchor="middle" fontSize="7"
                fontFamily="'JetBrains Mono', monospace"
                fill={COLORS.amber} letterSpacing="0.15em">
                MISSION · {u.label}
              </text>
            </g>
          </g>
        ))}</g>

      {/* Phase 2.1: tracking lines */}
      <g>{state.units
        .filter((u) => u.engageTargetId && u.faction === "friendly")
        .map((u) => {
          const tgt = state.units.find((x) => x.id === u.engageTargetId);
          if (!tgt) return null;
          return (
            <g key={`track-${u.id}`}>
              <line x1={u.x} y1={u.y} x2={tgt.x} y2={tgt.y}
                stroke={COLORS.amber} strokeWidth="1.2"
                strokeDasharray="6 3" opacity="0.7">
                <animate attributeName="stroke-dashoffset" from="0" to="-9"
                  dur="1s" repeatCount="indefinite" />
              </line>
              <g transform={`translate(${tgt.x},${tgt.y})`}>
                <circle r="14" fill="none" stroke={COLORS.amber}
                  strokeWidth="1" opacity="0.7">
                  <animate attributeName="r" values="14;20;14"
                    dur="2s" repeatCount="indefinite" />
                </circle>
                <text y="-22" textAnchor="middle" fontSize="7"
                  fontFamily="'JetBrains Mono', monospace"
                  fill={COLORS.amber} letterSpacing="0.15em">
                  ▶ TRACK
                </text>
              </g>
            </g>
          );
        })}</g>

      <g opacity="0.18">{sensorCircles.map((s) => (
        <circle key={`sens-${s.id}`} cx={s.x} cy={s.y} r={s.r}
          fill="none" stroke={COLORS.phosphor} strokeWidth="0.8" strokeDasharray="2 6" />
      ))}</g>
      {/* Sensor glow: subtle phosphor brightness in actively monitored areas */}
      <g>{sensorCircles.map((s) => (
        <circle key={`glow-${s.id}`} cx={s.x} cy={s.y} r={s.r}
          fill={`url(#sg-${s.id})`} pointerEvents="none" />
      ))}</g>
      <g opacity="0.25">{sensorCircles.filter((s) => s.sonar > 0).map((s) => (
        <circle key={`son-${s.id}`} cx={s.x} cy={s.y} r={s.sonar}
          fill="none" stroke={COLORS.subsurface} strokeWidth="0.6" strokeDasharray="1 3" />
      ))}</g>

      {/* Phase 3: AIS ships — real-world contacts, main map only */}
      <g>{state.aisShips.map((ship) => {
        const tracking = state.units.some(
          (u) => u.type === "USV" && u.aisEngageMMSI === ship.mmsi
        );
        return (
          <AISShipGlyph key={ship.mmsi} ship={ship}
            tracking={tracking} onContextMenu={onAISContextMenu} />
        );
      })}</g>

      {tool === "patrol" && patrolPoints.length > 0 && hoverWorld && (
        <g>
          <polyline points={[...patrolPoints, hoverWorld].map((p) => `${p.x},${p.y}`).join(" ")}
            fill="rgba(184,255,94,0.05)" stroke={COLORS.phosphor} strokeWidth="1" strokeDasharray="4 3" />
          {patrolPoints.map((p, i) => (
            <circle key={i} cx={p.x} cy={p.y} r="3" fill={COLORS.phosphor} />
          ))}
        </g>
      )}

      {dragBox && (
        <rect x={Math.min(dragBox.x0, dragBox.x1)} y={Math.min(dragBox.y0, dragBox.y1)}
          width={Math.abs(dragBox.x1 - dragBox.x0)} height={Math.abs(dragBox.y1 - dragBox.y0)}
          fill="rgba(184,255,94,0.05)" stroke={COLORS.phosphor}
          strokeWidth="1" strokeDasharray="3 3" />
      )}

      <g>{state.units.map((u) => (
        <UnitGlyph key={u.id} unit={u}
          selected={state.selectedIds.includes(u.id)}
          detected={state.detections[u.id]}
          onClick={onClickUnit}
          onContextMenu={onUnitContextMenu} />
      ))}</g>

      {/* Fog: very light — map always readable; monitored zones slightly brighter via sensor glow */}
      <rect x="0" y="0" width={CONFIG.WORLD_W} height={CONFIG.WORLD_H}
        fill="rgba(2,8,5,0.18)" mask="url(#fog-mask)" pointerEvents="none" />
    </svg>
  );
};

// ─── TOP BAR ─────────────────────────────────────────────────────────────────
const TopBar = ({ state, dispatch, aisStatus }) => {
  const { paused, simSpeed, simTime } = state;
  const speeds = [1, 5, 20, 100];
  const hh = String(Math.floor(simTime / 3600)).padStart(2, "0");
  const mm = String(Math.floor((simTime % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(simTime % 60)).padStart(2, "0");

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 16px", height: 44, flexShrink: 0,
      borderBottom: `1px solid ${COLORS.border}`,
      background: COLORS.surface, color: COLORS.text,
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Hexagon size={16} style={{ color: COLORS.phosphor }} />
        <span style={{ fontWeight: 700, letterSpacing: "0.2em", fontSize: 14, fontFamily: "'Chakra Petch', monospace" }}>
          BLACK SHEEP WALL
        </span>
        <span style={{ fontSize: 11, marginLeft: 8, color: COLORS.textDim }}>// ISR.CMD.v0.4</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: COLORS.phosphorDim }}>
          <Activity size={12} />
          <span>T+{hh}:{mm}:{ss}</span>
        </div>

        {/* Synthetic AIS feed status */}
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 9, color: COLORS.ais, letterSpacing: "0.1em" }}>
            AIS.SIM
          </span>
          <span style={{ fontSize: 9, color: COLORS.aisDim }}>
            {state.aisShips.length} vessels
          </span>
          <span style={{ width: 6, height: 6, borderRadius: "50%",
                         background: COLORS.ais, display: "inline-block",
                         animation: "pulse 2s ease-in-out infinite" }} />
        </div>

        <button onClick={() => dispatch({ type: "TOGGLE_PAUSE" })}
          style={{
            display: "flex", alignItems: "center", gap: 6, padding: "4px 10px",
            border: `1px solid ${paused ? COLORS.amber : COLORS.border}`,
            background: paused ? "rgba(255,184,74,0.1)" : "transparent",
            color: paused ? COLORS.amber : COLORS.text,
            cursor: "pointer", fontFamily: "inherit", fontSize: 11,
          }}>
          {paused ? <Play size={12} /> : <Pause size={12} />}
          <span>{paused ? "RESUME" : "PAUSE"}</span>
        </button>

        <div style={{ display: "flex", border: `1px solid ${COLORS.border}` }}>
          {speeds.map((s) => (
            <button key={s} onClick={() => dispatch({ type: "SET_SPEED", speed: s })}
              style={{
                padding: "4px 10px", fontFamily: "inherit", fontSize: 11,
                background: simSpeed === s ? COLORS.phosphor : "transparent",
                color: simSpeed === s ? COLORS.bg : COLORS.text,
                fontWeight: simSpeed === s ? 700 : 400,
                border: "none", cursor: "pointer",
              }}>{s}×</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: COLORS.phosphorDim }}>
        <Power size={12} style={{ color: COLORS.phosphor }} />
        <span>LINK NOMINAL</span>
      </div>
    </div>
  );
};

// ─── DOCK PANEL FRAME ────────────────────────────────────────────────────────
const DockPanel = ({ title, icon, width, children, accent = COLORS.phosphorDim, flex }) => (
  <div style={{
    display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden",
    width: flex ? undefined : width,
    flex: flex ? "1 1 0" : undefined,
    borderRight: `1px solid ${COLORS.border}`,
    background: COLORS.surface,
  }}>
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "0 12px", height: 28, flexShrink: 0,
      borderBottom: `1px solid ${COLORS.border}`,
      background: COLORS.bg,
    }}>
      {icon}
      <span style={{
        fontSize: 10, letterSpacing: "0.25em", fontWeight: 700, color: accent,
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        {title}
      </span>
    </div>
    <div style={{ flex: "1 1 0", overflow: "hidden", minHeight: 0 }}>{children}</div>
  </div>
);

// ─── PANEL: TACTICAL OVERVIEW ────────────────────────────────────────────────
const TacticalOverviewPanel = ({ state, cam, setCam }) => {
  const ref = useRef(null);
  const onClick = (e) => {
    const svg = ref.current;
    if (!svg) return;
    const pt = svg.createSVGPoint();
    pt.x = e.clientX; pt.y = e.clientY;
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const wp = pt.matrixTransform(ctm.inverse());
    const vbW = CONFIG.WORLD_W / cam.zoom, vbH = CONFIG.WORLD_H / cam.zoom;
    setCam({ ...cam, x: wp.x - vbW / 2, y: wp.y - vbH / 2 });
  };
  const vbW = CONFIG.WORLD_W / cam.zoom, vbH = CONFIG.WORLD_H / cam.zoom;

  return (
    <div style={{ padding: 8, height: "100%", display: "flex", alignItems: "center", justifyContent: "center", boxSizing: "border-box" }}>
      <svg ref={ref} viewBox={`0 0 ${CONFIG.WORLD_W} ${CONFIG.WORLD_H}`}
        style={{ background: COLORS.ocean1, border: `1px solid ${COLORS.border}`,
                 width: "100%", height: "100%", cursor: "crosshair" }}
        onClick={onClick} preserveAspectRatio="xMidYMid meet">
        {LAND.map((d, i) => <path key={i} d={d} fill={COLORS.land} stroke={COLORS.borderHi} strokeWidth="2" />)}
        {state.patrolAreas.map((pa) => (
          <polygon key={pa.id} points={pa.polygon.map((p) => `${p.x},${p.y}`).join(" ")}
            fill={COLORS.phosphor} fillOpacity="0.15" stroke={COLORS.phosphor} strokeWidth="6" />
        ))}
        {state.jamZones.map((jz) => (
          <circle key={jz.id} cx={jz.x} cy={jz.y} r={jz.radius}
            fill={COLORS.hostile} fillOpacity="0.15" stroke={COLORS.hostile} strokeWidth="4" />
        ))}
        {state.units.map((u) => {
          const det = state.detections[u.id];
          if (u.faction !== "friendly" && (!det || det.confidence < CONFIG.POSSIBLE_THRESHOLD)) return null;
          const c = u.faction === "friendly" ? COLORS.phosphor :
                    isUnderwater(u) ? COLORS.subsurface :
                    u.faction === "hostile" ? COLORS.hostile : COLORS.neutral;
          const r = u.type === "USV" ? 28 : u.type === "UAV" ? 16 : 22;
          return <circle key={u.id} cx={u.x} cy={u.y} r={r} fill={c} />;
        })}
        <rect x={cam.x} y={cam.y} width={vbW} height={vbH}
          fill="none" stroke={COLORS.amber} strokeWidth="6" strokeDasharray="20 10" opacity="0.85" />
      </svg>
    </div>
  );
};

// ─── PANEL: STATUS ───────────────────────────────────────────────────────────
const Row = ({ k, v, vColor = COLORS.text }) => (
  <div style={{
    display: "flex", justifyContent: "space-between",
    borderBottom: `1px dashed ${COLORS.border}`, paddingBottom: 2,
  }}>
    <span style={{ color: COLORS.textDim }}>{k}</span>
    <span style={{ color: vColor }}>{v}</span>
  </div>
);

const BatteryBar = ({ value }) => {
  const color = value > 60 ? COLORS.phosphor : value > 30 ? COLORS.amber : COLORS.hostile;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div style={{ width: 36, height: 4, border: `1px solid ${COLORS.border}`, background: COLORS.bg }}>
        <div style={{ width: `${value}%`, height: "100%", background: color }} />
      </div>
      <span style={{ fontSize: 9, color, minWidth: 26 }}>
        {Math.floor(value)}%
      </span>
    </div>
  );
};

const StatusPanel = ({ state, dispatch }) => {
  const friendly = state.units.filter((u) => u.faction === "friendly");
  const selectedFriendly = state.units.filter((u) => state.selectedIds.includes(u.id));
  const usvSel = selectedFriendly.find((u) => u.type === "USV");

  // Phase 2: roster click selects USV + its UAVs
  const onRosterClick = (u) => {
    if (u.type === "USV") {
      const ids = [u.id, ...state.units.filter((x) => x.parentId === u.id).map((x) => x.id)];
      dispatch({ type: "SELECT", ids });
    } else dispatch({ type: "SELECT", ids: [u.id] });
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
      <div style={{ padding: 8, borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.1em", marginBottom: 6, color: COLORS.textDim }}>
          FORCE.ROSTER
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 96, overflowY: "auto" }}>
          {friendly.map((u) => {
            const isSel = state.selectedIds.includes(u.id);
            return (
              <button key={u.id} onClick={() => onRosterClick(u)}
                style={{
                  width: "100%", textAlign: "left", padding: "4px 8px",
                  border: `1px solid ${isSel ? COLORS.phosphor : COLORS.border}`,
                  background: isSel ? "rgba(184,255,94,0.06)" : "transparent",
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  cursor: "pointer", fontFamily: "inherit",
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  {u.type === "USV" && <Anchor size={10} style={{ color: COLORS.phosphor, flexShrink: 0 }} />}
                  {u.type === "UAV" && <Plane size={10} style={{ color: COLORS.phosphor, flexShrink: 0 }} />}
                  <span style={{ color: isSel ? COLORS.phosphor : COLORS.text }}>{u.label}</span>
                  <span style={{ fontSize: 9, color: COLORS.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {u.state.toUpperCase()}
                  </span>
                </div>
                <BatteryBar value={u.battery} />
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ padding: 8, flex: "1 1 0", overflowY: "auto", minHeight: 0 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.1em", marginBottom: 6, color: COLORS.textDim }}>SELECTED</div>
        {usvSel ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10, color: COLORS.text }}>
            <Row k="UNIT" v={usvSel.label} />
            <Row k="TYPE" v={usvSel.type} />
            <Row k="STATE" v={usvSel.state.toUpperCase()}
                 vColor={
                   usvSel.state === "patrolling" ? COLORS.amber :
                   usvSel.state === "tracking" ? COLORS.amber :
                   usvSel.state === "jammed" ? COLORS.hostile :
                   COLORS.phosphor
                 } />
            {usvSel.engageTargetId && (() => {
              const tgt = state.units.find((x) => x.id === usvSel.engageTargetId);
              return tgt ? <Row k="TRACK" v={tgt.label} vColor={COLORS.amber} /> : null;
            })()}
            <Row k="POS" v={`${Math.round(usvSel.x)}, ${Math.round(usvSel.y)}`} />
            <Row k="HDG" v={`${(Math.round(rad2deg(usvSel.heading)) + 360) % 360}°`} />
            <Row k="BATT" v={`${Math.round(usvSel.battery)}%`}
                 vColor={usvSel.battery > 60 ? COLORS.phosphor :
                         usvSel.battery > 30 ? COLORS.amber : COLORS.hostile} />
            <Row k="GROUP" v={`+${selectedFriendly.length - 1} attached`} />
          </div>
        ) : (
          <div style={{ color: COLORS.textDim, fontSize: 10 }}>
            // No unit selected.<br />
            // Click roster or drag-box on map.
          </div>
        )}
      </div>

      <div style={{
        padding: "4px 8px", borderTop: `1px solid ${COLORS.border}`,
        display: "flex", justifyContent: "space-between", fontSize: 9,
        background: COLORS.bg, color: COLORS.textDim, flexShrink: 0,
      }}>
        <span>GPS: <span style={{ color: state.jamZones.length > 0 ? COLORS.amber : COLORS.phosphor }}>
          {state.jamZones.length > 0 ? "DEGRADED" : "OK"}
        </span></span>
        <span>SNR: <span style={{ color: COLORS.phosphor }}>OK</span></span>
        <span>JAM.Z: <span style={{ color: state.jamZones.length > 0 ? COLORS.hostile : COLORS.textDim }}>
          {state.jamZones.length}
        </span></span>
      </div>
    </div>
  );
};

// ─── PANEL: VISUAL INTEL — PHASE 3 ──────────────────────────────────────────
const VisualIntelPanel = ({ state, dispatch }) => {
  const [apiKey, setApiKey]       = useState("");
  const [keyDraft, setKeyDraft]   = useState("");
  const [imageDataUrl, setImageDataUrl] = useState(null);
  const [imageBase64, setImageBase64]   = useState(null);
  const [imageMime, setImageMime] = useState("image/jpeg");
  const [analyzing, setAnalyzing] = useState(false);
  const [extraction, setExtraction]   = useState(null);
  const [comparison, setComparison]   = useState(null);
  const [aisTarget, setAisTarget]     = useState(null);  // real AIS ship or null
  const [deployedTarget, setDeployedTarget] = useState(null); // deployed merchant or null
  const [error, setError]         = useState(null);
  const [isDragOver, setIsDragOver]   = useState(false);
  const fileInputRef = useRef(null);

  const activeUAV = state.units.find((u) => u.type === "UAV" && u.state === "orbiting");
  const jammedUAV = state.units.find((u) => u.type === "UAV" && u.state === "jammed");

  // Find nearest REAL AIS ship to orbiting UAV (within a generous range)
  const findNearestAIS = () => {
    if (!activeUAV) return null;
    const pool = state.aisShips.filter((s) => dist(activeUAV, { x: s.wx, y: s.wy }) < 500);
    if (!pool.length) return null;
    return pool.reduce((b, s) =>
      dist(activeUAV, { x: s.wx, y: s.wy }) < dist(activeUAV, { x: b.wx, y: b.wy }) ? s : b
    );
  };

  // Find nearest DEPLOYED merchant (simulated) within sensor range
  const findNearestDeployed = () => {
    if (!activeUAV) return null;
    const pool = state.units.filter(
      (u) => u.type === "COMMERCIAL" &&
             (state.detections[u.id]?.confidence || 0) > CONFIG.CONFIRMED_THRESHOLD
    );
    if (!pool.length) return null;
    return pool.reduce((b, u) => dist(activeUAV, u) < dist(activeUAV, b) ? u : b);
  };

  const readFile = (file) => {
    if (!file?.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const url = e.target.result;
      setImageDataUrl(url);
      setImageBase64(url.split(",")[1]);
      setImageMime(file.type);
      setExtraction(null); setComparison(null); setError(null);
      setAisTarget(findNearestAIS());
      setDeployedTarget(findNearestDeployed());
    };
    reader.readAsDataURL(file);
  };

  // Compare GPT-4o extraction against a real AIS ship
  const compareWithRealAIS = (ex, ship) => {
    const n = (s) => (s || "").toUpperCase().trim();
    const diffs = [];
    const cvType = n(ex.vesselType), aisType = n(ship.type);
    if (cvType && cvType !== "UNKNOWN" && aisType && aisType !== "UNKNOWN" && cvType !== aisType)
      diffs.push({ field: "TYPE", cv: cvType, ais: aisType });
    if (cvType === "MILITARY" && !["MILITARY","SPECIAL"].includes(aisType))
      diffs.push({ field: "CLASS", cv: "MILITARY ASSET", ais: "CIVILIAN AIS" });
    const cvFlag = n(ex.flagVisible), aisFlag = n(ship.flag);
    if (cvFlag && cvFlag !== "NONE" && cvFlag !== "—" && aisFlag &&
        !cvFlag.includes(aisFlag.slice(0,3)) && !aisFlag.includes(cvFlag.slice(0,3)))
      diffs.push({ field: "FLAG", cv: cvFlag, ais: aisFlag });
    return { match: diffs.length === 0, diffs };
  };

  const runAnalysis = async () => {
    if (!imageBase64 || !apiKey) return;
    const nearAIS = findNearestAIS();
    const nearDeployed = findNearestDeployed();
    setAisTarget(nearAIS);
    setDeployedTarget(nearDeployed);
    setAnalyzing(true); setError(null);

    const prompt = `You are a maritime ISR analyst reviewing aerial imagery.
Respond ONLY with a valid JSON object — no markdown, no preamble:
{
  "vesselType": "TANKER|CARGO|BULK|CONTAINER|MILITARY|FISHING|PASSENGER|TUG|UNKNOWN",
  "estimatedLengthM": <integer or null>,
  "hullColor": "<primary color>",
  "superstructure": "<one sentence>",
  "flagVisible": "<country code e.g. KOR, PAN, USA, or NONE>",
  "visibleIdentifiers": "<hull numbers, name text, markings, or NONE>",
  "confidence": <0-100>,
  "notes": "<anomalies or observations, max 80 chars>"
}`;

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 400,
          messages: [{
            role: "user",
            content: [
              { type: "image_url",
                image_url: { url: `data:${imageMime};base64,${imageBase64}`, detail: "low" } },
              { type: "text", text: prompt },
            ],
          }],
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const raw = data.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
      const ex = JSON.parse(raw);
      setExtraction(ex);

      // ── Comparison logic ──────────────────────────────────────────────────
      if (nearAIS) {
        // Case 1: Real AIS ship nearby — compare CV vs AIS
        const comp = compareWithRealAIS(ex, nearAIS);
        setComparison({ mode: "ais", ...comp, ship: nearAIS });
        if (!comp.match) {
          dispatch({ type: "ADD_ALERT", kind: "AIS.MISMATCH", severity: "high",
            title: `AIS MISMATCH — ${nearAIS.name || nearAIS.mmsi}`,
            body: `CV: ${ex.vesselType} vs AIS: ${nearAIS.type}. ${comp.diffs.length} field(s) discrepant.` });
        }
      } else if (nearDeployed) {
        // Case 2: Deployed merchant in sensor range, no real AIS signal → AIS DARK
        setComparison({ mode: "dark", match: false, diffs: [], vessel: nearDeployed });
        dispatch({ type: "ADD_ALERT", kind: "AIS.DARK", severity: "high",
          title: `AIS DARK — ${nearDeployed.label}`,
          body: "Vessel confirmed by ISR but transmitting no AIS. Possible transponder blackout." });
      } else {
        // Case 3: Nothing to compare against
        setComparison({ mode: "none", match: true, diffs: [] });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const reset = () => {
    setImageDataUrl(null); setImageBase64(null);
    setExtraction(null); setComparison(null); setError(null);
  };

  // ── No key ──────────────────────────────────────────────────────────────────
  if (!apiKey) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column",
                    justifyContent: "center", gap: 8, padding: 12, boxSizing: "border-box" }}>
        <div style={{ fontSize: 9, letterSpacing: "0.1em", marginBottom: 4, color: COLORS.phosphorDim }}>
          OPENAI API KEY REQUIRED
        </div>
        <input type="password" placeholder="sk-..."
          value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && keyDraft.startsWith("sk-") && setApiKey(keyDraft)}
          style={{ width: "100%", padding: "6px 8px", fontSize: 10, boxSizing: "border-box",
                   border: `1px solid ${COLORS.borderHi}`, background: COLORS.bg,
                   color: COLORS.phosphor, outline: "none",
                   fontFamily: "'JetBrains Mono', monospace" }} />
        <button onClick={() => keyDraft.startsWith("sk-") && setApiKey(keyDraft)}
          disabled={!keyDraft.startsWith("sk-")}
          style={{
            width: "100%", padding: "6px 0", fontSize: 10, fontWeight: 700,
            letterSpacing: "0.1em", cursor: keyDraft.startsWith("sk-") ? "pointer" : "not-allowed",
            border: `1px solid ${keyDraft.startsWith("sk-") ? COLORS.phosphor : COLORS.border}`,
            background: keyDraft.startsWith("sk-") ? COLORS.phosphor : "transparent",
            color: keyDraft.startsWith("sk-") ? COLORS.bg : COLORS.textDim,
            fontFamily: "'JetBrains Mono', monospace",
          }}>
          CONNECT GPT-4o
        </button>
        <div style={{ fontSize: 8, lineHeight: 1.5, color: COLORS.textDim,
                      fontFamily: "'JetBrains Mono', monospace" }}>
          // Lives in browser memory only.<br />// Sent only to api.openai.com.
        </div>
      </div>
    );
  }

  // ── Analyzing ───────────────────────────────────────────────────────────────
  if (analyzing) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column",
                    alignItems: "center", justifyContent: "center", gap: 12, padding: 12, boxSizing: "border-box" }}>
        <div style={{ fontSize: 9, fontFamily: "'JetBrains Mono', monospace",
                      letterSpacing: "0.1em", color: COLORS.amber }}>▶ GPT-4o ANALYZING...</div>
        <div style={{ width: "100%", height: 4, border: `1px solid ${COLORS.border}`, overflow: "hidden" }}>
          <div style={{ height: "100%", background: COLORS.phosphor,
                        animation: "cvprogress 1.8s ease-in-out infinite" }} />
        </div>
        {imageDataUrl && (
          <img src={imageDataUrl} alt="feed"
               style={{ width: "100%", maxHeight: 80, objectFit: "cover",
                        border: `1px solid ${COLORS.border}`,
                        opacity: 0.7, filter: "grayscale(40%) brightness(0.8)" }} />
        )}
        <div style={{ fontSize: 8, color: COLORS.textDim, fontFamily: "'JetBrains Mono', monospace" }}>
          model: gpt-4o · detail: low
        </div>
        <style>{`@keyframes cvprogress {
          0%   { width:0%;  margin-left:0% }
          50%  { width:50%; margin-left:25% }
          100% { width:0%;  margin-left:100% }
        }`}</style>
      </div>
    );
  }

  // ── Results ─────────────────────────────────────────────────────────────────
  if (extraction && comparison) {
    const isDark    = comparison.mode === "dark";
    const isNone    = comparison.mode === "none";
    const isMatch   = comparison.match && !isDark;
    const diffs     = comparison.diffs ?? [];
    const refShip   = comparison.ship;   // real AIS ship
    const refDeploy = comparison.vessel; // deployed merchant

    const verdictColor = isDark ? COLORS.hostile :
                         isNone ? COLORS.textDim :
                         isMatch ? COLORS.phosphor : COLORS.hostile;

    const rows = [
      { f: "TYPE",  cv: extraction.vesselType,
        ais: refShip?.type || refDeploy?.vesselType || "—" },
      { f: "FLAG",  cv: extraction.flagVisible || "—",
        ais: refShip?.flag || refDeploy?.flag || "—" },
      { f: "LEN",   cv: extraction.estimatedLengthM ? `~${extraction.estimatedLengthM}m` : "—",
        ais: "—" },
      { f: "NAME",  cv: extraction.visibleIdentifiers?.slice(0,10) || "—",
        ais: refShip?.name?.slice(0,10) || refDeploy?.label || "—" },
      { f: "MMSI",  cv: "—",
        ais: refShip?.mmsi || refDeploy?.mmsi?.slice(0,9) || "NO DATA" },
    ];

    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 6, padding: 8, overflowY: "auto", boxSizing: "border-box" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {imageDataUrl && (
            <img src={imageDataUrl} alt="target" style={{ width: 64, height: 48, objectFit: "cover", flexShrink: 0, border: `1px solid ${verdictColor}` }} />
          )}
          <div style={{ flex: 1, fontSize: 8.5, fontFamily: "'JetBrains Mono', monospace", color: COLORS.textDim }}>
            <div style={{ color: COLORS.phosphor }}>GPT-4o EXTRACT</div>
            <div>CONF: <span style={{ color: COLORS.amber }}>{extraction.confidence}%</span></div>
            <div style={{ color: isDark ? COLORS.hostile : COLORS.amberDim }}>
              {isDark ? "⚠ NO AIS SIGNAL" :
               refShip ? `AIS: ${refShip.name?.slice(0,12) || refShip.mmsi}` :
               isNone ? "NO AIS CONTACT" : "—"}
            </div>
          </div>
        </div>

        <div style={{ fontSize: "8.5px", fontFamily: "'JetBrains Mono', monospace" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 2, marginBottom: 2 }}>
            <span style={{ color: COLORS.textDim }}>FIELD</span>
            <span style={{ color: COLORS.neutral }}>CV</span>
            <span style={{ color: isDark ? COLORS.hostile : COLORS.amber }}>
              {isDark ? "AIS ✗" : "AIS"}
            </span>
          </div>
          {rows.map(({ f, cv, ais }) => {
            const mismatch = diffs.some((d) => d.field === f) || (isDark && f === "MMSI");
            const trunc = (s) => s?.length > 10 ? s.slice(0, 10) + "…" : (s || "—");
            return (
              <div key={f} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", padding: "2px 0", background: mismatch ? `${COLORS.hostile}18` : "transparent" }}>
                <span style={{ color: COLORS.textDim }}>{f}</span>
                <span style={{ color: mismatch ? COLORS.hostile : COLORS.neutral }}>{trunc(cv)}</span>
                <span style={{ color: mismatch ? COLORS.hostile : COLORS.amber }}>{trunc(ais)}</span>
              </div>
            );
          })}
        </div>

        {extraction.notes && extraction.notes !== "None" && (
          <div className="text-[7.5px] font-mono px-1 py-0.5 border"
               style={{ borderColor: COLORS.border, color: COLORS.textDim }}>
            {extraction.notes.slice(0, 80)}
          </div>
        )}

        <div className="border px-2 py-1.5 text-[9px] font-mono font-bold"
             style={{
               borderColor: verdictColor,
               background: `${verdictColor}0d`,
               color: verdictColor,
               letterSpacing: "0.1em",
             }}>
          {isDark  ? "⚠ AIS DARK — NO TRANSPONDER" :
           isNone  ? "// NO AIS CONTACT IN RANGE" :
           isMatch ? "✓ AIS CONSISTENT" :
                     `⚠ MISMATCH · ${diffs.length} FIELD${diffs.length > 1 ? "S" : ""}`}
        </div>

        {error && (
          <div className="text-[8px] font-mono p-1 border"
               style={{ borderColor: COLORS.hostile, color: COLORS.hostile }}>
            ERR: {error.slice(0, 55)}
          </div>
        )}

        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={reset}
            style={{ flex: 1, padding: "4px 0", border: `1px solid ${COLORS.border}`, fontSize: 9, color: COLORS.textDim, background: "transparent", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
            NEW IMG
          </button>
          <button onClick={runAnalysis}
            style={{ flex: 1, padding: "4px 0", border: `1px solid ${COLORS.phosphor}`, fontSize: 9, fontWeight: 700, color: COLORS.phosphor, background: "transparent", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
            RERUN
          </button>
          <button onClick={() => { setApiKey(""); setKeyDraft(""); reset(); }}
            className="py-1 px-1.5 border text-[9px] font-mono"
            style={{ borderColor: COLORS.border, color: COLORS.textDim }}>
            KEY
          </button>
        </div>
      </div>
    );
  }

  // ── Drop zone ───────────────────────────────────────────────────────────────
  const nearAIS      = findNearestAIS();
  const nearDeployed = findNearestDeployed();

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 8, padding: 8, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 9, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: COLORS.phosphorDim }}>
          <Camera size={9} />
          {activeUAV
            ? <><span>UAV-{activeUAV.label}</span>
                <span style={{ display: "inline-flex", alignItems: "center", gap: 3, marginLeft: 4, color: COLORS.hostile }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.hostile, display: "inline-block" }} />LIVE
                </span></>
            : jammedUAV
              ? <span style={{ color: COLORS.amber }}>JAMMED</span>
              : <span style={{ color: COLORS.textDim }}>NO UAV FEED</span>
          }
        </div>
        <button onClick={() => { setApiKey(""); setKeyDraft(""); }}
          style={{ fontSize: 8, color: COLORS.phosphorDim, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
          GPT-4o ✓
        </button>
      </div>

      {/* Context: what ISR sees */}
      <div className="border px-2 py-1 text-[8px] font-mono space-y-0.5"
           style={{ borderColor: nearAIS ? COLORS.ais : nearDeployed ? COLORS.amber : COLORS.border }}>
        {nearAIS
          ? <div>
              <span style={{ color: COLORS.aisDim }}>AIS · </span>
              <span style={{ color: COLORS.ais }}>{nearAIS.name?.slice(0,14) || nearAIS.mmsi}</span>
              <span style={{ color: COLORS.textDim }}> · {nearAIS.type} · {nearAIS.flag}</span>
            </div>
          : <div style={{ color: COLORS.textDim }}>// No real AIS contact in sensor range</div>
        }
        {nearDeployed && (
          <div>
            <span style={{ color: COLORS.amberDim }}>SIM · </span>
            <span style={{ color: COLORS.amber }}>{nearDeployed.label}</span>
            <span style={{ color: COLORS.textDim }}> {nearDeployed.vesselType} (no AIS)</span>
          </div>
        )}
      </div>

      <div
        style={{ flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", border: "1px dashed", cursor: "pointer", overflow: "hidden" }}
        style={{
          borderColor: isDragOver ? COLORS.phosphor : COLORS.borderHi,
          borderStyle: "dashed",
          background: isDragOver ? `${COLORS.phosphor}08` : COLORS.bg,
          transition: "all 0.15s",
        }}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragOver(false); readFile(e.dataTransfer.files[0]); }}
        onClick={() => fileInputRef.current?.click()}
      >
        {imageDataUrl
          ? <img src={imageDataUrl} alt="target" style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.9 }} />
          : <div className="text-center px-2">
              <ImageIcon size={18} style={{ color: COLORS.phosphorDim, margin: "0 auto 4px" }} />
              <div className="text-[9px] font-mono" style={{ color: COLORS.textDim }}>
                DROP AERIAL IMAGE<br />
                <span style={{ color: COLORS.phosphorDim }}>or click to browse</span>
              </div>
            </div>
        }
        <input ref={fileInputRef} type="file" accept="image/*"
               style={{ display: "none" }}
               onChange={(e) => e.target.files[0] && readFile(e.target.files[0])} />
      </div>

      {imageDataUrl && (
        <button onClick={runAnalysis}
          style={{ width: "100%", padding: "6px 0", flexShrink: 0, border: `1px solid ${COLORS.phosphor}`, background: COLORS.phosphor, color: COLORS.bg, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
          ▶ ANALYZE WITH GPT-4o
        </button>
      )}

      {error && (
        <div className="text-[8px] font-mono p-1 border"
             style={{ borderColor: COLORS.hostile, color: COLORS.hostile }}>
          ERR: {error.slice(0, 60)}
        </div>
      )}
    </div>
  );
};
// ─── PANEL: COMMAND ──────────────────────────────────────────────────────────
const CmdButton = ({ icon, label, active, disabled, onClick }) => (
  <button onClick={onClick} disabled={disabled}
    style={{
      padding: "8px 6px", border: `1px solid ${active ? COLORS.phosphor : COLORS.border}`,
      background: active ? "rgba(184,255,94,0.08)" : "transparent",
      color: disabled ? COLORS.textDim : (active ? COLORS.phosphor : COLORS.text),
      opacity: disabled ? 0.4 : 1, cursor: disabled ? "not-allowed" : "pointer",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
      fontFamily: "'JetBrains Mono', monospace",
    }}>
    {icon}
    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.1em" }}>{label}</span>
  </button>
);

const DeployButton = ({ label, color, active, onClick }) => (
  <button onClick={onClick}
    style={{
      padding: "6px", border: `1px solid ${active ? color : COLORS.border}`,
      color, background: active ? `${color}14` : "transparent",
      fontSize: 9, fontWeight: 700, letterSpacing: "0.05em",
      cursor: "pointer", fontFamily: "'JetBrains Mono', monospace",
    }}>{label}</button>
);

const CommandPanel = ({ state, dispatch, tool, setTool, deployType, setDeployType }) => {
  const hasSelection = state.selectedIds.length > 0;
  const setDeploy = (t) => { setTool("deploy"); setDeployType(t); };

  return (
    <div style={{ height: "100%", display: "flex" }}>
      {/* Orders + deploy column */}
      <div style={{
        width: 320, padding: 8, display: "flex", flexDirection: "column", gap: 6,
        borderRight: `1px solid ${COLORS.border}`, flexShrink: 0,
      }}>
        <div style={{ fontSize: 9, letterSpacing: "0.1em", color: COLORS.textDim }}>
          ORDERS {!hasSelection && <span style={{ color: COLORS.amberDim }}>// no selection</span>}
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
          <CmdButton icon={<Crosshair size={11} />} label="MOVE"
            disabled={!hasSelection} active={tool === "select"}
            onClick={() => setTool("select")} />
          <CmdButton icon={<Hexagon size={11} />} label="PATROL"
            disabled={!hasSelection} active={tool === "patrol"}
            onClick={() => setTool("patrol")} />
          <CmdButton icon={<Radar size={11} />} label="HOLD"
            disabled={!hasSelection}
            onClick={() => dispatch({ type: "HOLD_SELECTED" })} />
        </div>

        <div style={{ fontSize: 9, letterSpacing: "0.1em", color: COLORS.textDim, marginTop: 4 }}>
          DEPLOY <span style={{ color: COLORS.amberDim }}>// sandbox</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4 }}>
          <DeployButton label="+ ISR" color={COLORS.phosphor}
            active={tool === "deploy" && deployType === "ISR"} onClick={() => setDeploy("ISR")} />
          <DeployButton label="+ MERCHANT" color={COLORS.neutral}
            active={tool === "deploy" && deployType === "COMMERCIAL"} onClick={() => setDeploy("COMMERCIAL")} />
          <DeployButton label="+ HOSTILE" color={COLORS.hostile}
            active={tool === "deploy" && deployType === "ENEMY"} onClick={() => setDeploy("ENEMY")} />
          <DeployButton label="+ SUB" color={COLORS.subsurface}
            active={tool === "deploy" && deployType === "SUBMARINE"} onClick={() => setDeploy("SUBMARINE")} />
          <DeployButton label="+ MINE" color={COLORS.subsurface}
            active={tool === "deploy" && deployType === "MINE"} onClick={() => setDeploy("MINE")} />
          <DeployButton label="+ JAM" color={COLORS.amber}
            active={tool === "deploy" && deployType === "JAM"} onClick={() => setDeploy("JAM")} />
        </div>

        <div style={{ marginTop: "auto", fontSize: 9, lineHeight: 1.6, color: COLORS.textDim,
                      fontFamily: "'JetBrains Mono', monospace" }}>
          {tool === "patrol" ? (
            <><span style={{ color: COLORS.phosphor }}>{">"}</span> Click vertices · R-click to close</>
          ) : tool === "deploy" ? (
            <><span style={{ color: COLORS.amber }}>{">"}</span> Click map to place {deployType.toLowerCase()}</>
          ) : (
            <>
              <span style={{ color: COLORS.phosphor }}>{">"}</span> R-click water: move<br />
              <span style={{ color: COLORS.phosphor }}>{">"}</span> R-click contact: TRACK<br />
              <span style={{ color: COLORS.phosphor }}>{">"}</span> Drag-select · Edge: pan
            </>
          )}
        </div>
      </div>

      {/* Alert feed column */}
      <div style={{ flex: "1 1 0", minWidth: 0, display: "flex", flexDirection: "column" }}>
        <div style={{ padding: "8px 8px 4px", fontSize: 9, letterSpacing: "0.1em",
                      color: COLORS.amberDim, flexShrink: 0 }}>
          ALERT.FEED
        </div>
        <div style={{ flex: "1 1 0", overflowY: "auto", padding: "0 8px 8px",
                      display: "flex", flexDirection: "column", gap: 4, minHeight: 0 }}>
          {state.alerts.length === 0 && (
            <div style={{ fontSize: 10, color: COLORS.textDim,
                          fontFamily: "'JetBrains Mono', monospace" }}>
              // No active alerts. Sensors nominal.
            </div>
          )}
          {state.alerts.map((a) => {
            const sevColor = a.severity === "high" ? COLORS.hostile :
                             a.severity === "med" ? COLORS.amber : COLORS.phosphor;
            return (
              <div key={a.id}
                style={{ border: `1px solid ${sevColor}`, padding: "6px 8px",
                         background: `${sevColor}0d`, cursor: "pointer", flexShrink: 0 }}
                onClick={() => dispatch({ type: "DISMISS_ALERT", id: a.id })}>
                <div style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9,
                              color: sevColor, fontFamily: "'JetBrains Mono', monospace" }}>
                  <AlertTriangle size={9} />
                  <span style={{ fontWeight: 700, letterSpacing: "0.1em" }}>{a.kind}</span>
                  <span style={{ marginLeft: "auto", color: COLORS.textDim }}>
                    T+{Math.floor(a.time)}s
                  </span>
                </div>
                <div style={{ fontSize: 10, marginTop: 2, color: COLORS.text,
                              fontFamily: "'JetBrains Mono', monospace" }}>
                  {a.title}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// ─── BOTTOM CURSOR/STATUS STRIP ──────────────────────────────────────────────
const CursorStrip = ({ cursorWorld, state }) => {
  const friendlyCount = state.units.filter((u) => u.faction === "friendly").length;
  const detectedHostile = Object.entries(state.detections).filter(
    ([id, d]) => d.confidence > CONFIG.POSSIBLE_THRESHOLD &&
                 state.units.find((u) => u.id === id)?.faction === "hostile"
  ).length;
  const subsurfaceContacts = Object.entries(state.detections).filter(
    ([id, d]) => d.confidence > CONFIG.POSSIBLE_THRESHOLD &&
                 isUnderwater(state.units.find((u) => u.id === id) || {})
  ).length;

  return (
    <div style={{
      height: 24, display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 12px", flexShrink: 0,
      borderTop: `1px solid ${COLORS.border}`,
      background: COLORS.bg, color: COLORS.textDim,
      fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span>CRSR: <span style={{ color: COLORS.phosphor }}>
          {cursorWorld ? `${cursorWorld.x.toFixed(0)}, ${cursorWorld.y.toFixed(0)}` : "----, ----"}
        </span></span>
        <span>SEL: <span style={{ color: COLORS.phosphor }}>{state.selectedIds.length}</span></span>
        <span>FRIENDLY: <span style={{ color: COLORS.phosphor }}>{friendlyCount}</span></span>
        <span>HOSTILE: <span style={{ color: COLORS.hostile }}>{detectedHostile}</span></span>
        <span>SUB.SFC: <span style={{ color: COLORS.subsurface }}>{subsurfaceContacts}</span></span>
      </div>
      <div style={{ color: COLORS.phosphorDim }}>BLACK SHEEP WALL // PHASE 3</div>
    </div>
  );
};

const ScanlineOverlay = () => (
  <div style={{
    pointerEvents: "none", position: "absolute", inset: 0, zIndex: 100,
    backgroundImage: `repeating-linear-gradient(
      0deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px,
      transparent 1px, transparent 3px
    )`,
    mixBlendMode: "multiply",
  }} />
);

// ─── MAIN APP ────────────────────────────────────────────────────────────────
export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, makeInitialState);
  const [tool, setTool] = useState("select");
  const [deployType, setDeployType] = useState("ENEMY");
  const [hover, setHover] = useState(null);
  const [cursorWorld, setCursorWorld] = useState(null);
  // Camera starts centered on ISR-1 spawn at (2400, 1900) — East China Sea.
  // At zoom 0.9, viewport ≈ 7110×4440 world units (fits 6400×4000 with margin).
  // cam.x/y is viewport top-left; centering = ISR_pos - viewport/2.
  const [cam, setCam] = useState({
    x: 2400 - (CONFIG.WORLD_W / 0.9) / 2,
    y: 1900 - (CONFIG.WORLD_H / 0.9) / 2,
    zoom: 0.9,
  });
  const [aisStatus, setAisStatus] = useState("ok"); // synthetic, always available
  const fleetRef = useRef(null);

  useEffect(() => {
    if (state.paused) return;
    const id = setInterval(() => dispatch({ type: "TICK" }), CONFIG.TICK_MS);
    return () => clearInterval(id);
  }, [state.paused]);

  // ─── Phase 4: Synthetic AIS fleet ─────────────────────────────────────────
  // Initialize a fleet of vessels along realistic shipping lanes through the
  // First Island Chain, then advance them along their routes each tick.
  useEffect(() => {
    if (!fleetRef.current) {
      fleetRef.current = generateAISFleet();
      dispatch({ type: "SET_AIS_SHIPS", ships: [...fleetRef.current] });
    }
    const id = setInterval(() => {
      const speedMul = state.simSpeed;
      const fleet = fleetRef.current;
      // Advance each ship along its route
      fleet.forEach((ship) => {
        ship.routePos += ship.routeSpeed * speedMul;
        if (ship.routePos >= 1) ship.routePos -= 1;
        const pos = pointAlongRoute(ship.route, ship.routePos);
        const next = pointAlongRoute(ship.route, (ship.routePos + 0.001) % 1);
        const wpHere = geoToWorld(pos.lat, pos.lon);
        const wpNext = geoToWorld(next.lat, next.lon);
        ship.lat = pos.lat; ship.lon = pos.lon;
        ship.wx = wpHere.x; ship.wy = wpHere.y;
        const dx = wpNext.x - wpHere.x, dy = wpNext.y - wpHere.y;
        ship.cog = (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360;
        ship.heading = ship.cog;
      });
      dispatch({ type: "SET_AIS_SHIPS", ships: [...fleet] });
    }, CONFIG.AIS_TICK_MS);
    return () => clearInterval(id);
  }, [state.simSpeed]);

  // Full-screen CSS reset — ensures html/body/#root fill the viewport in local dev
  useEffect(() => {
    const style = document.createElement("style");
    style.id = "bsw-reset";
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; }
      html, body {
        margin: 0; padding: 0;
        width: 100%; height: 100%;
        overflow: hidden;
        background: #08100c;
      }
      #root, #app {
        width: 100%; height: 100%;
        display: flex; flex-direction: column;
      }
      @keyframes pulse {
        0%, 100% { opacity: 1; }
        50%      { opacity: 0.35; }
      }
    `;
    document.head.appendChild(style);
    return () => { try { document.head.removeChild(style); } catch (e) {} };
  }, []);

  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap";
    document.head.appendChild(link);
    return () => { try { document.head.removeChild(link); } catch (e) {} };
  }, []);

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === " ") { e.preventDefault(); dispatch({ type: "TOGGLE_PAUSE" }); }
      if (e.key === "Escape") { setTool("select"); dispatch({ type: "SELECT", ids: [] }); }
      if (e.key === "p" || e.key === "P") setTool("patrol");
      if (e.key === "h" || e.key === "H") dispatch({ type: "HOLD_SELECTED" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div style={{
      position: "fixed", inset: 0,
      display: "flex", flexDirection: "column", overflow: "hidden",
      background: COLORS.bg, color: COLORS.text,
      fontFamily: "'JetBrains Mono', 'Courier New', monospace",
    }}>
      <TopBar state={state} dispatch={dispatch} aisStatus={aisStatus} />

      {/* Map — takes all remaining vertical space */}
      <div style={{ flex: "1 1 0", minHeight: 0, position: "relative", overflow: "hidden" }}>
        <MapView state={state} dispatch={dispatch}
          tool={tool} setTool={setTool} deployType={deployType}
          setHover={setHover} setCursorWorld={setCursorWorld}
          cam={cam} setCam={setCam} />
      </div>

      {/* Bottom dock — 4 panels side by side, fixed height */}
      <div style={{
        height: 224, flexShrink: 0, display: "flex",
        borderTop: `1px solid ${COLORS.border}`,
      }}>
        <DockPanel title="TACTICAL.OVERVIEW" width={260}
          icon={<Hexagon size={10} style={{ color: COLORS.phosphor }} />}>
          <TacticalOverviewPanel state={state} cam={cam} setCam={setCam} />
        </DockPanel>
        <DockPanel title="STATUS" width={300}
          icon={<Activity size={10} style={{ color: COLORS.phosphor }} />}>
          <StatusPanel state={state} dispatch={dispatch} />
        </DockPanel>
        <DockPanel title="VISUAL.INTEL" width={280}
          icon={<Camera size={10} style={{ color: COLORS.phosphor }} />}>
          <VisualIntelPanel state={state} dispatch={dispatch} />
        </DockPanel>
        <DockPanel title="COMMAND" flex
          icon={<Crosshair size={10} style={{ color: COLORS.phosphor }} />}>
          <CommandPanel state={state} dispatch={dispatch}
            tool={tool} setTool={setTool}
            deployType={deployType} setDeployType={setDeployType} />
        </DockPanel>
      </div>

      <CursorStrip cursorWorld={cursorWorld} state={state} />
      <ScanlineOverlay />
    </div>
  );
}