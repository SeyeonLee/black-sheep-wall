import { useState } from "react";
import { Play, Pause, Hexagon, Power, Activity } from "lucide-react";
import { COLORS } from "../config";

export const TopBar = ({ state, dispatch, aisUsername, setAisUsername, aisStatus, onRefreshAIS }) => {
  const { paused, simSpeed, simTime } = state;
  const speeds = [1, 5, 20, 100];
  const hh = String(Math.floor(simTime / 3600)).padStart(2, "0");
  const mm = String(Math.floor((simTime % 3600) / 60)).padStart(2, "0");
  const ss = String(Math.floor(simTime % 60)).padStart(2, "0");
  const [aisDraft, setAisDraft] = useState("");

  const aisStatusColor = aisStatus === "ok" ? COLORS.ais :
                         aisStatus === "fetching" ? COLORS.amber :
                         aisStatus === "error" ? COLORS.hostile : COLORS.textDim;

  // Count synthetic AIS ships (always-on simulated fleet)
  const simShipCount = state.aisShips.length;

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "0 16px", height: 44, flexShrink: 0,
      borderBottom: `1px solid ${COLORS.border}`,
      background: COLORS.surface, color: COLORS.text,
      fontFamily: "'JetBrains Mono', monospace",
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <Hexagon size={16} style={{ color: COLORS.phosphor }} />
        <span style={{ fontWeight: 700, letterSpacing: "0.2em", fontSize: 14, fontFamily: "'Chakra Petch', monospace" }}>
          BLACK SHEEP WALL
        </span>
        <span style={{ fontSize: 11, marginLeft: 8, color: COLORS.textDim }}>// ISR.CMD.v0.4</span>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 12, fontSize: 11, fontFamily: "'JetBrains Mono', monospace" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: COLORS.phosphorDim }}>
          <Activity size={12} />
          <span>T+{hh}:{mm}:{ss}</span>
        </div>

        {/* Synthetic AIS fleet indicator */}
        {simShipCount > 0 && (
          <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
            <span style={{
              width: 6, height: 6, borderRadius: "50%", background: COLORS.ais,
              display: "inline-block", opacity: 0.9,
              boxShadow: `0 0 4px ${COLORS.ais}`,
            }} />
            <span style={{ fontSize: 9, color: COLORS.ais }}>AIS.SIM</span>
            <span style={{ fontSize: 9, color: COLORS.aisDim }}>({simShipCount})</span>
          </div>
        )}

        {/* Real AIS (AISHub) */}
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {aisUsername
            ? <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 9, color: aisStatusColor }}>
                  AIS.LIVE {aisStatus.toUpperCase()}
                </span>
                <button onClick={onRefreshAIS}
                  style={{ fontSize: 9, padding: "0 4px", border: `1px solid ${COLORS.border}`,
                           color: COLORS.aisDim, background: "transparent", cursor: "pointer" }}>↺</button>
                <button onClick={() => { setAisUsername(""); setAisDraft(""); }}
                  style={{ fontSize: 9, padding: "0 4px", border: `1px solid ${COLORS.border}`,
                           color: COLORS.textDim, background: "transparent", cursor: "pointer" }}>✕</button>
              </div>
            : <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                <span style={{ fontSize: 9, color: COLORS.textDim }}>AISHub:</span>
                <input
                  type="text" placeholder="username"
                  value={aisDraft} onChange={(e) => setAisDraft(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && aisDraft && setAisUsername(aisDraft)}
                  style={{ fontSize: 9, padding: "0 6px", height: 20, width: 90,
                           border: `1px solid ${COLORS.border}`, background: COLORS.bg,
                           color: COLORS.ais, outline: "none", fontFamily: "inherit" }}
                />
                <button onClick={() => aisDraft && setAisUsername(aisDraft)}
                  style={{ fontSize: 9, padding: "0 6px", height: 20, fontWeight: 700,
                           border: `1px solid ${COLORS.ais}`, color: COLORS.ais,
                           background: "transparent", cursor: "pointer", fontFamily: "inherit" }}>
                  CONNECT
                </button>
              </div>
          }
        </div>

        <button onClick={() => dispatch({ type: "TOGGLE_PAUSE" })}
          style={{
            display: "flex", alignItems: "center", gap: 6, padding: "4px 10px",
            border: `1px solid ${paused ? COLORS.amber : COLORS.border}`,
            background: paused ? "rgba(255,184,74,0.1)" : "transparent",
            color: paused ? COLORS.amber : COLORS.text,
            cursor: "pointer", fontFamily: "inherit", fontSize: 11,
          }}>
          {paused ? <Play size={12} /> : <Pause size={12} />}
          <span>{paused ? "RESUME" : "PAUSE"}</span>
        </button>

        <div style={{ display: "flex", border: `1px solid ${COLORS.border}` }}>
          {speeds.map((s) => (
            <button key={s} onClick={() => dispatch({ type: "SET_SPEED", speed: s })}
              style={{
                padding: "4px 10px", fontFamily: "inherit", fontSize: 11,
                background: simSpeed === s ? COLORS.phosphor : "transparent",
                color: simSpeed === s ? COLORS.bg : COLORS.text,
                fontWeight: simSpeed === s ? 700 : 400,
                border: "none", cursor: "pointer",
              }}>{s}×</button>
          ))}
        </div>
      </div>

      <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: COLORS.phosphorDim }}>
        <Power size={12} style={{ color: COLORS.phosphor }} />
        <span>LINK NOMINAL</span>
      </div>
    </div>
  );
};
