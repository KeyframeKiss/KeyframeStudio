import assert from 'node:assert/strict';
import { test } from 'node:test';
import { noteRequest, replayProblem, retarget, startRecording, stopRecording } from '../../app/src/lib/macros.ts';

const edit = { cmd: 'chara.set', args: { id: 7, blush: 0.5 } };

test('scene replacement is excluded from recordings and blocks the whole saved action', () => {
  for (const cmd of ['scene.new', 'scene.load']) {
    startRecording();
    noteRequest(edit.cmd, edit.args);
    noteRequest(cmd, {});
    assert.deepEqual(stopRecording(), [edit]);
    const steps = [edit, { cmd, args: {} }];
    for (const useSelection of [true, false]) {
      assert.match(replayProblem({ name: 'Example', steps, useSelection }, [2]), /replaces the open scene/);
    }
  }
});

test('selection checks cover single objects, groups, and object-owned tracks', () => {
  for (const args of [{ id: 7 }, { ids: [7] }, { oci: 0 }]) {
    const action = { name: 'Example', steps: [{ cmd: 'test', args }], useSelection: true };
    assert.match(replayProblem(action, []), /Select/);
    assert.equal(replayProblem(action, [2]), undefined);
    assert.equal(replayProblem({ ...action, useSelection: false }, []), undefined);
  }
  assert.deepEqual(retarget({ oci: 0 }, [2]), { oci: 2 });
});

test('scene-wide tracks work with an empty selection', () => {
  const args = { oci: -1 };
  const steps = [{ cmd: 'timeline.addTrack', args }];
  assert.equal(replayProblem({ name: 'Camera', steps, useSelection: true }, []), undefined);
  assert.deepEqual(retarget(args, [2]), args);
});
