/**
 * Friendly names and body regions for Koikatsu bone names (ABMX body sliders): "cf_d_bust01_L" → "Bust 1 (left)",
 * region "Bust". The raw name is always shown too; this only makes long lists readable.
 */

const WORDS: Record<string, string> = {
  bust: 'Bust',
  bnip: 'Nipple',
  siri: 'Buttock',
  sk: 'Skirt',
  arm: 'Arm',
  forearm: 'Forearm',
  hand: 'Hand',
  thigh: 'Thigh',
  leg: 'Leg',
  kosi: 'Waist',
  waist: 'Waist',
  spine: 'Spine',
  neck: 'Neck',
  head: 'Head',
  cheeklow: 'Lower cheek',
  cheekup: 'Upper cheek',
  cheekmid: 'Mid cheek',
  chin: 'Chin',
  chinlow: 'Lower chin',
  chintip: 'Chin tip',
  chinbase: 'Chin base',
  earbase: 'Ear',
  earlow: 'Lower ear',
  earup: 'Upper ear',
  eye: 'Eye',
  eyepos: 'Eye position',
  facebase: 'Face',
  facelow: 'Lower face',
  faceup: 'Upper face',
  faceroot: 'Face root',
  mouth: 'Mouth',
  mouthbase: 'Mouth',
  mouthlow: 'Lower lip',
  mouthup: 'Upper lip',
  nose: 'Nose',
  nosebase: 'Nose',
  nosebridge: 'Nose bridge',
  nosewing: 'Nostril',
  nosetip: 'Nose tip',
  mayu: 'Brow',
  hitomi: 'Iris',
  shoulder: 'Shoulder',
  toes: 'Toes',
  foot: 'Foot',
  knee: 'Knee',
  elbo: 'Elbow',
  elboback: 'Elbow back',
  wrist: 'Wrist',
  hips: 'Hips',
  ankle: 'Ankle',
  hand_l: 'Hand',
  top: 'top',
  base: 'base',
};
// axis / variant tags that don't help a person ("_s", "_tx"…)
const DROP = /^(s|sx|sy|sz|tx|ty|tz|rx|ry|rz|j|d|n|a|b)$/i;

/** The side of a bone: 'L', 'R' or '' (centre). */
export const boneSide = (bone: string) => (/_L$/.test(bone) ? 'L' : /_R$/.test(bone) ? 'R' : '');

/** Body joints (cf_j_…) move everything below them; shape bones (cf_s_…) only reshape. */
export const boneKind = (bone: string) => (/^c[fm]_j_/.test(bone) ? 'joint' : /^c[fm]_s_/.test(bone) ? 'shape' : '');

/** The label without "(left)" / "(right)". */
export const boneBase = (bone: string) => boneLabel(bone).replace(/ \((left|right)\)$/, '');

export function boneLabel(bone: string): string {
  let s = bone.replace(/^(cf_|cm_)/i, '').replace(/^(j_|d_|s_|n_|t_|hit_)/i, '');
  let side = '';
  const m = /_(L|R)$/.exec(s);
  if (m) {
    side = m[1] === 'L' ? ' (left)' : ' (right)';
    s = s.slice(0, -2);
  }
  const parts: string[] = [];
  for (const tok of s.split('_').filter(Boolean)) {
    if (DROP.test(tok)) continue;
    const t = /^([A-Za-z]+?)(\d+)$/.exec(tok);
    const word = (t ? t[1] : tok).toLowerCase();
    const num = t ? String(Number(t[2])) : '';
    const name = WORDS[word] ?? (/^\d+$/.test(tok) ? String(Number(tok)) : tok.charAt(0).toUpperCase() + tok.slice(1));
    parts.push(num ? `${name} ${num}` : name);
  }
  const out = parts.join(' ').replace(/\s+/g, ' ').trim();
  // nothing readable left ("j_01" → "1"): the bone's own name says more
  return (!out || /^[\d ]+$/.test(out) ? bone.replace(/_[LR]$/, '') : out) + side;
}

export const REGIONS = ['Head & neck', 'Bust', 'Torso & hips', 'Arms & hands', 'Legs & feet', 'Accessories', 'Other'] as const;
export type Region = (typeof REGIONS)[number];

export function boneRegion(bone: string, location = 1): Region {
  if (location > 1) return 'Accessories';
  const b = bone.toLowerCase();
  if (/bust|bnip|mune/.test(b)) return 'Bust';
  if (/thigh|leg|knee|foot|toe|ankle|kokan/.test(b)) return 'Legs & feet';
  if (/forearm|arm|hand|shoulder|elbo|wrist|finger|thumb|index|middle|ring|little|_te_/.test(b)) return 'Arms & hands';
  if (/head|face|cheek|chin|eye|ear|mouth|nose|mayu|hitomi|kao|tooth|neck|tang/.test(b)) return 'Head & neck';
  if (/spine|waist|kosi|siri|belly|hara|sk_|skirt|hips|body|ana/.test(b)) return 'Torso & hips';
  return 'Other';
}
