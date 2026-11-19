// Builds the portable release: release/KeyframeStudio-<version>.zip, laid out like the game folder:
//   BepInEx/plugins/KKStudioEX/KKStudioEX.Bridge.dll   (unzip into the Koikatsu folder)
//   Keyframe Studio/Keyframe Studio.exe (+ runtime files)  (the app: keep the folder together, put it anywhere)
//   README.txt
// No downloads: the app runs on the Electron runtime already in app/node_modules/electron/dist.
// Usage: npm run package
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appDir = path.join(root, 'app');
const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
const version = pkg.version;
const name = `KeyframeStudio-${version}`;
const out = path.join(root, 'release');
const stage = path.join(out, name);
const run = (cmd, cwd) => {
  console.log(`> ${cmd}`);
  execSync(cmd, { cwd, stdio: 'inherit' });
};

// 1. build the app and the plugin
run('npm run build', appDir);
run('dotnet build -c Release', path.join(root, 'plugin', 'StudioBridge'));
const dll = path.join(root, 'plugin', 'StudioBridge', 'bin', 'Release', 'KKStudioEX.Bridge.dll');
if (!fs.existsSync(dll)) throw new Error('plugin build output not found: ' + dll);

// 2. lay out the folders
fs.rmSync(stage, { recursive: true, force: true });
const pluginOut = path.join(stage, 'BepInEx', 'plugins', 'KKStudioEX');
fs.mkdirSync(pluginOut, { recursive: true });
fs.copyFileSync(dll, path.join(pluginOut, 'KKStudioEX.Bridge.dll'));

const runtime = path.join(appDir, 'node_modules', 'electron', 'dist');
if (!fs.existsSync(path.join(runtime, 'electron.exe'))) throw new Error('Electron runtime not found (run npm install in app/)');
const appOut = path.join(stage, 'Keyframe Studio');
fs.cpSync(runtime, appOut, { recursive: true });
fs.renameSync(path.join(appOut, 'electron.exe'), path.join(appOut, 'Keyframe Studio.exe'));
// our icon on the exe itself (Explorer, shortcuts), with our own small tool (tools/SetIcon, no downloads)
const setIcon = path.join(root, 'tools', 'SetIcon');
run(`dotnet build -c Release -o "${path.join(setIcon, 'bin', 'out')}"`, setIcon);
run(`"${path.join(setIcon, 'bin', 'out', 'SetIcon.exe')}" "${path.join(appOut, 'Keyframe Studio.exe')}" "${path.join(appDir, 'build', 'icon.ico')}"`, root);
fs.rmSync(path.join(appOut, 'resources', 'default_app.asar'), { force: true });

// the app itself, in resources/app: the main process, the built UI, the icon
const res = path.join(appOut, 'resources', 'app');
fs.mkdirSync(res, { recursive: true });
fs.cpSync(path.join(appDir, 'electron'), path.join(res, 'electron'), { recursive: true });
fs.cpSync(path.join(appDir, 'dist'), path.join(res, 'dist'), { recursive: true });
fs.cpSync(path.join(appDir, 'build'), path.join(res, 'build'), { recursive: true });
fs.writeFileSync(
  path.join(res, 'package.json'),
  JSON.stringify({ name: pkg.name, productName: 'Keyframe Studio', version, description: pkg.description, main: 'electron/main.cjs' }, null, 2),
);

// 3. read-me
const electronVersion = fs.readFileSync(path.join(runtime, 'version'), 'utf8').trim();
fs.writeFileSync(
  path.join(stage, 'README.txt'),
  [
    `Keyframe Studio ${version}`,
    '',
    'An editing window for Koikatsu CharaStudio: animation, posing, looks, effects, camera and rendering.',
    '',
    'INSTALL',
    '  1. Unzip this into your Koikatsu folder (the one with CharaStudio.exe).',
    '     The plugin lands in BepInEx\\plugins\\KKStudioEX.',
    '  2. The "Keyframe Studio" folder can stay there or move anywhere you like — keep its files together.',
    '  3. Start CharaStudio, then "Keyframe Studio\\Keyframe Studio.exe". It connects by itself.',
    '',
    'NEEDS',
    '  - Koikatsu with BepInEx 5.4 and KKAPI (any HF Patch / BetterRepack has them).',
    '  - Timeline, for animation. Other plugins (KKPE, MaterialEditor, KKABMX, VideoExport, Screencap,',
    '    xukmi FX, RealPOV, LockOnPlugin, LightManager, HideAllUI, NodesConstraints) are used when installed; features that',
    '    need a missing one say so.',
    '',
    'UPDATE',
    '  Replace both folders with the new ones. Your looks, poses, faces, clips and settings are kept:',
    '  they live in Koikatsu\\UserData\\StudioEX and %APPDATA%\\studio-ex.',
    '',
    'REMOVE',
    '  Delete BepInEx\\plugins\\KKStudioEX and the "Keyframe Studio" folder.',
    '',
    'Windows may warn about an unknown publisher the first time (the app isn\'t code-signed):',
    'choose "More info" → "Run anyway".',
    '',
    `Built on Electron ${electronVersion}. Licences for Electron and Chromium are in the Keyframe Studio folder.`,
    '',
  ].join('\r\n'),
);

// 4. zip (Windows' own zip, nothing to install)
const zip = path.join(out, `${name}.zip`);
fs.rmSync(zip, { force: true });
run(`powershell -NoProfile -Command "Compress-Archive -Path '${stage}\\*' -DestinationPath '${zip}' -CompressionLevel Optimal"`, root);
const mb = (fs.statSync(zip).size / 1048576).toFixed(1);
console.log(`\n→ ${path.relative(root, zip)} (${mb} MB)`);
