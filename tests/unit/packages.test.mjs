// Scene packages and library backups (app/electron/packages.cjs), against fake Koikatsu folders in a temp directory:
// what goes in, how an import treats new / identical / differing files and clashing scenes, and that a tampered
// zip can't write anywhere it shouldn't. Windows only (the app zips with Windows' own tar).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import Module, { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const skip = process.platform !== 'win32' || !fs.existsSync(TAR) ? 'needs Windows tar' : false;

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'kfpkg-test-'));
after(() => fs.rmSync(base, { recursive: true, force: true }));
let currentGame = path.join(base, 'gameA');
// packages.cjs runs in Electron's main process: stand in for Electron and the remembered game folder
const realLoad = Module._load;
Module._load = function (req, ...rest) {
  if (req === 'electron') return { app: { getVersion: () => 'test', getPath: () => base }, BrowserWindow: {}, dialog: {}, ipcMain: { handle() {} } };
  if (req === './setup.cjs') return { gameDir: () => currentGame };
  return realLoad.call(this, req, ...rest);
};
const { _test: pkg } = skip ? { _test: null } : createRequire(import.meta.url)('../../app/electron/packages.cjs');
Module._load = realLoad;

const put = (root, rel, text) => {
  const f = path.join(root, ...rel.split('/'));
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.writeFileSync(f, text);
  return f;
};
const read = (root, rel) => fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8');
const list = (zip) => execFileSync(TAR, ['-t', '-f', zip], { encoding: 'utf8' }).split(/\r?\n/).filter((l) => l && !l.endsWith('/'));

test('a scene package holds the scene and what it uses, nothing else', { skip }, () => {
  const A = (currentGame = path.join(base, 'gameA'));
  const files = [
    put(A, 'UserData/studio/scene/my scene.png', 'SCENE-A'),
    put(A, 'UserData/audio/line 1.wav', 'WAV-A'),
    put(A, 'UserData/studio/pose/sub/stand.dat', 'POSE-A'),
    put(A, 'UserData/StudioEX/clips/Walk.xml', 'CLIP-A'),
    put(A, 'UserData/audio/evil.exe', 'NO'),
    put(base, 'outside.wav', 'OUT'),
  ];
  const w = pkg.writePackage(path.join(base, 'scene.zip'), files, { kind: 'scene', version: 1, scene: 'UserData/studio/scene/my scene.png' });
  const entries = list(path.join(base, 'scene.zip'));
  assert.equal(w.files, 4);
  for (const rel of ['UserData/studio/scene/my scene.png', 'UserData/audio/line 1.wav', 'UserData/studio/pose/sub/stand.dat', 'UserData/StudioEX/clips/Walk.xml']) assert.ok(entries.includes(rel), rel);
  assert.ok(!entries.some((l) => /evil|outside/.test(l)));
});

test('importing: new files in, identical skipped, differing asked about, a clashing scene renamed', { skip }, () => {
  const B = (currentGame = path.join(base, 'gameB'));
  put(B, 'UserData/audio/line 1.wav', 'WAV-DIFFERENT');
  put(B, 'UserData/studio/pose/sub/stand.dat', 'POSE-A');
  put(B, 'UserData/studio/scene/my scene.png', 'SCENE-OTHER');
  let p = pkg.inspect(path.join(base, 'scene.zip'));
  assert.equal(p.kind, 'scene');
  assert.equal(p.fresh, 1); // the clip
  assert.equal(p.same, 1); // the pose
  assert.deepEqual(p.differ, ['UserData/audio/line 1.wav']); // the scene clash isn't asked about
  let r = pkg.apply(p.token, false);
  assert.equal(read(B, 'UserData/audio/line 1.wav'), 'WAV-DIFFERENT', 'kept');
  assert.equal(read(B, 'UserData/studio/scene/my scene.png'), 'SCENE-OTHER', 'never overwritten');
  assert.equal(read(B, 'UserData/studio/scene/my scene (imported).png'), 'SCENE-A');
  assert.match(r.scenePath, /\(imported\)\.png$/);
  p = pkg.inspect(path.join(base, 'scene.zip'));
  r = pkg.apply(p.token, true);
  assert.equal(read(B, 'UserData/audio/line 1.wav'), 'WAV-A', 'replaced');
  assert.equal(read(B, 'UserData/studio/scene/my scene (imported 2).png'), 'SCENE-A', 'the next free name');
});

test('a library backup carries the library and translations (not caches) and restores', { skip }, () => {
  const A = (currentGame = path.join(base, 'gameA'));
  put(A, 'UserData/StudioEX/looks/Mine.json', '{"a":1}');
  put(A, 'UserData/StudioEX/item-thumbs/x.png', 'CACHE');
  put(A, 'BepInEx/Translation/en/Text/zz_StudioEX_Overrides.txt', 'A=B');
  const zip = path.join(base, 'library.zip');
  pkg.writePackage(zip, pkg.libraryFiles(A), { kind: 'library', version: 1 });
  const entries = list(zip).join('\n');
  assert.match(entries, /looks\/Mine\.json/);
  assert.match(entries, /zz_StudioEX_Overrides/);
  assert.doesNotMatch(entries, /item-thumbs/);
  currentGame = path.join(base, 'gameC');
  fs.mkdirSync(currentGame);
  const p = pkg.inspect(zip);
  assert.equal(p.kind, 'library');
  pkg.apply(p.token, false);
  assert.ok(fs.existsSync(path.join(currentGame, 'UserData/StudioEX/looks/Mine.json')));
  assert.ok(fs.existsSync(path.join(currentGame, 'BepInEx/Translation/en/Text/zz_StudioEX_Overrides.txt')));
});

test('a tampered zip: ".." entries and other file types never land; the safe files still do', { skip }, () => {
  const evil = path.join(base, 'evil.zip');
  // Windows' tar won't even write ".." entries: Python's zipfile will
  execFileSync('python', ['-c', "import zipfile,sys; z=zipfile.ZipFile(sys.argv[1],'w'); z.writestr('keyframe-package.json','{}'); z.writestr('../../escape.txt','X'); z.writestr('UserData/../../escape.txt','X'); z.writestr('UserData/audio/run.exe','X'); z.writestr('UserData/audio/ok.wav','W'); z.close()", evil]);
  currentGame = path.join(base, 'gameD');
  fs.mkdirSync(currentGame);
  const p = pkg.inspect(evil);
  pkg.apply(p.token, true);
  assert.ok(p.rejected.length >= 3, JSON.stringify(p.rejected));
  assert.ok(!fs.existsSync(path.join(base, 'escape.txt')) && !fs.existsSync(path.join(os.tmpdir(), 'escape.txt')));
  assert.ok(!fs.existsSync(path.join(currentGame, 'UserData/audio/run.exe')));
  assert.ok(fs.existsSync(path.join(currentGame, 'UserData/audio/ok.wav')));
});

test('a zip that isn’t a package is refused', { skip }, () => {
  const plain = path.join(base, 'plain.zip');
  const stage = path.join(base, 'plainstage');
  put(stage, 'readme.txt', 'hi');
  execFileSync(TAR, ['-a', '-c', '-f', plain, '-C', stage, 'readme.txt']);
  assert.throws(() => pkg.inspect(plain), /isn’t a Keyframe Studio package/);
});
