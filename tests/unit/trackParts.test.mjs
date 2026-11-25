// The dope sheet's automatic body parts for a character's tracks (no Studio needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitParts, trackPart, trackPartLabel } from '../../app/src/lib/trackParts.ts';

const go = (bone, rot = true) => ({ model: rot ? 'guideObjectRot' : 'guideObjectPos', name: `GO ${rot ? 'Rotation' : 'Position'} (${bone})` });

test('bones go to their part', () => {
  assert.equal(trackPart(go('chaF_001', false)), 'Place');
  assert.equal(trackPart(go('chaF_001')), 'Place');
  assert.equal(trackPart(go('cf_j_hips')), 'Spine & head');
  assert.equal(trackPart(go('cf_j_neck')), 'Spine & head');
  assert.equal(trackPart(go('cf_j_forearm01_R')), 'Right arm');
  assert.equal(trackPart(go('cf_j_shoulder_L')), 'Left arm');
  assert.equal(trackPart(go('cf_j_hand_L')), 'Left arm');
  assert.equal(trackPart(go('cf_j_index02_R')), 'Right hand');
  assert.equal(trackPart(go('cf_j_thumb01_L')), 'Left hand');
  assert.equal(trackPart(go('cf_j_thigh00_R')), 'Right leg');
  assert.equal(trackPart(go('cf_j_toes20_L')), 'Left leg');
  assert.equal(trackPart(go('cm_J_dan101_00')), 'Other');
  assert.equal(trackPart({ model: 'characterEyes', name: 'Eyes' }), 'Face');
  assert.equal(trackPart({ model: 'blush', name: 'Blush' }), 'Face');
  assert.equal(trackPart({ model: 'characterNeck', name: 'Neck Direction' }), 'Face');
  assert.equal(trackPart({ model: 'kkpeIkWeight', name: 'Something' }), 'Other');
});

test('readable names without the side the part already says', () => {
  assert.equal(trackPartLabel(go('cf_j_thigh00_R')), 'Thigh 0');
  assert.equal(trackPartLabel(go('cf_j_hips')), 'Hips');
  assert.equal(trackPartLabel(go('chaF_001', false)), 'Position');
  assert.equal(trackPartLabel(go('chaF_001')), 'Rotation');
  assert.equal(trackPartLabel(go('cf_j_hand_L', false)), 'Hand position');
  assert.equal(trackPartLabel({ model: 'characterEyes', name: 'Eyes' }), null);
});

test('parts come in body order, tracks keep their order', () => {
  const list = [{ model: 'characterEyes', name: 'Eyes' }, go('cf_j_leg01_L'), go('chaF_001', false), go('cf_j_thigh00_L'), go('cf_j_hips')];
  const parts = splitParts(list);
  assert.deepEqual(parts.map((p) => p.part), ['Place', 'Spine & head', 'Left leg', 'Face']);
  assert.deepEqual(parts[2].tracks.map((t) => t.name), ['GO Rotation (cf_j_leg01_L)', 'GO Rotation (cf_j_thigh00_L)']);
});
