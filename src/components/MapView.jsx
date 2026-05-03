import { useState, useEffect, useRef, useCallback } from "react";
import { CONFIG, COLORS } from "../config";
import { clamp } from "../utils";
import { polygonCentroid } from "../sim/geometry";
import { getLandPolygons } from "../sim/landData";
import { UnitGlyph } from "./glyphs/UnitGlyph";
import { JamZoneGlyph } from "./glyphs/JamZoneGlyph";
import { AISShipGlyph } from "./glyphs/AISShipGlyph";

// ─── Tile math ─────────────────────────────────────────────────────────────────
const lonToTileX = (lon, z) =>
  Math.floor((lon + 180) / 360 * Math.pow(2, z));

const latToTileY = (lat, z) => {
  const r = lat * Math.PI / 180;
  return Math.floor(
    (1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2 * Math.pow(2, z)
  );
};

const tileToLon = (tx, z) => tx / Math.pow(2, z) * 360 - 180;

const tileToLat = (ty, z) => {
  const n = Math.PI - (2 * Math.PI * ty) / Math.pow(2, z);
  return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
};

// Linear projection helpers — matches geoToWorld in utils.js
const lonToWorld = (lon) =>
  (lon - CONFIG.GEO_LON_MIN) / (CONFIG.GEO_LON_MAX - CONFIG.GEO_LON_MIN) * CONFIG.WORLD_W;
const latToWorld = (lat) =>
  (CONFIG.GEO_LAT_MAX - lat) / (CONFIG.GEO_LAT_MAX - CONFIG.GEO_LAT_MIN) * CONFIG.WORLD_H;

// ─── Tile URL templates ─────────────────────────────────────────────────────────
const TILE_URL = {
  satellite: (z, x, y) =>
    `https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${z}/${y}/${x}`,
  nautical: (z, x, y) =>
    `https://a.basemaps.cartocdn.com/rastertiles/voyager/${z}/${x}/${y}.png`,
  seamark: (z, x, y) =>
    `https://tiles.openseamap.org/seamark/${z}/${x}/${y}.png`,
};

// ─── TileLayer ──────────────────────────────────────────────────────────────────
// Geo range is 120° lon × 90° lat → adjust tile zoom relative to cam.zoom.
const TileLayer = ({ cam, style }) => {
  const z = cam.zoom <= 0.18 ? 2
          : cam.zoom <= 0.35 ? 3
          : cam.zoom <= 0.7  ? 4
          : cam.zoom <= 1.4  ? 5
          : cam.zoom <= 2.8  ? 6
          : cam.zoom <= 5.5  ? 7
          : 8;
  const n = Math.pow(2, z);

  const vbW = CONFIG.WORLD_W / cam.zoom;
  const vbH = CONFIG.WORLD_H / cam.zoom;

  // Convert viewport world bounds → lon/lat
  const lonRange = CONFIG.GEO_LON_MAX - CONFIG.GEO_LON_MIN;
  const latRange = CONFIG.GEO_LAT_MAX - CONFIG.GEO_LAT_MIN;
  const lonMin = CONFIG.GEO_LON_MIN + (cam.x / CONFIG.WORLD_W) * lonRange;
  const lonMax = CONFIG.GEO_LON_MIN + ((cam.x + vbW) / CONFIG.WORLD_W) * lonRange;
  const latMax = CONFIG.GEO_LAT_MAX - (cam.y / CONFIG.WORLD_H) * latRange;
  const latMin = CONFIG.GEO_LAT_MAX - ((cam.y + vbH) / CONFIG.WORLD_H) * latRange;

  const txMin = Math.max(0, lonToTileX(lonMin - 3, z));
  const txMax = Math.min(n - 1, lonToTileX(lonMax + 3, z));
  const tyMin = Math.max(0, latToTileY(Math.min(85, latMax + 4), z));
  const tyMax = Math.min(n - 1, latToTileY(Math.max(-85, latMin - 4), z));

  const tiles = [];
  for (let ty = tyMin; ty <= tyMax; ty++) {
    for (let tx = txMin; tx <= txMax; tx++) {
      const lon0 = tileToLon(tx, z);
      const lon1 = tileToLon(tx + 1, z);
      const lat0 = tileToLat(ty, z);       // north edge
      const lat1 = tileToLat(ty + 1, z);   // south edge

      const wx0 = lonToWorld(lon0);
      const wx1 = lonToWorld(lon1);
      const wy0 = latToWorld(lat0);         // smaller y = further north
      const wy1 = latToWorld(lat1);

      const url = TILE_URL[style]?.(z, tx, ty);
      if (!url) continue;
      tiles.push({ key: `${z}-${tx}-${ty}`, url, x: wx0, y: wy0, w: wx1 - wx0, h: wy1 - wy0 });
    }
  }

  return (
    <g>
      {tiles.map(({ key, url, x, y, w, h }) => (
        <image key={key} href={url}
          x={x} y={y} width={w} height={h}
          preserveAspectRatio="none" />
      ))}
    </g>
  );
};

// ─── LandLayer (tactical mode — real GeoJSON polygons) ─────────────────────────
const LandLayer = () => {
  const polys = getLandPolygons();
  return (
    <g>
      {polys.map(({ points }, i) => (
        <polygon key={i}
          points={points.map((p) => `${p.x},${p.y}`).join(" ")}
          fill={COLORS.land} stroke={COLORS.borderHi} strokeWidth="1" />
      ))}
    </g>
  );
};

// ─── Camera bounds clamp ────────────────────────────────────────────────────────
// Prevents the viewport from showing empty space outside the world rectangle.
const clampCamBounds = (c) => {
  const vbW = CONFIG.WORLD_W / c.zoom;
  const vbH = CONFIG.WORLD_H / c.zoom;
  // If viewport larger than world, center it; otherwise clamp to edges.
  const x = vbW >= CONFIG.WORLD_W
    ? (CONFIG.WORLD_W - vbW) / 2
    : clamp(c.x, 0, CONFIG.WORLD_W - vbW);
  const y = vbH >= CONFIG.WORLD_H
    ? (CONFIG.WORLD_H - vbH) / 2
    : clamp(c.y, 0, CONFIG.WORLD_H - vbH);
  return { ...c, x, y };
};

// ─── MapView ───────────────────────────────────────────────────────────────────
export const MapView = ({
  state, dispatch, tool, setTool, deployType,
  setHover, setCursorWorld, cam, setCam,
  mapStyle = "tactical",
  fogEnabled = true,
}) => {
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

  const isTile = mapStyle === "satellite" || mapStyle === "nautical";

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

  // ── Edge-pan RAF ──────────────────────────────────────────────────────────────
  useEffect(() => {
    let raf;
    const tick = () => {
      const cs = cursorScreenRef.current;
      const svg = svgRef.current;
      if (cs && svg) {
        const rect = svg.getBoundingClientRect();
        const z = CONFIG.EDGE_PAN_ZONE;
        const lx = cs.x - rect.left, rx = rect.right - cs.x;
        const ty = cs.y - rect.top,  by = rect.bottom - cs.y;
        let fx = 0, fy = 0;
        if (lx < z && lx >= -2) fx = -((z - Math.max(0, lx)) / z);
        else if (rx < z && rx >= -2) fx = ((z - Math.max(0, rx)) / z);
        if (ty < z && ty >= -2) fy = -((z - Math.max(0, ty)) / z);
        else if (by < z && by >= -2) fy = ((z - Math.max(0, by)) / z);
        if (fx !== 0 || fy !== 0) {
          const c = camRef.current;
          const dx = (fx * CONFIG.EDGE_PAN_SPEED) / c.zoom;
          const dy = (fy * CONFIG.EDGE_PAN_SPEED) / c.zoom;
          setCam((cur) => clampCamBounds({ ...cur, x: cur.x + dx, y: cur.y + dy }));
          const wp = screenToWorld(cs.x, cs.y);
          setHoverWorld(wp); setHover(wp); setCursorWorld(wp);
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
      setCam(clampCamBounds({ ...cam, x: panStart.camX - dx, y: panStart.camY - dy }));
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
    const newZoom = clamp(cam.zoom * factor, 0.12, 12);
    const newVbW = CONFIG.WORLD_W / newZoom, newVbH = CONFIG.WORLD_H / newZoom;
    const svg = svgRef.current;
    const rect = svg.getBoundingClientRect();
    const px = (e.clientX - rect.left) / rect.width;
    const py = (e.clientY - rect.top) / rect.height;
    setCam(clampCamBounds({ x: wp.x - px * newVbW, y: wp.y - py * newVbH, zoom: newZoom }));
  };

  const hasUSVSelected = state.units.some(
    (x) => state.selectedIds.includes(x.id) && x.type === "USV"
  );
  // Airborne (non-docked) UAV in selection — can be ordered to orbit a target unit
  const hasAirborneUAVSelected = state.units.some(
    (x) => state.selectedIds.includes(x.id) && x.type === "UAV" && x.state !== "docked"
  );

  const onClickUnit = (u, e) => {
    if (u.faction !== "friendly") {
      if (hasUSVSelected) {
        const det = state.detections[u.id];
        if (det && det.confidence >= CONFIG.POSSIBLE_THRESHOLD) {
          dispatch({ type: "ENGAGE_TARGET", targetId: u.id });
        }
      }
      return;
    }
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

  const onUnitContextMenu = (u, e) => {
    if (state.selectedIds.length === 0) return;
    if (u.faction === "friendly") {
      // Right-click any friendly not in selection → selected USVs/UAVs escort/follow it
      if (!state.selectedIds.includes(u.id) && (hasUSVSelected || hasAirborneUAVSelected)) {
        dispatch({ type: "ENGAGE_TARGET", targetId: u.id });
      }
      return;
    }
    // Right-click enemy/neutral → selected USVs engage; selected UAVs orbit (if detected)
    if (!hasUSVSelected && !hasAirborneUAVSelected) return;
    const det = state.detections[u.id];
    if (!det || det.confidence < CONFIG.POSSIBLE_THRESHOLD) return;
    dispatch({ type: "ENGAGE_TARGET", targetId: u.id });
  };

  const onAISContextMenu = (ship) => {
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

  // Units currently being tracked by any friendly (USV engageTargetId or UAV trackTargetId)
  // Split by target faction for visual differentiation
  const trackedEnemyIds = new Set(
    state.units
      .filter((u) => u.faction === "friendly")
      .flatMap((u) => [u.engageTargetId, u.trackTargetId].filter(Boolean))
      .filter((id) => {
        const t = state.units.find((x) => x.id === id);
        return t && t.faction !== "friendly";
      })
  );
  const trackedFriendlyIds = new Set(
    state.units
      .filter((u) => u.faction === "friendly")
      .flatMap((u) => [u.engageTargetId, u.trackTargetId].filter(Boolean))
      .filter((id) => {
        const t = state.units.find((x) => x.id === id);
        return t && t.faction === "friendly";
      })
  );

  const vbW = CONFIG.WORLD_W / cam.zoom;
  const vbH = CONFIG.WORLD_H / cam.zoom;

  const fogFill = isTile ? "rgba(0,0,0,0.68)" : "rgba(2,8,5,0.22)";

  return (
    <svg ref={svgRef}
      style={{
        background: isTile ? "#0a1520" : COLORS.ocean1,
        userSelect: "none",
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
          <rect x={cam.x} y={cam.y} width={vbW} height={vbH} fill="white" />
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

      {/* ── Background layer ───────────────────────────────────────────────── */}
      {mapStyle === "tactical" && (
        <>
          {/* Ocean background extends to full viewBox (covers beyond world bounds too) */}
          <rect x={cam.x} y={cam.y} width={vbW} height={vbH} fill="url(#ocean-grad)" />
          <rect x={cam.x} y={cam.y} width={vbW} height={vbH} fill="url(#grid)" />
          <rect x={cam.x} y={cam.y} width={vbW} height={vbH} fill="url(#grid-major)" />
          <LandLayer />
        </>
      )}
      {mapStyle === "satellite" && (
        <>
          <TileLayer cam={cam} style="satellite" />
          <rect x={cam.x} y={cam.y} width={vbW} height={vbH} fill="url(#grid)" opacity="0.07" />
        </>
      )}
      {mapStyle === "nautical" && (
        <>
          <TileLayer cam={cam} style="nautical" />
          <TileLayer cam={cam} style="seamark" />
          <rect x={cam.x} y={cam.y} width={vbW} height={vbH} fill="url(#grid)" opacity="0.10" />
        </>
      )}

      {/* ── Lat/Lon labels (tactical only, global grid) ────────────────────── */}
      {mapStyle === "tactical" && (
        <g fontFamily="'JetBrains Mono', monospace" fontSize="10" fill={COLORS.textDim} opacity="0.5">
          {/* Every 15° longitude */}
          {Array.from({ length: 17 }, (_, i) => {
            const lon = CONFIG.GEO_LON_MIN + i * (CONFIG.GEO_LON_MAX - CONFIG.GEO_LON_MIN) / 8;
            const step = Math.round((CONFIG.GEO_LON_MAX - CONFIG.GEO_LON_MIN) / 8);
            const actualLon = CONFIG.GEO_LON_MIN + i * step;
            if (actualLon > CONFIG.GEO_LON_MAX) return null;
            const x = lonToWorld(actualLon);
            const label = actualLon >= 0
              ? `E${String(actualLon).padStart(3, "0")}°`
              : `W${String(-actualLon).padStart(3, "0")}°`;
            return <text key={`lon${i}`} x={x} y={cam.y + 16}>{label}</text>;
          })}
          {/* Every ~10° latitude */}
          {Array.from({ length: 10 }, (_, i) => {
            const step = Math.round((CONFIG.GEO_LAT_MAX - CONFIG.GEO_LAT_MIN) / 9);
            const lat = CONFIG.GEO_LAT_MAX - i * step;
            if (lat < CONFIG.GEO_LAT_MIN) return null;
            const y = latToWorld(lat);
            const label = lat >= 0 ? `N${String(lat).padStart(2, "0")}°` : `S${String(-lat).padStart(2, "0")}°`;
            return <text key={`lat${i}`} x={cam.x + 6} y={y + 4}>{label}</text>;
          })}
        </g>
      )}

      {/* ── Patrol areas ───────────────────────────────────────────────────── */}
      <g>{state.patrolAreas.map((pa) => {
        const c = polygonCentroid(pa.polygon);
        const assignments = pa.assignments || [{ path: pa.path, region: pa.polygon }];
        const colors = [COLORS.phosphor, COLORS.ais, COLORS.amber, COLORS.subsurface];
        return (
          <g key={pa.id}>
            <polygon points={pa.polygon.map((p) => `${p.x},${p.y}`).join(" ")}
              fill="none" stroke={COLORS.phosphor} strokeWidth="1.2"
              strokeDasharray="6 3" opacity="0.6" />
            {assignments.map((a, ai) => {
              const col = colors[ai % colors.length];
              const hasRegion = a.region && a.region !== pa.polygon && a.region.length >= 3;
              return (
                <g key={ai}>
                  {hasRegion && (
                    <polygon points={a.region.map((p) => `${p.x},${p.y}`).join(" ")}
                      fill="url(#patrol-hatch)" stroke={col} strokeWidth="0.8"
                      strokeDasharray="4 4" opacity="0.6" />
                  )}
                  {a.path && (
                    <polyline points={a.path.map((p) => `${p.x},${p.y}`).join(" ")}
                      fill="none" stroke={col} strokeWidth="1.2" strokeDasharray="3 4" opacity="0.7" />
                  )}
                </g>
              );
            })}
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

      <g>{state.jamZones.map((jz) => (
        <JamZoneGlyph key={jz.id} zone={jz}
          onClick={(z, e) => { if (e.shiftKey) dispatch({ type: "REMOVE_JAM_ZONE", id: z.id }); }} />
      ))}</g>

      {/* ── USV goal lines ─────────────────────────────────────────────────── */}
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

      {/* ── UAV mission target lines (fixed-point and unit-track) ─────────── */}
      <g>{state.units
        .filter((u) => u.type === "UAV" &&
          (u.state === "flying_to_mission" || u.state === "mission_orbit") &&
          (u.missionTarget || u.trackTargetId))
        .map((u) => {
          const tgtUnit = u.trackTargetId
            ? state.units.find((x) => x.id === u.trackTargetId)
            : null;
          const tgtPos = tgtUnit ?? u.missionTarget;
          if (!tgtPos) return null;

          const isFriendlyTgt = tgtUnit?.faction === "friendly";
          const lineColor = tgtUnit
            ? (isFriendlyTgt ? COLORS.phosphor : COLORS.amber)
            : COLORS.amber;
          const statusLabel = u.state === "mission_orbit"
            ? (isFriendlyTgt ? "▶ ESCORT" : "▶ ON-STATION")
            : (isFriendlyTgt ? "▶ ESCORT" : "▶ EN ROUTE");

          return (
            <g key={`mission-${u.id}`}>
              <line x1={u.x} y1={u.y} x2={tgtPos.x} y2={tgtPos.y}
                stroke={lineColor} strokeWidth="1" strokeDasharray="6 3" opacity="0.6">
                <animate attributeName="stroke-dashoffset" from="0" to="-9" dur="1s" repeatCount="indefinite" />
              </line>
              {/* Fixed-point target: show crosshair marker */}
              {!tgtUnit && (
                <g transform={`translate(${tgtPos.x},${tgtPos.y})`}>
                  <circle r="16" fill="none" stroke={lineColor} strokeWidth="1" opacity="0.5" strokeDasharray="4 4" />
                  <circle r="4" fill="none" stroke={lineColor} strokeWidth="1.5" opacity="0.9" />
                  <text y="-22" textAnchor="middle" fontSize="7"
                    fontFamily="'JetBrains Mono', monospace" fill={lineColor} letterSpacing="0.15em">
                    {statusLabel}
                  </text>
                </g>
              )}
              {/* Unit target: just float the label above the tracked unit */}
              {tgtUnit && (
                <text x={tgtPos.x} y={tgtPos.y - 36} textAnchor="middle" fontSize="7"
                  fontFamily="'JetBrains Mono', monospace" fill={lineColor} letterSpacing="0.15em"
                  pointerEvents="none">
                  {statusLabel}
                </text>
              )}
            </g>
          );
        })}</g>

      {/* ── Engage / track / escort target lines ──────────────────────────── */}
      <g>{state.units
        .filter((u) => u.engageTargetId && u.faction === "friendly")
        .map((u) => {
          const tgt = state.units.find((x) => x.id === u.engageTargetId);
          if (!tgt) return null;
          const isEscortLine = tgt.faction === "friendly";
          const lineColor  = isEscortLine ? COLORS.phosphor : COLORS.amber;
          const lineLabel  = isEscortLine ? "▶ ESCORT"     : "▶ TRACK";
          const pulseDur   = isEscortLine ? "1.8s"         : "2s";
          const dashOffset = isEscortLine ? "-9"           : "-9";
          return (
            <g key={`track-${u.id}`}>
              <line x1={u.x} y1={u.y} x2={tgt.x} y2={tgt.y}
                stroke={lineColor} strokeWidth="1.2" strokeDasharray="6 3" opacity="0.7">
                <animate attributeName="stroke-dashoffset" from="0" to={dashOffset} dur="1s" repeatCount="indefinite" />
              </line>
              <g transform={`translate(${tgt.x},${tgt.y})`}>
                <circle r="14" fill="none" stroke={lineColor} strokeWidth="1" opacity="0.7">
                  <animate attributeName="r" values="14;22;14" dur={pulseDur} repeatCount="indefinite" />
                </circle>
                <text y="-22" textAnchor="middle" fontSize="7"
                  fontFamily="'JetBrains Mono', monospace" fill={lineColor} letterSpacing="0.15em">
                  {lineLabel}
                </text>
              </g>
            </g>
          );
        })}</g>

      {/* ── Sensor circles ─────────────────────────────────────────────────── */}
      <g opacity="0.18">{sensorCircles.map((s) => (
        <circle key={`sens-${s.id}`} cx={s.x} cy={s.y} r={s.r}
          fill="none" stroke={COLORS.phosphor} strokeWidth="0.8" strokeDasharray="2 6" />
      ))}</g>
      <g>{sensorCircles.map((s) => (
        <circle key={`glow-${s.id}`} cx={s.x} cy={s.y} r={s.r}
          fill={`url(#sg-${s.id})`} pointerEvents="none" />
      ))}</g>
      <g opacity="0.25">{sensorCircles.filter((s) => s.sonar > 0).map((s) => (
        <circle key={`son-${s.id}`} cx={s.x} cy={s.y} r={s.sonar}
          fill="none" stroke={COLORS.subsurface} strokeWidth="0.6" strokeDasharray="1 3" />
      ))}</g>

      {/* ── AIS ships ──────────────────────────────────────────────────────── */}
      <g>{state.aisShips.map((ship) => {
        const tracking = state.units.some((u) => u.type === "USV" && u.aisEngageMMSI === ship.mmsi);
        return (
          <AISShipGlyph key={ship.mmsi} ship={ship}
            tracking={tracking} onContextMenu={onAISContextMenu} />
        );
      })}</g>

      {/* ── Patrol drawing preview ─────────────────────────────────────────── */}
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
          fill="rgba(184,255,94,0.05)" stroke={COLORS.phosphor} strokeWidth="1" strokeDasharray="3 3" />
      )}

      {/* ── Units ──────────────────────────────────────────────────────────── */}
      <g>{state.units.map((u) => (
        <UnitGlyph key={u.id} unit={u}
          selected={state.selectedIds.includes(u.id)}
          detected={state.detections[u.id]}
          onClick={onClickUnit}
          onContextMenu={onUnitContextMenu}
          isAutoTracked={u.faction !== "friendly" && trackedEnemyIds.has(u.id)}
          isEscorted={u.faction === "friendly" && trackedFriendlyIds.has(u.id)}
          canTrack={
            !state.selectedIds.includes(u.id) &&
            (hasUSVSelected || hasAirborneUAVSelected) &&
            (u.faction === "friendly" ||
              (state.detections[u.id]?.confidence ?? 0) >= CONFIG.POSSIBLE_THRESHOLD)
          } />
      ))}</g>

      {/* ── Mine markers (persistent, click × to remove) ───────────────────── */}
      <g>{(state.mineMarkers || []).map((marker) => (
        <g key={marker.id} transform={`translate(${marker.x},${marker.y})`}>
          {/* Marker body */}
          <circle r="18" fill="rgba(255,184,74,0.08)" stroke={COLORS.amber}
                  strokeWidth="1.5" strokeDasharray="4 3" />
          {/* X symbol */}
          <line x1="-9" y1="-9" x2="9" y2="9" stroke={COLORS.amber} strokeWidth="2.5" />
          <line x1="-9" y1="9" x2="9" y2="-9" stroke={COLORS.amber} strokeWidth="2.5" />
          {/* Label */}
          <text y="-24" textAnchor="middle" fontSize="7.5"
                fontFamily="'JetBrains Mono', monospace"
                fill={COLORS.amber} letterSpacing="0.1em">
            ⚠ MINE · {marker.label}
          </text>
          {/* Remove button — always visible at top-right */}
          <g transform="translate(18,-18)"
             style={{ cursor: "pointer" }}
             onMouseDown={(e) => {
               e.stopPropagation();
               dispatch({ type: "REMOVE_MINE_MARKER", id: marker.id });
             }}>
            <circle r="9" fill={COLORS.hostile} opacity="0.85" />
            <text textAnchor="middle" dominantBaseline="central"
                  fontSize="12" fill="white" fontWeight="bold"
                  fontFamily="'JetBrains Mono', monospace" y="0.5">×</text>
          </g>
        </g>
      ))}</g>

      {/* ── Fog of war (conditional) ───────────────────────────────────────── */}
      {fogEnabled && (
        <rect x={cam.x} y={cam.y} width={vbW} height={vbH}
          fill={fogFill} mask="url(#fog-mask)" pointerEvents="none" />
      )}
    </svg>
  );
};
