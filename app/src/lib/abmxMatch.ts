/**
 * The body slider (ABMX bone) that goes with a joint picked in Studio's view. Studio's joints are the FK bones
 * (cf_j_thigh00_L) and IK targets (cf_t_hand_L); ABMX usually shapes the scale bones beside them (cf_s_thigh01_L).
 * Prefers a bone that already has a slider, then the exact bone, then the same body part on the same side.
 */

/** "cf_j_thigh00_L" → { core: "thigh", num: "00", side: "L" } */
export function boneCore(name: string): { core: string; num: string; side: '' | 'L' | 'R' } {
  const m = /^c[fm]_[a-z]+_(.+?)(?:_([LR]))?$/i.exec(name);
  const rest = m ? m[1] : name;
  const side = (m?.[2]?.toUpperCase() ?? '') as '' | 'L' | 'R';
  const d = /^([a-z]+?)(\d*)(?:_.*)?$/i.exec(rest);
  return { core: (d ? d[1] : rest).toLowerCase(), num: d?.[2] ?? '', side };
}

/** A few joints are named differently from the shape bones around them. */
const SAME: Record<string, string[]> = {
  leg: ['leg', 'knee', 'foot'],
  foot: ['foot', 'leg', 'toes'],
  arm: ['arm', 'elboback', 'elbo'],
  forearm: ['forearm', 'wrist', 'elbo'],
  hand: ['hand', 'wrist'],
  spine: ['spine', 'bust', 'chest'],
  waist: ['waist', 'kosi'],
  hips: ['hips', 'kosi', 'waist'],
};

/**
 * @param picked the joint's bone name
 * @param withSlider bones that already have a slider, in list order
 * @param all every bone ABMX can shape
 * @returns the bone to show, and whether it already has a slider; null when nothing fits
 */
export function abmxForJoint(picked: string, withSlider: string[], all: string[]): { bone: string; has: boolean } | null {
  const p = boneCore(picked);
  const exact = [picked, picked.replace(/^(c[fm])_[jtd]_/i, '$1_s_')];
  for (const b of exact) if (withSlider.includes(b)) return { bone: b, has: true };
  const cores = SAME[p.core] ?? [p.core];
  const fits = (b: string) => {
    const c = boneCore(b);
    return c.side === p.side && cores.includes(c.core);
  };
  // the same part: the nearest number first (thigh00 → thigh01 before thigh03)
  const rank = (b: string) => {
    const c = boneCore(b);
    return cores.indexOf(c.core) * 100 + Math.abs(Number(c.num || 0) - Number(p.num || 0));
  };
  const has = withSlider.filter(fits).sort((a, b) => rank(a) - rank(b));
  if (has.length) return { bone: has[0], has: true };
  // to add: the shape bone beside the joint before the joint itself
  for (const b of [...exact].reverse()) if (all.includes(b)) return { bone: b, has: false };
  const any = all.filter(fits).sort((a, b) => rank(a) - rank(b));
  return any.length ? { bone: any[0], has: false } : null;
}
