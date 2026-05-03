import { Anchor, Plane } from "lucide-react";
import { COLORS } from "../../config";
import { rad2deg } from "../../utils";

const Row = ({ k, v, vColor = COLORS.text }) => (
  <div style={{
    display: "flex", justifyContent: "space-between",
    borderBottom: `1px dashed ${COLORS.border}`, paddingBottom: 2,
  }}>
    <span style={{ color: COLORS.textDim }}>{k}</span>
    <span style={{ color: vColor }}>{v}</span>
  </div>
);

const BatteryBar = ({ value }) => {
  const color = value > 60 ? COLORS.phosphor : value > 30 ? COLORS.amber : COLORS.hostile;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div style={{ width: 36, height: 4, border: `1px solid ${COLORS.border}`, background: COLORS.bg }}>
        <div style={{ width: `${value}%`, height: "100%", background: color }} />
      </div>
      <span style={{ fontSize: 9, color, minWidth: 26 }}>
        {Math.floor(value)}%
      </span>
    </div>
  );
};

export const StatusPanel = ({ state, dispatch }) => {
  const friendly = state.units.filter((u) => u.faction === "friendly");
  const selectedFriendly = state.units.filter((u) => state.selectedIds.includes(u.id));
  const usvSel = selectedFriendly.find((u) => u.type === "USV");

  const onRosterClick = (u) => {
    if (u.type === "USV") {
      const ids = [u.id, ...state.units.filter((x) => x.parentId === u.id).map((x) => x.id)];
      dispatch({ type: "SELECT", ids });
    } else dispatch({ type: "SELECT", ids: [u.id] });
  };

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", fontSize: 12, fontFamily: "'JetBrains Mono', monospace" }}>
      <div style={{ padding: 8, borderBottom: `1px solid ${COLORS.border}`, flexShrink: 0 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.1em", marginBottom: 6, color: COLORS.textDim }}>
          FORCE.ROSTER
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 4, maxHeight: 96, overflowY: "auto" }}>
          {friendly.map((u) => {
            const isSel = state.selectedIds.includes(u.id);
            return (
              <button key={u.id} onClick={() => onRosterClick(u)}
                style={{
                  width: "100%", textAlign: "left", padding: "4px 8px",
                  border: `1px solid ${isSel ? COLORS.phosphor : COLORS.border}`,
                  background: isSel ? "rgba(184,255,94,0.06)" : "transparent",
                  display: "flex", alignItems: "center", justifyContent: "space-between",
                  cursor: "pointer", fontFamily: "inherit",
                }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  {u.type === "USV" && <Anchor size={10} style={{ color: COLORS.phosphor, flexShrink: 0 }} />}
                  {u.type === "UAV" && <Plane size={10} style={{ color: COLORS.phosphor, flexShrink: 0 }} />}
                  <span style={{ color: isSel ? COLORS.phosphor : COLORS.text }}>{u.label}</span>
                  <span style={{ fontSize: 9, color: COLORS.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {u.state.toUpperCase()}
                  </span>
                </div>
                <BatteryBar value={u.battery} />
              </button>
            );
          })}
        </div>
      </div>

      <div style={{ padding: 8, flex: "1 1 0", overflowY: "auto", minHeight: 0 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.1em", marginBottom: 6, color: COLORS.textDim }}>SELECTED</div>
        {usvSel ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10, color: COLORS.text }}>
            <Row k="UNIT" v={usvSel.label} />
            <Row k="TYPE" v={usvSel.type} />
            <Row k="STATE" v={usvSel.state.toUpperCase()}
                 vColor={
                   usvSel.state === "patrolling" ? COLORS.amber :
                   usvSel.state === "tracking" ? COLORS.amber :
                   usvSel.state === "jammed" ? COLORS.hostile :
                   COLORS.phosphor
                 } />
            {usvSel.engageTargetId && (() => {
              const tgt = state.units.find((x) => x.id === usvSel.engageTargetId);
              return tgt ? <Row k="TRACK" v={tgt.label} vColor={COLORS.amber} /> : null;
            })()}
            <Row k="POS" v={`${Math.round(usvSel.x)}, ${Math.round(usvSel.y)}`} />
            <Row k="HDG" v={`${(Math.round(rad2deg(usvSel.heading)) + 360) % 360}°`} />
            <Row k="BATT" v={`${Math.round(usvSel.battery)}%`}
                 vColor={usvSel.battery > 60 ? COLORS.phosphor :
                         usvSel.battery > 30 ? COLORS.amber : COLORS.hostile} />
            <Row k="GROUP" v={`+${selectedFriendly.length - 1} attached`} />
          </div>
        ) : (
          <div style={{ color: COLORS.textDim, fontSize: 10 }}>
            // No unit selected.<br />
            // Click roster or drag-box on map.
          </div>
        )}
      </div>

      <div style={{
        padding: "4px 8px", borderTop: `1px solid ${COLORS.border}`,
        display: "flex", justifyContent: "space-between", fontSize: 9,
        background: COLORS.bg, color: COLORS.textDim, flexShrink: 0,
      }}>
        <span>GPS: <span style={{ color: state.jamZones.length > 0 ? COLORS.amber : COLORS.phosphor }}>
          {state.jamZones.length > 0 ? "DEGRADED" : "OK"}
        </span></span>
        <span>SNR: <span style={{ color: COLORS.phosphor }}>OK</span></span>
        <span>JAM.Z: <span style={{ color: state.jamZones.length > 0 ? COLORS.hostile : COLORS.textDim }}>
          {state.jamZones.length}
        </span></span>
      </div>
    </div>
  );
};
