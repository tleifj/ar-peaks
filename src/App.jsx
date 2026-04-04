import { useState, useEffect, useRef, useCallback } from "react";

// ─── Peak Database ─────────────────────────────────────────────────────────
const PEAKS = [
  // { name: "San Jacinto Peak",   lat: 33.8148, lng: -116.6794, elev: 3302 },
  // { name: "Tahquitz Peak",      lat: 33.7568, lng: -116.6793, elev: 2676 },
  // { name: "Toro Peak",          lat: 33.5267, lng: -116.4625, elev: 2659 },
  // { name: "Santa Rosa Mtn",     lat: 33.4783, lng: -116.4669, elev: 2407 },
  // { name: "Monument Peak",      lat: 32.9314, lng: -116.4428, elev: 1997 },
  // { name: "Cuyamaca Peak",      lat: 32.9734, lng: -116.5800, elev: 1985 },
  // { name: "Garnet Peak",        lat: 32.9264, lng: -116.4558, elev: 1900 },
  // { name: "Middle Peak",        lat: 32.9700, lng: -116.5736, elev: 1895 },
  // { name: "Palomar Mtn",        lat: 33.3606, lng: -116.8647, elev: 1871 },
  // { name: "Volcan Mountain",    lat: 33.1289, lng: -116.6128, elev: 1810 },
  // { name: "Hot Springs Mtn",    lat: 33.2989, lng: -116.6428, elev: 1765 },
  // { name: "Stonewall Peak",     lat: 32.9723, lng: -116.5647, elev: 1779 },
  // { name: "Boucher Hill",       lat: 33.3375, lng: -116.9050, elev: 1678 },
  // { name: "Lyons Peak",         lat: 32.9106, lng: -116.5536, elev: 1606 },
  // { name: "El Cajon Mountain",  lat: 32.8967, lng: -116.8297, elev: 1274 },
  // { name: "Iron Mountain",      lat: 33.0019, lng: -116.9447, elev:  937 },
  // { name: "Woodson Mountain",   lat: 33.0031, lng: -117.0019, elev:  843 },
  { name: "Cowles Mountain",    lat: 32.8161, lng: -117.0333, elev:  516 },
  { name: "North Fortuna",      lat: 32.8264, lng: -117.0481, elev:  400 },
  { name: "South Fortuna",      lat: 32.8178, lng: -117.0467, elev:  381 },
  { name: "Kwaay Paay Peak",    lat: 32.8339, lng: -117.0417, elev:  273 },
  { name: "Pyles Peak",         lat: 32.8233, lng: -117.0556, elev:  323 },
];

// ─── Constants ─────────────────────────────────────────────────────────────
const H_FOV = 65;   // horizontal field of view in degrees
const V_FOV = 48;   // vertical field of view in degrees
const MAX_DIST = 180000; // only show peaks within 180 km

// Default demo location: Mission Trails Regional Park
const DEMO_LOCATION = { lat: 32.8172, lng: -117.0519, elev: 120 };

// ─── Math Utilities ─────────────────────────────────────────────────────────
const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

function getBearing(lat1, lng1, lat2, lng2) {
  const f1 = toRad(lat1), f2 = toRad(lat2), dl = toRad(lng2 - lng1);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function getDistanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const f1 = toRad(lat1), f2 = toRad(lat2);
  const df = toRad(lat2 - lat1), dl = toRad(lng2 - lng1);
  const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function getElevAngle(userElev, peakElev, distM) {
  return toDeg(Math.atan2(peakElev - userElev, distM));
}

// Shortest angular difference: result in [-180, 180]
function shortAngle(a, b) {
  return ((a - b + 540) % 360) - 180;
}

function compassLabel(h) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(h / 22.5) % 16];
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = {
  root: {
    width: "100vw", height: "100vh",
    background: "#0a0e14",
    position: "relative", overflow: "hidden",
    fontFamily: "'DM Mono', 'Courier New', monospace",
    userSelect: "none", WebkitUserSelect: "none",
    cursor: "crosshair",
    touchAction: "none",
  },
  video: {
    width: "100%", height: "100%",
    objectFit: "cover",
    position: "absolute", inset: 0,
  },
  overlay: {
    position: "absolute", inset: 0,
    pointerEvents: "none",
  },
};

// ─── Component ───────────────────────────────────────────────────────────────
export default function ARPeaks() {
  const videoRef       = useRef(null);
  const dragRef        = useRef({ active: false, startX: 0, startHeading: 0 });
  const orientRef      = useRef(null); // latest raw orientation

  const [phase, setPhase]           = useState("start"); // start | loading | ready
  const [error, setError]           = useState(null);
  const [isDesktop, setIsDesktop]   = useState(false);
  const [cameraOn, setCameraOn]     = useState(false);

  // Sensors
  const [location, setLocation]     = useState(null);
  const [heading, setHeading]       = useState(null);   // compass degrees, null = unknown
  const [pitch, setPitch]           = useState(90);     // device beta; 90 = upright
  // "none" | "ios" | "absolute" | "relative-fallback"
  const [orientSource, setOrientSource] = useState("none");

  // Desktop sim
  const [simHeading, setSimHeading] = useState(60);

  // Computed labels
  const [labels, setLabels]         = useState([]);
  const [showDebug, setShowDebug]   = useState(false);

  // ── Detect platform ────────────────────────────────────────────────────────
  useEffect(() => {
    const mobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    setIsDesktop(!mobile);
  }, []);

  // ── Camera ─────────────────────────────────────────────────────────────────
  const startCamera = useCallback(async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: { ideal: 1920 } },
        audio: false,
      });
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setCameraOn(true);
    } catch {
      // Camera optional — continue without it
    }
  }, []);

  // ── Geolocation ────────────────────────────────────────────────────────────
  const startLocation = useCallback(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setLocation({
          lat: pos.coords.latitude,
          lng:  pos.coords.longitude,
          elev: pos.coords.altitude ?? DEMO_LOCATION.elev,
        });
      },
      () => {/* use demo loc */},
      { enableHighAccuracy: true, timeout: 10000 }
    );
  }, []);

  // ── Device orientation ─────────────────────────────────────────────────────
  const startOrientation = useCallback(() => {
    // iOS handler — webkitCompassHeading is always compass-true
    const iosHandler = (e) => {
      if (typeof e.webkitCompassHeading !== "number") return;
      setOrientSource("ios");
      setHeading(e.webkitCompassHeading);
      if (e.beta != null) setPitch(e.beta);
      orientRef.current = e;
    };

    // Android — ONLY accept events where e.absolute === true
    const absoluteHandler = (e) => {
      if (!e.absolute || e.alpha == null) return;
      setOrientSource("absolute");
      setHeading((360 - e.alpha) % 360);
      if (e.beta != null) setPitch(e.beta);
      orientRef.current = e;
    };

    // Permission is already obtained in initialize() before this is called.
    // Just register the listeners directly.
    window.addEventListener("deviceorientationabsolute", absoluteHandler, true);
    window.addEventListener("deviceorientation", iosHandler, true);

    return () => {
      window.removeEventListener("deviceorientationabsolute", absoluteHandler, true);
      window.removeEventListener("deviceorientation", iosHandler, true);
    };
  }, []);

  // ── Initialize ─────────────────────────────────────────────────────────────
  const initialize = useCallback(async () => {
    setPhase("loading");

    // ⚠️ iOS Safari: requestPermission() MUST be called first — before any
    // other awaits — while still inside the synchronous user-gesture context.
    // Awaiting getUserMedia() first breaks the gesture chain and iOS silently
    // denies orientation access.
    let orientGranted = true; // non-iOS: no permission API, assume available
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        orientGranted = res === "granted";
      } catch {
        orientGranted = false;
      }
    }

    await startCamera();
    startLocation();

    if (!isDesktop) {
      if (orientGranted) startOrientation();
      else setError("Compass access denied — labels won\'t track rotation.");
    } else {
      setLocation(DEMO_LOCATION);
    }

    setPhase("ready");
  }, [startCamera, startLocation, startOrientation, isDesktop]);

  // ── Compute label positions ────────────────────────────────────────────────
  useEffect(() => {
    if (phase !== "ready") return;

    // On mobile, don't render anything until we have a real compass heading.
    // This prevents all peaks flooding the screen with a stale/zero heading.
    if (!isDesktop && heading === null) {
      setLabels([]);
      return;
    }

    const loc = location ?? DEMO_LOCATION;
    const h   = isDesktop ? simHeading : heading;
    // beta=90 → device upright / horizon; tilting up increases beta
    const tiltAboveHorizon = (isDesktop ? 0 : pitch) - 90;

    const computed = PEAKS.map((peak) => {
      const dist = getDistanceM(loc.lat, loc.lng, peak.lat, peak.lng);
      if (dist > MAX_DIST || dist < 100) return null;

      const az     = getBearing(loc.lat, loc.lng, peak.lat, peak.lng);
      const elvAng = getElevAngle(loc.elev, peak.elev, dist);

      const hDiff = shortAngle(az, h);          // +right
      const vDiff = elvAng - tiltAboveHorizon;  // +above horizon

      const x = 50 + (hDiff / H_FOV) * 100;    // %
      const y = 50 - (vDiff / V_FOV) * 100;    // %

      // Strict: only render peaks actually inside the camera FOV
      if (x < 2 || x > 98 || y < 2 || y > 98) return null;

      const distKm  = (dist / 1000).toFixed(1);
      const elevFt  = Math.round(peak.elev * 3.28084).toLocaleString();
      const isFocus = Math.abs(hDiff) < 5 && Math.abs(vDiff) < 4;

      return { ...peak, x, y, dist, distKm, elevFt, isFocus, az };
    })
      .filter(Boolean)
      .sort((a, b) => b.dist - a.dist);

    setLabels(computed);
  }, [phase, location, heading, pitch, simHeading, isDesktop, orientSource]);

  // ── Desktop drag-to-pan ────────────────────────────────────────────────────
  const onPointerDown = (e) => {
    if (!isDesktop || phase !== "ready") return;
    dragRef.current = { active: true, startX: e.clientX, startHeading: simHeading };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!isDesktop || !dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.startX;
    setSimHeading((dragRef.current.startHeading + dx * 0.35 + 720) % 360);
  };
  const onPointerUp = () => { dragRef.current.active = false; };

  const effectiveHeading  = isDesktop ? simHeading : (heading ?? 0);
  const compassReady      = !isDesktop && heading !== null;
  const compassWaiting    = !isDesktop && heading === null;
  const gpsReady          = location !== null && !isDesktop;

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=DM+Mono:wght@400;500&family=Barlow+Condensed:wght@400;600;700&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :root { --amber: #f59e0b; --sky: #38bdf8; --green: #4ade80; --red: #f87171; }
        body { overflow: hidden; }

        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes scanLine {
          0%   { transform: translateY(0); }
          100% { transform: translateY(100vh); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 1; }
          50% { opacity: 0.5; }
        }
        @keyframes labelFade {
          from { opacity: 0; transform: translate(-50%, -105%); }
          to   { opacity: 1; transform: translate(-50%, -100%); }
        }
        .peak-label { animation: labelFade 0.3s ease forwards; }
        .btn-primary {
          padding: 14px 36px;
          background: var(--amber);
          color: #0a0e14;
          border: none;
          border-radius: 3px;
          font-family: 'Barlow Condensed', sans-serif;
          font-size: 18px;
          font-weight: 700;
          letter-spacing: 0.08em;
          text-transform: uppercase;
          cursor: pointer;
          transition: background 0.15s, transform 0.1s;
          pointer-events: all;
        }
        .btn-primary:hover { background: #fbbf24; transform: translateY(-1px); }
        .btn-primary:active { transform: translateY(0); }
      `}</style>

      <div
        style={styles.root}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* ── Video feed ── */}
        <video
          ref={videoRef}
          autoPlay playsInline muted
          style={{
            ...styles.video,
            opacity: cameraOn ? 1 : 0,
            transition: "opacity 0.8s",
          }}
        />

        {/* Sky gradient when no camera */}
        {!cameraOn && phase === "ready" && (
          <div style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(180deg, #0c1928 0%, #1a3a5c 45%, #2d6a8f 70%, #3d8fa0 85%, #4a7c5a 100%)",
          }} />
        )}

        {/* ── START SCREEN ── */}
        {phase === "start" && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            background: "linear-gradient(160deg, #060c14 0%, #0e1f36 50%, #081a10 100%)",
            padding: 32, gap: 0,
          }}>
            {/* Grid lines */}
            <div style={{
              position: "absolute", inset: 0,
              backgroundImage: `
                linear-gradient(rgba(245,158,11,0.04) 1px, transparent 1px),
                linear-gradient(90deg, rgba(245,158,11,0.04) 1px, transparent 1px)
              `,
              backgroundSize: "60px 60px",
            }} />

            <div style={{ animation: "fadeUp 0.6s ease both", textAlign: "center", position: "relative" }}>
              {/* Icon */}
              <div style={{ marginBottom: 28 }}>
                <svg width="72" height="48" viewBox="0 0 72 48" fill="none">
                  <path d="M36 4 L68 44 H4 Z" fill="none" stroke="var(--amber)" strokeWidth="1.5" />
                  <path d="M36 4 L54 28 H18 Z" fill="rgba(245,158,11,0.08)" stroke="var(--amber)" strokeWidth="0.5" />
                  <line x1="36" y1="4" x2="36" y2="0" stroke="var(--amber)" strokeWidth="1.5" />
                  <circle cx="36" cy="4" r="2.5" fill="var(--amber)" />
                </svg>
              </div>

              <div style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontSize: 11, letterSpacing: "0.3em",
                color: "var(--amber)", marginBottom: 12,
                textTransform: "uppercase", opacity: 0.8,
              }}>
                Augmented Reality
              </div>

              <h1 style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontSize: 52, fontWeight: 700,
                color: "#f0f4f8", letterSpacing: "0.02em",
                lineHeight: 1, marginBottom: 8,
              }}>
                PEAK<span style={{ color: "var(--amber)" }}>AR</span>
              </h1>

              <p style={{
                color: "#4a6580", fontSize: 13, lineHeight: 1.6,
                maxWidth: 260, margin: "0 auto 36px",
                fontFamily: "'DM Mono', monospace",
              }}>
                Point your camera at the mountains.<br />
                Discover every peak by name.
              </p>

              <button className="btn-primary" onClick={initialize}>
                Start Experience
              </button>

              <div style={{
                marginTop: 20, color: "#2a4560", fontSize: 11,
                fontFamily: "'DM Mono', monospace", letterSpacing: "0.05em",
              }}>
                {isDesktop
                  ? "[ desktop mode — drag to pan ]"
                  : "[ requires camera + GPS + compass ]"}
              </div>
            </div>
          </div>
        )}

        {/* ── LOADING SCREEN ── */}
        {phase === "loading" && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            background: "#060c14", gap: 20,
          }}>
            <div style={{
              width: 48, height: 48, borderRadius: "50%",
              border: "2px solid #1a2a3a",
              borderTopColor: "var(--amber)",
              animation: "spin 0.8s linear infinite",
            }} />
            <div style={{ color: "#4a6580", fontSize: 12, letterSpacing: "0.15em" }}>
              INITIALIZING SENSORS
            </div>
          </div>
        )}

        {/* ── AR OVERLAY ── */}
        {phase === "ready" && (
          <div style={styles.overlay}>

            {/* Scan line effect */}
            <div style={{
              position: "absolute", left: 0, right: 0, height: 1,
              background: "linear-gradient(90deg, transparent, rgba(245,158,11,0.08), transparent)",
              animation: "scanLine 6s linear infinite",
            }} />

            {/* Corner brackets */}
            {[
              { top: 16, left: 16 },
              { top: 16, right: 16 },
              { bottom: 16, left: 16 },
              { bottom: 16, right: 16 },
            ].map((pos, i) => {
              const flipH = i === 1 || i === 3;
              const flipV = i === 2 || i === 3;
              return (
                <div key={i} style={{
                  position: "absolute", ...pos,
                  width: 24, height: 24,
                  borderTop: flipV ? "none" : "1.5px solid rgba(245,158,11,0.4)",
                  borderBottom: flipV ? "1.5px solid rgba(245,158,11,0.4)" : "none",
                  borderLeft: flipH ? "none" : "1.5px solid rgba(245,158,11,0.4)",
                  borderRight: flipH ? "1.5px solid rgba(245,158,11,0.4)" : "none",
                }} />
              );
            })}

            {/* Center crosshair */}
            <div style={{
              position: "absolute", top: "50%", left: "50%",
              transform: "translate(-50%, -50%)",
              width: 32, height: 32,
            }}>
              <div style={{ position: "absolute", top: "50%", left: 0, right: 0, height: 1, background: "rgba(255,255,255,0.2)" }} />
              <div style={{ position: "absolute", left: "50%", top: 0, bottom: 0, width: 1, background: "rgba(255,255,255,0.2)" }} />
              <div style={{
                position: "absolute", top: "50%", left: "50%",
                transform: "translate(-50%,-50%)",
                width: 4, height: 4, borderRadius: "50%",
                background: "rgba(255,255,255,0.4)",
              }} />
            </div>

            {/* Horizon line */}
            <div style={{
              position: "absolute", left: 0, right: 0, top: "50%",
              height: 1,
              background: "linear-gradient(90deg, transparent 0%, rgba(56,189,248,0.15) 20%, rgba(56,189,248,0.15) 80%, transparent 100%)",
            }}>
              <div style={{
                position: "absolute", left: "50%", transform: "translateX(-50%)",
                top: 4, color: "rgba(56,189,248,0.4)", fontSize: 9,
                fontFamily: "'DM Mono', monospace", letterSpacing: "0.2em",
              }}>
                HORIZON
              </div>
            </div>

            {/* ── COMPASS BAR ── */}
            <div style={{
              position: "absolute", top: 20, left: "50%",
              transform: "translateX(-50%)",
              display: "flex", alignItems: "center", gap: 10,
              background: "rgba(6,12,20,0.85)",
              backdropFilter: "blur(12px)",
              border: "1px solid rgba(245,158,11,0.25)",
              borderRadius: 2, padding: "7px 18px",
              whiteSpace: "nowrap",
            }}>
              {/* Compass needle */}
              <svg width="16" height="16" viewBox="0 0 16 16">
                <polygon points="8,1 10,13 8,11 6,13" fill="var(--amber)" />
                <polygon points="8,15 6,3 8,5 10,3" fill="#2a4560" />
              </svg>

              <span style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontSize: 20, fontWeight: 600, color: "#f0f4f8",
                letterSpacing: "0.04em", minWidth: 44,
              }}>
                {Math.round(effectiveHeading).toString().padStart(3, "0")}°
              </span>

              <span style={{
                fontFamily: "'Barlow Condensed', sans-serif",
                fontSize: 15, fontWeight: 600, color: "var(--amber)",
                minWidth: 32,
              }}>
                {compassLabel(effectiveHeading)}
              </span>

              <div style={{ width: 1, height: 14, background: "rgba(255,255,255,0.1)" }} />

              {/* Status indicators */}
              <div style={{ display: "flex", gap: 8 }}>
                <span style={{
                  fontSize: 9, letterSpacing: "0.1em", color: gpsReady ? "var(--green)" : "#2a4560",
                  animation: gpsReady ? "none" : "pulse 1.5s ease infinite",
                }}>
                  GPS{gpsReady ? " ✓" : " …"}
                </span>
                <span style={{
                  fontSize: 9, letterSpacing: "0.1em",
                  color: compassReady ? "var(--green)" : isDesktop ? "#2a4560" : "#2a4560",
                  animation: (!compassReady && !isDesktop) ? "pulse 1.5s ease infinite" : "none",
                }}>
                  {isDesktop ? "SIM ●" : compassReady ? "HDG ✓" : "HDG …"}
                </span>
              </div>
            </div>

            {/* ── PEAK LABELS ── */}
            {labels.map((peak) => (
              <PeakLabel key={peak.name} peak={peak} />
            ))}

            {/* Waiting for compass */}
            {compassWaiting && (
              <div style={{
                position: "absolute", top: "50%", left: "50%",
                transform: "translate(-50%, -50%)",
                background: "rgba(6,12,20,0.88)",
                border: "1px solid rgba(245,158,11,0.3)",
                borderRadius: 3, padding: "18px 28px",
                textAlign: "center", pointerEvents: "none",
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: "50%",
                  border: "2px solid #1a2a3a", borderTopColor: "var(--amber)",
                  animation: "spin 0.8s linear infinite",
                  margin: "0 auto 12px",
                }} />
                <div style={{
                  color: "var(--amber)", fontSize: 11,
                  fontFamily: "'DM Mono', monospace", letterSpacing: "0.15em",
                }}>
                  AWAITING COMPASS SIGNAL
                </div>
                <div style={{
                  color: "#2a4560", fontSize: 9, marginTop: 6,
                  fontFamily: "'DM Mono', monospace", letterSpacing: "0.1em",
                }}>
                  Point device toward sky · Move slowly
                </div>
              </div>
            )}

            {/* No peaks in view (compass is working but nothing in frame) */}
            {!compassWaiting && labels.length === 0 && (
              <div style={{
                position: "absolute", bottom: 90, left: "50%",
                transform: "translateX(-50%)",
                color: "rgba(255,255,255,0.25)", fontSize: 11,
                letterSpacing: "0.15em", fontFamily: "'DM Mono', monospace",
                textAlign: "center", whiteSpace: "nowrap",
              }}>
                NO PEAKS IN FIELD OF VIEW
                {isDesktop && " — DRAG TO PAN"}
              </div>
            )}

            {/* ── BOTTOM HUD ── */}
            <div style={{
              position: "absolute", bottom: 20, left: "50%",
              transform: "translateX(-50%)",
              display: "flex", gap: 8, alignItems: "center",
            }}>
              {isDesktop && (
                <div style={{
                  background: "rgba(6,12,20,0.85)",
                  border: "1px solid rgba(245,158,11,0.15)",
                  borderRadius: 2, padding: "5px 14px",
                  color: "#2a4560", fontSize: 10,
                  letterSpacing: "0.15em",
                  fontFamily: "'DM Mono', monospace",
                }}>
                  ← DRAG TO PAN →
                </div>
              )}

              <button
                onClick={() => setShowDebug((v) => !v)}
                style={{
                  background: "rgba(6,12,20,0.85)",
                  border: "1px solid rgba(245,158,11,0.15)",
                  borderRadius: 2, padding: "5px 12px",
                  color: "#2a4560", fontSize: 10,
                  letterSpacing: "0.15em", cursor: "pointer",
                  fontFamily: "'DM Mono', monospace",
                  pointerEvents: "all",
                }}
              >
                {showDebug ? "HIDE DEBUG" : "DEBUG"}
              </button>
            </div>

            {/* ── DEBUG PANEL ── */}
            {showDebug && (
              <div style={{
                position: "absolute", bottom: 56, right: 16,
                background: "rgba(6,12,20,0.92)",
                border: "1px solid rgba(245,158,11,0.2)",
                borderRadius: 2, padding: "10px 14px",
                color: "var(--green)", fontSize: 10,
                fontFamily: "'DM Mono', monospace",
                lineHeight: 1.9, minWidth: 180,
              }}>
                <div style={{ color: "var(--amber)", marginBottom: 4, letterSpacing: "0.1em" }}>// SENSOR DATA</div>
                <div>source    {orientSource}</div>
                <div>heading   {heading !== null ? Math.round(heading) + "°" : "null"}</div>
                <div>pitch     {Math.round(pitch)}° (beta)</div>
                <div>lat       {(location ?? DEMO_LOCATION).lat.toFixed(5)}</div>
                <div>lng       {(location ?? DEMO_LOCATION).lng.toFixed(5)}</div>
                <div>elev      {(location ?? DEMO_LOCATION).elev.toFixed(0)}m</div>
                <div>peaks_vis {labels.length}</div>
                <div>h_fov     {H_FOV}°</div>
                <div>v_fov     {V_FOV}°</div>
              </div>
            )}
          </div>
        )}

        {/* ── ERROR TOAST ── */}
        {error && (
          <div style={{
            position: "absolute", bottom: 80, left: 16, right: 16,
            background: "rgba(239,68,68,0.9)", backdropFilter: "blur(8px)",
            borderRadius: 2, padding: "12px 16px",
            color: "#fff", fontSize: 12, letterSpacing: "0.05em",
            fontFamily: "'DM Mono', monospace",
            border: "1px solid rgba(248,113,113,0.5)",
          }}>
            ⚠ {error}
          </div>
        )}
      </div>
    </>
  );
}

// ─── Peak Label Sub-component ─────────────────────────────────────────────
function PeakLabel({ peak }) {
  const { x, y, name, elevFt, distKm, isFocus } = peak;

  return (
    <div
      className="peak-label"
      style={{
        position: "absolute",
        left: `${x}%`,
        top: `${y}%`,
        transform: "translate(-50%, -100%)",
        pointerEvents: "none",
        transition: "left 0.08s linear, top 0.08s linear",
      }}
    >
      {/* Label box */}
      <div style={{
        background: isFocus
          ? "rgba(245,158,11,0.95)"
          : "rgba(6,12,20,0.82)",
        backdropFilter: "blur(6px)",
        border: `1px solid ${isFocus ? "var(--amber)" : "rgba(245,158,11,0.25)"}`,
        borderRadius: 2,
        padding: isFocus ? "6px 12px" : "4px 10px",
        textAlign: "center",
        whiteSpace: "nowrap",
        transition: "all 0.15s",
        boxShadow: isFocus ? "0 0 20px rgba(245,158,11,0.4)" : "0 2px 12px rgba(0,0,0,0.5)",
      }}>
        <div style={{
          fontFamily: "'Barlow Condensed', sans-serif",
          fontWeight: 700,
          fontSize: isFocus ? 15 : 13,
          color: isFocus ? "#0a0e14" : "#e8edf2",
          letterSpacing: "0.04em",
          textTransform: "uppercase",
        }}>
          {name}
        </div>
        <div style={{
          fontFamily: "'DM Mono', monospace",
          fontSize: 9,
          color: isFocus ? "rgba(10,14,20,0.7)" : "rgba(245,158,11,0.7)",
          marginTop: 2, letterSpacing: "0.06em",
        }}>
          {elevFt} ft · {distKm} km
        </div>
      </div>

      {/* Stem line */}
      <div style={{
        width: 1,
        height: isFocus ? 36 : 20,
        background: isFocus
          ? "linear-gradient(180deg, var(--amber) 0%, transparent 100%)"
          : "linear-gradient(180deg, rgba(245,158,11,0.4) 0%, transparent 100%)",
        margin: "0 auto",
        transition: "height 0.15s",
      }} />

      {/* Base dot */}
      <div style={{
        width: isFocus ? 6 : 4,
        height: isFocus ? 6 : 4,
        borderRadius: "50%",
        background: isFocus ? "var(--amber)" : "rgba(245,158,11,0.5)",
        margin: "0 auto",
        boxShadow: isFocus ? "0 0 8px var(--amber)" : "none",
        transition: "all 0.15s",
      }} />
    </div>
  );
}
