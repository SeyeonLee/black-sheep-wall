import { Crosshair, Hexagon, Radar, RotateCcw } from "lucide-react";
import { COLORS } from "../../config";

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

export const CommandPanel = ({ state, dispatch, tool, setTool, deployType, setDeployType }) => {
  const hasSelection = state.selectedIds.length > 0;
  const hasUSVSel = state.units.some((u) => state.selectedIds.includes(u.id) && u.type === "USV");
  const hasUAVMission = state.units.some(
    (u) => state.selectedIds.includes(u.id) && u.type === "UAV" &&
           (u.state === "flying_to_mission" || u.state === "mission_orbit")
  );
  const setDeploy = (t) => { setTool("deploy"); setDeployType(t); };

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
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr 1fr", gap: 4, flexShrink: 0 }}>
        <CmdButton icon={<Crosshair size={11} />} label="MOVE"
          disabled={!hasSelection} active={tool === "select"}
          onClick={() => setTool("select")} />
        <CmdButton icon={<Hexagon size={11} />} label="PATROL"
          disabled={!hasUSVSel} active={tool === "patrol"}
          onClick={() => setTool("patrol")} />
        <CmdButton icon={<Radar size={11} />} label="HOLD"
          disabled={!hasUSVSel}
          onClick={() => dispatch({ type: "HOLD_SELECTED" })} />
        <CmdButton icon={<RotateCcw size={11} />} label="RECALL"
          disabled={!hasUAVMission} accent={COLORS.amber}
          onClick={() => dispatch({ type: "RECALL_UAV" })} />
      </div>

      {/* Deploy */}
      <div style={{ fontSize: 9, letterSpacing: "0.1em", color: COLORS.textDim, marginTop: 2, flexShrink: 0 }}>
        DEPLOY <span style={{ color: COLORS.amberDim }}>// sandbox</span>
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 4, flexShrink: 0 }}>
        <DeployButton label="+ ISR" color={COLORS.phosphor}
          active={tool === "deploy" && deployType === "ISR"} onClick={() => setDeploy("ISR")} />
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

      {/* Hint */}
      <div style={{ marginTop: "auto", fontSize: 9, lineHeight: 1.7, color: COLORS.textDim, flexShrink: 0 }}>
        {tool === "patrol" ? (
          <><span style={{ color: COLORS.phosphor }}>{">"}</span> Click vertices · R-click to close</>
        ) : tool === "deploy" ? (
          <><span style={{ color: COLORS.amber }}>{">"}</span> Click map to place {deployType.toLowerCase()}</>
        ) : (
          <>
            <span style={{ color: COLORS.phosphor }}>{">"}</span> R-click water: move USV<br />
            <span style={{ color: COLORS.phosphor }}>{">"}</span> Click contact: TRACK<br />
            <span style={{ color: COLORS.phosphor }}>{">"}</span> UAV alone → R-click: mission
          </>
        )}
      </div>
    </div>
  );
};
