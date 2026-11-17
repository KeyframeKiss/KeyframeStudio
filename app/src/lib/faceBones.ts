// Face Studio: Koikatsu face bones grouped by feature, with plain-language names.
// Bone names and descriptions come from KKABMX's bone list. Paired bones are listed by their _L name;
// with "Mirror" on, edits apply to the _R twin as well (mirrored).

export type Channel = 'pos' | 'rot' | 'scale';

export interface FaceBone {
  name: string;
  label: string;
  hint?: string;
  /** Which controls to show; default all three. */
  channels?: Channel[];
}

export interface FaceFeature {
  id: string;
  label: string;
  bones: FaceBone[];
}

export const FACE_FEATURES: FaceFeature[] = [
  {
    id: 'head',
    label: 'Head shape',
    bones: [
      { name: 'cf_J_FaceBase', label: 'Whole head' },
      { name: 'cf_J_FaceUp_ty', label: 'Upper face' },
      { name: 'cf_J_FaceUp_tz', label: 'Forehead & brow ridge', hint: 'Upper front of the head: eyes, brow ridge and brows' },
      { name: 'cf_J_FaceLow_tz', label: 'Lower face' },
      { name: 'cf_J_FaceLow_sx', label: 'Lower face (not mouth)', hint: 'Like Lower face, but leaves the mouth alone' },
    ],
  },
  {
    id: 'eyes',
    label: 'Eyes',
    bones: [
      { name: 'cf_J_Eye_tz', label: 'Both eyes', hint: 'Base of both eyes: depth and spacing together' },
      { name: 'cf_J_Eye_tx_L', label: 'Eye', hint: 'Position and size of each eye' },
      { name: 'cf_J_Eye_rz_L', label: 'Eye tilt', channels: ['rot', 'scale'] },
      { name: 'cf_J_hitomi_tx_L', label: 'Iris', hint: 'Iris size. Position is left to the eye-look system.', channels: ['scale'] },
    ],
  },
  {
    id: 'lids',
    label: 'Eyelids',
    bones: [
      { name: 'cf_J_Eye01_s_L', label: 'Upper lid · inner corner', hint: 'Eyelid parts run from the inner upper corner around the eye' },
      { name: 'cf_J_Eye02_s_L', label: 'Upper lid · inner' },
      { name: 'cf_J_Eye03_s_L', label: 'Upper lid · middle' },
      { name: 'cf_J_Eye04_s_L', label: 'Upper lid · outer' },
      { name: 'cf_J_Eye05_s_L', label: 'Outer corner' },
      { name: 'cf_J_Eye06_s_L', label: 'Lower lid · outer' },
      { name: 'cf_J_Eye07_s_L', label: 'Lower lid · middle' },
      { name: 'cf_J_Eye08_s_L', label: 'Lower lid · inner' },
    ],
  },
  {
    id: 'brows',
    label: 'Brows',
    bones: [
      { name: 'cf_J_Mayu_ty', label: 'Both brows', hint: 'Base of both eyebrows; distance from the forehead' },
      { name: 'cf_J_Mayu_L', label: 'Eyebrow' },
      { name: 'cf_J_Mayumoto_L', label: 'Brow base' },
      { name: 'cf_J_MayuMid_s_L', label: 'Inner brow' },
      { name: 'cf_J_MayuTip_s_L', label: 'Brow tip' },
    ],
  },
  {
    id: 'nose',
    label: 'Nose',
    bones: [
      { name: 'cf_J_NoseBase', label: 'Whole nose' },
      { name: 'cf_J_NoseBridge_rx', label: 'Nose ridge' },
      { name: 'cf_J_NoseBridge_ty', label: 'Bridge height' },
      { name: 'cf_J_NoseBase_rx', label: 'Nose tip' },
      { name: 'cf_J_Nose_tip', label: 'Very tip' },
    ],
  },
  {
    id: 'mouth',
    label: 'Mouth',
    bones: [
      { name: 'cf_J_MouthBase_ty', label: 'Mouth position' },
      { name: 'cf_J_MouthBase_rx', label: 'Mouth angle' },
      { name: 'cf_J_Mouthup', label: 'Upper lip' },
      { name: 'cf_J_MouthLow', label: 'Lower lip', hint: 'Also moves the lower teeth a little' },
      { name: 'cf_J_Mouth_L', label: 'Mouth corner', hint: 'Can also smooth odd wrinkles around the mouth' },
      { name: 'cf_J_MouthCavity', label: 'Inside of the mouth', hint: 'Adjust to fix clipping after scaling the mouth' },
    ],
  },
  {
    id: 'cheeks',
    label: 'Cheeks',
    bones: [
      { name: 'cf_J_CheekUpBase', label: 'Both cheeks' },
      { name: 'cf_J_CheekUp2_L', label: 'Cheekbone' },
      { name: 'cf_J_CheekUp_s_L', label: 'Lower cheek', hint: 'Below the cheekbone (despite its name)' },
      { name: 'cf_J_CheekLow_s_L', label: 'Jaw-line cheek', hint: 'Lowest part of the cheek, around the jaw' },
    ],
  },
  {
    id: 'jaw',
    label: 'Jaw & chin',
    bones: [
      { name: 'cf_J_Chin_Base', label: 'Chin' },
      { name: 'cf_J_ChinTip_Base', label: 'Chin tip' },
      { name: 'cf_J_ChinLow', label: 'Under the chin' },
    ],
  },
  {
    id: 'ears',
    label: 'Ears',
    bones: [
      { name: 'cf_J_EarBase_ry_L', label: 'Whole ear' },
      { name: 'cf_J_EarUp_L', label: 'Upper ear' },
      { name: 'cf_J_EarLow_L', label: 'Earlobe' },
    ],
  },
];

export const ALL_FACE_BONES = FACE_FEATURES.flatMap((f) => f.bones.flatMap((b) => (b.name.endsWith('_L') ? [b.name, b.name.slice(0, -2) + '_R'] : [b.name])));

export const isPaired = (name: string) => name.endsWith('_L') || name.endsWith('_R');
export const twinOf = (name: string) => (name.endsWith('_L') ? name.slice(0, -2) + '_R' : name.endsWith('_R') ? name.slice(0, -2) + '_L' : name);

/** Slider ranges per channel (position in Koikatsu units, rotation in degrees, scale as a multiplier). */
export const RANGES: Record<Channel, { min: number; max: number; step: number; digits: number; neutral: number; label: string }> = {
  pos: { min: -0.05, max: 0.05, step: 0.0005, digits: 3, neutral: 0, label: 'Move' },
  rot: { min: -45, max: 45, step: 0.5, digits: 1, neutral: 0, label: 'Rotate' },
  scale: { min: 0.5, max: 1.5, step: 0.005, digits: 3, neutral: 1, label: 'Scale' },
};
