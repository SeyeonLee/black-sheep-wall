import { CONFIG } from "../config";
import { tickUnit, applyUAVRotation, updateDetections, generateAlerts } from "./tick";
import { polygonSweepPath, placeVoronoiSeeds, voronoiSubPolygons } from "./geometry";
import { newId, createEnemyVessel, createCommercialVessel, createSubmarine, createMine, createISRUnit, createJamZone } from "./factories";
import { isOnLand } from "./landData";

// ─── Re-partition a patrol area for a (smaller) set of remaining unit IDs ──────
const repartitionPatrol = (pa, remainingIds) => {
  let assignments;
  if (remainingIds.length === 1) {
    const path = polygonSweepPath(pa.polygon);
    assignments = [{ usvId: remainingIds[0], path, region: pa.polygon }];
  } else {
    const seeds = placeVoronoiSeeds(pa.polygon, remainingIds.length);
    const regions = voronoiSubPolygons(pa.polygon, seeds);
    assignments = remainingIds.map((uid, i) => ({
      usvId: uid,
      path: polygonSweepPath(regions[i]?.length >= 3 ? regions[i] : pa.polygon),
      region: regions[i]?.length >= 3 ? regions[i] : pa.polygon,
    }));
  }
  return { ...pa, unitIds: remainingIds, assignments };
};

// ─── Clear orders for specific USVs; remaining patrol-mates get re-partitioned ─
export const clearOrdersForUSVs = (state, usvIds) => {
  // Reset departing USVs to idle
  let units = state.units.map((u) =>
    usvIds.includes(u.id)
      ? { ...u, goal: null, patrolPath: null, patrolIdx: 0,
          engageTargetId: null, aisEngageMMSI: null, state: "idle" }
      : u
  );

  const patrolAreas = [];

  for (const pa of state.patrolAreas) {
    const leavingFromThis = pa.unitIds.filter((id) => usvIds.includes(id));
    if (leavingFromThis.length === 0) {
      // Not affected — keep as-is
      patrolAreas.push(pa);
      continue;
    }
    const remainingIds = pa.unitIds.filter((id) => !usvIds.includes(id));
    if (remainingIds.length === 0) {
      // All units leaving — discard patrol area
      continue;
    }
    // Re-partition for the remaining units
    const updated = repartitionPatrol(pa, remainingIds);
    patrolAreas.push(updated);
    // Give each remaining unit its new sub-region sweep
    updated.assignments.forEach(({ usvId, path }) => {
      units = units.map((u) =>
        u.id === usvId
          ? { ...u, patrolPath: path, patrolIdx: 0, state: "patrolling", goal: null }
          : u
      );
    });
  }

  return { units, patrolAreas };
};

export const reducer = (state, action) => {
  switch (action.type) {

    // ─────────────────────────────────────────────────────────────────────────
    case "TICK": {
      const dt = state.simSpeed;
      let patrolAreas = state.patrolAreas;
      const mineMarkers = [...state.mineMarkers];

      // AIS-engage: keep USVs pointed at their live AIS ship
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

      // ── #1 Mine markers: stamp location on first POSSIBLE detection ─────────
      units.filter((u) => u.type === "MINE").forEach((mine) => {
        const prevConf = state.detections[mine.id]?.confidence ?? 0;
        const newConf  = detections[mine.id]?.confidence ?? 0;
        if (prevConf < CONFIG.POSSIBLE_THRESHOLD && newConf >= CONFIG.POSSIBLE_THRESHOLD) {
          if (!mineMarkers.find((m) => m.mineId === mine.id)) {
            mineMarkers.push({
              id: newId("mkr"),
              x: mine.x, y: mine.y,
              label: mine.label,
              mineId: mine.id,
            });
          }
        }
      });

      // ── #2 Auto-track newly detected submarines / hostiles (idle USVs) ────────
      const prevDetFn = (id) => state.detections[id]?.confidence ?? 0;
      const curDetFn  = (id) => detections[id]?.confidence ?? 0;

      // Returns true if any friendly unit (USV or UAV) is already tracking this target
      const isAlreadyTracked = (targetId) =>
        units.some((u) => u.faction === "friendly" &&
          (u.engageTargetId === targetId || u.trackTargetId === targetId));

      const newSubContacts = units.filter((u) =>
        u.type === "SUBMARINE" &&
        prevDetFn(u.id) < CONFIG.POSSIBLE_THRESHOLD &&
        curDetFn(u.id) >= CONFIG.POSSIBLE_THRESHOLD
      );
      if (newSubContacts.length > 0) {
        newSubContacts.forEach((sub) => {
          if (isAlreadyTracked(sub.id)) return; // already covered — alert only
          const idleUSVs = units.filter((u) =>
            u.type === "USV" && u.faction === "friendly" &&
            u.state === "idle" && !u.engageTargetId && !u.aisEngageMMSI
          );
          if (idleUSVs.length === 0) return;
          const nearest = idleUSVs.reduce((a, b) =>
            Math.hypot(a.x - sub.x, a.y - sub.y) <
            Math.hypot(b.x - sub.x, b.y - sub.y) ? a : b
          );
          units = units.map((u) =>
            u.id === nearest.id ? { ...u, engageTargetId: sub.id, state: "tracking" } : u
          );
        });
      }

      const newHostileContacts = units.filter((u) =>
        u.type === "ENEMY" && u.faction === "hostile" &&
        prevDetFn(u.id) < CONFIG.POSSIBLE_THRESHOLD &&
        curDetFn(u.id) >= CONFIG.POSSIBLE_THRESHOLD
      );
      if (newHostileContacts.length > 0) {
        newHostileContacts.forEach((hostile) => {
          if (isAlreadyTracked(hostile.id)) return; // already covered — alert only
          const idleUSVs = units.filter((u) =>
            u.type === "USV" && u.faction === "friendly" &&
            u.state === "idle" && !u.engageTargetId && !u.aisEngageMMSI
          );
          if (idleUSVs.length === 0) return;
          const nearest = idleUSVs.reduce((a, b) =>
            Math.hypot(a.x - hostile.x, a.y - hostile.y) <
            Math.hypot(b.x - hostile.x, b.y - hostile.y) ? a : b
          );
          units = units.map((u) =>
            u.id === nearest.id ? { ...u, engageTargetId: hostile.id, state: "tracking" } : u
          );
        });
      }

      // ── #3/#4 Patrol interrupt: patrolling USV spots untracked contact ───────
      // Skip targets already being handled by another unit (don't double-assign)
      const patrolInterruptMap = {};
      for (const u of units) {
        if (u.type !== "USV" || u.faction !== "friendly") continue;
        if (u.state !== "patrolling") continue;
        if (u.engageTargetId) continue; // already tracking

        let bestTarget = null;
        let bestDist   = Infinity;
        for (const t of units) {
          if (t.type !== "ENEMY" && t.type !== "SUBMARINE") continue;
          if (curDetFn(t.id) < CONFIG.POSSIBLE_THRESHOLD) continue;
          if (isAlreadyTracked(t.id)) continue; // already tracked — stay on patrol
          const range = t.type === "SUBMARINE" ? CONFIG.SONAR_RANGE : CONFIG.USV_SENSOR_RANGE;
          const d = Math.hypot(u.x - t.x, u.y - t.y);
          if (d <= range && d < bestDist) {
            bestTarget = t;
            bestDist   = d;
          }
        }
        if (bestTarget) patrolInterruptMap[u.id] = bestTarget.id;
      }

      if (Object.keys(patrolInterruptMap).length > 0) {
        const interruptingIds = Object.keys(patrolInterruptMap);
        // Remove interrupted USVs from their patrol areas and re-partition remainder (#4)
        const cleared = clearOrdersForUSVs({ ...state, units, patrolAreas }, interruptingIds);
        units       = cleared.units;
        patrolAreas = cleared.patrolAreas;
        // Assign each interrupted USV to its spotted target
        interruptingIds.forEach((usvId) => {
          units = units.map((u) =>
            u.id === usvId
              ? { ...u, engageTargetId: patrolInterruptMap[usvId], state: "tracking" }
              : u
          );
        });
      }

      const jamEvents = units
        .filter((u) => u.faction === "friendly" && u.state === "jammed")
        .map((u) => ({ unitId: u.id, unitLabel: u.label, unitType: u.type }));
      const newSimTime = state.simTime + dt * 0.05;
      const alerts = generateAlerts(units, detections, state.alerts, jamEvents, newSimTime);
      const newReveals = units
        .filter((u) => u.faction === "friendly" && u.state !== "docked" && u.state !== "jammed")
        .map((u) => ({ x: u.x, y: u.y, r: CONFIG.FOG_REVEAL_RANGE }));

      return {
        ...state,
        units, detections, alerts,
        fogReveal: newReveals,
        simTime: newSimTime,
        patrolAreas,
        mineMarkers,
      };
    }

    case "TOGGLE_PAUSE": return { ...state, paused: !state.paused };
    case "SET_SPEED":    return { ...state, simSpeed: action.speed };
    case "SELECT":       return { ...state, selectedIds: action.ids };

    case "MOVE_SELECTED": {
      const selectedFriendly = state.units.filter(
        (u) => state.selectedIds.includes(u.id) && u.faction === "friendly"
      );
      const usvIds    = selectedFriendly.filter((u) => u.type === "USV").map((u) => u.id);
      const soloUavIds = selectedFriendly.filter((u) => u.type === "UAV").map((u) => u.id);

      if (usvIds.length > 0) {
        const cleared = clearOrdersForUSVs(state, usvIds);
        const units = cleared.units.map((u) =>
          usvIds.includes(u.id) ? { ...u, goal: action.target, state: "moving" } : u
        );
        return { ...state, units, patrolAreas: cleared.patrolAreas };
      }
      if (soloUavIds.length > 0) {
        const units = state.units.map((u) =>
          soloUavIds.includes(u.id)
            ? { ...u, missionTarget: action.target, state: "flying_to_mission" }
            : u
        );
        return { ...state, units };
      }
      return state;
    }

    case "RECALL_UAV": {
      const units = state.units.map((u) => {
        if (!state.selectedIds.includes(u.id) || u.type !== "UAV") return u;
        if (u.state === "flying_to_mission" || u.state === "mission_orbit") {
          return { ...u, missionTarget: null, trackTargetId: null, state: "returning" };
        }
        return u;
      });
      return { ...state, units };
    }

    case "ENGAGE_TARGET": {
      const usvIds = state.units
        .filter((u) => state.selectedIds.includes(u.id) && u.type === "USV")
        .map((u) => u.id);
      // Airborne UAVs (not docked) can be assigned to orbit a target unit
      const uavIds = state.units
        .filter((u) => state.selectedIds.includes(u.id) && u.type === "UAV" && u.state !== "docked")
        .map((u) => u.id);

      if (usvIds.length === 0 && uavIds.length === 0) return state;

      let result = state;

      if (usvIds.length > 0) {
        const cleared = clearOrdersForUSVs(result, usvIds);
        const units = cleared.units.map((u) =>
          usvIds.includes(u.id)
            ? { ...u, engageTargetId: action.targetId, state: "tracking" }
            : u
        );
        result = { ...result, units, patrolAreas: cleared.patrolAreas };
      }

      if (uavIds.length > 0) {
        const units = result.units.map((u) =>
          uavIds.includes(u.id)
            ? { ...u, trackTargetId: action.targetId, missionTarget: null,
                missionAborted: false, state: "flying_to_mission" }
            : u
        );
        result = { ...result, units };
      }

      return result;
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
      const id = newId("pat");

      let assignments;
      if (usvIds.length === 1) {
        const path = polygonSweepPath(polygon);
        assignments = [{ usvId: usvIds[0], path, region: polygon }];
      } else {
        const seeds   = placeVoronoiSeeds(polygon, usvIds.length);
        const regions = voronoiSubPolygons(polygon, seeds);
        assignments = usvIds.map((uid, i) => ({
          usvId: uid,
          path:   polygonSweepPath(regions[i]?.length >= 3 ? regions[i] : polygon),
          region: regions[i]?.length >= 3 ? regions[i] : polygon,
        }));
      }

      const units = cleared.units.map((u) => {
        const a = assignments.find((x) => x.usvId === u.id);
        if (!a) return u;
        return { ...u, patrolPath: a.path, patrolIdx: 0, state: "patrolling", goal: null };
      });

      return {
        ...state, units,
        patrolAreas: [...cleared.patrolAreas, { id, polygon, unitIds: usvIds, assignments }],
      };
    }

    case "SPAWN_ENEMY":
      return { ...state, units: [...state.units, createEnemyVessel(action.x, action.y)] };
    case "SPAWN_COMMERCIAL":
      return { ...state, units: [...state.units, createCommercialVessel(action.x, action.y)] };
    case "SPAWN_SUBMARINE":
      return { ...state, units: [...state.units, createSubmarine(action.x, action.y)] };
    case "SPAWN_MINE":
      if (isOnLand(action.x, action.y)) return state;
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

    // ── #1 Mine marker removal — also deletes the mine unit ───────────────────
    case "REMOVE_MINE_MARKER": {
      const marker = state.mineMarkers.find((m) => m.id === action.id);
      return {
        ...state,
        mineMarkers: state.mineMarkers.filter((m) => m.id !== action.id),
        units: marker ? state.units.filter((u) => u.id !== marker.mineId) : state.units,
      };
    }

    default: return state;
  }
};
