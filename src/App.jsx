import { useState, useEffect, useRef, useReducer, useCallback } from "react";
import { Hexagon, Activity, Camera, Crosshair } from "lucide-react";

import { CONFIG, COLORS } from "./config";
import { worldToGeo, decodeAISType, geoToWorld } from "./utils";
import { makeInitialState, generateAISFleet, pointAlongRoute } from "./sim/factories";
import { reducer } from "./sim/reducer";

import { TopBar } from "./components/TopBar";
import { MapView } from "./components/MapView";
import { AlertFeed } from "./components/AlertFeed";
import { DockPanel } from "./components/DockPanel";
import { TacticalOverviewPanel } from "./components/panels/TacticalOverviewPanel";
import { StatusPanel } from "./components/panels/StatusPanel";
import { VisualIntelPanel } from "./components/panels/VisualIntelPanel";
import { CommandPanel } from "./components/panels/CommandPanel";
import { CursorStrip, ScanlineOverlay } from "./components/CursorStrip";

export default function App() {
  const [state, dispatch] = useReducer(reducer, undefined, makeInitialState);
  const [tool, setTool] = useState("select");
  const [deployType, setDeployType] = useState("ENEMY");
  const [hover, setHover] = useState(null);
  const [cursorWorld, setCursorWorld] = useState(null);
  // Camera centred on the ISR spawn at (2400, 1900) — middle of the First Island Chain
  const [cam, setCam] = useState(() => {
    const zoom = 0.9;
    const vbW = CONFIG.WORLD_W / zoom;
    const vbH = CONFIG.WORLD_H / zoom;
    return { x: 2400 - vbW / 2, y: 1900 - vbH / 2, zoom };
  });
  const [aisUsername, setAisUsername] = useState("");
  const [aisStatus, setAisStatus] = useState("disconnected");
  const aisUsernameRef = useRef(aisUsername);
  aisUsernameRef.current = aisUsername;

  // Synthetic AIS fleet — always running, advances on every AIS_TICK_MS interval
  const fleetRef = useRef(null);
  useEffect(() => {
    fleetRef.current = generateAISFleet();
    dispatch({ type: "SET_AIS_SHIPS", ships: fleetRef.current });

    const id = setInterval(() => {
      if (!fleetRef.current) return;
      fleetRef.current = fleetRef.current.map((ship) => {
        // routePos wraps 0→1 (sinusoidal bounce inside pointAlongRoute)
        const newRoutePos = ship.routePos + ship.routeSpeed;
        const geo = pointAlongRoute(ship.route, newRoutePos);
        const wp = geoToWorld(geo.lat, geo.lon);
        // Approximate heading from position delta
        const dx = wp.x - ship.wx, dy = wp.y - ship.wy;
        const cog = dx !== 0 || dy !== 0
          ? (Math.atan2(dy, dx) * 180 / Math.PI + 360) % 360
          : ship.cog;
        return {
          ...ship,
          routePos: newRoutePos,
          lat: geo.lat, lon: geo.lon,
          wx: wp.x, wy: wp.y,
          cog, heading: cog,
        };
      });
      dispatch({ type: "SET_AIS_SHIPS", ships: fleetRef.current });
    }, CONFIG.AIS_TICK_MS);

    return () => clearInterval(id);
  }, []);

  // Simulation tick
  useEffect(() => {
    if (state.paused) return;
    const id = setInterval(() => dispatch({ type: "TICK" }), CONFIG.TICK_MS);
    return () => clearInterval(id);
  }, [state.paused]);

  // Real AIS fetch (AISHub — optional)
  const fetchAIS = useCallback(async (username) => {
    if (!username) return;
    setAisStatus("fetching");
    const usv = state.units.find((u) => u.type === "USV");
    const centre = usv ? worldToGeo(usv.x, usv.y) : { lat: 25, lon: 122 };
    const pad = CONFIG.AIS_RANGE_DEG;
    const latMin = (centre.lat - pad).toFixed(2);
    const latMax = (centre.lat + pad).toFixed(2);
    const lonMin = (centre.lon - pad).toFixed(2);
    const lonMax = (centre.lon + pad).toFixed(2);
    const aisUrl = `https://data.aishub.net/ws.php?username=${username}&format=1&output=json&compress=0&latmin=${latMin}&latmax=${latMax}&lonmin=${lonMin}&lonmax=${lonMax}`;
    const proxyUrl = `https://corsproxy.io/?${encodeURIComponent(aisUrl)}`;
    try {
      const res = await fetch(proxyUrl);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      const shipArr = Array.isArray(raw) && raw.length >= 2 && Array.isArray(raw[1])
        ? raw[1]
        : Array.isArray(raw) ? raw : [];
      const ships = shipArr
        .filter((s) => s.MMSI && s.LATITUDE && s.LONGITUDE)
        .map((s) => {
          const wp = geoToWorld(parseFloat(s.LATITUDE), parseFloat(s.LONGITUDE));
          return {
            mmsi:    String(s.MMSI),
            name:    (s.NAME || "").trim() || `MMSI-${s.MMSI}`,
            lat:     parseFloat(s.LATITUDE),
            lon:     parseFloat(s.LONGITUDE),
            wx:      wp.x,
            wy:      wp.y,
            cog:     parseFloat(s.COG) || 0,
            sog:     parseFloat(s.SOG) || 0,
            heading: parseFloat(s.HEADING) || parseFloat(s.COG) || 0,
            type:    decodeAISType(s.TYPE),
            flag:    s.FLAG || "—",
            dest:    (s.DEST || "—").trim(),
            imo:     s.IMO ? String(s.IMO) : null,
          };
        });
      // Merge real AIS on top of synthetic fleet
      const syntheticOnly = (fleetRef.current || []).filter(
        (s) => !ships.find((r) => r.mmsi === s.mmsi)
      );
      dispatch({ type: "SET_AIS_SHIPS", ships: [...ships, ...syntheticOnly] });
      setAisStatus("ok");
    } catch (err) {
      console.warn("AIS fetch failed:", err.message);
      setAisStatus("error");
    }
  }, [state.units]);

  useEffect(() => {
    if (!aisUsername) { setAisStatus("disconnected"); return; }
    fetchAIS(aisUsername);
    const id = setInterval(() => fetchAIS(aisUsernameRef.current), CONFIG.AIS_FETCH_MS);
    return () => clearInterval(id);
  }, [aisUsername]);

  // CSS reset injected once
  useEffect(() => {
    const style = document.createElement("style");
    style.id = "bsw-reset";
    style.textContent = `
      *, *::before, *::after { box-sizing: border-box; }
      html, body {
        margin: 0; padding: 0;
        width: 100%; height: 100%;
        overflow: hidden;
        background: #08100c;
      }
      #root, #app {
        width: 100%; height: 100%;
        display: flex; flex-direction: column;
      }
    `;
    document.head.appendChild(style);
    return () => { try { document.head.removeChild(style); } catch (e) {} };
  }, []);

  // Fonts
  useEffect(() => {
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?family=Chakra+Petch:wght@400;600;700&family=JetBrains+Mono:wght@400;500;700&display=swap";
    document.head.appendChild(link);
    return () => { try { document.head.removeChild(link); } catch (e) {} };
  }, []);

  // Keyboard shortcuts
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === " ") { e.preventDefault(); dispatch({ type: "TOGGLE_PAUSE" }); }
      if (e.key === "Escape") { setTool("select"); dispatch({ type: "SELECT", ids: [] }); }
      if (e.key === "p" || e.key === "P") setTool("patrol");
      if (e.key === "h" || e.key === "H") dispatch({ type: "HOLD_SELECTED" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div style={{
      position: "fixed", inset: 0,
      display: "flex", flexDirection: "column", overflow: "hidden",
      background: COLORS.bg, color: COLORS.text,
      fontFamily: "'JetBrains Mono', 'Courier New', monospace",
    }}>
      <TopBar state={state} dispatch={dispatch}
              aisUsername={aisUsername} setAisUsername={setAisUsername}
              aisStatus={aisStatus} onRefreshAIS={() => fetchAIS(aisUsername)} />

      {/* Map area + alert feed side by side */}
      <div style={{ flex: "1 1 0", minHeight: 0, display: "flex", overflow: "hidden" }}>
        <div style={{ flex: "1 1 0", position: "relative", overflow: "hidden" }}>
          <MapView state={state} dispatch={dispatch}
            tool={tool} setTool={setTool} deployType={deployType}
            setHover={setHover} setCursorWorld={setCursorWorld}
            cam={cam} setCam={setCam} />
        </div>
        <AlertFeed alerts={state.alerts} dispatch={dispatch} />
      </div>

      {/* Bottom dock — 260px tall so all four panels have room */}
      <div style={{
        height: 260, flexShrink: 0, display: "flex",
        borderTop: `1px solid ${COLORS.border}`,
      }}>
        <DockPanel title="TACTICAL.OVERVIEW" width={260}
          icon={<Hexagon size={10} style={{ color: COLORS.phosphor }} />}>
          <TacticalOverviewPanel state={state} cam={cam} setCam={setCam} />
        </DockPanel>
        <DockPanel title="STATUS" width={300}
          icon={<Activity size={10} style={{ color: COLORS.phosphor }} />}>
          <StatusPanel state={state} dispatch={dispatch} />
        </DockPanel>
        <DockPanel title="VISUAL.INTEL" width={280}
          icon={<Camera size={10} style={{ color: COLORS.phosphor }} />}>
          <VisualIntelPanel state={state} dispatch={dispatch} />
        </DockPanel>
        <DockPanel title="COMMAND" flex
          icon={<Crosshair size={10} style={{ color: COLORS.phosphor }} />}>
          <CommandPanel state={state} dispatch={dispatch}
            tool={tool} setTool={setTool}
            deployType={deployType} setDeployType={setDeployType} />
        </DockPanel>
      </div>

      <CursorStrip cursorWorld={cursorWorld} state={state} />
      <ScanlineOverlay />
    </div>
  );
}
