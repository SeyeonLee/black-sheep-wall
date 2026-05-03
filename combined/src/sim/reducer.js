import { CONFIG } from "../config";
import { tickUnit, applyUAVRotation, updateDetections, generateAlerts } from "./tick";
import { polygonSweepPath, placeVoronoiSeeds, voronoiSubPolygons } from "./geometry";
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
      const selectedFriendly = state.units.filter(
        (u) => state.selectedIds.includes(u.id) && u.faction === "friendly"
      );
      const usvIds = selectedFriendly.filter((u) => u.type === "USV").map((u) => u.id);
      const soloUavIds = selectedFriendly.filter((u) => u.type === "UAV").map((u) => u.id);

      if (usvIds.length > 0) {
        // USVs in selection → USVs respond to move; UAVs keep their current orbit/mission
        const cleared = clearOrdersForUSVs(state, usvIds);
        const units = cleared.units.map((u) =>
          usvIds.includes(u.id) ? { ...u, goal: action.target, state: "moving" } : u
        );
        return { ...state, units, patrolAreas: cleared.patrolAreas };
      }
      if (soloUavIds.length > 0) {
        // UAV-only selection → UAVs fly to point and orbit it independently
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
      // Cancel independent mission; UAV returns to orbiting its home USV
      const units = state.units.map((u) => {
        if (!state.selectedIds.includes(u.id) || u.type !== "UAV") return u;
        if (u.state === "flying_to_mission" || u.state === "mission_orbit") {
          return { ...u, missionTarget: null, state: "returning" };
        }
        return u;
      });
      return { ...state, units };
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
      const id = newId("pat");

      let assignments;
      if (usvIds.length === 1) {
        const path = polygonSweepPath(polygon);
        assignments = [{ usvId: usvIds[0], path, region: polygon }];
      } else {
        // Voronoi partition — each USV gets its own sub-region sweep
        const seeds = placeVoronoiSeeds(polygon, usvIds.length);
        const regions = voronoiSubPolygons(polygon, seeds);
        assignments = usvIds.map((uid, i) => ({
          usvId: uid,
          path: polygonSweepPath(regions[i]?.length >= 3 ? regions[i] : polygon),
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
