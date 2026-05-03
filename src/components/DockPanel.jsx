import { COLORS } from "../config";

export const DockPanel = ({ title, icon, width, children, accent = COLORS.phosphorDim, flex }) => (
  <div style={{
    display: "flex", flexDirection: "column", flexShrink: 0, overflow: "hidden",
    width: flex ? undefined : width,
    flex: flex ? "1 1 0" : undefined,
    borderRight: `1px solid ${COLORS.border}`,
    background: COLORS.surface,
  }}>
    <div style={{
      display: "flex", alignItems: "center", gap: 6,
      padding: "0 12px", height: 28, flexShrink: 0,
      borderBottom: `1px solid ${COLORS.border}`,
      background: COLORS.bg,
    }}>
      {icon}
      <span style={{
        fontSize: 10, letterSpacing: "0.25em", fontWeight: 700, color: accent,
        fontFamily: "'JetBrains Mono', monospace",
      }}>
        {title}
      </span>
    </div>
    <div style={{ flex: "1 1 0", overflow: "hidden", minHeight: 0 }}>{children}</div>
  </div>
);
