/**
 * A character's Timeline tracks sorted into body parts for the dope sheet ("Left arm", "Face"…), with readable
 * names: "GO Rotation (cf_j_thigh00_R)" → "Thigh 0" under "Right leg". Keyed characters have 80+ tracks, which as
 * one flat list is a wall; parts start closed and show their keys merged on one row.
 */
import { boneLabel } from './boneNames.ts';

export const PARTS = ['Place', 'Spine & head', 'Right arm', 'Left arm', 'Right hand', 'Left hand', 'Right leg', 'Left leg', 'Face', 'Other'] as const;
export type Part = (typeof PARTS)[number];

/** Fewer tracks than this on an object: no parts, the list is short enough. */
export const PARTS_FROM = 12;

const FACE_MODELS = /^(character(Eyebrows|Eyes|EyesOpen|Mouth|MouthOpen|Neck|EyesLook|Nipples|Tongue|Head)|blush|tears|face|eye|mouth|lips?)/i;

/** The bone a "GO Rotation (cf_j_…)" / "GO Position (…)" track moves, if any. */
export function trackBone(t: { model: string; name: string }): string | null {
  if (!/^guideObject/i.test(t.model)) return null;
  const m = /\(([^()]+)\)\s*$/.exec(t.name);
  return m ? m[1] : null;
}

export function trackPart(t: { model: string; name: string }): Part {
  if (FACE_MODELS.test(t.model)) return 'Face';
  const bone = trackBone(t);
  if (bone == null) return /^guideObject/i.test(t.model) ? 'Place' : 'Other';
  const b = bone.toLowerCase();
  if (!/^c[fm]_/.test(b)) return 'Place'; // the character's own guide object (chaF_001…)
  const side = /_r$/.test(b) ? 'Right' : /_l$/.test(b) ? 'Left' : '';
  if (/thumb|index|middle|ring|little|finger/.test(b)) return side ? (`${side} hand` as Part) : 'Other';
  if (/shoulder|arm|elbo|wrist|hand/.test(b)) return side ? (`${side} arm` as Part) : 'Other';
  if (/thigh|leg|knee|foot|toe|ankle/.test(b)) return side ? (`${side} leg` as Part) : 'Other';
  if (/hips|spine|waist|kosi|neck|head|chest|body/.test(b)) return 'Spine & head';
  return 'Other';
}

/** A track's name inside its part: the bone in words, without the side the part already says. */
export function trackPartLabel(t: { model: string; name: string }): string | null {
  const bone = trackBone(t);
  if (bone == null) return null;
  const pos = /Pos/i.test(t.model);
  const scale = /Scale/i.test(t.model);
  const what = pos ? 'position' : scale ? 'scale' : 'rotation';
  if (!/^c[fm]_/i.test(bone)) return what.charAt(0).toUpperCase() + what.slice(1);
  const label = boneLabel(bone).replace(/ \((left|right)\)$/, '');
  return pos || scale ? `${label} ${what}` : label;
}

/** Tracks in part order (keeping their order inside a part). */
export function splitParts<T extends { model: string; name: string }>(list: T[]): { part: Part; tracks: T[] }[] {
  const by = new Map<Part, T[]>();
  for (const t of list) {
    const p = trackPart(t);
    const l = by.get(p) ?? [];
    l.push(t);
    by.set(p, l);
  }
  return PARTS.filter((p) => by.has(p)).map((p) => ({ part: p, tracks: by.get(p)! }));
}
