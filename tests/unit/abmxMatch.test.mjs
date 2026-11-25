// Character › Body follows the joint picked in Studio's view: joint → body slider (no Studio needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { abmxForJoint, boneCore } from '../../app/src/lib/abmxMatch.ts';

test('bone names split into part, number and side', () => {
  assert.deepEqual(boneCore('cf_j_thigh00_L'), { core: 'thigh', num: '00', side: 'L' });
  assert.deepEqual(boneCore('cf_s_spine02'), { core: 'spine', num: '02', side: '' });
  assert.deepEqual(boneCore('cf_t_hand_R'), { core: 'hand', num: '', side: 'R' });
});

const all = ['cf_s_thigh01_L', 'cf_s_thigh02_L', 'cf_s_thigh03_L', 'cf_s_thigh01_R', 'cf_s_head', 'cf_j_head', 'cf_s_spine02', 'cf_s_leg01_L', 'cf_s_wrist_L', 'cf_s_forearm01_L'];

test('a slider that exists wins, on the same side', () => {
  assert.deepEqual(abmxForJoint('cf_j_thigh00_L', ['cf_s_thigh03_L', 'cf_s_thigh01_R'], all), { bone: 'cf_s_thigh03_L', has: true });
  assert.deepEqual(abmxForJoint('cf_j_thigh00_L', ['cf_s_thigh03_L', 'cf_s_thigh01_L'], all), { bone: 'cf_s_thigh01_L', has: true });
  assert.deepEqual(abmxForJoint('cf_j_head', ['cf_j_head', 'cf_s_head'], all), { bone: 'cf_j_head', has: true });
});

test('otherwise a bone to add a slider for', () => {
  assert.deepEqual(abmxForJoint('cf_j_head', [], all), { bone: 'cf_s_head', has: false });
  assert.deepEqual(abmxForJoint('cf_j_thigh00_R', [], all), { bone: 'cf_s_thigh01_R', has: false });
  assert.deepEqual(abmxForJoint('cf_j_hand_L', [], all), { bone: 'cf_s_wrist_L', has: false });
  assert.deepEqual(abmxForJoint('cf_t_leg_L', [], all), { bone: 'cf_s_leg01_L', has: false });
  assert.equal(abmxForJoint('cf_j_tang_00', [], all), null);
});
