import { useState, useRef } from "react";
import { Camera, Image as ImageIcon } from "lucide-react";
import { CONFIG, COLORS } from "../../config";
import { dist } from "../../utils";

export const VisualIntelPanel = ({ state, dispatch }) => {
  const [apiKey, setApiKey]       = useState("");
  const [keyDraft, setKeyDraft]   = useState("");
  const [imageDataUrl, setImageDataUrl] = useState(null);
  const [imageBase64, setImageBase64]   = useState(null);
  const [imageMime, setImageMime] = useState("image/jpeg");
  const [analyzing, setAnalyzing] = useState(false);
  const [extraction, setExtraction]   = useState(null);
  const [comparison, setComparison]   = useState(null);
  const [aisTarget, setAisTarget]     = useState(null);
  const [deployedTarget, setDeployedTarget] = useState(null);
  const [error, setError]         = useState(null);
  const [isDragOver, setIsDragOver]   = useState(false);
  const fileInputRef = useRef(null);

  const selectedUAVs = state.units.filter(
    (u) => state.selectedIds.includes(u.id) && u.type === "UAV"
  );
  const singleUAVSelected = selectedUAVs.length === 1;
  const activeUAV = singleUAVSelected ? selectedUAVs[0] : null;

  const findNearestAIS = () => {
    if (!activeUAV) return null;
    const pool = state.aisShips.filter((s) => dist(activeUAV, { x: s.wx, y: s.wy }) < 500);
    if (!pool.length) return null;
    return pool.reduce((b, s) =>
      dist(activeUAV, { x: s.wx, y: s.wy }) < dist(activeUAV, { x: b.wx, y: b.wy }) ? s : b
    );
  };

  const findNearestDeployed = () => {
    if (!activeUAV) return null;
    const pool = state.units.filter(
      (u) => u.type === "COMMERCIAL" &&
             (state.detections[u.id]?.confidence || 0) > CONFIG.CONFIRMED_THRESHOLD
    );
    if (!pool.length) return null;
    return pool.reduce((b, u) => dist(activeUAV, u) < dist(activeUAV, b) ? u : b);
  };

  const readFile = (file) => {
    if (!file?.type.startsWith("image/")) return;
    const reader = new FileReader();
    reader.onload = (e) => {
      const url = e.target.result;
      setImageDataUrl(url);
      setImageBase64(url.split(",")[1]);
      setImageMime(file.type);
      setExtraction(null); setComparison(null); setError(null);
      setAisTarget(findNearestAIS());
      setDeployedTarget(findNearestDeployed());
    };
    reader.readAsDataURL(file);
  };

  const compareWithRealAIS = (ex, ship) => {
    const n = (s) => (s || "").toUpperCase().trim();
    const diffs = [];
    const cvType = n(ex.vesselType), aisType = n(ship.type);
    if (cvType && cvType !== "UNKNOWN" && aisType && aisType !== "UNKNOWN" && cvType !== aisType)
      diffs.push({ field: "TYPE", cv: cvType, ais: aisType });
    if (cvType === "MILITARY" && !["MILITARY","SPECIAL"].includes(aisType))
      diffs.push({ field: "CLASS", cv: "MILITARY ASSET", ais: "CIVILIAN AIS" });
    const cvFlag = n(ex.flagVisible), aisFlag = n(ship.flag);
    if (cvFlag && cvFlag !== "NONE" && cvFlag !== "—" && aisFlag &&
        !cvFlag.includes(aisFlag.slice(0,3)) && !aisFlag.includes(cvFlag.slice(0,3)))
      diffs.push({ field: "FLAG", cv: cvFlag, ais: aisFlag });
    return { match: diffs.length === 0, diffs };
  };

  const runAnalysis = async () => {
    if (!imageBase64 || !apiKey) return;
    const nearAIS = findNearestAIS();
    const nearDeployed = findNearestDeployed();
    setAisTarget(nearAIS);
    setDeployedTarget(nearDeployed);
    setAnalyzing(true); setError(null);

    const prompt = `You are a maritime ISR analyst reviewing aerial imagery.
Respond ONLY with a valid JSON object — no markdown, no preamble:
{
  "companyOperator": "<shipping company or operator name if visible/inferable, or UNKNOWN>",
  "vesselName": "<name painted on hull or superstructure if legible, or UNKNOWN>",
  "vesselType": "TANKER|CARGO|BULK|CONTAINER|MILITARY|FISHING|PASSENGER|TUG|UNKNOWN",
  "estimatedLengthM": <integer or null>,
  "hullColor": "<primary color>",
  "superstructure": "<one sentence>",
  "flagVisible": "<country code e.g. KOR, PAN, USA, or NONE>",
  "visibleIdentifiers": "<hull numbers, name text, markings, or NONE>",
  "confidence": <0-100>,
  "notes": "<anomalies or observations, max 80 chars>"
}`;

    try {
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "gpt-4o",
          max_tokens: 400,
          messages: [{
            role: "user",
            content: [
              { type: "image_url",
                image_url: { url: `data:${imageMime};base64,${imageBase64}`, detail: "low" } },
              { type: "text", text: prompt },
            ],
          }],
        }),
      });

      if (!res.ok) {
        const err = await res.json();
        throw new Error(err.error?.message || `HTTP ${res.status}`);
      }

      const data = await res.json();
      const raw = data.choices[0].message.content.trim().replace(/```json|```/g, "").trim();
      const ex = JSON.parse(raw);
      setExtraction(ex);

      if (nearAIS) {
        const comp = compareWithRealAIS(ex, nearAIS);
        setComparison({ mode: "ais", ...comp, ship: nearAIS });
        if (!comp.match) {
          dispatch({ type: "ADD_ALERT", kind: "AIS.MISMATCH", severity: "high",
            title: `AIS MISMATCH — ${nearAIS.name || nearAIS.mmsi}`,
            body: `CV: ${ex.vesselType} vs AIS: ${nearAIS.type}. ${comp.diffs.length} field(s) discrepant.` });
        }
      } else if (nearDeployed) {
        setComparison({ mode: "dark", match: false, diffs: [], vessel: nearDeployed });
        dispatch({ type: "ADD_ALERT", kind: "AIS.DARK", severity: "high",
          title: `AIS DARK — ${nearDeployed.label}`,
          body: "Vessel confirmed by ISR but transmitting no AIS. Possible transponder blackout." });
      } else {
        setComparison({ mode: "none", match: true, diffs: [] });
      }
    } catch (e) {
      setError(e.message);
    } finally {
      setAnalyzing(false);
    }
  };

  const reset = () => {
    setImageDataUrl(null); setImageBase64(null);
    setExtraction(null); setComparison(null); setError(null);
  };

  if (!singleUAVSelected) {
    return (
      <div style={{
        height: "100%", display: "flex", flexDirection: "column",
        alignItems: "center", justifyContent: "center",
        gap: 6, padding: 16, boxSizing: "border-box",
      }}>
        <Camera size={18} style={{ color: COLORS.textDim, opacity: 0.4 }} />
        <div style={{
          fontSize: 9, letterSpacing: "0.1em", color: COLORS.textDim,
          fontFamily: "'JetBrains Mono', monospace", textAlign: "center", lineHeight: 1.8,
        }}>
          // SELECT A SINGLE UAV<br />
          <span style={{ color: COLORS.phosphorDim }}>to enable visual intel</span>
        </div>
      </div>
    );
  }

  if (!apiKey) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column",
                    justifyContent: "center", gap: 8, padding: 12, boxSizing: "border-box" }}>
        <div style={{ fontSize: 9, letterSpacing: "0.1em", marginBottom: 4, color: COLORS.phosphorDim }}>
          OPENAI API KEY REQUIRED
        </div>
        <input type="password" placeholder="sk-..."
          value={keyDraft} onChange={(e) => setKeyDraft(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && keyDraft.startsWith("sk-") && setApiKey(keyDraft)}
          style={{ width: "100%", padding: "6px 8px", fontSize: 10, boxSizing: "border-box",
                   border: `1px solid ${COLORS.borderHi}`, background: COLORS.bg,
                   color: COLORS.phosphor, outline: "none",
                   fontFamily: "'JetBrains Mono', monospace" }} />
        <button onClick={() => keyDraft.startsWith("sk-") && setApiKey(keyDraft)}
          disabled={!keyDraft.startsWith("sk-")}
          style={{
            width: "100%", padding: "6px 0", fontSize: 10, fontWeight: 700,
            letterSpacing: "0.1em", cursor: keyDraft.startsWith("sk-") ? "pointer" : "not-allowed",
            border: `1px solid ${keyDraft.startsWith("sk-") ? COLORS.phosphor : COLORS.border}`,
            background: keyDraft.startsWith("sk-") ? COLORS.phosphor : "transparent",
            color: keyDraft.startsWith("sk-") ? COLORS.bg : COLORS.textDim,
            fontFamily: "'JetBrains Mono', monospace",
          }}>
          CONNECT GPT-4o
        </button>
        <div style={{ fontSize: 8, lineHeight: 1.5, color: COLORS.textDim,
                      fontFamily: "'JetBrains Mono', monospace" }}>
          // Lives in browser memory only.<br />// Sent only to api.openai.com.
        </div>
      </div>
    );
  }

  if (analyzing) {
    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column",
                    alignItems: "center", justifyContent: "center", gap: 12, padding: 12, boxSizing: "border-box" }}>
        <div style={{ fontSize: 9, fontFamily: "'JetBrains Mono', monospace",
                      letterSpacing: "0.1em", color: COLORS.amber }}>▶ GPT-4o ANALYZING...</div>
        <div style={{ width: "100%", height: 4, border: `1px solid ${COLORS.border}`, overflow: "hidden" }}>
          <div style={{ height: "100%", background: COLORS.phosphor,
                        animation: "cvprogress 1.8s ease-in-out infinite" }} />
        </div>
        {imageDataUrl && (
          <img src={imageDataUrl} alt="feed"
               style={{ width: "100%", maxHeight: 80, objectFit: "cover",
                        border: `1px solid ${COLORS.border}`,
                        opacity: 0.7, filter: "grayscale(40%) brightness(0.8)" }} />
        )}
        <div style={{ fontSize: 8, color: COLORS.textDim, fontFamily: "'JetBrains Mono', monospace" }}>
          model: gpt-4o · detail: low
        </div>
        <style>{`@keyframes cvprogress {
          0%   { width:0%;  margin-left:0% }
          50%  { width:50%; margin-left:25% }
          100% { width:0%;  margin-left:100% }
        }`}</style>
      </div>
    );
  }

  if (extraction && comparison) {
    const isDark    = comparison.mode === "dark";
    const isNone    = comparison.mode === "none";
    const isMatch   = comparison.match && !isDark;
    const diffs     = comparison.diffs ?? [];
    const refShip   = comparison.ship;
    const refDeploy = comparison.vessel;

    const verdictColor = isDark ? COLORS.hostile :
                         isNone ? COLORS.textDim :
                         isMatch ? COLORS.phosphor : COLORS.hostile;

    const rows = [
      { f: "COMPANY", cv: extraction.companyOperator || "—", ais: "—" },
      { f: "VESSEL",  cv: extraction.vesselName || "—",
        ais: refShip?.name?.slice(0, 12) || refDeploy?.label || "—" },
      { f: "TYPE",    cv: extraction.vesselType,
        ais: refShip?.type || refDeploy?.vesselType || "—" },
      { f: "FLAG",    cv: extraction.flagVisible || "—",
        ais: refShip?.flag || refDeploy?.flag || "—" },
      { f: "LEN",     cv: extraction.estimatedLengthM ? `~${extraction.estimatedLengthM}m` : "—",
        ais: "—" },
      { f: "MMSI",    cv: "—",
        ais: refShip?.mmsi || refDeploy?.mmsi?.slice(0, 9) || "NO DATA" },
    ];

    return (
      <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 6, padding: 8, overflowY: "auto", boxSizing: "border-box" }}>
        {/* Company / Vessel identity header */}
        <div style={{ fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: COLORS.phosphor, letterSpacing: "0.05em", lineHeight: 1.3 }}>
            {extraction.vesselName && extraction.vesselName !== "UNKNOWN"
              ? extraction.vesselName
              : <span style={{ color: COLORS.textDim, fontStyle: "italic" }}>VESSEL UNKNOWN</span>}
          </div>
          <div style={{ fontSize: 8.5, color: COLORS.amberDim, letterSpacing: "0.05em" }}>
            {extraction.companyOperator && extraction.companyOperator !== "UNKNOWN"
              ? extraction.companyOperator
              : <span style={{ color: COLORS.textDim }}>OPERATOR UNKNOWN</span>}
          </div>
          <div style={{ fontSize: 8, color: COLORS.neutral, marginTop: 1 }}>
            {extraction.vesselType}
            {extraction.estimatedLengthM ? ` · ~${extraction.estimatedLengthM}m` : ""}
          </div>
        </div>

        <div style={{ display: "flex", gap: 8, alignItems: "flex-start" }}>
          {imageDataUrl && (
            <img src={imageDataUrl} alt="target" style={{ width: 56, height: 42, objectFit: "cover", flexShrink: 0, border: `1px solid ${verdictColor}` }} />
          )}
          <div style={{ flex: 1, fontSize: 8, fontFamily: "'JetBrains Mono', monospace", color: COLORS.textDim }}>
            <div>CONF: <span style={{ color: COLORS.amber }}>{extraction.confidence}%</span></div>
            <div style={{ color: isDark ? COLORS.hostile : COLORS.amberDim }}>
              {isDark ? "⚠ NO AIS SIGNAL" :
               refShip ? `AIS: ${refShip.name?.slice(0,12) || refShip.mmsi}` :
               isNone ? "NO AIS CONTACT" : "—"}
            </div>
          </div>
        </div>

        <div style={{ fontSize: "8.5px", fontFamily: "'JetBrains Mono', monospace" }}>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", borderBottom: `1px solid ${COLORS.border}`, paddingBottom: 2, marginBottom: 2 }}>
            <span style={{ color: COLORS.textDim }}>FIELD</span>
            <span style={{ color: COLORS.neutral }}>CV</span>
            <span style={{ color: isDark ? COLORS.hostile : COLORS.amber }}>
              {isDark ? "AIS ✗" : "AIS"}
            </span>
          </div>
          {rows.map(({ f, cv, ais }) => {
            const mismatch = diffs.some((d) => d.field === f) || (isDark && f === "MMSI");
            const trunc = (s) => s?.length > 10 ? s.slice(0, 10) + "…" : (s || "—");
            return (
              <div key={f} style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", padding: "2px 0", background: mismatch ? `${COLORS.hostile}18` : "transparent" }}>
                <span style={{ color: COLORS.textDim }}>{f}</span>
                <span style={{ color: mismatch ? COLORS.hostile : COLORS.neutral }}>{trunc(cv)}</span>
                <span style={{ color: mismatch ? COLORS.hostile : COLORS.amber }}>{trunc(ais)}</span>
              </div>
            );
          })}
        </div>

        {extraction.notes && extraction.notes !== "None" && (
          <div style={{ fontSize: "7.5px", fontFamily: "'JetBrains Mono', monospace", padding: "2px 4px", border: `1px solid ${COLORS.border}`, color: COLORS.textDim }}>
            {extraction.notes.slice(0, 80)}
          </div>
        )}

        <div style={{
          border: `1px solid ${verdictColor}`,
          background: `${verdictColor}0d`,
          color: verdictColor,
          padding: "6px 8px", fontSize: "9px",
          fontFamily: "'JetBrains Mono', monospace", fontWeight: 700,
          letterSpacing: "0.1em",
        }}>
          {isDark  ? "⚠ AIS DARK — NO TRANSPONDER" :
           isNone  ? "// NO AIS CONTACT IN RANGE" :
           isMatch ? "✓ AIS CONSISTENT" :
                     `⚠ MISMATCH · ${diffs.length} FIELD${diffs.length > 1 ? "S" : ""}`}
        </div>

        {error && (
          <div style={{ fontSize: "8px", fontFamily: "'JetBrains Mono', monospace", padding: 4, border: `1px solid ${COLORS.hostile}`, color: COLORS.hostile }}>
            ERR: {error.slice(0, 55)}
          </div>
        )}

        <div style={{ display: "flex", gap: 4 }}>
          <button onClick={reset}
            style={{ flex: 1, padding: "4px 0", border: `1px solid ${COLORS.border}`, fontSize: 9, color: COLORS.textDim, background: "transparent", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
            NEW IMG
          </button>
          <button onClick={runAnalysis}
            style={{ flex: 1, padding: "4px 0", border: `1px solid ${COLORS.phosphor}`, fontSize: 9, fontWeight: 700, color: COLORS.phosphor, background: "transparent", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
            RERUN
          </button>
          <button onClick={() => { setApiKey(""); setKeyDraft(""); reset(); }}
            style={{ padding: "4px 6px", border: `1px solid ${COLORS.border}`, fontSize: 9, color: COLORS.textDim, background: "transparent", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
            KEY
          </button>
        </div>
      </div>
    );
  }

  const nearAIS      = findNearestAIS();
  const nearDeployed = findNearestDeployed();

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", gap: 8, padding: 8, boxSizing: "border-box" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 9, fontFamily: "'JetBrains Mono', monospace", flexShrink: 0 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, color: COLORS.phosphorDim }}>
          <Camera size={9} />
          <span>UAV-{activeUAV.label}</span>
          {activeUAV.state === "jammed"
            ? <span style={{ color: COLORS.amber, marginLeft: 4 }}>⚡ JAMMED</span>
            : activeUAV.state === "docked"
              ? <span style={{ color: COLORS.textDim, marginLeft: 4 }}>DOCKED</span>
              : <span style={{ display: "inline-flex", alignItems: "center", gap: 3, marginLeft: 4, color: COLORS.hostile }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: COLORS.hostile, display: "inline-block" }} />LIVE
                </span>
          }
        </div>
        <button onClick={() => { setApiKey(""); setKeyDraft(""); }}
          style={{ fontSize: 8, color: COLORS.phosphorDim, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>
          GPT-4o ✓
        </button>
      </div>

      <div style={{
        border: `1px solid ${nearAIS ? COLORS.ais : nearDeployed ? COLORS.amber : COLORS.border}`,
        padding: "4px 8px", fontSize: "8px", fontFamily: "'JetBrains Mono', monospace",
      }}>
        {nearAIS
          ? <div>
              <span style={{ color: COLORS.aisDim }}>AIS · </span>
              <span style={{ color: COLORS.ais }}>{nearAIS.name?.slice(0,14) || nearAIS.mmsi}</span>
              <span style={{ color: COLORS.textDim }}> · {nearAIS.type} · {nearAIS.flag}</span>
            </div>
          : <div style={{ color: COLORS.textDim }}>// No real AIS contact in sensor range</div>
        }
        {nearDeployed && (
          <div>
            <span style={{ color: COLORS.amberDim }}>SIM · </span>
            <span style={{ color: COLORS.amber }}>{nearDeployed.label}</span>
            <span style={{ color: COLORS.textDim }}> {nearDeployed.vesselType} (no AIS)</span>
          </div>
        )}
      </div>

      <div
        style={{
          flex: "1 1 0", minHeight: 0, display: "flex", flexDirection: "column",
          alignItems: "center", justifyContent: "center", cursor: "pointer", overflow: "hidden",
          borderColor: isDragOver ? COLORS.phosphor : COLORS.borderHi,
          borderStyle: "dashed", borderWidth: 1,
          background: isDragOver ? `${COLORS.phosphor}08` : COLORS.bg,
          transition: "all 0.15s",
        }}
        onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => { e.preventDefault(); setIsDragOver(false); readFile(e.dataTransfer.files[0]); }}
        onClick={() => fileInputRef.current?.click()}
      >
        {imageDataUrl
          ? <img src={imageDataUrl} alt="target" style={{ width: "100%", height: "100%", objectFit: "cover", opacity: 0.9 }} />
          : <div style={{ textAlign: "center", padding: "0 8px" }}>
              <ImageIcon size={18} style={{ color: COLORS.phosphorDim, margin: "0 auto 4px", display: "block" }} />
              <div style={{ fontSize: "9px", fontFamily: "'JetBrains Mono', monospace", color: COLORS.textDim }}>
                DROP AERIAL IMAGE<br />
                <span style={{ color: COLORS.phosphorDim }}>or click to browse</span>
              </div>
            </div>
        }
        <input ref={fileInputRef} type="file" accept="image/*"
               style={{ display: "none" }}
               onChange={(e) => e.target.files[0] && readFile(e.target.files[0])} />
      </div>

      {imageDataUrl && (
        <button onClick={runAnalysis}
          style={{ width: "100%", padding: "6px 0", flexShrink: 0, border: `1px solid ${COLORS.phosphor}`, background: COLORS.phosphor, color: COLORS.bg, fontSize: 10, fontWeight: 700, letterSpacing: "0.1em", cursor: "pointer", fontFamily: "'JetBrains Mono', monospace" }}>
          ▶ ANALYZE WITH GPT-4o
        </button>
      )}

      {error && (
        <div style={{ fontSize: "8px", fontFamily: "'JetBrains Mono', monospace", padding: 4, border: `1px solid ${COLORS.hostile}`, color: COLORS.hostile }}>
          ERR: {error.slice(0, 60)}
        </div>
      )}
    </div>
  );
};
