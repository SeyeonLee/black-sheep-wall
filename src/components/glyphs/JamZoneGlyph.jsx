import { COLORS } from "../../config";

export const JamZoneGlyph = ({ zone, onClick }) => (
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
