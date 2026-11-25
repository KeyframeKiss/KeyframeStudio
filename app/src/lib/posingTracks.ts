/**
 * The KKPE Timeline track behind a value on Character › Posing, so a ◆ beside it can add that track and key it.
 * KKPE names its IK tracks by part ("IK R. Hand Pos Weight"); physics bones are one track type with the bone's root
 * path as the parameter, the way saved scenes name them.
 */

export interface PosingTrack {
  owner: 'KKPE';
  model: string;
  /** For physics bones: KKPE's root path of the bone. */
  param?: string;
}

const PART: Record<string, string> = {
  body: 'Body',
  shoulderL: 'L. Shoulder',
  shoulderR: 'R. Shoulder',
  handL: 'L. Hand',
  handR: 'R. Hand',
  thighL: 'L. Thigh',
  thighR: 'R. Thigh',
  footL: 'L. Foot',
  footR: 'R. Foot',
  elbowL: 'L. Elbow',
  elbowR: 'R. Elbow',
  kneeL: 'L. Knee',
  kneeR: 'R. Knee',
};

/** Target strength (pos / rot) of an effector, or a bend goal's strength. */
export function ikTrack(key: string, what: 'pos' | 'rot' | 'bend'): PosingTrack | null {
  const part = PART[key];
  if (!part) return null;
  if (what === 'bend') return /Elbow|Knee/.test(part) ? { owner: 'KKPE', model: `fbbikConstraintBendWeight${part}` } : null;
  if (/Elbow|Knee/.test(part)) return null;
  return { owner: 'KKPE', model: `fbbikEffector${what === 'pos' ? 'Position' : 'Rotation'}Weight${part}` };
}

const BUST: Record<string, string> = { BreastL: 'leftBoob', BreastR: 'rightBoob', HipL: 'leftButt', HipR: 'rightButt' };

/** Bust and buttock physics: on/off, gravity, force. */
export function bustTrack(id: string, prop: 'enabled' | 'gravity' | 'force'): PosingTrack | null {
  const side = BUST[id];
  return side ? { owner: 'KKPE', model: `${side}${prop.charAt(0).toUpperCase()}${prop.slice(1)}` } : null;
}

export type DynProp = 'enabled' | 'weight' | 'stiffness' | 'elasticity' | 'damping' | 'inertia' | 'radius' | 'gravity' | 'force';

/** Hair, skirt and accessory physics, one bone by its root path. */
export function dynTrack(path: string, prop: DynProp): PosingTrack {
  return { owner: 'KKPE', model: `dynamicBone${prop.charAt(0).toUpperCase()}${prop.slice(1)}`, param: path };
}

/** A collider on the body, by its path under the character (KKPE's Timeline parameter). */
export function colliderTrack(path: string, prop: 'radius' | 'height' | 'center' | 'direction' | 'bound'): PosingTrack {
  const model = { radius: 'colliderRadius', height: 'colliderHeight', center: 'colliderBaseCenter', direction: 'colliderBaseDirection', bound: 'colliderBaseBound' }[prop];
  return { owner: 'KKPE', model, param: path };
}
