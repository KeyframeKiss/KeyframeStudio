// Moving work between PCs (or sharing it): zips laid out like the Koikatsu folder.
//  - a scene package: the saved scene and the files it uses from outside itself (audio WAVs, Motion builder poses
//    and motion clips — the bridge says which);
//  - a library backup: Keyframe Studio's UserData/StudioEX library (looks, rigs, clips, faces, outfits, templates…)
//    and the translations made in the app.
// Zips are written and read with Windows' own tar (bsdtar), as the release zip is. Importing never trusts the zip:
// every entry is checked (known folders and file types only, no ".." or absolute paths), it's unpacked into a
// temporary folder first, and a file that already exists but differs is only replaced when the user says so.
// Scenes are never overwritten: an imported scene that clashes gets a new name.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { execFileSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { gameDir } = require('./setup.cjs');

const TAR = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
const MANIFEST = 'keyframe-package.json';
// what may be inside a package, and where it goes (relative to the Koikatsu folder)
const ALLOWED = [
  { re: /^UserData\/audio\/[^/]+\.wav$/i },
  { re: /^UserData\/studio\/scene\/(?:[^/]+\/)*[^/]+\.png$/i, scene: true },
  { re: /^UserData\/studio\/pose\/(?:[^/]+\/)*[^/]+\.(?:dat|png)$/i },
  { re: /^UserData\/StudioEX\/(?:[^/]+\/)*[^/]+\.(?:json|xml|jpg|png|txt|dat)$/i },
  { re: /^BepInEx\/Translation\/en\/Text\/(?:zz_StudioEX_Overrides|zy_StudioEX_Machine)\.txt$/i },
];
// caches the app makes again by itself: not worth carrying in a backup
const LIBRARY_SKIP = new Set(['item-thumbs', 'pose-thumbs']);

const allowed = (rel) => !rel.split('/').some((p) => p === '..' || p === '.' || p === '') && ALLOWED.find((a) => a.re.test(rel));
const sha = (f) => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex');
const tmpDir = (tag) => fs.mkdtempSync(path.join(os.tmpdir(), `kf-${tag}-`));
const rmrf = (d) => {
  try {
    fs.rmSync(d, { recursive: true, force: true });
  } catch {
    /* temp */
  }
};
const game = () => {
  const g = gameDir();
  if (!g) throw new Error('Keyframe Studio doesn’t know your Koikatsu folder yet: set it up in Settings › About & diagnostics');
  return g;
};
/** A file inside the game folder, given as an absolute path: its "UserData/…" path, or null when it's elsewhere. */
function relIn(root, abs) {
  const r = path.relative(root, path.resolve(abs));
  return !r || r.startsWith('..') || path.isAbsolute(r) ? null : r.split(path.sep).join('/');
}

function zipStage(stage, out) {
  const top = fs.readdirSync(stage);
  execFileSync(TAR, ['-a', '-c', '-f', out, '-C', stage, ...top], { windowsHide: true });
}

async function saveDialog(e, title, name) {
  const win = BrowserWindow.fromWebContents(e.sender);
  const r = await dialog.showSaveDialog(win, { title, defaultPath: path.join(app.getPath('documents'), name), filters: [{ name: 'Zip', extensions: ['zip'] }] });
  return r.canceled || !r.filePath ? null : r.filePath;
}

/** Copy files (absolute paths inside the game folder) into a staging folder at their game-folder paths; zip it. */
function writePackage(out, files, manifest) {
  const root = game();
  const stage = tmpDir('pack');
  try {
    let bytes = 0;
    const rels = [];
    for (const f of files) {
      const rel = relIn(root, f);
      if (!rel || !allowed(rel) || !fs.existsSync(f) || !fs.statSync(f).isFile()) continue;
      const dest = path.join(stage, ...rel.split('/'));
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(f, dest);
      bytes += fs.statSync(f).size;
      rels.push(rel);
    }
    fs.writeFileSync(path.join(stage, MANIFEST), JSON.stringify({ ...manifest, files: rels, app: app.getVersion(), made: new Date().toISOString() }, null, 2));
    fs.rmSync(out, { force: true });
    zipStage(stage, out);
    return { path: out, files: rels.length, bytes: fs.statSync(out).size, content: bytes };
  } finally {
    rmrf(stage);
  }
}

// imports waiting for the user's answer about files that differ
const pending = new Map();

/** Unpack a zip into a temporary folder (checked entries only) and compare with what's already here. */
function inspect(zip) {
  const root = game();
  const listed = execFileSync(TAR, ['-t', '-f', zip], { windowsHide: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .map((l) => l.trim().replace(/\\/g, '/').replace(/^\.\//, ''))
    .filter((l) => l && !l.endsWith('/'));
  if (!listed.includes(MANIFEST)) throw new Error('That zip isn’t a Keyframe Studio package or backup');
  const ok = listed.filter((l) => l !== MANIFEST && allowed(l));
  const rejected = listed.filter((l) => l !== MANIFEST && !allowed(l));
  const stage = tmpDir('import');
  try {
    // everything into the temporary folder (tar refuses ".." and absolute paths on its own, and then exits with an
    // error after extracting the rest); only checked entries, and only plain files (never links), are ever copied
    // out of it
    try {
      execFileSync(TAR, ['-x', '-f', zip, '-C', stage], { windowsHide: true, stdio: 'pipe' });
    } catch (e) {
      if (!fs.existsSync(path.join(stage, MANIFEST))) throw new Error('That zip couldn’t be opened: ' + String(e.stderr || e.message).split(/\r?\n/)[0]);
    }
  } catch (e) {
    rmrf(stage);
    throw e;
  }
  let manifest = {};
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(stage, MANIFEST), 'utf8'));
  } catch {
    /* an unreadable manifest: still a package of checked files */
  }
  if (typeof manifest.scene !== 'string' || !ok.includes(manifest.scene)) delete manifest.scene; // only a file it really holds
  const out = { fresh: [], same: [], differ: [] };
  for (const rel of ok) {
    const src = path.join(stage, ...rel.split('/'));
    if (!fs.existsSync(src) || !fs.lstatSync(src).isFile()) continue;
    const dest = path.join(root, ...rel.split('/'));
    if (!fs.existsSync(dest)) out.fresh.push(rel);
    else if (fs.statSync(dest).size === fs.statSync(src).size && sha(dest) === sha(src)) out.same.push(rel);
    else out.differ.push(rel);
  }
  const token = crypto.randomBytes(8).toString('hex');
  pending.set(token, { stage, root, ...out, manifest });
  const scenes = (rel) => ALLOWED.find((a) => a.re.test(rel))?.scene;
  return {
    token,
    kind: manifest.kind === 'library' ? 'library' : 'scene',
    scene: manifest.scene || ok.find(scenes) || null,
    fresh: out.fresh.length,
    same: out.same.length,
    // a clashing scene isn't asked about: it comes in under a new name
    differ: out.differ.filter((r) => !scenes(r)),
    rejected,
    made: manifest.made || null,
  };
}

/** Put an inspected package's files in place: new ones always, differing ones only with replace (scenes: renamed). */
function apply(token, replace) {
  const p = pending.get(token);
  if (!p) throw new Error('That import has expired: open the zip again');
  pending.delete(token);
  try {
    const scenes = (rel) => ALLOWED.find((a) => a.re.test(rel))?.scene;
    let copied = 0;
    let scenePath = null;
    const place = (rel, dest) => {
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.copyFileSync(path.join(p.stage, ...rel.split('/')), dest);
      copied++;
      if (p.manifest.scene === rel || (!p.manifest.scene && scenes(rel))) scenePath = dest;
    };
    for (const rel of p.fresh) place(rel, path.join(p.root, ...rel.split('/')));
    for (const rel of p.same) if (p.manifest.scene === rel) scenePath = path.join(p.root, ...rel.split('/'));
    for (const rel of p.differ) {
      const dest = path.join(p.root, ...rel.split('/'));
      if (scenes(rel)) {
        // never overwrite a scene: keep both
        const ext = path.extname(dest);
        let n = 1;
        let alt = `${dest.slice(0, -ext.length)} (imported)${ext}`;
        while (fs.existsSync(alt)) alt = `${dest.slice(0, -ext.length)} (imported ${++n})${ext}`;
        place(rel, alt);
      } else if (replace) place(rel, dest);
    }
    return { copied, kept: replace ? 0 : p.differ.filter((r) => !scenes(r)).length, scenePath };
  } finally {
    rmrf(p.stage);
  }
}

function libraryFiles(root) {
  const files = [];
  const walk = (dir, top) => {
    if (!fs.existsSync(dir)) return;
    for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
      if (top && d.isDirectory() && LIBRARY_SKIP.has(d.name)) continue;
      const f = path.join(dir, d.name);
      if (d.isDirectory()) walk(f, false);
      else files.push(f);
    }
  };
  walk(path.join(root, 'UserData', 'StudioEX'), true);
  for (const t of ['zz_StudioEX_Overrides.txt', 'zy_StudioEX_Machine.txt']) {
    const f = path.join(root, 'BepInEx', 'Translation', 'en', 'Text', t);
    if (fs.existsSync(f)) files.push(f);
  }
  return files;
}

function register() {
  // the renderer sends what the bridge collected; only files inside the game folder (and allowed kinds) go in
  ipcMain.handle('pkg:exportScene', async (e, info) => {
    if (!info || typeof info.scene !== 'string') throw new Error('Save the scene first');
    const name = path.basename(info.scene, path.extname(info.scene));
    const out = await saveDialog(e, 'Save the scene package', `${name} package.zip`);
    if (!out) return null;
    const files = [info.scene, ...(Array.isArray(info.files) ? info.files.filter((f) => typeof f === 'string') : [])];
    return writePackage(out, files, { kind: 'scene', version: 1, scene: relIn(game(), info.scene) });
  });
  ipcMain.handle('pkg:exportLibrary', async (e) => {
    const root = game();
    const out = await saveDialog(e, 'Save the library backup', `Keyframe Studio library ${new Date().toISOString().slice(0, 10)}.zip`);
    if (!out) return null;
    return writePackage(out, libraryFiles(root), { kind: 'library', version: 1 });
  });
  ipcMain.handle('pkg:open', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: 'Open a scene package or library backup', filters: [{ name: 'Zip', extensions: ['zip'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    return inspect(r.filePaths[0]);
  });
  ipcMain.handle('pkg:apply', (_e, token, replace) => apply(String(token), !!replace));
  ipcMain.handle('pkg:cancel', (_e, token) => {
    const p = pending.get(String(token));
    if (p) (rmrf(p.stage), pending.delete(String(token)));
    return true;
  });
}

module.exports = { register, _test: { writePackage, inspect, apply, libraryFiles } };
