// One-click setup: find the Koikatsu folder, check the Keyframe Studio bridge plugin there against the copy this
// app carries, and install or update it. Works from the unzipped app folder; nothing else to copy by hand.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { app, dialog, BrowserWindow } = require('electron');

const PLUGIN_DIR = ['BepInEx', 'plugins', 'KKStudioEX'];
const DLL = 'KKStudioEX.Bridge.dll';
const settingsFile = () => path.join(app.getPath('userData'), 'setup.json');

/** The bridge plugin this app carries: resources/app/bridge in the release, the plugin's build output in development. */
function bundled() {
  const candidates = [path.join(__dirname, '..', 'bridge', DLL), path.join(__dirname, '..', '..', 'plugin', 'StudioBridge', 'bin', 'Release', DLL)];
  return candidates.find((f) => fs.existsSync(f)) || null;
}

const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

/** A Koikatsu (not Sunshine) folder with CharaStudio: CharaStudio.exe next to Koikatu.exe / Koikatsu Party.exe. */
function isGame(dir) {
  if (typeof dir !== 'string' || !/^[a-z]:\\/i.test(path.normalize(dir))) return false; // a local drive only
  const has = (f) => fs.existsSync(path.join(dir, f));
  return has('CharaStudio.exe') && (has('Koikatu.exe') || has('Koikatsu Party.exe'));
}

/** The usual places Koikatsu lives, on every drive. */
function findGame() {
  const tails = ['Games\\Koikatsu', 'Games\\Koikatsu Party', 'Koikatsu', 'Koikatsu Party', 'illusion\\Koikatu', 'Games\\illusion\\Koikatu',
    'Program Files (x86)\\Steam\\steamapps\\common\\Koikatsu Party', 'Program Files\\Steam\\steamapps\\common\\Koikatsu Party',
    'SteamLibrary\\steamapps\\common\\Koikatsu Party', 'Steam\\steamapps\\common\\Koikatsu Party'];
  for (const d of 'CDEFGHIJKLMNOPQRSTUVWXYZ')
    for (const t of tails) {
      const dir = `${d}:\\${t}`;
      try {
        if (isGame(dir)) return dir;
      } catch {
        /* drive not ready */
      }
    }
  return null;
}

function load() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch {
    return {};
  }
}
function save(s) {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(s));
  } catch {
    /* settings only */
  }
}

/** Where things stand for a game folder (the remembered one, else one found). */
function status(dir) {
  const game = dir && isGame(dir) ? dir : isGame(load().gameDir) ? load().gameDir : findGame();
  const src = bundled();
  const out = { gameDir: game, found: !!game, bepinex: false, installed: false, upToDate: false, bundled: !!src };
  if (!game) return out;
  out.bepinex = fs.existsSync(path.join(game, 'BepInEx', 'core')) || fs.existsSync(path.join(game, 'BepInEx', 'plugins'));
  const dest = path.join(game, ...PLUGIN_DIR, DLL);
  out.installed = fs.existsSync(dest);
  if (out.installed && src) out.upToDate = sha(dest) === sha(src);
  return out;
}

/**
 * Put the bundled plugin in place. A loaded DLL can't be overwritten but can be renamed, so the old one is set aside
 * (a name not ending in .dll, which BepInEx ignores) and the new one takes effect the next time CharaStudio starts.
 */
function install(dir) {
  if (!isGame(dir)) throw new Error('That folder isn’t Koikatsu (no CharaStudio.exe next to Koikatu.exe)');
  if (!fs.existsSync(path.join(dir, 'BepInEx'))) throw new Error('BepInEx isn’t installed in that folder — install BepInEx (with the HF Patch or BetterRepack) first');
  const src = bundled();
  if (!src) throw new Error('This copy of Keyframe Studio doesn’t carry the bridge plugin');
  const folder = path.join(dir, ...PLUGIN_DIR);
  fs.mkdirSync(folder, { recursive: true });
  // earlier set-aside copies: gone once CharaStudio no longer holds them
  for (const f of fs.readdirSync(folder)) if (/\.dll\.old-\d+$/i.test(f)) try { fs.unlinkSync(path.join(folder, f)); } catch { /* still loaded */ }
  const dest = path.join(folder, DLL);
  if (fs.existsSync(dest)) {
    // always rename first: a file in use (a running CharaStudio) can't be replaced, and one that's "deleted" while
    // still open keeps its name until it's closed — a renamed one frees the name either way
    const aside = `${dest}.old-${Date.now()}`;
    fs.renameSync(dest, aside);
    try {
      fs.unlinkSync(aside);
    } catch {
      /* still loaded: removed on a later install */
    }
  }
  fs.copyFileSync(src, dest);
  save({ ...load(), gameDir: dir });
  return status(dir);
}

function register(ipcMain) {
  ipcMain.handle('setup:status', (_e, dir) => status(dir));
  ipcMain.handle('setup:install', (_e, dir) => install(dir));
  ipcMain.handle('setup:pick', async (e) => {
    const win = BrowserWindow.fromWebContents(e.sender);
    const r = await dialog.showOpenDialog(win, { title: 'Choose your Koikatsu folder (where CharaStudio.exe is)', properties: ['openDirectory'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const dir = r.filePaths[0];
    if (!isGame(dir)) throw new Error('That folder isn’t Koikatsu — pick the one with CharaStudio.exe and Koikatu.exe');
    save({ ...load(), gameDir: dir });
    return status(dir);
  });
}

module.exports = { register };
