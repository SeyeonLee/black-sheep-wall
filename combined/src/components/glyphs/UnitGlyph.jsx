import { COLORS, CONFIG } from "../../config";
import { rad2deg, isUnderwater } from "../../utils";

export const UnitGlyph = ({ unit, selected, detected, onClick, onContextMenu, canTrack }) => {
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
    // Color: amber on mission, hostile+abort, normal otherwise
    const onMission = unit.state === "flying_to_mission" || unit.state === "mission_orbit";
    const aborting  = unit.missionAborted && unit.state === "returning";
    const uavColor  = aborting ? COLORS.hostile : onMission ? COLORS.amber : color;
    const dim = unit.state === "docked" ? 0.4 : unit.state === "jammed" ? 0.6 : 1;
    glyph = (
      <g opacity={dim}>
        <path d="M 0 -8 L 7 6 L 0 3 L -7 6 Z" fill={uavColor} stroke={uavColor} strokeWidth="1" />
        {aborting && (
          <text y="-14" textAnchor="middle" fontSize="11"
                fontFamily="'JetBrains Mono', monospace"
                fill={COLORS.hostile} fontWeight="700">!</text>
        )}
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
       style={{ cursor: canTrack ? "crosshair" : "pointer" }}
       onMouseDown={(e) => { e.stopPropagation(); onClick && onClick(unit, e); }}
       onContextMenu={(e) => {
         if (onContextMenu) {
           e.preventDefault(); e.stopPropagation();
           onContextMenu(unit, e);
         }
       }}>
      {/* Enlarged transparent hit area for non-friendly contacts */}
      {!isFriendly && <circle r="22" fill="transparent" />}
      {selected && (
        <g>
          <circle r="22" fill="none" stroke={baseColor} strokeWidth="1" strokeDasharray="3 3" opacity="0.9">
            <animateTransform attributeName="transform" type="rotate" from="0" to="360" dur="6s" repeatCount="indefinite" />
          </circle>
          <circle r="26" fill="none" stroke={baseColor} strokeWidth="0.5" opacity="0.4" />
        </g>
      )}
      {isPossible && (
        <circle r="18" fill="none" stroke={dimColor} strokeWidth="1" strokeDasharray="2 4" opacity="0.7" />
      )}

      <g transform={rotateGlyph ? `rotate(${headingDeg + 90})` : ""} opacity={isPossible ? 0.75 : 1}>
        {glyph}
      </g>

      <text x="14" y="-10" fontSize="9" fontFamily="'JetBrains Mono', monospace"
            fill={selected ? baseColor : color}
            opacity={isFriendly || !isPossible ? 1 : 0.8}>
        {unit.label}{isPossible ? "?" : ""}
      </text>

      {!isFriendly && (
        <text x="14" y="0" fontSize="6.5" fontFamily="'JetBrains Mono', monospace"
              fill={isPossible ? COLORS.amber : color}
              letterSpacing="0.1em">
          {isPossible ? "POSSIBLE" : "CONFIRMED"}
        </text>
      )}

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

      {submerged && !isPossible && (
        <text x="-30" y="3" fontSize="6" fontFamily="'JetBrains Mono', monospace"
              fill={COLORS.subsurfaceDim}>
          ~{Math.floor(20 + Math.abs(unit.x * 13 + unit.y * 7) % 60)}m
        </text>
      )}
    </g>
  );
};
