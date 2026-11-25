// Character › Posing ◆ buttons: the KKPE Timeline track behind each value (no Studio needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bustTrack, colliderTrack, dynTrack, ikTrack } from '../../app/src/lib/posingTracks.ts';

test('target strength and bend goals use KKPE track names per part', () => {
  assert.equal(ikTrack('handR', 'pos')?.model, 'fbbikEffectorPositionWeightR. Hand');
  assert.equal(ikTrack('footL', 'rot')?.model, 'fbbikEffectorRotationWeightL. Foot');
  assert.equal(ikTrack('body', 'pos')?.model, 'fbbikEffectorPositionWeightBody');
  assert.equal(ikTrack('elbowL', 'bend')?.model, 'fbbikConstraintBendWeightL. Elbow');
  assert.equal(ikTrack('kneeR', 'bend')?.model, 'fbbikConstraintBendWeightR. Knee');
  assert.equal(ikTrack('elbowL', 'pos'), null);
  assert.equal(ikTrack('handR', 'bend'), null);
  assert.equal(ikTrack('nope', 'pos'), null);
});

test('physics: bust sides by name, bones and colliders by path', () => {
  assert.equal(bustTrack('BreastL', 'gravity')?.model, 'leftBoobGravity');
  assert.equal(bustTrack('HipR', 'enabled')?.model, 'rightButtEnabled');
  assert.deepEqual(dynTrack('a/b/c', 'stiffness'), { owner: 'KKPE', model: 'dynamicBoneStiffness', param: 'a/b/c' });
  assert.deepEqual(colliderTrack('x/cf_hit_arm_L', 'center'), { owner: 'KKPE', model: 'colliderBaseCenter', param: 'x/cf_hit_arm_L' });
});
