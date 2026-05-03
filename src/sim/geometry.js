import { CONFIG } from "../config";

// ─── Point-in-polygon (ray casting) ─────────────────────────────────────────
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

// ─── Polygon sweep path (boustrophedon lawnmower) ───────────────────────────
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

export const polygonSweepPath = (poly, lanes = CONFIG.PATROL_LANES) => {
  if (poly.length < 3) return [];
  const ys = poly.map((p) => p.y);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
  const stepY = (maxY - minY) / lanes;
  const path = [];
  let dir = 1;
  for (let i = 0; i <= lanes; i++) {
    const y = minY + i * stepY + 0.001;
    const xs = lineXIntersects(y, poly);
    if (xs.length < 2) continue;
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

// ─── Voronoi patrol partitioning (multi-USV) ────────────────────────────────
// Distribute N seeds inside the polygon evenly, then build a coarse Voronoi
// region per seed by rasterizing → tracing each region's row spans.
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
    if (!pointInPolygon({ x: sx, y: sy }, poly)) { sx = cx; sy = cy; }
    seeds.push({ x: sx, y: sy });
  }
  return seeds;
};

// Build per-seed polygonal sub-regions via rasterization.
export const voronoiSubPolygons = (poly, seeds, gridStep = 50) => {
  const xs = poly.map((p) => p.x), ys = poly.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs);
  const minY = Math.min(...ys), maxY = Math.max(...ys);
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
  return perSeed.map(({ rows }) => {
    if (rows.size === 0) return [];
    const sorted = [...rows.values()].sort((a, b) => a.y - b.y);
    const left  = sorted.map((r) => ({ x: r.minX, y: r.y }));
    const right = sorted.slice().reverse().map((r) => ({ x: r.maxX, y: r.y }));
    return [...left, ...right];
  });
};
