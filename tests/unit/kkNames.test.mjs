// Plain names for Koikatsu's renderer / material names (no Studio needed). Inputs are real names from scenes.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { materialName, partName, rendererName } from '../../app/src/lib/kkNames.ts';

const body = (n) => rendererName(n, 'Character:0');

test('body renderers', () => {
  const cases = {
    cf_O_mayuge: ['Eyebrows', 'Face'],
    cf_O_face: ['Face', 'Face'],
    cf_O_noseline: ['Nose', 'Face'],
    cf_O_tooth: ['Teeth', 'Mouth'],
    cf_O_canine: ['Fangs', 'Mouth'],
    cf_O_eyeline: ['Upper eyelashes', 'Eyes'],
    cf_O_eyeline_low: ['Lower eyelashes', 'Eyes'],
    cf_O_namida_L: ['Tears (large)', 'Eyes'],
    cf_O_namida_S: ['Tears (small)', 'Eyes'],
    cf_Ohitomi_L: ['Eye white (left)', 'Eyes'],
    cf_Ohitomi_R02: ['Iris (right)', 'Eyes'],
    cf_O_gag_eye_00: ['Comic eyes 1', 'Eyes'],
    o_tang: ['Tongue', 'Mouth'],
    n_tang: ['Tongue (H scenes)', 'Mouth'],
    o_body_a: ['Body skin', 'Body'],
    n_body_silhouette: ['Silhouette (body)', 'Hidden'],
    n_tang_silhouette: ['Silhouette (tongue)', 'Hidden'],
    o_shadowcaster_cm: ['Shadow caster', 'Hidden'],
    cm_O_mayuge: ['Eyebrows', 'Face'],
  };
  for (const [raw, [label, group]] of Object.entries(cases)) assert.deepEqual(body(raw), { label, group }, raw);
});

test('clothes and hair', () => {
  assert.equal(rendererName('o_inner_a', 'Clothing:0').label, 'Inner layer (dressed)');
  assert.equal(rendererName('o_inner_b', 'Clothing:0').label, 'Inner layer (half off)');
  assert.equal(rendererName('o_parker_pt_m_a', 'Clothing:0').label, 'Hoodie (dressed)');
  assert.equal(rendererName('bot_mhpants_a', 'Clothing:1').label, 'Pants (dressed)');
  assert.equal(rendererName('o_bra_a_op1', 'Clothing:2').label, 'Bra (dressed, option 1)');
  assert.equal(rendererName('o_shorts_c', 'Clothing:3').label, 'Underwear (pulled down)');
  assert.equal(rendererName('o_socks_boyclo', 'Clothing:6').label, 'Socks');
  assert.equal(rendererName('o_shoes_flowersand', 'Clothing:7').label, 'Shoes');
  assert.equal(rendererName('cf_hair_idol_b_00', 'Hair:0').label, 'Hair (back)');
  assert.equal(rendererName('cf_hair_f_300_00_0_FL2', 'Accessory:11').label, 'Hair (front)');
  assert.equal(rendererName('cf_hair_o_07_01', 'Accessory:3').label, 'Hair (extension)');
});

test('materials', () => {
  assert.equal(materialName('cf_m_mayuge_00'), 'Eyebrows');
  assert.equal(materialName('cf_m_mayuge_00.MECopy1'), 'Eyebrows (copy 1)');
  assert.equal(materialName('cf_m_sirome_00'), 'Eye white');
  assert.equal(materialName('cf_m_hitomi_00'), 'Iris');
  assert.equal(materialName('cf_m_eyeline_00_up'), 'Upper eyelashes');
  assert.equal(materialName('cf_m_eyeline_kage'), 'Eyelash shadow');
  assert.equal(materialName('cm_m_body'), 'Body skin');
  assert.equal(materialName('c_m_silhouette'), 'Silhouette');
  assert.equal(materialName('cf_m_hair_b_01_00'), 'Hair (back)');
  assert.equal(materialName('cf_bra_fband_m'), 'Bra');
  assert.equal(materialName('cf_m_shorts_06'), 'Underwear');
  assert.equal(materialName('m_top_parker_pt_m'), 'Hoodie');
  assert.equal(materialName('acs_m_headphone_01'), 'Headphones');
  assert.equal(materialName('n_blanc'), null);
});

test('accessories are named by what is in them', () => {
  assert.equal(partName('Accessory 2 · ca_slot01', 'Accessory:1', ['o_acs_head_headphone_00']), 'Accessory 2 · Headphones');
  assert.equal(partName('Accessory 1 · ca_slot00', 'Accessory:0', ['acs_frillgarter_r']), 'Accessory 1 · Garter');
  assert.equal(partName('Accessory 6 · ca_slot05', 'Accessory:5', ['cf_acs_310_b_ribon_00_0', 'cf_hair_b_310_01_0']), 'Accessory 6 · Ribbon');
  assert.equal(partName('Accessory 2 · ca_slot01', 'Accessory:1', ['CTA_bot_a_']), 'Accessory 2 · CTA_bot_a');
  assert.equal(partName('Top', 'Clothing:0', ['o_inner_a']), 'Top');
});
