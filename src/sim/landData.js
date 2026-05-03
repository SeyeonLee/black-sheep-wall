// ─── Land data: Natural Earth 110m ───────────────────────────────────────────
// Fetches real land polygons once, converts to world coords, provides:
//   getLandPolygons() → [{points:[{x,y}], bbox:{minX,minY,maxX,maxY}}]
//   isOnLand(x, y)   → bool  (used by tick.js for USV/sub/mine collision)

import { geoToWorld } from "../utils";
import { CONFIG } from "../config";

// Clip bbox slightly larger than world bounds
const BBOX_PAD = 3; // degrees
const LON_MIN = CONFIG.GEO_LON_MIN - BBOX_PAD;
const LON_MAX = CONFIG.GEO_LON_MAX + BBOX_PAD;
const LAT_MIN = CONFIG.GEO_LAT_MIN - BBOX_PAD;
const LAT_MAX = CONFIG.GEO_LAT_MAX + BBOX_PAD;

let landPolygons = null; // [{points:[{x,y}], bbox}] — null = not loaded yet
let loadPromise  = null;

// ─── Internals ────────────────────────────────────────────────────────────────
function polyBbox(points) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const { x, y } of points) {
    if (x < minX) minX = x;  if (y < minY) minY = y;
    if (x > maxX) maxX = x;  if (y > maxY) maxY = y;
  }
  return { minX, minY, maxX, maxY };
}

function ringTouchesRegion(ring) {
  // Quick check: does any vertex fall in our expanded bbox?
  return ring.some(([lon, lat]) =>
    lon >= LON_MIN && lon <= LON_MAX && lat >= LAT_MIN && lat <= LAT_MAX
  );
}

function ringToWorldPoly(ring) {
  return ring
    .filter(([lon, lat]) =>
      lon >= LON_MIN - 1 && lon <= LON_MAX + 1 &&
      lat >= LAT_MIN - 1 && lat <= LAT_MAX + 1
    )
    .map(([lon, lat]) => geoToWorld(lat, lon));
}

function pointInPolygon(x, y, points) {
  let inside = false;
  for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
    const xi = points[i].x, yi = points[i].y;
    const xj = points[j].x, yj = points[j].y;
    if (((yi > y) !== (yj > y)) &&
        x < ((xj - xi) * (y - yi) / (yj - yi) + xi)) {
      inside = !inside;
    }
  }
  return inside;
}

// ─── Public API ───────────────────────────────────────────────────────────────
export async function loadLandData() {
  if (landPolygons !== null) return;
  if (loadPromise) return loadPromise;

  loadPromise = fetch(
    "https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson/ne_110m_land.json"
  )
    .then((r) => r.json())
    .then((data) => {
      const result = [];
      for (const feature of data.features) {
        const { type, coordinates } = feature.geometry;
        const polyGroups =
          type === "Polygon"      ? [coordinates]      :
          type === "MultiPolygon" ? coordinates : [];

        for (const poly of polyGroups) {
          const ring = poly[0]; // outer ring only
          if (!ringTouchesRegion(ring)) continue;
          const points = ringToWorldPoly(ring);
          if (points.length < 3) continue;
          result.push({ points, bbox: polyBbox(points) });
        }
      }
      landPolygons = result;
      console.log(`[landData] loaded ${landPolygons.length} land polygons`);
    })
    .catch((err) => {
      console.warn("[landData] fetch failed:", err.message);
      landPolygons = []; // fail open — units can move everywhere
    });

  return loadPromise;
}

/** Returns land polygons for rendering (tactical mode land fill) */
export function getLandPolygons() {
  return landPolygons || [];
}

/** Returns true if world-coord point (x, y) is on land. */
export function isOnLand(x, y) {
  if (!landPolygons || landPolygons.length === 0) return false;
  for (const { points, bbox } of landPolygons) {
    if (x < bbox.minX || x > bbox.maxX || y < bbox.minY || y > bbox.maxY) continue;
    if (pointInPolygon(x, y, points)) return true;
  }
  return false;
}
