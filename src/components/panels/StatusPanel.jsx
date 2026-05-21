import { Anchor, Plane, Crosshair } from "lucide-react";
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

const HealthBar = ({ value, max }) => {
  const pct = max > 0 ? Math.max(0, value / max) : 0;
  const color = pct > 0.5 ? COLORS.phosphor : pct > 0.25 ? COLORS.amber : COLORS.hostile;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div style={{ width: 36, height: 4, border: `1px solid ${COLORS.border}`, background: COLORS.bg }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: color }} />
      </div>
      <span style={{ fontSize: 9, color, minWidth: 36 }}>
        {Math.round(value)}/{max}
      </span>
    </div>
  );
};

const AmmoBar = ({ value, max }) => {
  const pct = max > 0 ? Math.max(0, value / max) : 0;
  const color = pct > 0.4 ? COLORS.phosphor : pct > 0.15 ? COLORS.amber : COLORS.hostile;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
      <div style={{ width: 36, height: 4, border: `1px solid ${COLORS.border}`, background: COLORS.bg }}>
        <div style={{ width: `${pct * 100}%`, height: "100%", background: color }} />
      </div>
      <span style={{ fontSize: 9, color, minWidth: 36 }}>
        {Math.round(value)}/{max}
      </span>
    </div>
  );
};

export const StatusPanel = ({ state, dispatch }) => {
  const friendly = state.units.filter((u) => u.faction === "friendly");
  const selectedFriendly = state.units.filter((u) => state.selectedIds.includes(u.id));
  const usvSel = selectedFriendly.find((u) => u.type === "USV");
  const trtSel = !usvSel && selectedFriendly.find((u) => u.type === "TURRET");

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
                  {u.type === "USV"    && <Anchor   size={10} style={{ color: COLORS.phosphor, flexShrink: 0 }} />}
                  {u.type === "UAV"    && <Plane     size={10} style={{ color: COLORS.phosphor, flexShrink: 0 }} />}
                  {u.type === "TURRET" && <Crosshair size={10} style={{ color: COLORS.amber,   flexShrink: 0 }} />}
                  <span style={{ color: isSel ? COLORS.phosphor : COLORS.text }}>{u.label}</span>
                  <span style={{ fontSize: 9, color: COLORS.textDim, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {u.state.toUpperCase().replace(/_/g, " ")}
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

        {/* ── USV selected ──────────────────────────────────────────────────── */}
        {usvSel ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10, color: COLORS.text }}>
            <Row k="UNIT" v={usvSel.label} />
            <Row k="TYPE" v={usvSel.type} />
            <Row k="STATE" v={usvSel.state.toUpperCase().replace(/_/g, " ")}
                 vColor={
                   usvSel.state === "patrolling" ? COLORS.amber :
                   usvSel.state === "tracking"   ? COLORS.amber :
                   usvSel.state === "jammed"     ? COLORS.hostile :
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
            {usvSel.health != null && (
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px dashed ${COLORS.border}`, paddingBottom: 2 }}>
                <span style={{ color: COLORS.textDim }}>HEALTH</span>
                <HealthBar value={usvSel.health} max={usvSel.maxHealth} />
              </div>
            )}
            <Row k="GROUP" v={`+${selectedFriendly.length - 1} attached`} />
          </div>

        /* ── TURRET selected ─────────────────────────────────────────────── */
        ) : trtSel ? (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 10, color: COLORS.text }}>
            <Row k="UNIT" v={trtSel.label} />
            <Row k="TYPE" v="TURRET" />
            <Row k="STATE" v={trtSel.state.toUpperCase().replace(/_/g, " ")}
                 vColor={
                   trtSel.isFiring    ? COLORS.hostile :
                   trtSel.state === "tracking"   ? COLORS.amber :
                   trtSel.state === "patrolling" ? COLORS.amber :
                   trtSel.state === "jammed"     ? COLORS.hostile :
                   COLORS.phosphor
                 } />
            <Row k="WEAPON"
                 v={trtSel.isFiring ? "FIRING" : trtSel.attackMode ? "ARMED" : trtSel.attackSuppressed ? "SHADOW" : "SAFE"}
                 vColor={trtSel.isFiring ? COLORS.hostile : trtSel.attackMode ? COLORS.amber : COLORS.phosphor} />
            {trtSel.engageTargetId && (() => {
              const tgt = state.units.find((x) => x.id === trtSel.engageTargetId);
              return tgt ? <Row k="TARGET" v={tgt.label} vColor={COLORS.hostile} /> : null;
            })()}
            <Row k="POS" v={`${Math.round(trtSel.x)}, ${Math.round(trtSel.y)}`} />
            <Row k="HDG" v={`${(Math.round(rad2deg(trtSel.heading)) + 360) % 360}°`} />
            <Row k="BATT" v={`${Math.round(trtSel.battery)}%`}
                 vColor={trtSel.battery > 60 ? COLORS.phosphor :
                         trtSel.battery > 30 ? COLORS.amber : COLORS.hostile} />
            {trtSel.ammo != null && (
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px dashed ${COLORS.border}`, paddingBottom: 2 }}>
                <span style={{ color: COLORS.textDim }}>AMMO</span>
                <AmmoBar value={trtSel.ammo} max={trtSel.maxAmmo} />
              </div>
            )}
            {trtSel.health != null && (
              <div style={{ display: "flex", justifyContent: "space-between", borderBottom: `1px dashed ${COLORS.border}`, paddingBottom: 2 }}>
                <span style={{ color: COLORS.textDim }}>HEALTH</span>
                <HealthBar value={trtSel.health} max={trtSel.maxHealth} />
              </div>
            )}
            {/* Quick-arm button */}
            {trtSel.engageTargetId && !trtSel.attackMode && (
              <button onClick={() => dispatch({ type: "TURRET_ATTACK_AUTHORIZE", turretId: trtSel.id })}
                style={{
                  marginTop: 4, padding: "5px 0",
                  background: `${COLORS.hostile}18`, border: `1px solid ${COLORS.hostile}`,
                  color: COLORS.hostile, cursor: "pointer",
                  fontFamily: "'JetBrains Mono', monospace", fontSize: 9, fontWeight: 700, letterSpacing: "0.1em",
                }}>
                ▶ ARM WEAPONS
              </button>
            )}
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
