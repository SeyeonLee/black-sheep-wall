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
      engageTargetId: null },
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
    jamZones: [],         // Phase 2
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

    // Phase 2.1: TRACK contact (right-click on detected non-friendly)
    if (u.engageTargetId) {
      const tgt = units.find((x) => x.id === u.engageTargetId);
      if (!tgt) {
        next.engageTargetId = null;
        next.state = "idle";
      } else {
        const dx = tgt.x - u.x, dy = tgt.y - u.y;
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
          engageTargetId: null, state: "idle" }
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
      let units = state.units.map((u) => tickUnit(u, state.units, state.jamZones, dt));
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
      className="select-none w-full h-full"
      style={{
        background: COLORS.ocean1,
        cursor: tool === "patrol" ? "crosshair" : tool === "deploy" ? "copy" : "default",
        display: "block",
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
              <stop offset="70%" stopColor="black" />
              <stop offset="100%" stopColor="white" />
            </radialGradient>
          ))}
          {state.fogReveal.map((r, i) => (
            <circle key={i} cx={r.x} cy={r.y} r={r.r} fill={`url(#reveal-${i})`} />
          ))}
        </mask>
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
      <g opacity="0.25">{sensorCircles.filter((s) => s.sonar > 0).map((s) => (
        <circle key={`son-${s.id}`} cx={s.x} cy={s.y} r={s.sonar}
          fill="none" stroke={COLORS.subsurface} strokeWidth="0.6" strokeDasharray="1 3" />
      ))}</g>

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

      <rect x="0" y="0" width={CONFIG.WORLD_W} height={CONFIG.WORLD_H}
        fill="rgba(2,8,5,0.78)" mask="url(#fog-mask)" pointerEvents="none" />
    </svg>
  );
};

// ─── TOP BAR ─────────────────────────────────────────────────────────────────
const TopBar = ({ state, dispatch }) => {
  const { paused, simSpeed, simTime } = state;
  const speeds = [1, 5, 20, 100];
  const hh = String(Math.floor(simTime / 3600)).padStart(2, "0");
  const mm = String(Math.floor((simTime % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(simTime % 60)).padStart(2, "0");

  return (
    <div className="flex items-center justify-between px-4 h-11 border-b shrink-0"
         style={{ background: COLORS.surface, borderColor: COLORS.border, color: COLORS.text }}>
      <div className="flex items-center gap-2">
        <Hexagon size={16} style={{ color: COLORS.phosphor }} className="fill-current" />
        <span className="font-bold tracking-[0.2em] text-sm" style={{ fontFamily: "'Chakra Petch', monospace" }}>
          BLACK SHEEP WALL
        </span>
        <span className="text-xs ml-2" style={{ color: COLORS.textDim }}>// ISR.CMD.v0.3</span>
      </div>

      <div className="flex items-center gap-4 font-mono text-xs">
        <div className="flex items-center gap-2" style={{ color: COLORS.phosphorDim }}>
          <Activity size={12} />
          <span>MISSION TIME</span>
          <span style={{ color: COLORS.phosphor }} className="tabular-nums">T+{hh}:{mm}:{ss}</span>
        </div>

        <button onClick={() => dispatch({ type: "TOGGLE_PAUSE" })}
          className="flex items-center gap-1.5 px-2.5 py-1 border transition-colors"
          style={{
            borderColor: paused ? COLORS.amber : COLORS.border,
            background: paused ? "rgba(255,184,74,0.1)" : "transparent",
            color: paused ? COLORS.amber : COLORS.text,
          }}>
          {paused ? <Play size={12} /> : <Pause size={12} />}
          <span>{paused ? "RESUME" : "PAUSE"}</span>
        </button>

        <div className="flex items-center border" style={{ borderColor: COLORS.border }}>
          {speeds.map((s) => (
            <button key={s} onClick={() => dispatch({ type: "SET_SPEED", speed: s })}
              className="px-2.5 py-1 transition-colors tabular-nums"
              style={{
                background: simSpeed === s ? COLORS.phosphor : "transparent",
                color: simSpeed === s ? COLORS.bg : COLORS.text,
                fontWeight: simSpeed === s ? 700 : 400,
              }}>{s}×</button>
          ))}
        </div>
      </div>

      <div className="flex items-center gap-2 text-xs font-mono" style={{ color: COLORS.phosphorDim }}>
        <Power size={12} style={{ color: COLORS.phosphor }} />
        <span>LINK NOMINAL</span>
      </div>
    </div>
  );
};

// ─── DOCK PANEL FRAME ────────────────────────────────────────────────────────
const DockPanel = ({ title, icon, width, children, accent = COLORS.phosphorDim, flex }) => (
  <div className="flex flex-col border-r shrink-0 overflow-hidden"
       style={{
         width: flex ? undefined : width,
         flex: flex ? "1 1 0" : undefined,
         borderColor: COLORS.border, background: COLORS.surface,
       }}>
    <div className="flex items-center gap-1.5 px-3 h-7 border-b shrink-0"
         style={{ borderColor: COLORS.border, background: COLORS.bg }}>
      {icon}
      <span className="text-[10px] tracking-[0.25em] font-bold" style={{ color: accent }}>
        {title}
      </span>
    </div>
    <div className="flex-1 overflow-hidden">{children}</div>
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
    <div className="p-2 h-full flex items-center justify-center">
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
  <div className="flex justify-between border-b border-dashed pb-0.5" style={{ borderColor: COLORS.border }}>
    <span style={{ color: COLORS.textDim }}>{k}</span>
    <span style={{ color: vColor }}>{v}</span>
  </div>
);

const BatteryBar = ({ value }) => {
  const color = value > 60 ? COLORS.phosphor : value > 30 ? COLORS.amber : COLORS.hostile;
  return (
    <div className="flex items-center gap-1">
      <div className="w-9 h-1 border" style={{ borderColor: COLORS.border, background: COLORS.bg }}>
        <div style={{ width: `${value}%`, height: "100%", background: color }} />
      </div>
      <span className="text-[9px] tabular-nums" style={{ color, minWidth: "26px" }}>
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
    <div className="h-full flex flex-col text-xs font-mono">
      <div className="p-2 border-b" style={{ borderColor: COLORS.border }}>
        <div className="text-[9px] tracking-widest mb-1.5" style={{ color: COLORS.textDim }}>
          FORCE.ROSTER
        </div>
        <div className="space-y-1 max-h-24 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
          {friendly.map((u) => {
            const isSel = state.selectedIds.includes(u.id);
            return (
              <button key={u.id} onClick={() => onRosterClick(u)}
                className="w-full text-left px-2 py-1 border flex items-center justify-between transition-colors"
                style={{
                  borderColor: isSel ? COLORS.phosphor : COLORS.border,
                  background: isSel ? "rgba(184,255,94,0.06)" : "transparent",
                }}>
                <div className="flex items-center gap-1.5 min-w-0">
                  {u.type === "USV" && <Anchor size={10} style={{ color: COLORS.phosphor, flexShrink: 0 }} />}
                  {u.type === "UAV" && <Plane size={10} style={{ color: COLORS.phosphor, flexShrink: 0 }} />}
                  <span style={{ color: isSel ? COLORS.phosphor : COLORS.text }}>{u.label}</span>
                  <span className="text-[9px] truncate" style={{ color: COLORS.textDim }}>
                    {u.state.toUpperCase()}
                  </span>
                </div>
                <BatteryBar value={u.battery} />
              </button>
            );
          })}
        </div>
      </div>

      <div className="p-2 flex-1 overflow-y-auto" style={{ scrollbarWidth: "thin" }}>
        <div className="text-[9px] tracking-widest mb-1.5" style={{ color: COLORS.textDim }}>SELECTED</div>
        {usvSel ? (
          <div className="space-y-1 text-[10px]" style={{ color: COLORS.text }}>
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
          <div style={{ color: COLORS.textDim }} className="text-[10px]">
            // No unit selected.<br />
            // Click roster or drag-box on map.
          </div>
        )}
      </div>

      <div className="px-2 py-1 border-t flex justify-between text-[9px]"
           style={{ borderColor: COLORS.border, background: COLORS.bg, color: COLORS.textDim }}>
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
// States: no-key → drop-zone → analyzing → results
// GPT-4o Vision extracts vessel characteristics → compared against nearest AIS contact.
const VisualIntelPanel = ({ state, dispatch }) => {
  const [apiKey, setApiKey]       = useState("");
  const [keyDraft, setKeyDraft]   = useState("");
  const [imageDataUrl, setImageDataUrl] = useState(null);
  const [imageBase64, setImageBase64]   = useState(null);
  const [imageMime, setImageMime] = useState("image/jpeg");
  const [analyzing, setAnalyzing] = useState(false);
  const [extraction, setExtraction]   = useState(null);
  const [comparison, setComparison]   = useState(null);
  const [aisTarget, setAisTarget]     = useState(null);
  const [error, setError]         = useState(null);
  const [isDragOver, setIsDragOver]   = useState(false);
  const fileInputRef = useRef(null);

  const activeUAV  = state.units.find((u) => u.type === "UAV" && u.state === "orbiting");
  const jammedUAV  = state.units.find((u) => u.type === "UAV" && u.state === "jammed");

  // Find nearest confirmed commercial vessel to the orbiting UAV
  const findTarget = () => {
    const ref = activeUAV;
    if (!ref) return null;
    const pool = state.units.filter(
      (u) => u.type === "COMMERCIAL" &&
             (state.detections[u.id]?.confidence || 0) > CONFIG.CONFIRMED_THRESHOLD
    );
    if (!pool.length) return null;
    return pool.reduce((best, u) => dist(ref, u) < dist(ref, best) ? u : best);
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
      setAisTarget(findTarget());
    };
    reader.readAsDataURL(file);
  };

  const compareWithAIS = (ex, unit) => {
    if (!unit) return { match: true, diffs: [] };
    const n = (s) => (s || "").toUpperCase().trim();
    const diffs = [];
    const cvType = n(ex.vesselType), aisType = n(unit.vesselType);
    if (cvType && cvType !== "UNKNOWN" && aisType && cvType !== aisType)
      diffs.push({ field: "TYPE", cv: cvType, ais: aisType });
    if (cvType === "MILITARY" && aisType !== "MILITARY")
      diffs.push({ field: "CLASS", cv: "MILITARY ASSET", ais: "CIVILIAN AIS" });
    const cvFlag = n(ex.flagVisible), aisFlag = n(unit.flag);
    if (cvFlag && cvFlag !== "NONE" && aisFlag && cvFlag.slice(0, 3) !== aisFlag.slice(0, 3))
      diffs.push({ field: "FLAG", cv: cvFlag, ais: aisFlag });
    return { match: diffs.length === 0, diffs };
  };

  const runAnalysis = async () => {
    if (!imageBase64 || !apiKey) return;
    const target = findTarget();
    setAisTarget(target);
    setAnalyzing(true); setError(null);

    const prompt = `You are a maritime ISR analyst. Identify vessel characteristics from this aerial image.
Respond ONLY with a valid JSON object — no markdown, no preamble, no explanation:
{
  "vesselType": "TANKER|CARGO|BULK|CONTAINER|MILITARY|FISHING|FERRY|TUGBOAT|UNKNOWN",
  "estimatedLengthM": <integer or null>,
  "hullColor": "<primary color>",
  "superstructure": "<one sentence>",
  "flagVisible": "<country name or NONE>",
  "visibleIdentifiers": "<hull numbers, name, markings, or NONE>",
  "confidence": <0-100>,
  "notes": "<anomalies or observations, max 80 chars>"
}`;

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 400,
          messages: [{
            role: "user",
            content: [
              {
                type: "image_url",
                image_url: { url: `data:${imageMime};base64,${imageBase64}`, detail: "low" },
              },
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
      const raw  = data.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
      const ex   = JSON.parse(raw);
      setExtraction(ex);

      const comp = compareWithAIS(ex, target);
      setComparison(comp);

      if (!comp.match && target) {
        dispatch({
          type: "ADD_ALERT",
          kind: "AIS.MISMATCH",
          severity: "high",
          title: `AIS MISMATCH — ${target.label}`,
          body: `CV: ${ex.vesselType} | AIS: ${target.vesselType}. ${comp.diffs.length} field${comp.diffs.length > 1 ? "s" : ""} discrepant.`,
        });
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

  // ── STATE: NO KEY ───────────────────────────────────────────────────────────
  if (!apiKey) {
    return (
      <div className="h-full flex flex-col justify-center gap-2 p-3">
        <div className="text-[9px] tracking-widest mb-1" style={{ color: COLORS.phosphorDim }}>
          OPENAI API KEY REQUIRED
        </div>
        <input
          type="password" placeholder="sk-..."
          value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && keyDraft.startsWith("sk-") && setApiKey(keyDraft)}
          className="w-full px-2 py-1.5 text-[10px] font-mono border"
          style={{
            background: COLORS.bg, borderColor: COLORS.borderHi,
            color: COLORS.phosphor, outline: "none",
          }}
        />
        <button
          onClick={() => keyDraft.startsWith("sk-") && setApiKey(keyDraft)}
          disabled={!keyDraft.startsWith("sk-")}
          className="w-full py-1.5 text-[10px] font-mono font-bold tracking-widest border"
          style={{
            borderColor: keyDraft.startsWith("sk-") ? COLORS.phosphor : COLORS.border,
            background: keyDraft.startsWith("sk-") ? COLORS.phosphor : "transparent",
            color: keyDraft.startsWith("sk-") ? COLORS.bg : COLORS.textDim,
          }}
        >
          CONNECT GPT-4o
        </button>
        <div className="text-[8px] font-mono leading-tight" style={{ color: COLORS.textDim }}>
          // Lives in browser memory only.<br />
          // Sent only to api.openai.com.
        </div>
      </div>
    );
  }

  // ── STATE: ANALYZING ────────────────────────────────────────────────────────
  if (analyzing) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-3 p-3">
        <div className="text-[9px] font-mono tracking-widest animate-pulse"
             style={{ color: COLORS.amber }}>
          ▶ GPT-4o ANALYZING...
        </div>
        <div className="w-full h-1 border overflow-hidden" style={{ borderColor: COLORS.border }}>
          <div style={{
            height: "100%", background: COLORS.phosphor,
            animation: "cvprogress 1.8s ease-in-out infinite",
          }} />
        </div>
        {imageDataUrl && (
          <img src={imageDataUrl} alt="feed" className="w-full object-cover border"
               style={{ maxHeight: 80, borderColor: COLORS.border,
                        opacity: 0.7, filter: "grayscale(40%) brightness(0.8)" }} />
        )}
        <div className="text-[8px] font-mono" style={{ color: COLORS.textDim }}>
          model: gpt-4o · detail: low
        </div>
        <style>{`
          @keyframes cvprogress {
            0%   { width: 0%;   margin-left: 0% }
            50%  { width: 50%;  margin-left: 25% }
            100% { width: 0%;   margin-left: 100% }
          }
        `}</style>
      </div>
    );
  }

  // ── STATE: RESULTS ──────────────────────────────────────────────────────────
  if (extraction) {
    const isMatch = comparison?.match ?? true;
    const diffs   = comparison?.diffs ?? [];

    const rowBg = (field) =>
      diffs.some((d) => d.field === field)
        ? `${COLORS.hostile}18`
        : "transparent";

    const rows = [
      { f: "TYPE", cv: extraction.vesselType,
        ais: aisTarget?.vesselType || "—" },
      { f: "FLAG", cv: extraction.flagVisible || "—",
        ais: aisTarget?.flag || "—" },
      { f: "LEN",  cv: extraction.estimatedLengthM ? `~${extraction.estimatedLengthM}m` : "—",
        ais: "—" },
      { f: "HULL", cv: extraction.hullColor || "—",
        ais: "—" },
      { f: "ID",   cv: extraction.visibleIdentifiers || "—",
        ais: aisTarget?.mmsi?.slice(0,7) + "…" || "—" },
    ];

    return (
      <div className="h-full flex flex-col gap-1.5 p-2 overflow-y-auto"
           style={{ scrollbarWidth: "thin" }}>

        {/* Thumbnail + confidence */}
        <div className="flex gap-2 items-start">
          {imageDataUrl && (
            <img src={imageDataUrl} alt="target" className="object-cover border flex-shrink-0"
                 style={{ width: 64, height: 48, borderColor: isMatch ? COLORS.border : COLORS.hostile }} />
          )}
          <div className="flex-1 text-[8.5px] font-mono" style={{ color: COLORS.textDim }}>
            <div style={{ color: COLORS.phosphor }}>GPT-4o EXTRACT</div>
            <div>CONF: <span style={{ color: COLORS.amber }}>{extraction.confidence}%</span></div>
            {aisTarget && (
              <div style={{ color: COLORS.amberDim }}>
                AIS: {aisTarget.label}
              </div>
            )}
          </div>
        </div>

        {/* Comparison table */}
        <div style={{ fontSize: "8.5px", fontFamily: "'JetBrains Mono', monospace" }}>
          <div className="grid grid-cols-3 border-b pb-0.5 mb-0.5"
               style={{ borderColor: COLORS.border }}>
            <span style={{ color: COLORS.textDim }}>FIELD</span>
            <span style={{ color: COLORS.neutral }}>CV</span>
            <span style={{ color: COLORS.amber }}>AIS</span>
          </div>
          {rows.map(({ f, cv, ais }) => {
            const mismatch = diffs.some((d) => d.field === f);
            const trunc = (s) => s?.length > 9 ? s.slice(0, 9) + "…" : (s || "—");
            return (
              <div key={f} className="grid grid-cols-3 py-0.5"
                   style={{ background: rowBg(f) }}>
                <span style={{ color: COLORS.textDim }}>{f}</span>
                <span style={{ color: mismatch ? COLORS.hostile : COLORS.neutral }}>
                  {trunc(cv)}
                </span>
                <span style={{ color: mismatch ? COLORS.hostile : COLORS.amber }}>
                  {trunc(ais)}
                </span>
              </div>
            );
          })}
        </div>

        {/* Notes */}
        {extraction.notes && extraction.notes !== "None" && (
          <div className="text-[7.5px] font-mono px-1 py-0.5 border"
               style={{ borderColor: COLORS.border, color: COLORS.textDim }}>
            {extraction.notes.length > 70
              ? extraction.notes.slice(0, 70) + "…"
              : extraction.notes}
          </div>
        )}

        {/* Verdict banner */}
        <div className="border px-2 py-1.5 text-[9px] font-mono font-bold"
             style={{
               borderColor: isMatch ? COLORS.phosphor : COLORS.hostile,
               background: isMatch ? `${COLORS.phosphor}0d` : `${COLORS.hostile}0d`,
               color: isMatch ? COLORS.phosphor : COLORS.hostile,
               letterSpacing: "0.1em",
             }}>
          {isMatch
            ? "✓ AIS CONSISTENT"
            : `⚠ MISMATCH · ${diffs.length} FIELD${diffs.length > 1 ? "S" : ""}`}
        </div>

        {/* Error */}
        {error && (
          <div className="text-[8px] font-mono p-1 border"
               style={{ borderColor: COLORS.hostile, color: COLORS.hostile }}>
            ERR: {error.slice(0, 55)}
          </div>
        )}

        {/* Actions */}
        <div className="flex gap-1">
          <button onClick={reset}
            className="flex-1 py-1 border text-[9px] font-mono"
            style={{ borderColor: COLORS.border, color: COLORS.textDim }}>
            NEW IMG
          </button>
          <button onClick={runAnalysis}
            className="flex-1 py-1 border text-[9px] font-mono font-bold"
            style={{ borderColor: COLORS.phosphor, color: COLORS.phosphor }}>
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

  // ── STATE: DROP ZONE (key set, no results) ──────────────────────────────────
  const curTarget = findTarget();
  return (
    <div className="h-full flex flex-col gap-2 p-2">
      {/* Status row */}
      <div className="flex items-center justify-between text-[9px] font-mono">
        <div className="flex items-center gap-1.5" style={{ color: COLORS.phosphorDim }}>
          <Camera size={9} />
          {activeUAV
            ? <><span>UAV-{activeUAV.label}</span>
                <span className="flex items-center gap-0.5" style={{ color: COLORS.hostile }}>
                  <span className="w-1 h-1 rounded-full animate-pulse inline-block"
                        style={{ background: COLORS.hostile }} />
                  LIVE
                </span></>
            : jammedUAV
              ? <span style={{ color: COLORS.amber }}>JAMMED</span>
              : <span style={{ color: COLORS.textDim }}>NO UAV FEED</span>
          }
        </div>
        <button onClick={() => { setApiKey(""); setKeyDraft(""); }}
          className="text-[8px] font-mono"
          style={{ color: COLORS.phosphorDim }}>
          GPT-4o ✓
        </button>
      </div>

      {/* AIS target info */}
      <div className="border px-2 py-1 text-[8px] font-mono"
           style={{
             borderColor: curTarget ? COLORS.amber : COLORS.border,
             background: curTarget ? `${COLORS.amber}08` : "transparent",
           }}>
        {curTarget
          ? <>
              <span style={{ color: COLORS.amberDim }}>AIS TARGET · </span>
              <span style={{ color: COLORS.amber }}>{curTarget.label}</span>
              <span style={{ color: COLORS.textDim }}> · {curTarget.vesselType} · {curTarget.flag}</span>
            </>
          : <span style={{ color: COLORS.textDim }}>// No confirmed AIS contact in sensor range.</span>
        }
      </div>

      {/* Drop zone */}
      <div
        className="flex-1 flex flex-col items-center justify-center border cursor-pointer"
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
          ? <img src={imageDataUrl} alt="target"
                 className="w-full h-full object-cover"
                 style={{ opacity: 0.9 }} />
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

      {/* Analyze button — only shown once image is loaded */}
      {imageDataUrl && (
        <button onClick={runAnalysis}
          className="w-full py-1.5 border text-[10px] font-mono font-bold tracking-widest"
          style={{
            borderColor: COLORS.phosphor,
            background: COLORS.phosphor,
            color: COLORS.bg,
          }}>
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
    className="px-1.5 py-2 border transition-colors flex flex-col items-center gap-1"
    style={{
      borderColor: active ? COLORS.phosphor : COLORS.border,
      background: active ? "rgba(184,255,94,0.08)" : "transparent",
      color: disabled ? COLORS.textDim : (active ? COLORS.phosphor : COLORS.text),
      opacity: disabled ? 0.4 : 1, cursor: disabled ? "not-allowed" : "pointer",
    }}>
    {icon}
    <span className="text-[9px] font-mono tracking-wider font-bold">{label}</span>
  </button>
);

const DeployButton = ({ label, color, active, onClick }) => (
  <button onClick={onClick}
    className="px-1.5 py-1.5 border text-[9px] font-mono font-bold tracking-wider"
    style={{
      borderColor: active ? color : COLORS.border,
      color: color,
      background: active ? `${color}14` : "transparent",
    }}>{label}</button>
);

const CommandPanel = ({ state, dispatch, tool, setTool, deployType, setDeployType }) => {
  const hasSelection = state.selectedIds.length > 0;
  const setDeploy = (t) => { setTool("deploy"); setDeployType(t); };

  return (
    <div className="h-full flex">
      <div className="p-2 flex flex-col gap-1.5"
           style={{ width: 320, borderRight: `1px solid ${COLORS.border}` }}>
        <div className="text-[9px] tracking-widest" style={{ color: COLORS.textDim }}>
          ORDERS {!hasSelection && <span style={{ color: COLORS.amberDim }}>// no selection</span>}
        </div>
        <div className="grid grid-cols-3 gap-1">
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

        <div className="mt-1 text-[9px] tracking-widest" style={{ color: COLORS.textDim }}>
          DEPLOY <span style={{ color: COLORS.amberDim }}>// sandbox</span>
        </div>
        <div className="grid grid-cols-3 gap-1">
          <DeployButton label="+ ISR" color={COLORS.phosphor}
            active={tool === "deploy" && deployType === "ISR"}
            onClick={() => setDeploy("ISR")} />
          <DeployButton label="+ MERCHANT" color={COLORS.neutral}
            active={tool === "deploy" && deployType === "COMMERCIAL"}
            onClick={() => setDeploy("COMMERCIAL")} />
          <DeployButton label="+ HOSTILE" color={COLORS.hostile}
            active={tool === "deploy" && deployType === "ENEMY"}
            onClick={() => setDeploy("ENEMY")} />
          <DeployButton label="+ SUB" color={COLORS.subsurface}
            active={tool === "deploy" && deployType === "SUBMARINE"}
            onClick={() => setDeploy("SUBMARINE")} />
          <DeployButton label="+ MINE" color={COLORS.subsurface}
            active={tool === "deploy" && deployType === "MINE"}
            onClick={() => setDeploy("MINE")} />
          <DeployButton label="+ JAM" color={COLORS.amber}
            active={tool === "deploy" && deployType === "JAM"}
            onClick={() => setDeploy("JAM")} />
        </div>

        <div className="mt-auto text-[9px] font-mono leading-snug" style={{ color: COLORS.textDim }}>
          {tool === "patrol" ? (
            <>
              <span style={{ color: COLORS.phosphor }}>{">"}</span> Click vertices · R-click to close
            </>
          ) : tool === "deploy" ? (
            <>
              <span style={{ color: COLORS.amber }}>{">"}</span> Click map to place {deployType.toLowerCase()}
              {deployType === "JAM" && <><br /><span style={{ color: COLORS.amber }}>{">"}</span> Shift+click zone to remove</>}
            </>
          ) : (
            <>
              <span style={{ color: COLORS.phosphor }}>{">"}</span> R-click water: move<br />
              <span style={{ color: COLORS.phosphor }}>{">"}</span> R-click contact: TRACK<br />
              <span style={{ color: COLORS.phosphor }}>{">"}</span> Drag: box-select · Edge: pan
            </>
          )}
        </div>
      </div>

      <div className="flex-1 flex flex-col">
        <div className="px-2 pt-2 pb-1 text-[9px] tracking-widest" style={{ color: COLORS.amberDim }}>
          ALERT.FEED
        </div>
        <div className="flex-1 overflow-y-auto px-2 space-y-1 pb-2" style={{ scrollbarWidth: "thin" }}>
          {state.alerts.length === 0 && (
            <div className="text-[10px] font-mono px-1" style={{ color: COLORS.textDim }}>
              // No active alerts. Sensors nominal.
            </div>
          )}
          {state.alerts.map((a) => {
            const sevColor = a.severity === "high" ? COLORS.hostile :
                             a.severity === "med" ? COLORS.amber : COLORS.phosphor;
            return (
              <div key={a.id} className="border p-1.5 cursor-pointer"
                style={{ borderColor: sevColor, background: `${sevColor}0d` }}
                onClick={() => dispatch({ type: "DISMISS_ALERT", id: a.id })}>
                <div className="flex items-center gap-1 text-[9px] font-mono" style={{ color: sevColor }}>
                  <AlertTriangle size={9} />
                  <span className="font-bold tracking-wider">{a.kind}</span>
                  <span className="ml-auto" style={{ color: COLORS.textDim }}>
                    T+{Math.floor(a.time)}s
                  </span>
                </div>
                <div className="text-[10px] font-mono mt-0.5" style={{ color: COLORS.text }}>
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
    <div className="h-6 flex items-center justify-between px-3 border-t font-mono text-[10px] shrink-0"
         style={{ background: COLORS.bg, borderColor: COLORS.border, color: COLORS.textDim }}>
      <div className="flex items-center gap-3">
        <span>CRSR: <span style={{ color: COLORS.phosphor }} className="tabular-nums">
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
  <div className="pointer-events-none absolute inset-0"
    style={{
      backgroundImage: `repeating-linear-gradient(
        0deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px,
        transparent 1px, transparent 3px
      )`,
      mixBlendMode: "multiply", zIndex: 100,
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

  useEffect(() => {
    if (state.paused) return;
    const id = setInterval(() => dispatch({ type: "TICK" }), CONFIG.TICK_MS);
    return () => clearInterval(id);
  }, [state.paused]);

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
    <div className="relative h-screen w-screen flex flex-col overflow-hidden"
      style={{ background: COLORS.bg, color: COLORS.text,
               fontFamily: "'JetBrains Mono', 'Courier New', monospace" }}>
      <TopBar state={state} dispatch={dispatch} />

      <div className="flex-1 flex relative overflow-hidden">
        <MapView state={state} dispatch={dispatch}
          tool={tool} setTool={setTool} deployType={deployType}
          setHover={setHover} setCursorWorld={setCursorWorld}
          cam={cam} setCam={setCam} />
      </div>

      <div className="flex shrink-0 border-t" style={{ height: 224, borderColor: COLORS.border }}>
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
