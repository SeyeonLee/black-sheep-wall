import { CONFIG } from "../config";

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
