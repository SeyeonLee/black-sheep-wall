import { CONFIG, COLORS } from "../config";
import { isUnderwater } from "../utils";

export const CursorStrip = ({ cursorWorld, state }) => {
  const friendlyCount = state.units.filter((u) => u.faction === "friendly").length;
  const detectedHostile = Object.entries(state.detections).filter(
    ([id, d]) => d.confidence > CONFIG.POSSIBLE_THRESHOLD &&
                 state.units.find((u) => u.id === id)?.faction === "hostile"
  ).length;
  const subsurfaceContacts = Object.entries(state.detections).filter(
    ([id, d]) => d.confidence > CONFIG.POSSIBLE_THRESHOLD &&
                 isUnderwater(state.units.find((u) => u.id === id) || {})
  ).length;

  return (
    <div style={{
      height: 24, display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 12px", flexShrink: 0,
      borderTop: `1px solid ${COLORS.border}`,
      background: COLORS.bg, color: COLORS.textDim,
      fontFamily: "'JetBrains Mono', monospace", fontSize: 10,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <span>CRSR: <span style={{ color: COLORS.phosphor }}>
          {cursorWorld ? `${cursorWorld.x.toFixed(0)}, ${cursorWorld.y.toFixed(0)}` : "----, ----"}
        </span></span>
        <span>SEL: <span style={{ color: COLORS.phosphor }}>{state.selectedIds.length}</span></span>
        <span>FRIENDLY: <span style={{ color: COLORS.phosphor }}>{friendlyCount}</span></span>
        <span>HOSTILE: <span style={{ color: COLORS.hostile }}>{detectedHostile}</span></span>
        <span>SUB.SFC: <span style={{ color: COLORS.subsurface }}>{subsurfaceContacts}</span></span>
        {state.aisShips.length > 0 && (
          <span>AIS.SIM: <span style={{ color: COLORS.ais }}>{state.aisShips.length}</span></span>
        )}
      </div>
      <div style={{ color: COLORS.phosphorDim }}>BLACK SHEEP WALL // PHASE 3</div>
    </div>
  );
};

export const ScanlineOverlay = () => (
  <div style={{
    pointerEvents: "none", position: "absolute", inset: 0, zIndex: 100,
    backgroundImage: `repeating-linear-gradient(
      0deg, rgba(0,0,0,0.12) 0px, rgba(0,0,0,0.12) 1px,
      transparent 1px, transparent 3px
    )`,
    mixBlendMode: "multiply",
  }} />
);
