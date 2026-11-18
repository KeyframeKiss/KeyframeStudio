// Plain-English names for Koikatsu's internal renderer / material names (cf_O_mayuge → Eyebrows).
// Many are romanised Japanese: mayuge = eyebrows, namida = tears, sirome = white of the eye, hitomi = iris,
// tang = tongue, kage = shadow. The raw names stay visible next to these — MaterialEditor users know them.

export type BodyGroup = 'Eyes' | 'Face' | 'Mouth' | 'Body' | 'Hidden';
export const BODY_GROUPS: BodyGroup[] = ['Eyes', 'Face', 'Mouth', 'Body', 'Hidden'];

interface Rule {
  re: RegExp;
  label: string | ((m: RegExpMatchArray) => string);
  group?: BodyGroup;
}

const side = (s: string | undefined) => (s === 'L' ? 'left' : s === 'R' ? 'right' : '');
const withSide = (label: string, s: string | undefined) => (side(s) ? `${label} (${side(s)})` : label);
const TEAR_SIZE: Record<string, string> = { L: 'large', M: 'medium', S: 'small' };

// Character body renderers (cf_ = female, cm_ = male; the same names otherwise)
const BODY_RENDERERS: Rule[] = [
  { re: /^c[fm]_Ohitomi_([LR])02$/, label: (m) => withSide('Iris', m[1]), group: 'Eyes' },
  { re: /^c[fm]_Ohitomi_([LR])$/, label: (m) => withSide('Eye white', m[1]), group: 'Eyes' },
  { re: /^c[fm]_O_eyeline_low$/, label: 'Lower eyelashes', group: 'Eyes' },
  { re: /^c[fm]_O_eyeline$/, label: 'Upper eyelashes', group: 'Eyes' },
  { re: /^c[fm]_O_namida_([LMS])$/, label: (m) => `Tears (${TEAR_SIZE[m[1]]})`, group: 'Eyes' },
  { re: /^c[fm]_O_gag_eye_0?(\d+)$/, label: (m) => `Comic eyes ${Number(m[1]) + 1}`, group: 'Eyes' },
  { re: /^c[fm]_O_mayuge$/, label: 'Eyebrows', group: 'Face' },
  { re: /^c[fm]_O_face$/, label: 'Face', group: 'Face' },
  { re: /^c[fm]_O_noseline$/, label: 'Nose', group: 'Face' },
  { re: /^c[fm]_O_hige$/, label: 'Beard', group: 'Face' },
  { re: /^c[fm]_O_tooth$/, label: 'Teeth', group: 'Mouth' },
  { re: /^c[fm]_O_canine$/, label: 'Fangs', group: 'Mouth' },
  { re: /^o_tang$/, label: 'Tongue', group: 'Mouth' },
  { re: /^n_tang$/, label: 'Tongue (H scenes)', group: 'Mouth' },
  { re: /^o_body_a$/, label: 'Body skin', group: 'Body' },
  { re: /^o_body_b$/, label: 'Body skin (alt)', group: 'Body' },
  { re: /^o_mnp[a-z]?$/, label: 'Genitals', group: 'Body' },
  { re: /^o_dankon$/, label: 'Penis', group: 'Body' },
  { re: /^o_dan_f$/, label: 'Testicles', group: 'Body' },
  { re: /^o_gomu$/, label: 'Condom', group: 'Body' },
  { re: /^o_nail/, label: 'Nails', group: 'Body' },
  { re: /^n_(\w+?)_silhouette$/, label: (m) => `Silhouette (${m[1] === 'tang' ? 'tongue' : m[1]})`, group: 'Hidden' },
  { re: /^o_shadowcaster/, label: 'Shadow caster', group: 'Hidden' },
  { re: /^o_hit_/, label: 'Touch area', group: 'Hidden' },
];

// Clothing pieces (a part's renderers; _a / _b / _c are the dressed / half-off / pulled-down states)
const CLOTHES: [RegExp, string][] = [
  [/inner/, 'Inner layer'],
  [/parker|hoodie/, 'Hoodie'],
  [/jacket|blazer|coat/, 'Jacket'],
  [/shirt|blouse/, 'Shirt'],
  [/sailor/, 'Sailor top'],
  [/skirt/, 'Skirt'],
  [/pants|trousers|jeans/, 'Pants'],
  [/^(o_)?top/, 'Top'],
  [/^(o_)?bot/, 'Bottom'],
  [/bra/, 'Bra'],
  [/shorts/, 'Underwear'],
  [/panst/, 'Pantyhose'],
  [/socks/, 'Socks'],
  [/gloves/, 'Gloves'],
  [/shoes/, 'Shoes'],
];
const STATE: Record<string, string> = { a: 'dressed', b: 'half off', c: 'pulled down' };

// Accessory / item words
const WORDS: [RegExp, string][] = [
  [/headphone/, 'Headphones'],
  [/earring|piasu|pierce/, 'Earrings'],
  [/megane|glasses/, 'Glasses'],
  [/frill.?garter|garter/, 'Garter'],
  [/ribb?on/, 'Ribbon'],
  [/necklace|neck/, 'Necklace'],
  [/choker/, 'Choker'],
  [/hat|cap\b/, 'Hat'],
  [/kamikazari|hairpin|kanzashi/, 'Hair ornament'],
  [/nekomimi|kemomimi|mimi/, 'Animal ears'],
  [/shippo|tail/, 'Tail'],
  [/wing|hane/, 'Wings'],
  [/mask/, 'Mask'],
  [/bag/, 'Bag'],
  [/sphere/, 'Sphere'],
];

const HAIR_KIND: Record<string, string> = { b: 'back', f: 'front', s: 'side', o: 'extension' };

/** "Hair (front)" for cf_hair_f_300_00_0_F, cf_hair_idol_b_00, cf_m_hair_b_01_00 … */
function hair(name: string): string | null {
  const m = /(?:^|_)hair_(?:[a-z]+_)?([bfso])(?:_|\d|$)/i.exec(name);
  if (!m) return /(?:^|_)hair(?:_|$)/i.test(name) ? 'Hair' : null;
  return `Hair (${HAIR_KIND[m[1].toLowerCase()]})`;
}

function clothes(name: string): string | null {
  const n = name.toLowerCase();
  const hit = CLOTHES.find(([re]) => re.test(n));
  if (!hit) return null;
  const st = /_([abc])(?:_op\d+)?$/.exec(n);
  const opt = /_op(\d+)$/.exec(n);
  const bits = [st ? STATE[st[1]] : '', opt ? `option ${opt[1]}` : ''].filter(Boolean);
  return bits.length ? `${hit[1]} (${bits.join(', ')})` : hit[1];
}

function words(name: string): string | null {
  const n = name.toLowerCase();
  return WORDS.find(([re]) => re.test(n))?.[1] ?? null;
}

export interface Friendly {
  label: string | null;
  group?: BodyGroup;
}

/** A renderer's plain name. `part` is the tree part key ("Character:0", "Clothing:3", "Hair:0", "Accessory:5", "Item:0"). */
export function rendererName(name: string, part: string): Friendly {
  if (part.startsWith('Character')) {
    for (const r of BODY_RENDERERS) {
      const m = name.match(r.re);
      if (m) return { label: typeof r.label === 'string' ? r.label : r.label(m), group: r.group };
    }
    return { label: hair(name) ?? clothes(name), group: 'Body' };
  }
  if (part.startsWith('Hair')) return { label: hair(name) ?? null };
  if (part.startsWith('Clothing')) return { label: clothes(name) };
  return { label: hair(name) ?? clothes(name) ?? words(name) };
}

// Materials: cf_m_* / cm_m_* / c_m_* names
const MATERIALS: [RegExp, string][] = [
  [/^c[fm]?_m_face/, 'Face'],
  [/^c[fm]?_m_mayuge/, 'Eyebrows'],
  [/^c[fm]?_m_noseline/, 'Nose'],
  [/^c[fm]?_m_tooth/, 'Teeth'],
  [/^c[fm]?_m_eyeline_\d+_up|^c[fm]?_m_eyeline_up/, 'Upper eyelashes'],
  [/^c[fm]?_m_eyeline_kage/, 'Eyelash shadow'],
  [/^c[fm]?_m_eyeline_down/, 'Lower eyelashes'],
  [/^c[fm]?_m_namida/, 'Tears'],
  [/^c[fm]?_m_sirome/, 'Eye white'],
  [/^c[fm]?_m_hitomi/, 'Iris'],
  [/^c[fm]?_m_gageye/, 'Comic eyes'],
  [/^c[fm]?_m_tang/, 'Tongue'],
  [/^c[fm]?_m_body/, 'Body skin'],
  [/^c[fm]?_m_skin/, 'Skin'],
  [/^c[fm]?_m_mnp/, 'Genitals'],
  [/^c[fm]?_m_dankon/, 'Penis'],
  [/^c[fm]?_m_dan_f/, 'Testicles'],
  [/^c[fm]?_m_gomu/, 'Condom'],
  [/^c[fm]?_m_silhouette/, 'Silhouette'],
  [/^c[fm]?_m_shadowcast/, 'Shadow caster'],
  [/^c[fm]?_m_nail/, 'Nails'],
];

/** A material's plain name; MaterialEditor's copies (".MECopy1") say so. */
export function materialName(name: string): string | null {
  const copy = /\.MECopy(\d+)$/.exec(name);
  const base = copy ? name.slice(0, copy.index) : name;
  const n = base.toLowerCase();
  const hit = MATERIALS.find(([re]) => re.test(n))?.[1] ?? hair(base) ?? clothes(base.replace(/^(c[fm]_)?m_|^cf_|^cm_/, '')) ?? words(base);
  if (!hit) return copy ? `Copy ${copy[1]}` : null;
  return copy ? `${hit} (copy ${copy[1]})` : hit;
}

/** "Accessory 2 · ca_slot01" → "Accessory 2 · Headphones" (from what's in it). */
export function partName(label: string, key: string, rendererNames: string[]): string {
  if (!key.startsWith('Accessory')) return label;
  const base = label.replace(/\s*·.*$/, '');
  for (const r of rendererNames) {
    const f = rendererName(r, key).label;
    if (f) return `${base} · ${f.replace(/\s*\((dressed|half off|pulled down)\)$/, '')}`;
  }
  const first = rendererNames[0];
  return first ? `${base} · ${first.replace(/_+$/, '')}` : base;
}
