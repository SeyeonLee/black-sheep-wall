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

// Linear Mercator approximation — First Island Chain (116°E–148°E, 5°N–42°N)
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
