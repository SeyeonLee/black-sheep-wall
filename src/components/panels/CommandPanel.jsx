import { useState } from "react";
import { Crosshair, Hexagon, Radar, RotateCcw, Target, Settings } from "lucide-react";
import { COLORS, CONFIG } from "../../config";

const CmdButton = ({ icon, label, active, disabled, onClick, accent }) => {
  const baseColor = accent || COLORS.phosphor;
  return (
    <button onClick={onClick} disabled={disabled}
      style={{
        padding: "7px 4px", border: `1px solid ${active ? baseColor : COLORS.border}`,
        background: active ? `${baseColor}14` : "transparent",
        color: disabled ? COLORS.textDim : (active ? baseColor : COLORS.text),
        opacity: disabled ? 0.35 : 1, cursor: disabled ? "not-allowed" : "pointer",
        display: "flex", flexDirection: "column", alignItems: "center", gap: 3,
        fontFamily: "'JetBrains Mono', monospace",
      }}>
      {icon}
      <span style={{ fontSize: 8, fontWeight: 700, letterSpacing: "0.08em" }}>{label}</span>
    </button>
  );
};

const DeployButton = ({ label, color, active, onClick }) => (
  <button onClick={onClick}
    style={{
      padding: "5px 4px", border: `1px solid ${active ? color : COLORS.border}`,
      color, background: active ? `${color}14` : "transparent",
      fontSize: 8, fontWeight: 700, letterSpacing: "0.04em",
      cursor: "pointer", fontFamily: "'JetBrains Mono', monospace",
    }}>{label}</button>
);

export const uavStateLabel = (s) => ({
  flying_to_mission: "TO MISSION",
  mission_orbit:     "ON MISSION",
})[s] || s.toUpperCase().replace(/_/g, " ");

// ─── Settings panel ────────────────────────────────────────────────────────────
const SETTINGS_FIELDS = [
  { type: "USV",        label: "ISR BOAT",   fields: [
    { key: "speed",  label: "SPD",    min: 0.1, max: 5,    step: 0.05, cfgKey: "USV_SPEED" },
    { key: "battery",label: "BATT%",  min: 10,  max: 100,  step: 5  },
    { key: "health", label: "HP",     min: 1,   max: 500,  step: 5  },
  ]},
  { type: "TURRET",     label: "TURRET",     fields: [
    { key: "speed",  label: "SPD",    min: 0.1, max: 5,    step: 0.05, cfgKey: "TURRET_SPEED" },
    { key: "battery",label: "BATT%",  min: 10,  max: 100,  step: 5  },
    { key: "health", label: "HP",     min: 1,   max: 500,  step: 5  },
  ]},
  { type: "ENEMY",      label: "HOSTILE",    fields: [
    { key: "speed",  label: "SPD",    min: 0.05,max: 5,    step: 0.05, cfgKey: "ENEMY_SPEED" },
    { key: "health", label: "HP",     min: 100, max: 10000,step: 100 },
  ]},
  { type: "COMMERCIAL", label: "MERCHANT",   fields: [
    { key: "speed",  label: "SPD",    min: 0.02,max: 3,    step: 0.02, cfgKey: "COMMERCIAL_SPEED" },
    { key: "health", label: "HP",     min: 100, max: 10000,step: 100 },
  ]},
  { type: "SUBMARINE",  label: "SUBMARINE",  fields: [
    { key: "speed",  label: "SPD",    min: 0.05,max: 3,    step: 0.05, cfgKey: "SUBMARINE_SPEED" },
    { key: "health", label: "HP",     min: 100, max: 10000,step: 100 },
  ]},
  { type: "MINE",       label: "MINE",       fields: [
    { key: "health", label: "HP",     min: 1,   max: 50,   step: 1   },
  ]},
];

const SettingsPanel = ({ unitSettings, dispatch }) => (
  <div style={{
    padding: "6px 8px", borderTop: `1px solid ${COLORS.border}`,
    display: "flex", flexDirection: "column", gap: 6,
    background: COLORS.surface,
  }}>
    <div style={{ fontSize: 9, letterSpacing: "0.1em", color: COLORS.textDim }}>
      UNIT.SETTINGS <span style={{ color: COLORS.amberDim }}>// affects new spawns</span>
    </div>
    {SETTINGS_FIELDS.map(({ type, label, fields }) => (
      <div key={type}>
        <div style={{ fontSize: 8, color: COLORS.phosphorDim, letterSpacing: "0.12em", marginBottom: 3 }}>
          {label}
        </div>
        <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
          {fields.map(({ key, label: fLabel, min, max, step, cfgKey }) => {
            const defaultVal = cfgKey ? CONFIG[cfgKey] : undefined;
            const val = unitSettings?.[type]?.[key] ?? defaultVal ?? "";
            return (
              <label key={key} style={{ display: "flex", flexDirection: "column", gap: 2, flex: "1 1 60px" }}>
                <span style={{ fontSize: 7.5, color: COLORS.textDim, fontFamily: "'JetBrains Mono', monospace", letterSpacing: "0.08em" }}>
                  {fLabel}
                </span>
                <input
                  type="number" min={min} max={max} step={step}
                  value={val}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    if (!isNaN(v)) dispatch({ type: "SET_UNIT_SETTINGS", unitType: type, key, value: v });
                  }}
                  style={{
                    background: COLORS.bg, color: COLORS.text, border: `1px solid ${COLORS.border}`,
                    fontFamily: "'JetBrains Mono', monospace", fontSize: 9, padding: "2px 4px",
                    width: "100%", boxSizing: "border-box",
                  }}
                />
              </label>
            );
          })}
        </div>
      </div>
    ))}
  </div>
);

export const CommandPanel = ({ state, dispatch, tool, setTool, deployType, setDeployType }) => {
  const [showSettings, setShowSettings] = useState(false);
  const hasSelection = state.selectedIds.length > 0;
  const hasUSVSel = state.units.some((u) => state.selectedIds.includes(u.id) && u.type === "USV");
  const hasTurretSel = state.units.some((u) => state.selectedIds.includes(u.id) && u.type === "TURRET");
  const hasUAVMission = state.units.some(
    (u) => state.selectedIds.includes(u.id) && u.type === "UAV" &&
           (u.state === "flying_to_mission" || u.state === "mission_orbit")
  );
  // Turrets that have a target but aren't authorized (can hit ATTACK to arm them)
  const hasArmedTurrets = state.units.some(
    (u) => state.selectedIds.includes(u.id) && u.type === "TURRET" && u.engageTargetId && u.attackMode
  );
  const hasPendingTurrets = state.units.some(
    (u) => state.selectedIds.includes(u.id) && u.type === "TURRET" && u.engageTargetId && !u.attackMode
  );

  const setDeploy = (t) => { setTool("deploy"); setDeployType(t); };

  const onAttackClick = () => {
    const trtIds = state.units
      .filter((u) => state.selectedIds.includes(u.id) && u.type === "TURRET")
      .map((u) => u.id);
    trtIds.forEach((id) => dispatch({ type: "TURRET_ATTACK_AUTHORIZE", turretId: id }));
  };

  return (
    <div style={{
      height: "100%", overflowY: "auto", padding: "8px 8px 4px",
      display: "flex", flexDirection: "column", gap: 6,
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      {/* Orders */}
      <div style={{ fontSize: 9, letterSpacing: "0.1em", color: COLORS.textDim, flexShrink: 0 }}>
        ORDERS {!hasSelection && <span style={{ color: COLORS.amberDim }}>// no selection</span>}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr 1fr", gap: 4, flexShrink: 0 }}>
        <CmdButton icon={<Crosshair size={11} />} label="MOVE"
          disabled={!hasSelection} active={tool === "select"}
          onClick={() => setTool("select")} />
        <CmdButton icon={<Hexagon size={11} />} label="PATROL"
          disabled={!hasUSVSel && !hasTurretSel} active={tool === "patrol"}
          onClick={() => setTool("patrol")} />
        <CmdButton icon={<Radar size={11} />} label="HOLD"
          disabled={!hasUSVSel && !hasTurretSel}
          onClick={() => dispatch({ type: "HOLD_SELECTED" })} />
        <CmdButton icon={<RotateCcw size={11} />} label="RECALL"
          disabled={!hasUAVMission} accent={COLORS.amber}
          onClick={() => dispatch({ type: "RECALL_UAV" })} />
        <CmdButton icon={<Target size={11} />} label="ATTACK"
          disabled={!hasTurretSel}
          active={hasArmedTurrets}
          accent={hasPendingTurrets ? COLORS.amber : COLORS.hostile}
          onClick={onAttackClick} />
      </div>

      {/* Deploy */}
      <div style={{ fontSize: 9, letterSpacing: "0.1em", color: COLORS.textDim, marginTop: 2, flexShrink: 0 }}>
        DEPLOY <span style={{ color: COLORS.amberDim }}>// sandbox</span>
        <button onClick={() => setShowSettings((v) => !v)}
          style={{
            marginLeft: 6, background: showSettings ? `${COLORS.amber}20` : "transparent",
            border: `1px solid ${showSettings ? COLORS.amber : COLORS.border}`,
            color: showSettings ? COLORS.amber : COLORS.textDim,
            cursor: "pointer", padding: "1px 5px", display: "inline-flex", alignItems: "center",
            verticalAlign: "middle",
          }}>
          <Settings size={9} />
        </button>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, flexShrink: 0 }}>
        <DeployButton label="+ ISR" color={COLORS.phosphor}
          active={tool === "deploy" && deployType === "ISR"} onClick={() => setDeploy("ISR")} />
        <DeployButton label="+ TURRET" color={COLORS.amber}
          active={tool === "deploy" && deployType === "TURRET"} onClick={() => setDeploy("TURRET")} />
        <DeployButton label="+ MERCHANT" color={COLORS.neutral}
          active={tool === "deploy" && deployType === "COMMERCIAL"} onClick={() => setDeploy("COMMERCIAL")} />
        <DeployButton label="+ HOSTILE" color={COLORS.hostile}
          active={tool === "deploy" && deployType === "ENEMY"} onClick={() => setDeploy("ENEMY")} />
        <DeployButton label="+ SUB" color={COLORS.subsurface}
          active={tool === "deploy" && deployType === "SUBMARINE"} onClick={() => setDeploy("SUBMARINE")} />
        <DeployButton label="+ MINE" color={COLORS.subsurface}
          active={tool === "deploy" && deployType === "MINE"} onClick={() => setDeploy("MINE")} />
        <DeployButton label="+ JAM" color={COLORS.amber}
          active={tool === "deploy" && deployType === "JAM"} onClick={() => setDeploy("JAM")} />
      </div>

      {/* Settings panel (toggle) */}
      {showSettings && (
        <SettingsPanel unitSettings={state.unitSettings} dispatch={dispatch} />
      )}

      {/* Hint */}
      <div style={{ marginTop: "auto", fontSize: 9, lineHeight: 1.7, color: COLORS.textDim, flexShrink: 0 }}>
        {tool === "patrol" ? (
          <><span style={{ color: COLORS.phosphor }}>{">"}</span> Click vertices · R-click to close</>
        ) : tool === "deploy" ? (
          <><span style={{ color: COLORS.amber }}>{">"}</span> Click map to place {deployType.toLowerCase()}</>
        ) : (
          <>
            <span style={{ color: COLORS.phosphor }}>{">"}</span> R-click water: move/mission<br />
            <span style={{ color: COLORS.phosphor }}>{">"}</span> Click contact: TRACK<br />
            <span style={{ color: COLORS.phosphor }}>{">"}</span> ATTACK btn: arm selected turrets
          </>
        )}
      </div>
    </div>
  );
};
