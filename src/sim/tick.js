import { CONFIG } from "../config";
import { dist, norm, clamp, angleOf, isUnderwater } from "../utils";
import { newId } from "./factories";
import { isOnLand } from "./landData";

// Wrapper: only move if next position is in water. UAVs ignore land.
const moveIfWater = (unit, nx, ny) =>
  (unit.type === "UAV" || !isOnLand(nx, ny))
    ? { x: nx, y: ny }
    : { x: unit.x, y: unit.y }; // blocked — stay put

export const tickUnit = (u, units, jamZones, dt) => {
  const next = { ...u };

  if (u.type === "UAV") {
    const parent = units.find((x) => x.id === u.parentId);
    if (!parent) return next;

    const isAirborne = u.state !== "docked";
    const inJam = isAirborne && jamZones.some((jz) => dist(u, jz) < jz.radius);
    // Jam any active (non-RTB) airborne state
    const activeState = u.state === "orbiting" || u.state === "flying_to_mission" || u.state === "mission_orbit";
    if (inJam && activeState) {
      next.state = "jammed";
      next.missionAborted = (u.missionTarget != null || u.trackTargetId != null);
      next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);
      return next;
    }

    // Proactive battery-margin check: abort mission if not enough to return home
    const distToHome = Math.hypot(parent.x - u.x, parent.y - u.y);
    const ticksToReturn = distToHome / CONFIG.UAV_SPEED;
    const batteryToReturn = ticksToReturn * CONFIG.UAV_BATTERY_DRAIN + CONFIG.UAV_RETURN_BATTERY_MARGIN;

    if (u.state === "orbiting") {
      next.orbitAngle = u.orbitAngle + CONFIG.UAV_ORBIT_ANGULAR_SPEED * dt;
      next.x = parent.x + Math.cos(next.orbitAngle) * CONFIG.UAV_ORBIT_RADIUS;
      next.y = parent.y + Math.sin(next.orbitAngle) * CONFIG.UAV_ORBIT_RADIUS;
      next.heading = next.orbitAngle + Math.PI / 2;
      next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);
      if (next.battery < CONFIG.UAV_LOW_BATTERY) next.state = "returning";

    } else if (u.state === "flying_to_mission") {
      // Resolve target: tracked unit (moving) takes priority over fixed-point mission
      const tgtUnit = u.trackTargetId ? units.find((x) => x.id === u.trackTargetId) : null;
      const target = tgtUnit ?? u.missionTarget;
      if (!target) { next.state = "returning"; next.trackTargetId = null; return next; }

      next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);

      // Abort proactively if battery won't cover return trip
      if (u.battery <= batteryToReturn || next.battery < CONFIG.UAV_LOW_BATTERY) {
        next.state = "returning";
        next.missionAborted = true;
        return next;
      }

      const dx = target.x - u.x, dy = target.y - u.y;
      const d = Math.hypot(dx, dy);
      if (d <= CONFIG.UAV_MISSION_ORBIT_RADIUS + 5) {
        // Arrived — snap orbit angle to current bearing to avoid position jump
        next.state = "mission_orbit";
        next.orbitAngle = Math.atan2(u.y - target.y, u.x - target.x);
      } else {
        const v = norm({ x: dx, y: dy });
        next.x = u.x + v.x * CONFIG.UAV_SPEED * dt;
        next.y = u.y + v.y * CONFIG.UAV_SPEED * dt;
        next.heading = angleOf(dx, dy);
      }

    } else if (u.state === "mission_orbit") {
      // Resolve target: tracked unit (moving) takes priority over fixed-point mission
      const tgtUnit = u.trackTargetId ? units.find((x) => x.id === u.trackTargetId) : null;
      const target = tgtUnit ?? u.missionTarget;
      if (!target) { next.state = "returning"; next.trackTargetId = null; return next; }

      next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);

      // Abort proactively if battery won't cover return trip
      if (u.battery <= batteryToReturn || next.battery < CONFIG.UAV_LOW_BATTERY) {
        next.state = "returning";
        next.missionAborted = true;
        return next;
      }

      next.orbitAngle = u.orbitAngle + CONFIG.UAV_ORBIT_ANGULAR_SPEED * dt;
      // Orbit around the target's current position (follows moving units)
      next.x = target.x + Math.cos(next.orbitAngle) * CONFIG.UAV_MISSION_ORBIT_RADIUS;
      next.y = target.y + Math.sin(next.orbitAngle) * CONFIG.UAV_MISSION_ORBIT_RADIUS;
      next.heading = next.orbitAngle + Math.PI / 2;

    } else if (u.state === "jammed" || u.state === "returning") {
      const dx = parent.x - u.x, dy = parent.y - u.y;
      const d = Math.hypot(dx, dy);
      next.battery = Math.max(0, u.battery - CONFIG.UAV_BATTERY_DRAIN * dt);
      if (d < CONFIG.UAV_DOCK_RANGE) {
        next.state = "docked";
        next.x = parent.x; next.y = parent.y;
        next.missionTarget = null;
        next.trackTargetId = null;
        next.missionAborted = false;
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

    const inJam = jamZones.find((jz) => dist(u, jz) < jz.radius);
    if (inJam) {
      const dx = u.x - inJam.x, dy = u.y - inJam.y;
      const d = Math.hypot(dx, dy) || 1;
      const v = { x: dx / d, y: dy / d };
      const pos = moveIfWater(u, u.x + v.x * CONFIG.USV_SPEED * dt, u.y + v.y * CONFIG.USV_SPEED * dt);
      next.x = pos.x; next.y = pos.y;
      next.heading = angleOf(v.x, v.y);
      next.state = "jammed";
      next.battery = Math.max(0, u.battery - CONFIG.USV_BATTERY_DRAIN * dt);
      return next;
    }

    if (u.engageTargetId || u.aisEngageMMSI) {
      let tgtPos = null;
      if (u.engageTargetId) {
        const tgt = units.find((x) => x.id === u.engageTargetId);
        if (tgt) { tgtPos = tgt; }
        else next.engageTargetId = null;
      }
      if (!tgtPos && !u.aisEngageMMSI) { next.state = "idle"; }
      else if (tgtPos) {
        const dx = tgtPos.x - u.x, dy = tgtPos.y - u.y;
        const d = Math.hypot(dx, dy);
        if (d > CONFIG.TRACK_STANDOFF) {
          const vv = norm({ x: dx, y: dy });
          const pos = moveIfWater(u, u.x + vv.x * CONFIG.USV_SPEED * dt, u.y + vv.y * CONFIG.USV_SPEED * dt);
          next.x = pos.x; next.y = pos.y;
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
        const pos = moveIfWater(u, u.x + v.x * CONFIG.USV_SPEED * dt, u.y + v.y * CONFIG.USV_SPEED * dt);
        next.x = pos.x; next.y = pos.y;
        next.heading = angleOf(dx, dy);
        next.state = u.patrolPath ? "patrolling" : "moving";
      }
    } else if (!u.patrolPath) next.state = "idle";
    next.battery = Math.max(0, u.battery - CONFIG.USV_BATTERY_DRAIN * dt);
    if (next.battery < CONFIG.USV_LOW_BATTERY) next.state = "charging";
    return next;
  }

  if (u.type === "MINE") return next;

  if (u.goal) {
    const dx = u.goal.x - u.x, dy = u.goal.y - u.y;
    const d = Math.hypot(dx, dy);
    if (d < 10) {
      // Pick a new random goal; submarines/enemies avoid land
      let newGoal;
      let attempts = 0;
      do {
        newGoal = {
          x: clamp(u.x + (Math.random() - 0.5) * 1800, 100, CONFIG.WORLD_W - 100),
          y: clamp(u.y + (Math.random() - 0.5) * 1800, 100, CONFIG.WORLD_H - 100),
        };
        attempts++;
      } while (u.type !== "ENEMY" && isOnLand(newGoal.x, newGoal.y) && attempts < 8);
      next.goal = newGoal;
    } else {
      const speed = u.type === "ENEMY" ? CONFIG.ENEMY_SPEED :
                    u.type === "SUBMARINE" ? CONFIG.SUBMARINE_SPEED :
                    CONFIG.COMMERCIAL_SPEED;
      const v = norm({ x: dx, y: dy });
      const pos = moveIfWater(u, u.x + v.x * speed * dt, u.y + v.y * speed * dt);
      next.x = pos.x; next.y = pos.y;
      next.heading = angleOf(dx, dy);
    }
  }
  return next;
};

export const applyUAVRotation = (units) =>
  units.map((u) => {
    if (u.type !== "UAV" || u.state !== "docked") return u;
    if (u.battery < CONFIG.UAV_FULL_BATTERY) return u;
    const sibling = units.find(
      (x) => x.type === "UAV" && x.parentId === u.parentId && x.id !== u.id
    );
    // Don't auto-launch if sibling is actively airborne
    const siblingActive = sibling && (
      sibling.state === "orbiting" ||
      sibling.state === "flying_to_mission" ||
      sibling.state === "mission_orbit"
    );
    if (!siblingActive) {
      return { ...u, state: "orbiting", orbitAngle: Math.random() * Math.PI * 2 };
    }
    return u;
  });

export const updateDetections = (units, detections, dt) => {
  const friendlies = units.filter((u) => u.faction === "friendly");
  const targets = units.filter((u) => u.faction !== "friendly");
  const next = { ...detections };

  targets.forEach((t) => {
    let inRange = false;
    if (isUnderwater(t)) {
      inRange = friendlies.some(
        (f) => f.type === "USV" && f.state !== "charging" && dist(f, t) < CONFIG.SONAR_RANGE
      );
    } else {
      const sensorRange = (f) => f.type === "UAV" ? CONFIG.UAV_SENSOR_RANGE : CONFIG.USV_SENSOR_RANGE;
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

export const generateAlerts = (units, detections, prevAlerts, jamEvents, simTime) => {
  const alerts = [...prevAlerts];
  const has = (eid) => alerts.find((a) => a.eventId === eid);

  units.forEach((u) => {
    const det = detections[u.id];
    if (!det) return;
    if (u.type === "MINE") {
      if (det.confidence > CONFIG.POSSIBLE_THRESHOLD && !has(`mine-pos-${u.id}`))
        alerts.unshift({ id: newId("alt"), eventId: `mine-pos-${u.id}`,
          kind: "MINE", severity: "med", title: `POSSIBLE MINE — ${u.label}`,
          body: "Sonar return suggests submerged threat.", unitId: u.id, time: simTime });
      if (det.confidence > CONFIG.CONFIRMED_THRESHOLD && !has(`mine-conf-${u.id}`))
        alerts.unshift({ id: newId("alt"), eventId: `mine-conf-${u.id}`,
          kind: "MINE", severity: "high", title: `CONFIRMED MINE — ${u.label}`,
          body: "Submerged mine confirmed. Maintain standoff.", unitId: u.id, time: simTime });
    } else if (u.type === "SUBMARINE") {
      if (det.confidence > CONFIG.POSSIBLE_THRESHOLD && !has(`sub-pos-${u.id}`))
        alerts.unshift({ id: newId("alt"), eventId: `sub-pos-${u.id}`,
          kind: "SUBSURFACE", severity: "med", title: `POSSIBLE SUB — ${u.label}`,
          body: "Sonar contact: submerged track. Auto-tracking nearest USV.", unitId: u.id, time: simTime });
      if (det.confidence > CONFIG.CONFIRMED_THRESHOLD && !has(`sub-${u.id}`))
        alerts.unshift({ id: newId("alt"), eventId: `sub-${u.id}`,
          kind: "SUBSURFACE", severity: "high", title: `CONFIRMED SUB — ${u.label}`,
          body: "Submerged hostile confirmed.", unitId: u.id, time: simTime });
    } else if (u.faction === "hostile") {
      if (det.confidence > CONFIG.POSSIBLE_THRESHOLD && !has(`hos-pos-${u.id}`))
        alerts.unshift({ id: newId("alt"), eventId: `hos-pos-${u.id}`,
          kind: "DETECT", severity: "med", title: `POSSIBLE HOSTILE — ${u.label}`,
          body: "Unidentified contact in sensor envelope.", unitId: u.id, time: simTime });
      if (det.confidence > CONFIG.CONFIRMED_THRESHOLD && !has(`hos-${u.id}`))
        alerts.unshift({ id: newId("alt"), eventId: `hos-${u.id}`,
          kind: "DETECT", severity: "high", title: `HOSTILE CONFIRMED — ${u.label}`,
          body: "Enemy vessel confirmed. Engaging.", unitId: u.id, time: simTime });
    }
  });

  jamEvents.forEach((je) => {
    if (!has(`jam-${je.unitId}`)) {
      const isUSV = je.unitType === "USV";
      alerts.unshift({ id: newId("alt"), eventId: `jam-${je.unitId}`,
        kind: "GPS.JAM", severity: isUSV ? "med" : "high",
        title: `GPS DENIAL — ${je.unitLabel}`,
        body: isUSV ? "USV in GPS-denied envelope. Backtracking."
                    : "UAV in GPS-denied envelope. RTB to USV.",
        unitId: je.unitId, time: simTime });
    }
  });

  // Mission abort alerts
  units.forEach((u) => {
    if (u.type !== "UAV") return;
    if (u.missionAborted && u.state === "returning" &&
        !has(`uav-abort-${u.id}-${Math.floor(simTime / 10)}`)) {
      alerts.unshift({ id: newId("alt"),
        eventId: `uav-abort-${u.id}-${Math.floor(simTime / 10)}`,
        kind: "MISSION.ABORT", severity: "med",
        title: `UAV ${u.label} ABORTING MISSION`,
        body: "Insufficient battery to complete mission. Returning to USV.",
        unitId: u.id, time: simTime });
    }
  });

  return alerts.slice(0, 30);
};
