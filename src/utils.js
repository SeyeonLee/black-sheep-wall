import { CONFIG } from "./config";

export const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
export const norm = (a) => {
  const m = Math.hypot(a.x, a.y);
  return m === 0 ? { x: 0, y: 0 } : { x: a.x / m, y: a.y / m };
};
export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
export const angleOf = (dx, dy) => Math.atan2(dy, dx);
export const rad2deg = (r) => (r * 180) / Math.PI;
export const isUnderwater = (u) => u.type === "SUBMARINE" || u.type === "MINE";

// Linear Mercator approximation for ~15°×25° viewport
export const geoToWorld = (lat, lon) => ({
  x: ((lon - CONFIG.GEO_LON_MIN) / (CONFIG.GEO_LON_MAX - CONFIG.GEO_LON_MIN)) * CONFIG.WORLD_W,
  y: ((CONFIG.GEO_LAT_MAX - lat)  / (CONFIG.GEO_LAT_MAX - CONFIG.GEO_LAT_MIN)) * CONFIG.WORLD_H,
});
export const worldToGeo = (x, y) => ({
  lon: CONFIG.GEO_LON_MIN + (x / CONFIG.WORLD_W) * (CONFIG.GEO_LON_MAX - CONFIG.GEO_LON_MIN),
  lat: CONFIG.GEO_LAT_MAX - (y / CONFIG.WORLD_H) * (CONFIG.GEO_LAT_MAX - CONFIG.GEO_LAT_MIN),
});

export const decodeAISType = (code) => {
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

// Standard scan-line: for each horizontal line, find polygon-edge intersections,
// Standard ray-casting point-in-polygon test
export const pointInPolygon = (pt, poly) => {
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
export const lineXIntersects = (y, poly) => {
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

export const polygonSweepPath = (poly, lanes = CONFIG.PATROL_LANES) => {
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

export const polygonCentroid = (poly) => {
  let x = 0, y = 0;
  poly.forEach((p) => { x += p.x; y += p.y; });
  return { x: x / poly.length, y: y / poly.length };
};

// Distribute N seeds inside the polygon, then build a coarse polygonal Voronoi
// region per seed by rasterizing → tracing each region's boundary as a polygon
// → running the existing polygonSweepPath on it.
export const placeVoronoiSeeds = (poly, n) => {
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
export const voronoiSubPolygons = (poly, seeds, gridStep = 50) => {
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

// Country-prefix MMSI codes (real ITU MID assignments)
export const FLAG_DATA = [
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
export const SHIPPING_ROUTES = [
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

export const pointAlongRoute = (waypoints, t) => {
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

export const generateAISFleet = () => {
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
