import { CONFIG } from "../config";
import { tickUnit, applyUAVRotation, updateDetections, generateAlerts } from "./tick";
import { polygonSweepPath, placeVoronoiSeeds, voronoiSubPolygons, polygonCentroid } from "../utils";
import { newId, createEnemyVessel, createCommercialVessel, createSubmarine, createMine, createISRUnit, createJamZone } from "./factories";

export const clearOrdersForUSVs = (state, usvIds) => ({
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

export const reducer = (state, action) => {
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
    case "RECALL_UAV": {
      // Cancel independent mission; UAV returns to orbiting its home USV
      const units = state.units.map((u) => {
        if (!state.selectedIds.includes(u.id) || u.type !== "UAV") return u;
        if (u.state === "mission") {
          return { ...u, missionGoal: null, state: "returning", missionAborted: true };
        }
        return u;
      });
      return { ...state, units };
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
