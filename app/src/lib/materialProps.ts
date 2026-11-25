/**
 * Shader property names (MaterialEditor) in words, grouped by what they do: used by Look › Materials (one
 * material) and Materials › By shader, so neither is a list of 40 raw names.
 */

/** A material's values grouped by what they do, so 40 sliders aren't one list. Matched on the property name. */
export const TOPICS = ['Colors', 'Shadow and ramp', 'Shine', 'Rim light', 'Reflection and metal', 'Outline', 'Glow', 'Surface detail', 'Cut-out and drawing', 'Other'] as const;
export type Topic = (typeof TOPICS)[number];
const TOPIC_RULES: [Topic, RegExp][] = [
  ['Outline', /outline|linewidth|linecolor|linetex/i],
  ['Glow', /emissi|glow/i],
  ['Rim light', /rim/i],
  ['Reflection and metal', /reflect|refl[A-Z_]|^refl|matcap|metal|roughness/i],
  ['Shine', /specul|speclar|gloss|highlight/i],
  ['Shadow and ramp', /shadow|ramp|shade|pointlight/i],
  ['Cut-out and drawing', /cutoff|cull|zwrite|alphaoption|backface|premultipl|^alpha$/i],
  ['Surface detail', /normal|detail|liquid|mask|nip|tessell|displace|^exp|expression/i],
  ['Colors', /^(col\d|color\d*|overcolor\d*|maincolor|saturation|customambient|transparency|alpha_?[ab]?|colorinverse|colorsort|whiteoff|ambient)$/i],
];
export function topicOf(name: string): Topic {
  const n = name.replace(/^_+/, '');
  for (const [t, re] of TOPIC_RULES) if (re.test(n)) return t;
  return /col(or|our)/i.test(n) ? 'Colors' : 'Other';
}
/** On/off values drawn as 0..1 sliders by MaterialEditor ("Use ramp for lights"): shown as switches. */
export function isSwitch(p: { name: string; value: number; min?: number; max?: number }) {
  const n = p.name.replace(/^_+/, '');
  const binary = (p.min === undefined || p.min === 0) && (p.max === undefined || p.max === 1) && (p.value === 0 || p.value === 1);
  return binary && /^(use|disable|enable|is[A-Z]|not?use|adjust)|(on|off|asdiffuse|overlayed|full|inverse|invert|sort)$/i.test(n);
}
/** Words out of MaterialEditor's property names: "ShadowColor" → "Shadow color", "rimpower" stays. */
export function nice(p: string) {
  const s = p.replace(/^_+/, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ');
  return s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();
}
