import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import {
  normDeg, shortAngle, targetVector, dirVector, rotationFromEuler,
  applyCalibration, smoothRotation, cameraPose, focalLengthPx, project, toDeg,
} from "./arMath";

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
  // Summit coordinates (NAD83/WGS84) & elevations (NAVD88) from USGS / ListsOfJohn
  { name: "Cowles Mountain",    lat: 32.8125, lng: -117.0311, elev:  486 },
  { name: "North Fortuna",      lat: 32.8469, lng: -117.0609, elev:  394 },
  { name: "South Fortuna",      lat: 32.8352, lng: -117.0550, elev:  333 },
  { name: "Kwaay Paay Peak",    lat: 32.8279, lng: -117.0461, elev:  364 },
  { name: "Pyles Peak",         lat: 32.8230, lng: -117.0382, elev:  420 },
];

// ─── Constants ─────────────────────────────────────────────────────────────
const MAX_DIST = 180000; // only show peaks within 180 km

// Field of view across the LONG side of the camera frame. Typical phone main
// ("1x", ~26 mm-equivalent) cameras are 65–70°. The visible FOV on screen is
// derived from this, the video resolution and the object-fit: cover crop.
const CAMERA_FOV_LONG = 67;

// Observer eye height above ground when using terrain elevation
const EYE_HEIGHT = 1.6;
// Re-query terrain elevation when the user moves ~30 m
const DEM_GRID = 0.0003;

// ── Calibration ─────────────────────────────────────────────────────────────
// Magnetic declination for San Diego ~11.5° East (2025).
// true heading = magnetic + DECLINATION
// Positive = East declination (most of continental US). Look up your location:
// https://www.ngdc.noaa.gov/geomag/calculators/magcalc.shtml
const MAGNETIC_DECLINATION = 11.5;

const DEFAULT_CALIBRATION = {
  declination: MAGNETIC_DECLINATION,
  headingOffset: 0, // residual compass error, set by "align to peak"
  pitchOffset: 0,   // residual tilt error, set by "align to peak"
  fov: CAMERA_FOV_LONG,
};
const CALIBRATION_KEY = "peakar.calibration.v2";

// Orientation smoothing (0..1, higher = more responsive, more jitter)
const ROTATION_SMOOTHING = 0.25;
// iOS: the compass (noisy) anchors the gyro (smooth, but relative) heading
const COMPASS_SMOOTHING = 0.03;

// Default demo location: Mission Trails Regional Park
const DEMO_LOCATION = { lat: 32.8172, lng: -117.0519, elev: 120 };

function loadCalibration() {
  try {
    return { ...DEFAULT_CALIBRATION, ...JSON.parse(localStorage.getItem(CALIBRATION_KEY) ?? "{}") };
  } catch {
    return DEFAULT_CALIBRATION;
  }
}

// Screen rotation relative to the device's natural (portrait) frame, which is
// the frame DeviceOrientation reports in. WebKit (all iOS browsers) reports
// screen.orientation.angle = 90 in portrait, so prefer window.orientation,
// which WebKit and Chrome both define relative to portrait.
function getScreenAngle() {
  if (typeof window.orientation === "number") return (window.orientation + 360) % 360;
  return screen.orientation?.angle ?? 0;
}

function compassLabel(h) {
  const dirs = ["N","NNE","NE","ENE","E","ESE","SE","SSE","S","SSW","SW","WSW","W","WNW","NW","NNW"];
  return dirs[Math.round(h / 22.5) % 16];
}

// ─── Styles ──────────────────────────────────────────────────────────────────
const styles = {
  root: {
    width: "100vw", height: "100dvh",
    background: "#f3ead8",
    position: "relative", overflow: "hidden",
    fontFamily: "'Nunito', system-ui, sans-serif",
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
  const rootRef          = useRef(null);
  const videoRef         = useRef(null);
  const dragRef          = useRef({ active: false, startX: 0, startY: 0, startHeading: 0, startPitch: 0 });
  const rawRef           = useRef(null); // latest absolute (magnetic) orientation sample
  const compassOffsetRef = useRef(null); // iOS: smoothed gyro→compass yaw offset {s, c}
  const smoothRRef       = useRef(null);
  const eventCountRef    = useRef(0);

  const [phase, setPhase]           = useState("start"); // start | loading | ready
  const [error, setError]           = useState(null);
  const [isDesktop]                 = useState(() => !/Android|iPhone|iPad|iPod/i.test(navigator.userAgent));
  const [cameraOn, setCameraOn]     = useState(false);
  const [orientGranted, setOrientGranted] = useState(false);

  // Sensors
  const [location, setLocation]     = useState(null);   // { lat, lng, alt, accuracy }
  const [groundElev, setGroundElev] = useState(null);   // terrain elevation at user (m, MSL)
  const [deviceR, setDeviceR]       = useState(null);   // smoothed device→Earth rotation (magnetic)
  const [compassAccuracy, setCompassAccuracy] = useState(null);
  const [compassRaw, setCompassRaw] = useState(null); // iOS webkitCompassHeading (magnetic)
  const [eventRate, setEventRate]   = useState(0);    // orientation events / second
  // "none" | "ios" | "absolute"
  const [orientSource, setOrientSource] = useState("none");

  // Desktop sim
  const [simHeading, setSimHeading] = useState(60);
  const [simPitch, setSimPitch]     = useState(0);

  // Screen / camera geometry
  const [viewport, setViewport]     = useState(() => ({ w: window.innerWidth, h: window.innerHeight, angle: getScreenAngle() }));
  const [videoSize, setVideoSize]   = useState(null);

  const [showDebug, setShowDebug]   = useState(false);

  // Runtime calibration (persisted to localStorage)
  const [calibration, setCalibration] = useState(loadCalibration);
  const [alignPeak, setAlignPeak]     = useState(PEAKS[0].name);
  const updateCalibration = (patch) => setCalibration((c) => ({ ...c, ...patch }));

  useEffect(() => {
    localStorage.setItem(CALIBRATION_KEY, JSON.stringify(calibration));
  }, [calibration]);

  // ── Viewport / screen orientation ─────────────────────────────────────────
  // Measure the actual root box: on iOS Safari 100vh ≠ innerHeight (toolbars),
  // and the video, crosshair and labels are all laid out in the root box.
  useEffect(() => {
    const el = rootRef.current;
    const update = () => setViewport({ w: el.clientWidth, h: el.clientHeight, angle: getScreenAngle() });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    window.addEventListener("orientationchange", update);
    screen.orientation?.addEventListener?.("change", update);
    return () => {
      ro.disconnect();
      window.removeEventListener("orientationchange", update);
      screen.orientation?.removeEventListener?.("change", update);
    };
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

  const onVideoResize = (e) => {
    const { videoWidth: w, videoHeight: h } = e.currentTarget;
    if (w && h) setVideoSize({ w, h });
  };

  // ── Geolocation (continuous — first fixes are often coarse) ───────────────
  useEffect(() => {
    if (phase !== "ready" || isDesktop || !navigator.geolocation) return;
    const id = navigator.geolocation.watchPosition(
      (pos) => {
        setLocation({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          alt: pos.coords.altitude,
          accuracy: pos.coords.accuracy,
        });
        setError((e) => (e?.startsWith("Location") ? null : e));
      },
      (err) => setError(`Location unavailable (${err.message}) — using demo location.`),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 5000 }
    );
    return () => navigator.geolocation.clearWatch(id);
  }, [phase, isDesktop]);

  const baseLocation = (!isDesktop && location) || DEMO_LOCATION;

  // ── Terrain elevation ──────────────────────────────────────────────────────
  // GPS altitude is noisy (±10–30 m), often ellipsoidal rather than sea-level
  // (~35 m off in San Diego) and frequently null. Use a DEM lookup instead.
  const snap = (d) => (Math.round(d / DEM_GRID) * DEM_GRID).toFixed(4);
  const demKey = `${snap(baseLocation.lat)},${snap(baseLocation.lng)}`;
  useEffect(() => {
    if (phase !== "ready") return;
    const ctrl = new AbortController();
    const [lat, lng] = demKey.split(",");
    fetch(`https://api.open-meteo.com/v1/elevation?latitude=${lat}&longitude=${lng}`, { signal: ctrl.signal })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(r.statusText))))
      .then((d) => { if (Number.isFinite(d?.elevation?.[0])) setGroundElev(d.elevation[0]); })
      .catch(() => {});
    return () => ctrl.abort();
  }, [phase, demKey]);

  const observer = useMemo(() => {
    const gpsAlt = baseLocation.alt ?? baseLocation.elev;
    if (groundElev != null) return { ...baseLocation, elev: groundElev + EYE_HEIGHT, elevSource: "terrain" };
    if (gpsAlt != null) return { ...baseLocation, elev: gpsAlt, elevSource: baseLocation === DEMO_LOCATION ? "demo" : "gps" };
    return { ...baseLocation, elev: DEMO_LOCATION.elev, elevSource: "default" };
  }, [baseLocation, groundElev]);

  // ── Device orientation ─────────────────────────────────────────────────────
  // We keep the full alpha/beta/gamma rotation (not just alpha or beta), so
  // heading and tilt stay correct when the phone is upright, tilted or rolled.
  useEffect(() => {
    if (phase !== "ready" || isDesktop || !orientGranted) return;

    // Android Chrome: alpha is absolute (magnetic north)
    const onAbsolute = (e) => {
      if (!e.absolute || e.alpha == null || e.beta == null || e.gamma == null) return;
      rawRef.current = { alpha: e.alpha, beta: e.beta, gamma: e.gamma, source: "absolute", accuracy: null };
      eventCountRef.current++;
    };

    // iOS: alpha is relative to wherever the phone pointed at startup, while
    // webkitCompassHeading (magnetic) is absolute but noisy. Fuse them: the
    // gyro gives smooth motion, the compass slowly corrects the yaw offset.
    const onRelative = (e) => {
      if (typeof e.webkitCompassHeading !== "number") return onAbsolute(e);
      if (e.alpha == null || e.beta == null || e.gamma == null) return;
      if (e.webkitCompassAccuracy == null || e.webkitCompassAccuracy >= 0) {
        const R = rotationFromEuler(e.alpha, e.beta, e.gamma);
        const pose = cameraPose(R);
        // iOS reports the camera direction when upright, the top edge when flat
        const refHeading = Math.abs(pose.pitch) < 50
          ? pose.heading
          : normDeg(toDeg(Math.atan2(R[0][1], R[1][1])));
        const off = ((refHeading - e.webkitCompassHeading) * Math.PI) / 180;
        const o = compassOffsetRef.current;
        compassOffsetRef.current = o
          ? { s: o.s + (Math.sin(off) - o.s) * COMPASS_SMOOTHING, c: o.c + (Math.cos(off) - o.c) * COMPASS_SMOOTHING }
          : { s: Math.sin(off), c: Math.cos(off) };
      }
      const o = compassOffsetRef.current;
      if (!o) return;
      rawRef.current = {
        alpha: e.alpha + toDeg(Math.atan2(o.s, o.c)),
        beta: e.beta, gamma: e.gamma,
        source: "ios", accuracy: e.webkitCompassAccuracy, compass: e.webkitCompassHeading,
      };
      eventCountRef.current++;
    };

    window.addEventListener("deviceorientationabsolute", onAbsolute, true);
    window.addEventListener("deviceorientation", onRelative, true);
    return () => {
      window.removeEventListener("deviceorientationabsolute", onAbsolute, true);
      window.removeEventListener("deviceorientation", onRelative, true);
    };
  }, [phase, isDesktop, orientGranted]);

  // Smooth + publish orientation once per animation frame
  useEffect(() => {
    if (phase !== "ready" || isDesktop) return;
    let id;
    const rateTimer = setInterval(() => {
      setEventRate(eventCountRef.current);
      eventCountRef.current = 0;
    }, 1000);
    const tick = () => {
      const r = rawRef.current;
      if (r) {
        smoothRRef.current = smoothRotation(smoothRRef.current, rotationFromEuler(r.alpha, r.beta, r.gamma), ROTATION_SMOOTHING);
        setDeviceR(smoothRRef.current);
        setOrientSource(r.source);
        setCompassAccuracy(r.accuracy);
        setCompassRaw(r.compass ?? null);
      }
      id = requestAnimationFrame(tick);
    };
    id = requestAnimationFrame(tick);
    return () => { cancelAnimationFrame(id); clearInterval(rateTimer); };
  }, [phase, isDesktop]);

  // ── Initialize ─────────────────────────────────────────────────────────────
  const initialize = useCallback(async () => {
    setPhase("loading");

    // ⚠️ iOS Safari: requestPermission() MUST be called first — before any
    // other awaits — while still inside the synchronous user-gesture context.
    // Awaiting getUserMedia() first breaks the gesture chain and iOS silently
    // denies orientation access.
    let granted = true; // non-iOS: no permission API, assume available
    if (
      typeof DeviceOrientationEvent !== "undefined" &&
      typeof DeviceOrientationEvent.requestPermission === "function"
    ) {
      try {
        const res = await DeviceOrientationEvent.requestPermission();
        granted = res === "granted";
      } catch {
        granted = false;
      }
    }

    await startCamera();

    if (!isDesktop) {
      setOrientGranted(granted);
      if (!granted) setError("Compass access denied — labels won't track rotation.");
    }

    setPhase("ready");
  }, [startCamera, isDesktop]);

  // ── Camera pose (true north, calibrated) ──────────────────────────────────
  const R = useMemo(() => {
    if (isDesktop) {
      return applyCalibration(rotationFromEuler(-simHeading, 90 + simPitch, 0), calibration.headingOffset, calibration.pitchOffset);
    }
    if (!deviceR) return null;
    return applyCalibration(deviceR, calibration.declination + calibration.headingOffset, calibration.pitchOffset);
  }, [isDesktop, simHeading, simPitch, deviceR, calibration]);

  const pose = useMemo(() => (R ? cameraPose(R) : null), [R]);

  const projection = useMemo(() => ({
    f: focalLengthPx({
      viewW: viewport.w, viewH: viewport.h,
      videoW: cameraOn ? videoSize?.w : undefined,
      videoH: cameraOn ? videoSize?.h : undefined,
      fovLongDeg: calibration.fov,
    }),
    viewW: viewport.w, viewH: viewport.h,
    screenAngle: isDesktop ? 0 : viewport.angle,
  }), [viewport, videoSize, cameraOn, calibration.fov, isDesktop]);

  // ── Compute label positions ────────────────────────────────────────────────
  const labels = useMemo(() => {
    // On mobile, don't render anything until we have a real compass heading.
    if (phase !== "ready" || !R) return [];
    return PEAKS.map((peak) => {
      const t = targetVector(observer, peak);
      if (t.dist > MAX_DIST || t.dist < 100) return null;

      const s = project(R, t.v, projection);
      if (!s || s.x < 0 || s.x > projection.viewW || s.y < 0 || s.y > projection.viewH) return null;

      const cosOff = pose.forward[0] * t.v[0] + pose.forward[1] * t.v[1] + pose.forward[2] * t.v[2];
      const isFocus = toDeg(Math.acos(Math.min(1, cosOff))) < 3;

      return {
        ...peak, x: s.x, y: s.y, dist: t.dist, az: t.az, elevAngle: t.elevAngle, isFocus,
        distKm: (t.dist / 1000).toFixed(1),
        elevFt: Math.round(peak.elev * 3.28084).toLocaleString(),
      };
    })
      .filter(Boolean)
      .sort((a, b) => b.dist - a.dist);
  }, [phase, R, pose, observer, projection]);

  // Debug: compass ticks on the true horizon every 10°, projected like labels.
  // They must stay glued to the real world; their spacing reveals FOV errors.
  const horizonTicks = useMemo(() => {
    if (!showDebug || !pose) return [];
    const base = Math.round(pose.heading / 10) * 10;
    return Array.from({ length: 19 }, (_, i) => normDeg(base + (i - 9) * 10))
      .map((az) => ({ az, s: project(R, dirVector(az, 0), projection) }))
      .filter(({ s }) => s && s.x >= 0 && s.x <= projection.viewW && s.y >= 0 && s.y <= projection.viewH);
  }, [showDebug, R, pose, projection]);

  // True horizon line (a straight line under pinhole projection)
  const horizon = useMemo(() => {
    if (!pose) return null;
    const a = project(R, dirVector(pose.heading - 15, 0), projection);
    const b = project(R, dirVector(pose.heading + 15, 0), projection);
    if (!a || !b) return null;
    return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, angle: toDeg(Math.atan2(b.y - a.y, b.x - a.x)) };
  }, [R, pose, projection]);

  // ── Align calibration: put the chosen summit under the crosshair ──────────
  const alignToPeak = () => {
    const peak = PEAKS.find((p) => p.name === alignPeak);
    if (!pose || !peak) return;
    const t = targetVector(observer, peak);
    setCalibration((c) => ({
      ...c,
      headingOffset: shortAngle(c.headingOffset + shortAngle(t.az, pose.heading), 0),
      pitchOffset: c.pitchOffset + (t.elevAngle - pose.pitch),
    }));
  };

  // ── Desktop drag-to-pan ────────────────────────────────────────────────────
  const onPointerDown = (e) => {
    if (!isDesktop || phase !== "ready" || e.target.closest("button, input, select")) return;
    dragRef.current = { active: true, startX: e.clientX, startY: e.clientY, startHeading: simHeading, startPitch: simPitch };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e) => {
    if (!isDesktop || !dragRef.current.active) return;
    const dx = e.clientX - dragRef.current.startX;
    const dy = e.clientY - dragRef.current.startY;
    setSimHeading(normDeg(dragRef.current.startHeading + dx * 0.15));
    setSimPitch(Math.max(-45, Math.min(45, dragRef.current.startPitch - dy * 0.15)));
  };
  const onPointerUp = () => { dragRef.current.active = false; };

  const effectiveHeading  = pose?.heading ?? 0;
  const compassReady      = !isDesktop && R !== null;
  const compassWaiting    = !isDesktop && R === null;
  const gpsReady          = location !== null && !isDesktop;
  const visibleFov        = (px) => (2 * toDeg(Math.atan(px / 2 / projection.f))).toFixed(0);

  // ─────────────────────────────────────────────────────────────────────────
  return (
    <>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Fraunces:ital,opsz,wght,SOFT@0,9..144,400..700,0..100;1,9..144,400..700,0..100&family=Nunito:wght@400;600;700&family=DM+Mono:wght@400;500&display=swap');
        * { box-sizing: border-box; margin: 0; padding: 0; }
        :root {
          --paper: #fbf6ec;
          --cream: #f3ead8;
          --sand:  #e3d4b6;
          --bark:  #3a2e24;
          --soil:  #6b5443;
          --moss:  #5f7346;
          --sage:  #a7b48c;
          --pine:  #2e4536;
          --clay:  #b5653a;
          --ochre: #c9973f;
          --serif: 'Fraunces', Georgia, serif;
          --sans:  'Nunito', system-ui, sans-serif;
          --mono:  'DM Mono', ui-monospace, monospace;
        }
        body { overflow: hidden; background: var(--cream); }

        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(20px); }
          to   { opacity: 1; transform: translateY(0); }
        }
        @keyframes spin {
          to { transform: rotate(360deg); }
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
          padding: 14px 34px;
          background: var(--moss);
          color: var(--paper);
          border: none;
          border-radius: 999px;
          font-family: var(--sans);
          font-size: 17px;
          font-weight: 700;
          letter-spacing: 0.01em;
          cursor: pointer;
          box-shadow: 0 6px 18px rgba(58,46,36,0.18);
          transition: background 0.15s, transform 0.1s;
          pointer-events: all;
        }
        .btn-primary:hover { background: var(--pine); transform: translateY(-1px); }
        .btn-primary:active { transform: translateY(0); }
        .pill {
          background: rgba(251,246,236,0.9);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border: 1px solid rgba(58,46,36,0.12);
          border-radius: 999px;
          box-shadow: 0 4px 14px rgba(58,46,36,0.18);
          color: var(--soil);
          font-family: var(--sans);
        }
        .card {
          background: rgba(251,246,236,0.94);
          backdrop-filter: blur(10px);
          -webkit-backdrop-filter: blur(10px);
          border: 1px solid rgba(58,46,36,0.12);
          border-radius: 16px;
          box-shadow: 0 8px 24px rgba(58,46,36,0.22);
          color: var(--bark);
        }
        .on-camera { text-shadow: 0 1px 3px rgba(40,30,20,0.6); }
      `}</style>

      <div
        ref={rootRef}
        style={styles.root}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* ── Video feed ── */}
        <video
          ref={videoRef}
          autoPlay playsInline muted
          onLoadedMetadata={onVideoResize}
          onResize={onVideoResize}
          style={{
            ...styles.video,
            opacity: cameraOn ? 1 : 0,
            transition: "opacity 0.8s",
          }}
        />

        {/* Dusky landscape gradient when no camera */}
        {!cameraOn && phase === "ready" && (
          <div style={{
            position: "absolute", inset: 0,
            background: "linear-gradient(180deg, #8c9f9b 0%, #b7b298 48%, #a48c66 74%, #6d6a45 88%, #4f5a38 100%)",
          }} />
        )}

        {/* ── START SCREEN ── */}
        {phase === "start" && (
          <div style={{
            position: "absolute", inset: 0,
            display: "flex", flexDirection: "column",
            alignItems: "center", justifyContent: "center",
            background: "linear-gradient(180deg, var(--paper) 0%, var(--cream) 60%, var(--sand) 100%)",
            padding: 32,
          }}>
            {/* Grid lines */}
            <div style={{
              position: "absolute", inset: 0,
              backgroundImage: `
                linear-gradient(rgba(95,115,70,0.09) 1px, transparent 1px),
                linear-gradient(90deg, rgba(95,115,70,0.09) 1px, transparent 1px)
              `,
              backgroundSize: "60px 60px",
            }} />

            <div style={{ animation: "fadeUp 0.6s ease both", textAlign: "center", position: "relative" }}>
              <div style={{ marginBottom: 22 }}>
                <svg width="64" height="44" viewBox="0 0 64 44" fill="none">
                  <path d="M4 40 L24 12 Q26 9 28 12 L34 20 L40 13 Q42 10 44 13 L60 40 Z" fill="var(--moss)" />
                  <path d="M24 12 Q26 9 28 12 L31 16 L27 19 L24 16 L21 18 Z" fill="var(--paper)" />
                  <circle cx="50" cy="8" r="5" fill="var(--ochre)" />
                </svg>
              </div>

              <div style={{
                fontFamily: "var(--sans)", fontWeight: 600,
                fontSize: 13, letterSpacing: "0.12em",
                color: "var(--clay)", marginBottom: 10,
                textTransform: "uppercase",
              }}>
                A field guide to the skyline
              </div>

              <h1 style={{
                fontFamily: "var(--serif)",
                fontVariationSettings: "'SOFT' 100, 'opsz' 144",
                fontSize: 60, fontWeight: 600,
                color: "var(--bark)", letterSpacing: "-0.01em",
                lineHeight: 1, marginBottom: 14,
              }}>
                Peak <span style={{ fontStyle: "italic", color: "var(--moss)" }}>AR</span>
              </h1>

              <p style={{
                color: "var(--soil)", fontSize: 16, lineHeight: 1.55,
                maxWidth: 280, margin: "0 auto 32px",
                fontFamily: "var(--sans)",
              }}>
                Point your camera at the mountains and learn every peak by name.
              </p>

              <button className="btn-primary" onClick={initialize}>
                Begin exploring
              </button>

              <div style={{
                marginTop: 18, color: "var(--soil)", opacity: 0.75, fontSize: 13,
                fontFamily: "var(--serif)", fontStyle: "italic",
              }}>
                {isDesktop
                  ? "Desktop mode — drag to look around"
                  : "Uses your camera, location and compass"}
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
            background: "var(--cream)", gap: 18,
          }}>
            <div style={{
              width: 44, height: 44, borderRadius: "50%",
              border: "3px solid var(--sand)",
              borderTopColor: "var(--moss)",
              animation: "spin 0.9s linear infinite",
            }} />
            <div style={{ color: "var(--soil)", fontSize: 17, fontFamily: "var(--serif)", fontStyle: "italic" }}>
              Getting your bearings…
            </div>
          </div>
        )}

        {/* ── AR OVERLAY ── */}
        {phase === "ready" && (
          <div style={styles.overlay}>

            {/* Center sight */}
            <div style={{
              position: "absolute", top: "50%", left: "50%",
              transform: "translate(-50%, -50%)",
              width: 30, height: 30, borderRadius: "50%",
              border: "1.5px solid rgba(251,246,236,0.7)",
              boxShadow: "0 0 0 1px rgba(58,46,36,0.25), inset 0 0 0 1px rgba(58,46,36,0.25)",
            }}>
              <div style={{
                position: "absolute", top: "50%", left: "50%",
                transform: "translate(-50%,-50%)",
                width: 4, height: 4, borderRadius: "50%",
                background: "var(--paper)",
              }} />
            </div>

            {/* Horizon line (projected — follows tilt and roll) */}
            {horizon && (
            <div style={{
              position: "absolute", left: horizon.x, top: horizon.y,
              width: "200vmax", height: 1,
              transform: `translate(-50%, -50%) rotate(${horizon.angle}deg)`,
              background: "linear-gradient(90deg, transparent 0%, rgba(251,246,236,0.35) 40%, rgba(251,246,236,0.35) 60%, transparent 100%)",
            }}>
              <div className="on-camera" style={{
                position: "absolute", left: "50%", transform: "translateX(-50%)",
                top: 4, color: "rgba(251,246,236,0.75)", fontSize: 11,
                fontFamily: "var(--serif)", fontStyle: "italic",
              }}>
                horizon
              </div>
            </div>
            )}

            {/* ── COMPASS BAR ── */}
            <div className="pill" style={{
              position: "absolute", top: 18, left: "50%",
              transform: "translateX(-50%)",
              display: "flex", alignItems: "center", gap: 10,
              padding: "6px 16px 6px 12px",
              whiteSpace: "nowrap",
            }}>
              {/* Compass needle */}
              <svg width="16" height="16" viewBox="0 0 16 16">
                <polygon points="8,1 10,8 8,7 6,8" fill="var(--clay)" />
                <polygon points="8,15 6,8 8,9 10,8" fill="var(--sand)" />
              </svg>

              <span style={{
                fontFamily: "var(--serif)",
                fontVariationSettings: "'SOFT' 100",
                fontSize: 20, fontWeight: 600, color: "var(--bark)",
                minWidth: 44, fontVariantNumeric: "tabular-nums",
              }}>
                {Math.round(effectiveHeading).toString().padStart(3, "0")}°
              </span>

              <span style={{
                fontFamily: "var(--serif)", fontStyle: "italic",
                fontSize: 16, fontWeight: 500, color: "var(--clay)",
                minWidth: 32,
              }}>
                {compassLabel(effectiveHeading)}
              </span>

              <div style={{ width: 1, height: 16, background: "rgba(58,46,36,0.15)" }} />

              {/* Status indicators */}
              <div style={{ display: "flex", gap: 8, fontSize: 11, fontWeight: 700 }}>
                <span style={{
                  color: gpsReady ? "var(--moss)" : "var(--soil)", opacity: gpsReady ? 1 : 0.6,
                  animation: gpsReady ? "none" : "pulse 1.5s ease infinite",
                }}>
                  {gpsReady ? "● GPS" : "○ GPS"}
                </span>
                <span style={{
                  color: compassReady ? "var(--moss)" : "var(--soil)", opacity: compassReady ? 1 : 0.6,
                  animation: (!compassReady && !isDesktop) ? "pulse 1.5s ease infinite" : "none",
                }}>
                  {isDesktop ? "◐ Sim" : compassReady ? "● Compass" : "○ Compass"}
                </span>
              </div>
            </div>

            {horizonTicks.map(({ az, s }) => (
              <div key={az} className="on-camera" style={{
                position: "absolute", left: s.x, top: s.y, transform: "translate(-50%, -100%)",
                color: "var(--paper)", fontSize: 11, fontFamily: "var(--sans)", fontWeight: 600, textAlign: "center",
              }}>
                {az % 90 === 0 ? compassLabel(az) : az}
                <div style={{ width: 1, height: 10, background: "rgba(251,246,236,0.8)", margin: "0 auto" }} />
              </div>
            ))}

            {/* ── PEAK LABELS ── */}
            {labels.map((peak) => (
              <PeakLabel key={peak.name} peak={peak} />
            ))}

            {/* Waiting for compass */}
            {compassWaiting && (
              <div className="card" style={{
                position: "absolute", top: "50%", left: "50%",
                transform: "translate(-50%, -50%)",
                padding: "20px 28px",
                textAlign: "center", pointerEvents: "none",
              }}>
                <div style={{
                  width: 28, height: 28, borderRadius: "50%",
                  border: "3px solid var(--sand)", borderTopColor: "var(--moss)",
                  animation: "spin 0.9s linear infinite",
                  margin: "0 auto 12px",
                }} />
                <div style={{ fontFamily: "var(--serif)", fontSize: 17, fontWeight: 600 }}>
                  Finding north…
                </div>
                <div style={{ color: "var(--soil)", fontSize: 13, marginTop: 4, fontFamily: "var(--sans)" }}>
                  Hold your phone up and move slowly
                </div>
              </div>
            )}

            {/* No peaks in view (compass is working but nothing in frame) */}
            {!compassWaiting && labels.length === 0 && (
              <div className="on-camera" style={{
                position: "absolute", bottom: 90, left: "50%",
                transform: "translateX(-50%)",
                color: "rgba(251,246,236,0.85)", fontSize: 15,
                fontFamily: "var(--serif)", fontStyle: "italic",
                textAlign: "center", whiteSpace: "nowrap",
              }}>
                No peaks in view{isDesktop && " — drag to look around"}
              </div>
            )}

            {/* ── BOTTOM HUD ── */}
            <div style={{
              position: "absolute", bottom: 20, left: "50%",
              transform: "translateX(-50%)",
              display: "flex", gap: 8, alignItems: "center",
            }}>
              {isDesktop && (
                <div className="pill" style={{ padding: "6px 14px", fontSize: 12, fontWeight: 600 }}>
                  ← Drag to pan →
                </div>
              )}

              <button
                className="pill"
                onClick={() => setShowDebug((v) => !v)}
                style={{
                  padding: "6px 14px", fontSize: 12, fontWeight: 600,
                  cursor: "pointer", pointerEvents: "all",
                }}
              >
                {showDebug ? "Hide details" : "Details"}
              </button>
            </div>

            {/* ── DEBUG PANEL ── */}
            {showDebug && (
              <div className="card" style={{
                position: "absolute", bottom: 60, right: 16,
                padding: "12px 16px",
                color: "var(--soil)", fontSize: 10,
                fontFamily: "var(--mono)",
                lineHeight: 1.85, minWidth: 190, textAlign: "left",
              }}>
                <div style={sectionHead}>Sensor data</div>
                <div>build     {import.meta.env.VITE_BUILD_ID}</div>
                <div>source    {isDesktop ? "sim" : orientSource}{compassAccuracy != null && ` ±${Math.round(compassAccuracy)}°`}{!isDesktop && ` · ${eventRate}/s`}</div>
                <div>heading   {pose ? Math.round(pose.heading) + "° true" : "null"}</div>
                {compassRaw != null && <div>compass   {Math.round(compassRaw)}° mag (raw)</div>}
                <div>adj       {calibration.headingOffset.toFixed(1)}° hdg · {calibration.pitchOffset.toFixed(1)}° pitch</div>
                <div>pitch     {pose ? pose.pitch.toFixed(1) + "°" : "null"}</div>
                <div>lat       {observer.lat.toFixed(5)}</div>
                <div>lng       {observer.lng.toFixed(5)}</div>
                <div style={{ color: location ? undefined : "var(--clay)" }}>
                  gps acc   {location?.accuracy != null ? "±" + Math.round(location.accuracy) + " m" : "NONE — using demo location"}
                </div>
                <div>elev      {Math.round(observer.elev)} m ({observer.elevSource})</div>
                <div>fov       {visibleFov(projection.viewW)}° × {visibleFov(projection.viewH)}°{videoSize ? ` (${videoSize.w}×${videoSize.h})` : ""}</div>
                <div>view      {Math.round(projection.viewW)}×{Math.round(projection.viewH)} @ {projection.screenAngle}°</div>
                <div>peaks_vis {labels.length}</div>

                <div style={{ ...sectionHead, marginTop: 10 }}>Calibration</div>

                <CalSlider label="declination" unit="°" min={-20} max={20} step={0.5}
                  value={calibration.declination} onChange={(v) => updateCalibration({ declination: v })} />
                <CalSlider label="camera fov" unit="°" min={45} max={90} step={0.5}
                  value={calibration.fov} onChange={(v) => updateCalibration({ fov: v })} />
                <CalSlider label="heading adj" unit="°" min={-30} max={30} step={0.5}
                  value={calibration.headingOffset} onChange={(v) => updateCalibration({ headingOffset: v })} />
                <CalSlider label="pitch adj" unit="°" min={-15} max={15} step={0.25}
                  value={calibration.pitchOffset} onChange={(v) => updateCalibration({ pitchOffset: v })} />

                <div style={{ color: "var(--soil)", fontSize: 11, margin: "6px 0 6px", lineHeight: 1.4, fontFamily: "var(--sans)" }}>
                  Center a summit in the sight, then:
                </div>
                <div style={{ display: "flex", gap: 6, pointerEvents: "all" }}>
                  <select value={alignPeak} onChange={(e) => setAlignPeak(e.target.value)} style={debugControl}>
                    {PEAKS.map((p) => <option key={p.name} value={p.name}>{p.name}</option>)}
                  </select>
                  <button onClick={alignToPeak} disabled={!pose} style={{ ...debugControl, background: "var(--moss)", color: "var(--paper)", borderColor: "var(--moss)" }}>Align</button>
                  <button onClick={() => setCalibration(DEFAULT_CALIBRATION)} style={debugControl}>Reset</button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── ERROR TOAST ── */}
        {error && (
          <div style={{
            position: "absolute", bottom: 80, left: 16, right: 16,
            background: "var(--clay)",
            borderRadius: 14, padding: "12px 16px",
            color: "var(--paper)", fontSize: 14,
            fontFamily: "var(--sans)", fontWeight: 600,
            boxShadow: "0 8px 24px rgba(58,46,36,0.25)",
          }}>
            {error}
          </div>
        )}
      </div>
    </>
  );
}

const sectionHead = {
  fontFamily: "var(--serif)", fontStyle: "italic", fontSize: 14, fontWeight: 600,
  color: "var(--bark)", marginBottom: 4,
};

const debugControl = {
  background: "var(--cream)", color: "var(--bark)",
  border: "1px solid rgba(58,46,36,0.2)", borderRadius: 999,
  fontFamily: "var(--sans)", fontWeight: 600, fontSize: 11, padding: "4px 10px",
  pointerEvents: "all", cursor: "pointer",
};

// ─── Calibration Slider ───────────────────────────────────────────────────
function CalSlider({ label, unit, value, min, max, step, onChange }) {
  return (
    <div style={{ marginBottom: 4 }}>
      <div>{label.padEnd(12, " ")}{value > 0 ? "+" : ""}{value.toFixed(step < 1 ? 1 : 0)}{unit}</div>
      <input type="range" min={min} max={max} step={step} value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ width: "100%", accentColor: "var(--moss)", pointerEvents: "all" }}
      />
    </div>
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
        left: x,
        top: y,
        transform: "translate(-50%, -100%)",
        pointerEvents: "none",
        // No CSS transition on position: it updates every frame (smoothing is
        // done on the rotation), and WebKit restarts the transition on every
        // change so the label never moves.
      }}
    >
      {/* Label card */}
      <div style={{
        background: isFocus ? "var(--moss)" : "rgba(251,246,236,0.92)",
        backdropFilter: "blur(6px)",
        WebkitBackdropFilter: "blur(6px)",
        border: `1px solid ${isFocus ? "var(--pine)" : "rgba(58,46,36,0.12)"}`,
        borderRadius: 12,
        padding: isFocus ? "7px 14px" : "5px 11px",
        textAlign: "center",
        whiteSpace: "nowrap",
        transition: "background 0.15s, padding 0.15s",
        boxShadow: isFocus ? "0 8px 22px rgba(46,69,54,0.45)" : "0 4px 14px rgba(58,46,36,0.3)",
      }}>
        <div style={{
          fontFamily: "var(--serif)",
          fontVariationSettings: "'SOFT' 100",
          fontWeight: 600,
          fontSize: isFocus ? 17 : 14,
          color: isFocus ? "var(--paper)" : "var(--bark)",
          lineHeight: 1.15,
        }}>
          {name}
        </div>
        <div style={{
          fontFamily: "var(--sans)",
          fontWeight: 600,
          fontSize: 10,
          color: isFocus ? "rgba(251,246,236,0.85)" : "var(--soil)",
          marginTop: 2,
        }}>
          {elevFt} ft · {distKm} km
        </div>
      </div>

      {/* Stem line */}
      <div style={{
        width: 1.5,
        height: isFocus ? 36 : 20,
        background: "linear-gradient(180deg, rgba(251,246,236,0.9) 0%, rgba(251,246,236,0) 100%)",
        margin: "0 auto",
        transition: "height 0.15s",
      }} />

      {/* Base dot */}
      <div style={{
        width: isFocus ? 8 : 6,
        height: isFocus ? 8 : 6,
        borderRadius: "50%",
        background: isFocus ? "var(--moss)" : "var(--paper)",
        border: `1.5px solid ${isFocus ? "var(--paper)" : "rgba(58,46,36,0.4)"}`,
        margin: "0 auto",
        transition: "width 0.15s, height 0.15s",
      }} />
    </div>
  );
}
