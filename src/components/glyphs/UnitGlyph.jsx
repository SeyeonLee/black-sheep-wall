import { COLORS, CONFIG } from "../../config";
import { rad2deg, isUnderwater } from "../../utils";

export const UnitGlyph = ({
  unit, selected, detected, onClick, onContextMenu, canTrack, isAutoTracked, isEscorted,
}) => {
  const isFriendly = unit.faction === "friendly";
  const isHostile  = unit.faction === "hostile";
  const submerged  = isUnderwater(unit);

  const baseColor = isFriendly ? COLORS.phosphor :
                    submerged  ? COLORS.subsurface :
                    isHostile  ? COLORS.hostile : COLORS.neutral;
  const dimColor  = isFriendly ? COLORS.phosphorDim :
                    submerged  ? COLORS.subsurfaceDim :
                    isHostile  ? COLORS.hostileDim : COLORS.neutralDim;

  const confidence   = detected?.confidence ?? (isFriendly ? 100 : 0);

  // Show enemy contacts once any detection has occurred (CONTACT_THRESHOLD)
  if (!isFriendly && confidence < CONFIG.CONTACT_THRESHOLD) return null;

  const isNewContact = !isFriendly && confidence < CONFIG.POSSIBLE_THRESHOLD;
  const isPossible   = !isFriendly && confidence >= CONFIG.POSSIBLE_THRESHOLD && confidence < CONFIG.CONFIRMED_THRESHOLD;
  // isConfirmed = isFriendly OR confidence >= CONFIRMED_THRESHOLD

  // Priority: auto-tracked → amber; new contact → amber-dim; possible → dim; confirmed → base
  const color = isAutoTracked   ? COLORS.amber
              : isNewContact    ? COLORS.amberDim
              : isPossible      ? dimColor
              : baseColor;

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
  } else if (unit.type === "TURRET") {
    const firingColor = unit.isFiring ? COLORS.hostile : color;
    glyph = (
      <g>
        {/* Fast-attack hull — pointed bow, wider stern */}
        <path d="M 0 -13 L 9 5 L 6 10 L -6 10 L -9 5 Z"
              fill="none" stroke={firingColor} strokeWidth="2" />
        {/* Superstructure stripe */}
        <line x1="-4" y1="2" x2="4" y2="2" stroke={firingColor} strokeWidth="1" opacity="0.6" />
        {/* Turret circle */}
        <circle r="4.5" cy="-1" fill={unit.isFiring ? COLORS.hostile : color}
                opacity={unit.isFiring ? 1 : 0.85} />
        {/* Gun barrel — points toward heading (forward = -Y since rotateGlyph is true) */}
        <line x1="0" y1="-1" x2="0" y2="-14" stroke={firingColor} strokeWidth="2.5" />
        {/* Muzzle flash when firing */}
        {unit.isFiring && (
          <g>
            <circle cx="0" cy="-17" r="5" fill={COLORS.hostile} opacity="0.85">
              <animate attributeName="r" values="3;8;3" dur="0.12s" repeatCount="indefinite" />
              <animate attributeName="opacity" values="0.9;0.25;0.9" dur="0.12s" repeatCount="indefinite" />
            </circle>
            <line x1="-5" y1="-13" x2="5" y2="-19" stroke={COLORS.hostile} strokeWidth="1.5">
              <animate attributeName="opacity" values="0.8;0.1;0.8" dur="0.10s" repeatCount="indefinite" />
            </line>
            <line x1="5" y1="-13" x2="-5" y2="-19" stroke={COLORS.hostile} strokeWidth="1.5">
              <animate attributeName="opacity" values="0.8;0.1;0.8" dur="0.10s" repeatCount="indefinite" />
            </line>
          </g>
        )}
      </g>
    );
  }

  return (
    <g transform={`translate(${unit.x},${unit.y})`}
       style={{ cursor: canTrack ? "crosshair" : "pointer" }}
       onMouseDown={(e) => { e.stopPropagation(); if (e.button !== 2) onClick && onClick(unit, e); }}
       onContextMenu={(e) => {
         if (onContextMenu) {
           e.preventDefault(); e.stopPropagation();
           onContextMenu(unit, e);
         }
       }}>
      {/* Hit area */}
      {!isFriendly && <circle r="22" fill="transparent" />}

      {/* ── Auto-tracked: pulsing amber ring ─────────────────────────────── */}
      {isAutoTracked && (
        <circle r="22" fill="none" stroke={COLORS.amber} strokeWidth="2" opacity="0.85">
          <animate attributeName="r" values="18;28;18" dur="1.4s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.85;0.25;0.85" dur="1.4s" repeatCount="indefinite" />
        </circle>
      )}

      {/* ── Escorted: pulsing phosphor ring (friendly being followed) ──────── */}
      {isEscorted && (
        <circle r="22" fill="none" stroke={COLORS.phosphor} strokeWidth="2" opacity="0.9">
          <animate attributeName="r" values="18;30;18" dur="1.8s" repeatCount="indefinite" />
          <animate attributeName="opacity" values="0.9;0.2;0.9" dur="1.8s" repeatCount="indefinite" />
        </circle>
      )}

      {/* ── New contact (confidence < POSSIBLE): faint amber pulse ───────── */}
      {isNewContact && !isAutoTracked && (
        <circle r="16" fill="none" stroke={COLORS.amberDim} strokeWidth="1"
                strokeDasharray="3 5" opacity="0.6">
          <animate attributeName="opacity" values="0.6;0.1;0.6" dur="2.4s" repeatCount="indefinite" />
        </circle>
      )}

      {/* ── Selected ring ─────────────────────────────────────────────────── */}
      {selected && (
        <g>
          <circle r="22" fill="none" stroke={baseColor} strokeWidth="1" strokeDasharray="3 3" opacity="0.9">
            <animateTransform attributeName="transform" type="rotate"
              from="0" to="360" dur="6s" repeatCount="indefinite" />
          </circle>
          <circle r="26" fill="none" stroke={baseColor} strokeWidth="0.5" opacity="0.4" />
        </g>
      )}

      {/* ── Possible contact dashed ring ──────────────────────────────────── */}
      {isPossible && !isAutoTracked && (
        <circle r="18" fill="none" stroke={dimColor} strokeWidth="1" strokeDasharray="2 4" opacity="0.7" />
      )}

      <g transform={rotateGlyph ? `rotate(${headingDeg + 90})` : ""}
         opacity={isNewContact ? 0.55 : isPossible ? 0.75 : 1}>
        {glyph}
      </g>

      {/* ── Labels ───────────────────────────────────────────────────────── */}
      <text x="14" y="-10" fontSize="9" fontFamily="'JetBrains Mono', monospace"
            fill={selected ? baseColor : color}
            opacity={isFriendly || !isNewContact ? 1 : 0.7}>
        {unit.label}{isNewContact ? "?" : isPossible ? "?" : ""}
      </text>

      {!isFriendly && (
        <text x="14" y="0" fontSize="6.5" fontFamily="'JetBrains Mono', monospace"
              fill={isAutoTracked ? COLORS.amber
                    : isNewContact ? COLORS.amberDim
                    : isPossible   ? COLORS.amber
                    : color}
              letterSpacing="0.1em">
          {isAutoTracked ? "AUTO-TRK"
           : isNewContact ? "NEW CNTCT"
           : isPossible   ? "POSSIBLE"
           : "CONFIRMED"}
        </text>
      )}

      {/* ── ESCORTED label (friendly unit being followed by another USV) ───── */}
      {isFriendly && isEscorted && (
        <text x="14" y="0" fontSize="6.5" fontFamily="'JetBrains Mono', monospace"
              fill={COLORS.phosphor} letterSpacing="0.1em" opacity="0.9">
          ESCORTED
        </text>
      )}

      {/* ── Health bar (units with health) ───────────────────────────────── */}
      {unit.health != null && unit.maxHealth != null && unit.maxHealth > 0 && (
        <g transform="translate(0, 18)">
          <rect x="-13" y="0" width="26" height="3"
                fill="none" stroke={color} strokeWidth="0.5" opacity="0.5" />
          <rect x="-13" y="0"
                width={26 * Math.max(0, unit.health / unit.maxHealth)} height="3"
                fill={unit.health / unit.maxHealth > 0.5 ? COLORS.phosphor :
                      unit.health / unit.maxHealth > 0.25 ? COLORS.amber : COLORS.hostile}
                opacity="0.85" />
        </g>
      )}

      {/* ── TURRET attack-mode status label ──────────────────────────────── */}
      {unit.type === "TURRET" && isFriendly && (
        <text x="14" y="0" fontSize="6.5" fontFamily="'JetBrains Mono', monospace"
              fill={unit.isFiring ? COLORS.hostile :
                    unit.attackMode ? COLORS.amber :
                    unit.attackSuppressed ? COLORS.phosphorDim : COLORS.textDim}
              letterSpacing="0.1em">
          {unit.isFiring ? "FIRING" :
           unit.attackMode ? "ARMED" :
           unit.attackSuppressed ? "SHADOW" : "SAFE"}
        </text>
      )}

      {unit.type === "COMMERCIAL" && !isPossible && !isNewContact && (
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

      {submerged && !isPossible && !isNewContact && (
        <text x="-30" y="3" fontSize="6" fontFamily="'JetBrains Mono', monospace"
              fill={isAutoTracked ? COLORS.amberDim : COLORS.subsurfaceDim}>
          ~{Math.floor(20 + Math.abs(unit.x * 13 + unit.y * 7) % 60)}m
        </text>
      )}
    </g>
  );
};
