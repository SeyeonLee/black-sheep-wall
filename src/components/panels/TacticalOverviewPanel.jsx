import { useRef } from "react";
import { CONFIG, COLORS } from "../../config";
import { isUnderwater } from "../../utils";
import { getLandPolygons } from "../../sim/landData";

export const TacticalOverviewPanel = ({ state, cam, setCam }) => {
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
        {getLandPolygons().map(({ points }, i) => (
          <polygon key={i} points={points.map((p) => `${p.x},${p.y}`).join(" ")}
            fill={COLORS.land} stroke={COLORS.borderHi} strokeWidth="2" />
        ))}
        {state.patrolAreas.map((pa) => (
          <polygon key={pa.id} points={pa.polygon.map((p) => `${p.x},${p.y}`).join(" ")}
            fill={COLORS.phosphor} fillOpacity="0.15" stroke={COLORS.phosphor} strokeWidth="6" />
        ))}
        {state.jamZones.map((jz) => (
          <circle key={jz.id} cx={jz.x} cy={jz.y} r={jz.radius}
            fill={COLORS.hostile} fillOpacity="0.15" stroke={COLORS.hostile} strokeWidth="4" />
        ))}
        {/* AIS ships (dots) */}
        {state.aisShips.map((s) => (
          <circle key={s.mmsi} cx={s.wx} cy={s.wy} r={14}
            fill={COLORS.ais} fillOpacity="0.5" />
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
