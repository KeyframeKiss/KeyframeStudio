// Quaternion <-> Euler matching Unity's convention (Quaternion.Euler applies Z, then X, then Y).

export type Quat = [number, number, number, number]; // x, y, z, w
export type Euler = [number, number, number]; // degrees

const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;

export function quatFromEuler([ex, ey, ez]: Euler): Quat {
  const hx = (ex * D2R) / 2;
  const hy = (ey * D2R) / 2;
  const hz = (ez * D2R) / 2;
  const cx = Math.cos(hx), sx = Math.sin(hx);
  const cy = Math.cos(hy), sy = Math.sin(hy);
  const cz = Math.cos(hz), sz = Math.sin(hz);
  // q = qy * qx * qz
  return [
    cy * sx * cz + sy * cx * sz,
    sy * cx * cz - cy * sx * sz,
    cy * cx * sz - sy * sx * cz,
    cy * cx * cz + sy * sx * sz,
  ];
}

export function eulerFromQuat([x, y, z, w]: Quat): Euler {
  const sinX = Math.max(-1, Math.min(1, 2 * (w * x - y * z)));
  const ex = Math.asin(sinX);
  let ey: number;
  let ez: number;
  if (Math.abs(sinX) > 0.9999) {
    // gimbal lock: put everything into Y
    ey = Math.atan2(2 * (w * y - x * z), 1 - 2 * (y * y + z * z));
    ez = 0;
  } else {
    ey = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y));
    ez = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
  }
  return [ex * R2D, ey * R2D, ez * R2D];
}

export function slerp(a: Quat, b: Quat, t: number): Quat {
  let [bx, by, bz, bw] = b;
  let dot = a[0] * bx + a[1] * by + a[2] * bz + a[3] * bw;
  if (dot < 0) {
    dot = -dot;
    bx = -bx;
    by = -by;
    bz = -bz;
    bw = -bw;
  }
  if (dot > 0.9995) {
    const r: Quat = [a[0] + (bx - a[0]) * t, a[1] + (by - a[1]) * t, a[2] + (bz - a[2]) * t, a[3] + (bw - a[3]) * t];
    const n = Math.hypot(...r) || 1;
    return r.map((v) => v / n) as Quat;
  }
  const th = Math.acos(dot);
  const s = Math.sin(th);
  const wa = Math.sin((1 - t) * th) / s;
  const wb = Math.sin(t * th) / s;
  return [a[0] * wa + bx * wb, a[1] * wa + by * wb, a[2] * wa + bz * wb, a[3] * wa + bw * wb];
}

/** Shift each angle by ±360° so it's closest to the reference — keeps graphs continuous. */
export function unwrap(e: Euler, ref: Euler): Euler {
  return e.map((v, i) => {
    let x = v;
    while (x - ref[i] > 180) x -= 360;
    while (x - ref[i] < -180) x += 360;
    return x;
  }) as Euler;
}
