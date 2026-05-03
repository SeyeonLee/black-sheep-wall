import { useState, useEffect, useRef, useCallback } from "react";
import { CONFIG, COLORS } from "../config";
import { clamp } from "../utils";
import { polygonCentroid } from "../sim/geometry";
import { LAND } from "../sim/factories";
import { UnitGlyph } from "./glyphs/UnitGlyph";
import { JamZoneGlyph } from "./glyphs/JamZoneGlyph";
import { AISShipGlyph } from "./glyphs/AISShipGlyph";

export const MapView = ({ state, dispatch, tool, setTool, deployType, setHover, setCursorWorld, cam, setCam }) => {
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

  const hasUSVSelected = state.units.some(
    (x) => state.selectedIds.includes(x.id) && x.type === "USV"
  );

  const onClickUnit = (u, e) => {
    if (u.faction !== "friendly") {
      // Left-click on a detected contact when USVs are selected → instant track
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
    if (u.faction === "friendly") return;
    const det = state.detections[u.id];
    if (!det || det.confidence < CONFIG.POSSIBLE_THRESHOLD) return;
    dispatch({ type: "ENGAGE_TARGET", targetId: u.id });
  };

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

      <g>{state.jamZones.map((jz) => (
        <JamZoneGlyph key={jz.id} zone={jz}
          onClick={(z, e) => { if (e.shiftKey) dispatch({ type: "REMOVE_JAM_ZONE", id: z.id }); }} />
      ))}</g>

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
      <g>{sensorCircles.map((s) => (
        <circle key={`glow-${s.id}`} cx={s.x} cy={s.y} r={s.r}
          fill={`url(#sg-${s.id})`} pointerEvents="none" />
      ))}</g>
      <g opacity="0.25">{sensorCircles.filter((s) => s.sonar > 0).map((s) => (
        <circle key={`son-${s.id}`} cx={s.x} cy={s.y} r={s.sonar}
          fill="none" stroke={COLORS.subsurface} strokeWidth="0.6" strokeDasharray="1 3" />
      ))}</g>

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
          onContextMenu={onUnitContextMenu}
          canTrack={u.faction !== "friendly" && hasUSVSelected &&
            (state.detections[u.id]?.confidence ?? 0) >= CONFIG.POSSIBLE_THRESHOLD} />
      ))}</g>

      <rect x="0" y="0" width={CONFIG.WORLD_W} height={CONFIG.WORLD_H}
        fill="rgba(2,8,5,0.18)" mask="url(#fog-mask)" pointerEvents="none" />
    </svg>
  );
};
