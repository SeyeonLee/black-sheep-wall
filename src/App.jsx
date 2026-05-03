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
  WORLD_W: 4000, WORLD_H: 2500,

  USV_SPEED: 0.45, UAV_SPEED: 2.2,
  ENEMY_SPEED: 0.35, COMMERCIAL_SPEED: 0.5,
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

  // Geographic projection — Yellow Sea / Korea Strait region
  // ISR-1 spawns at (2000,1300) ≈ 132.5°E, 37.2°N (Yellow Sea)
  GEO_LON_MIN: 120, GEO_LON_MAX: 145,   // 25° span → 4000 world units
  GEO_LAT_MIN: 30,  GEO_LAT_MAX: 45,    // 15° span → 2500 world units
  AIS_RANGE_DEG: 3,                       // bounding box padding for fetch
  AIS_FETCH_MS: 60000,                    // refresh every 60 s
  AIS_SHIP_VISIBLE_RANGE: 350,            // world units — radius to show AIS labels
};

const COLORS = {
  bg: "#08100c", surface: "#0d1612", surfaceHi: "#121e18",
  border: "#1f3329", borderHi: "#2d4a3c",
  ocean1: "#06100d", ocean2: "#0a1813", land: "#152019", grid: "#1a2a22",
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

// ─── PHASE 2: PROPER POLYGON-CLIPPED SWEEP PATH ──────────────────────────────
// Standard scan-line: for each horizontal line, find polygon-edge intersections,
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
      state: "orbiting", parentId: usvId, orbitAngle: 0, label: "α" },
    { id: newId("uav"), type: "UAV", faction: "friendly", x, y, heading: 0, battery: 100,
      state: "docked", parentId: usvId, orbitAngle: Math.PI, label: "β" },
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
  const isr = createISRUnit(2000, 1300, 1);
  return {
    units: [
      ...isr,
      createCommercialVessel(1400, 900),
      createCommercialVessel(2600, 1700),
      createCommercialVessel(2200, 800),
    ],
    detections: {},
    alerts: [],
    patrolAreas: [],
    jamZones: [],
    aisShips: [],          // Phase 3: live AIS feed
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

    // Always drain battery if airborne (even when jammed)
    const isAirborne = u.state !== "docked";

    // Check jam-zone presence. If inside any zone while airborne, become jammed.
    const inJam = isAirborne && jamZones.some((jz) => dist(u, jz) < jz.radius);

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
    } else if (u.state === "jammed") {
      // Phase 2.1: jammed UAV commits to RTB; doesn't resume orbit until
      // it docks, charges, and re-launches via applyUAVRotation.
      const dx = parent.x - u.x, dy = parent.y - u.y;
      const d = Math.hypot(dx, dy);
      next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);
      if (d < CONFIG.UAV_DOCK_RANGE) {
        next.state = "docked"; next.x = parent.x; next.y = parent.y;
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
      const usvIds = state.units
        .filter((u) => state.selectedIds.includes(u.id) && u.type === "USV")
        .map((u) => u.id);
      if (usvIds.length === 0) return state;
      const cleared = clearOrdersForUSVs(state, usvIds);
      const units = cleared.units.map((u) =>
        usvIds.includes(u.id) ? { ...u, goal: action.target, state: "moving" } : u
      );
      return { ...state, units, patrolAreas: cleared.patrolAreas };
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
      const usvIds = state.units
        .filter((u) => unitIds.includes(u.id) && u.type === "USV")
        .map((u) => u.id);
      if (usvIds.length === 0) return state;
      const cleared = clearOrdersForUSVs(state, usvIds);
      const path = polygonSweepPath(polygon);
      const id = newId("pat");
      const units = cleared.units.map((u) =>
        usvIds.includes(u.id)
          ? { ...u, patrolPath: path, patrolIdx: 0, state: "patrolling", goal: null }
          : u
      );
      return {
        ...state, units,
        patrolAreas: [...cleared.patrolAreas, { id, polygon, unitIds: usvIds, path }],
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

// ─── LANDMASSES ──────────────────────────────────────────────────────────────
const LAND = [
  "M 3050 200 L 3400 220 L 3600 380 L 3700 600 L 3680 850 L 3500 1050 L 3400 1300 L 3500 1500 L 3450 1700 L 3300 1900 L 3200 2100 L 3000 2200 L 2950 2350 L 3050 2500 L 4000 2500 L 4000 0 L 3050 0 Z",
  "M 3050 1500 L 2950 1700 L 2900 1900 L 2980 2050 L 3100 2000 L 3150 1850 L 3120 1650 Z",
  "M 1200 450 Q 1280 430 1320 480 Q 1300 540 1230 530 Q 1190 500 1200 450 Z",
  "M 800 1800 Q 870 1780 900 1830 Q 880 1880 820 1870 Q 790 1840 800 1800 Z",
  "M 2400 2300 Q 2480 2280 2520 2330 Q 2500 2380 2430 2370 Q 2390 2350 2400 2300 Z",
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
    glyph = (
      <g opacity={dim}>
        <path d="M 0 -8 L 7 6 L 0 3 L -7 6 Z" fill={color} stroke={color} strokeWidth="1" />
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

  // Phase 2.1: right-click on detected non-friendly → TRACK
  const onUnitContextMenu = (u, e) => {
    if (state.selectedIds.length === 0) return;
    if (u.faction === "friendly") return;
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

      {/* Patrol areas with proper sweep paths */}
      <g>{state.patrolAreas.map((pa) => {
        const c = polygonCentroid(pa.polygon);
        return (
          <g key={pa.id}>
            <polygon points={pa.polygon.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="url(#patrol-hatch)" stroke={COLORS.phosphor} strokeWidth="1.2"
              strokeDasharray="6 3" opacity="0.85" />
            <polyline points={pa.path.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none" stroke={COLORS.phosphor} strokeWidth="1.2" strokeDasharray="3 4" opacity="0.7" />
            {pa.polygon.map((v, i) => (
              <circle key={i} cx={v.x} cy={v.y} r="2.5" fill={COLORS.phosphor} opacity="0.9" />
            ))}
            <text x={c.x} y={c.y} textAnchor="middle" fontSize="9"
                  fontFamily="'JetBrains Mono', monospace"
                  fill={COLORS.phosphor} opacity="0.6" letterSpacing="0.2em">
              PATROL
            </text>
          </g>
        );
      })}</g>

      {/* Phase 2: jam zones */}
      <g>{state.jamZones.map((jz) => (
        <JamZoneGlyph key={jz.id} zone={jz}
          onClick={(z, e) => { if (e.shiftKey) dispatch({ type: "REMOVE_JAM_ZONE", id: z.id }); }} />
      ))}</g>

      {/* Movement waypoints */}
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
const TopBar = ({ state, dispatch, aisUsername, setAisUsername, aisStatus, onRefreshAIS }) => {
  const { paused, simSpeed, simTime } = state;
  const speeds = [1, 5, 20, 100];
  const hh = String(Math.floor(simTime / 3600)).padStart(2, "0");
  const mm = String(Math.floor((simTime % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(simTime % 60)).padStart(2, "0");
  const [aisDraft, setAisDraft] = useState("");

  const aisStatusColor = aisStatus === "ok" ? COLORS.ais :
                         aisStatus === "fetching" ? COLORS.amber :
                         aisStatus === "error" ? COLORS.hostile : COLORS.textDim;

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
        <span style={{ fontSize: 11, marginLeft: 8, color: COLORS.textDim }}>// ISR.CMD.v0.3</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: COLORS.phosphorDim }}>
          <Activity size={12} />
          <span>T+{hh}:{mm}:{ss}</span>
        </div>

        {/* AISHub connect */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {aisUsername
            ? <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 9, color: aisStatusColor }}>
                  AIS {aisStatus.toUpperCase()}
                </span>
                <span style={{ fontSize: 9, color: COLORS.textDim }}>
                  ({state.aisShips.length})
                </span>
                <button onClick={onRefreshAIS}
                  style={{ fontSize: 9, padding: "0 4px", border: `1px solid ${COLORS.border}`,
                           color: COLORS.aisDim, background: "transparent", cursor: "pointer" }}>↺</button>
                <button onClick={() => { setAisUsername(""); setAisDraft(""); }}
                  style={{ fontSize: 9, padding: "0 4px", border: `1px solid ${COLORS.border}`,
                           color: COLORS.textDim, background: "transparent", cursor: "pointer" }}>✕</button>
              </div>
            : <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 9, color: COLORS.textDim }}>AISHub:</span>
                <input
                  type="text" placeholder="username"
                  value={aisDraft} onChange={(e) => setAisDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && aisDraft && setAisUsername(aisDraft)}
                  style={{ fontSize: 9, padding: "0 6px", height: 20, width: 90,
                           border: `1px solid ${COLORS.border}`, background: COLORS.bg,
                           color: COLORS.ais, outline: "none", fontFamily: "inherit" }}
                />
                <button onClick={() => aisDraft && setAisUsername(aisDraft)}
                  style={{ fontSize: 9, padding: "0 6px", height: 20, fontWeight: 700,
                           border: `1px solid ${COLORS.ais}`, color: COLORS.ais,
                           background: "transparent", cursor: "pointer", fontFamily: "inherit" }}>
                  CONNECT
                </button>
              </div>
          }
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
  const [cam, setCam] = useState({ x: 0, y: 0, zoom: 0.55 });
  const [aisUsername, setAisUsername] = useState("");
  const [aisStatus, setAisStatus] = useState("disconnected"); // disconnected | fetching | ok | error
  const aisUsernameRef = useRef(aisUsername);
  aisUsernameRef.current = aisUsername;

  useEffect(() => {
    if (state.paused) return;
    const id = setInterval(() => dispatch({ type: "TICK" }), CONFIG.TICK_MS);
    return () => clearInterval(id);
  }, [state.paused]);

  // AIS fetch — polls AISHub every 60s while username is set
  const fetchAIS = useCallback(async (username) => {
    if (!username) return;
    setAisStatus("fetching");
    // Centre the fetch box on current ISR-1 position (world → geo)
    const usv = state.units.find((u) => u.type === "USV");
    const centre = usv ? worldToGeo(usv.x, usv.y) : { lat: 37, lon: 126 };
    const pad = CONFIG.AIS_RANGE_DEG;
    const latMin = (centre.lat - pad).toFixed(2);
    const latMax = (centre.lat + pad).toFixed(2);
    const lonMin = (centre.lon - pad).toFixed(2);
    const lonMax = (centre.lon + pad).toFixed(2);
    const aisUrl = `https://data.aishub.net/ws.php?username=${username}&format=1&output=json&compress=0&latmin=${latMin}&latmax=${latMax}&lonmin=${lonMin}&lonmax=${lonMax}`;
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(aisUrl)}`;
    try {
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      // AISHub format=1 → [ {header}, [ {ship}, … ] ]
      const shipArr = Array.isArray(raw) && raw.length >= 2 && Array.isArray(raw[1])
        ? raw[1]
        : Array.isArray(raw) ? raw : [];
      const ships = shipArr
        .filter((s) => s.MMSI && s.LATITUDE && s.LONGITUDE)
        .map((s) => {
          const wp = geoToWorld(parseFloat(s.LATITUDE), parseFloat(s.LONGITUDE));
          return {
            mmsi:    String(s.MMSI),
            name:    (s.NAME || "").trim() || `MMSI-${s.MMSI}`,
            lat:     parseFloat(s.LATITUDE),
            lon:     parseFloat(s.LONGITUDE),
            wx:      wp.x,
            wy:      wp.y,
            cog:     parseFloat(s.COG) || 0,
            sog:     parseFloat(s.SOG) || 0,
            heading: parseFloat(s.HEADING) || parseFloat(s.COG) || 0,
            type:    decodeAISType(s.TYPE),
            flag:    s.FLAG || "—",
            dest:    (s.DEST || "—").trim(),
            imo:     s.IMO ? String(s.IMO) : null,
          };
        });
      dispatch({ type: "SET_AIS_SHIPS", ships });
      setAisStatus("ok");
    } catch (err) {
      console.warn("AIS fetch failed:", err.message);
      setAisStatus("error");
    }
  }, [state.units]);

  useEffect(() => {
    if (!aisUsername) { setAisStatus("disconnected"); return; }
    fetchAIS(aisUsername);
    const id = setInterval(() => fetchAIS(aisUsernameRef.current), CONFIG.AIS_FETCH_MS);
    return () => clearInterval(id);
  }, [aisUsername]);

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
      <TopBar state={state} dispatch={dispatch}
              aisUsername={aisUsername} setAisUsername={setAisUsername}
              aisStatus={aisStatus} onRefreshAIS={() => fetchAIS(aisUsername)} />

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