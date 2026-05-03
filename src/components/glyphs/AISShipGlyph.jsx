import { COLORS } from "../../config";

export const AISShipGlyph = ({ ship, tracking, onContextMenu }) => {
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
      <g transform={`rotate(${headingDeg})`}>
        <polygon points="0,-10 6,6 0,3 -6,6" fill={COLORS.ais} opacity="0.85" />
      </g>
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
