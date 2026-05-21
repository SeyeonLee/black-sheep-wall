import { AlertTriangle, X } from "lucide-react";
import { COLORS } from "../config";

export const AlertFeed = ({ alerts, dispatch }) => (
  <div style={{
    width: 220, flexShrink: 0, display: "flex", flexDirection: "column",
    borderLeft: `1px solid ${COLORS.border}`,
    background: COLORS.surface,
    overflow: "hidden",
  }}>
    <div style={{
      padding: "0 10px", height: 28, flexShrink: 0,
      display: "flex", alignItems: "center", justifyContent: "space-between",
      borderBottom: `1px solid ${COLORS.border}`, background: COLORS.bg,
    }}>
      <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
        <AlertTriangle size={10} style={{ color: COLORS.amber }} />
        <span style={{
          fontSize: 10, letterSpacing: "0.2em", fontWeight: 700, color: COLORS.amberDim,
          fontFamily: "'JetBrains Mono', monospace",
        }}>ALERT.FEED</span>
      </div>
      {alerts.length > 0 && (
        <span style={{
          fontSize: 9, background: COLORS.hostile, color: "#fff",
          borderRadius: 2, padding: "0 5px", fontFamily: "'JetBrains Mono', monospace",
          fontWeight: 700,
        }}>{alerts.length}</span>
      )}
    </div>

    <div style={{
      flex: "1 1 0", overflowY: "auto", padding: "4px 6px",
      display: "flex", flexDirection: "column", gap: 3, minHeight: 0,
    }}>
      {alerts.length === 0 ? (
        <div style={{ fontSize: 9, color: COLORS.textDim, fontFamily: "'JetBrains Mono', monospace", padding: 4 }}>
          // Sensors nominal.
        </div>
      ) : alerts.map((a) => {
        const sevColor = a.severity === "high" ? COLORS.hostile :
                         a.severity === "med" ? COLORS.amber : COLORS.phosphor;
        const hasActions = a.actions && a.actions.length > 0;
        return (
          <div key={a.id} style={{
            border: `1px solid ${sevColor}`, padding: "5px 7px",
            background: `${sevColor}10`, flexShrink: 0,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div style={{
                display: "flex", alignItems: "center", gap: 3,
                fontSize: 8, color: sevColor,
                fontFamily: "'JetBrains Mono', monospace", fontWeight: 700, letterSpacing: "0.1em",
              }}>
                <AlertTriangle size={8} />
                {a.kind}
              </div>
              <button
                onClick={() => dispatch({ type: "DISMISS_ALERT", id: a.id })}
                style={{ background: "none", border: "none", cursor: "pointer", color: COLORS.textDim, padding: 0, lineHeight: 1, display: "flex" }}>
                <X size={9} />
              </button>
            </div>
            <div style={{ fontSize: 9, color: COLORS.text, fontFamily: "'JetBrains Mono', monospace", marginTop: 2, lineHeight: 1.3 }}>
              {a.title}
            </div>
            {a.body && (
              <div style={{ fontSize: 7.5, color: COLORS.textDim, fontFamily: "'JetBrains Mono', monospace", marginTop: 2, lineHeight: 1.4 }}>
                {a.body}
              </div>
            )}
            <div style={{ fontSize: 8, color: COLORS.textDim, fontFamily: "'JetBrains Mono', monospace", marginTop: 1 }}>
              T+{Math.floor(a.time)}s
            </div>
            {hasActions && (
              <div style={{ display: "flex", gap: 4, marginTop: 5 }}>
                {a.actions.map((act, i) => {
                  const isDestructive = act.label === "ENGAGE" || act.label === "CONFIRM";
                  const btnColor = isDestructive ? COLORS.hostile : COLORS.phosphor;
                  return (
                    <button key={i} onClick={() => {
                      if (act.action) dispatch(act.action);
                      dispatch({ type: "DISMISS_ALERT", id: a.id });
                    }} style={{
                      flex: 1, padding: "3px 0", fontSize: 8, fontWeight: 700,
                      fontFamily: "'JetBrains Mono', monospace",
                      background: `${btnColor}15`,
                      color: btnColor,
                      border: `1px solid ${btnColor}`,
                      cursor: "pointer", letterSpacing: "0.08em",
                    }}>
                      {act.label}
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  </div>
);
