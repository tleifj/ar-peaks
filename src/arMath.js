// ─── AR math: geodesy, device orientation, pinhole camera projection ────────
// Frames:
//   Earth (ENU): x = East, y = North, z = Up
//   Device (W3C DeviceOrientation): x = right, y = top, z = out of the screen
//   The rear camera looks along device −z.

export const toRad = (d) => (d * Math.PI) / 180;
export const toDeg = (r) => (r * 180) / Math.PI;
export const normDeg = (d) => ((d % 360) + 360) % 360;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

const R_EARTH = 6371008.8;
// Standard atmospheric refraction coefficient (light bends ~1/7 of curvature)
const REFRACTION_K = 0.13;

export function getBearing(lat1, lng1, lat2, lng2) {
  const f1 = toRad(lat1), f2 = toRad(lat2), dl = toRad(lng2 - lng1);
  const y = Math.sin(dl) * Math.cos(f2);
  const x = Math.cos(f1) * Math.sin(f2) - Math.sin(f1) * Math.cos(f2) * Math.cos(dl);
  return normDeg(toDeg(Math.atan2(y, x)));
}

export function getDistanceM(lat1, lng1, lat2, lng2) {
  const f1 = toRad(lat1), f2 = toRad(lat2);
  const df = toRad(lat2 - lat1), dl = toRad(lng2 - lng1);
  const a = Math.sin(df / 2) ** 2 + Math.cos(f1) * Math.cos(f2) * Math.sin(dl / 2) ** 2;
  return R_EARTH * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

// Shortest angular difference: result in [-180, 180]
export function shortAngle(a, b) {
  return ((a - b + 540) % 360) - 180;
}

// Unit ENU direction from an observer to a target, with curvature + refraction.
export function targetVector(obs, tgt) {
  const dist = getDistanceM(obs.lat, obs.lng, tgt.lat, tgt.lng);
  const az = getBearing(obs.lat, obs.lng, tgt.lat, tgt.lng);
  const drop = ((dist * dist) / (2 * R_EARTH)) * (1 - REFRACTION_K);
  const dh = tgt.elev - obs.elev - drop;
  return { v: dirVector(az, toDeg(Math.atan2(dh, dist))), dist, az, elevAngle: toDeg(Math.atan2(dh, dist)) };
}

export function dirVector(azDeg, elevDeg) {
  const a = toRad(azDeg), e = toRad(elevDeg);
  return [Math.cos(e) * Math.sin(a), Math.cos(e) * Math.cos(a), Math.sin(e)];
}

// ── Rotation matrices (row-major 3×3) ───────────────────────────────────────
export function mul(A, B) {
  return A.map((row) => [0, 1, 2].map((j) => row[0] * B[0][j] + row[1] * B[1][j] + row[2] * B[2][j]));
}

export function rotZ(deg) {
  const c = Math.cos(toRad(deg)), s = Math.sin(toRad(deg));
  return [[c, -s, 0], [s, c, 0], [0, 0, 1]];
}

export function rotX(deg) {
  const c = Math.cos(toRad(deg)), s = Math.sin(toRad(deg));
  return [[1, 0, 0], [0, c, -s], [0, s, c]];
}

// W3C DeviceOrientation: R = Rz(α)·Rx(β)·Ry(γ) maps device frame → Earth frame.
export function rotationFromEuler(alpha, beta, gamma) {
  const a = toRad(alpha), b = toRad(beta), g = toRad(gamma);
  const cA = Math.cos(a), sA = Math.sin(a);
  const cB = Math.cos(b), sB = Math.sin(b);
  const cG = Math.cos(g), sG = Math.sin(g);
  return [
    [cA * cG - sA * sB * sG, -sA * cB, cA * sG + sA * sB * cG],
    [sA * cG + cA * sB * sG,  cA * cB, sA * sG - cA * sB * cG],
    [-cB * sG,                sB,      cB * cG],
  ];
}

// Apply user calibration: heading offset is a clockwise yaw about Earth-up,
// pitch offset tilts the camera axis about the device x-axis (mounting bias).
export function applyCalibration(R, headingOffset, pitchOffset) {
  return mul(mul(rotZ(-headingOffset), R), rotX(pitchOffset));
}

// Exponential smoothing of a rotation matrix, re-orthonormalized.
// Avoids the wrap-around / gimbal problems of smoothing Euler angles.
export function smoothRotation(prev, next, t) {
  if (!prev) return next;
  const M = prev.map((row, i) => row.map((v, j) => v + (next[i][j] - v) * t));
  // Columns: c2 = device y (up), c3 = device z; rebuild an orthonormal basis.
  const col = (j) => [M[0][j], M[1][j], M[2][j]];
  const norm = (v) => { const n = Math.hypot(...v) || 1; return v.map((x) => x / n); };
  const cross = (u, v) => [u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]];
  const z = norm(col(2));
  const x = norm(cross(col(1), z));
  const y = cross(z, x);
  return [0, 1, 2].map((i) => [x[i], y[i], z[i]]);
}

// Heading / pitch of the rear-camera optical axis.
export function cameraPose(R) {
  const v = [-R[0][2], -R[1][2], -R[2][2]];
  return {
    heading: normDeg(toDeg(Math.atan2(v[0], v[1]))),
    pitch: toDeg(Math.asin(clamp(v[2], -1, 1))),
    forward: v,
  };
}

// Focal length (CSS px) of the camera image as rendered with object-fit: cover.
// fovLongDeg is the FOV across the long side of the video frame.
export function focalLengthPx({ viewW, viewH, videoW, videoH, fovLongDeg }) {
  const vw = videoW || viewW, vh = videoH || viewH;
  const scale = Math.max(viewW / vw, viewH / vh);
  return ((Math.max(vw, vh) / 2) / Math.tan(toRad(fovLongDeg) / 2)) * scale;
}

// Pinhole projection of an Earth-frame direction into screen CSS pixels.
// screenAngle = screen.orientation.angle (0 portrait, 90 landscape, …).
export function project(R, v, { f, viewW, viewH, screenAngle = 0 }) {
  // Earth → device: d = Rᵀ·v
  const dx = R[0][0] * v[0] + R[1][0] * v[1] + R[2][0] * v[2];
  const dy = R[0][1] * v[0] + R[1][1] * v[1] + R[2][1] * v[2];
  const dz = R[0][2] * v[0] + R[1][2] * v[1] + R[2][2] * v[2];
  const depth = -dz;
  if (depth <= 1e-3) return null; // behind the camera
  const px = (f * dx) / depth, py = (f * dy) / depth;
  // Device axes → current screen axes
  const c = Math.cos(toRad(screenAngle)), s = Math.sin(toRad(screenAngle));
  const sx = c * px - s * py;
  const su = s * px + c * py;
  return { x: viewW / 2 + sx, y: viewH / 2 - su, depth };
}
