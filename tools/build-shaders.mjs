// Compiles Keyframe Studio's effect shaders with Unity 5.6.2f1 (Koikatsu's exact version) into
// plugin/StudioBridge/res/kfeffects.bundle, which the plugin embeds. Usage: npm run build:shaders
// Needs Unity 5.6.2f1 activated once (free Personal licence). Set KF_UNITY to use another install path.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const project = path.join(root, 'shaders', 'KfShaders');
const unity = process.env.KF_UNITY || 'C:/Program Files/Unity 5.6.2f1/Editor/Unity.exe';
const log = path.join(project, 'build.log');
if (!fs.existsSync(unity)) {
  console.error(`Unity 5.6.2f1 not found at ${unity} (set KF_UNITY)`);
  process.exit(1);
}
console.log('Building shaders with Unity 5.6.2f1…');
const r = spawnSync(unity, ['-batchmode', '-nographics', '-quit', '-projectPath', project, '-executeMethod', 'KfBuild.Build', '-logFile', log], { stdio: 'inherit' });
const text = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
const errors = text.split(/\r?\n/).filter((l) => /Shader error|error CS|Exception|failed/i.test(l) && !/^\s*at /.test(l));
for (const l of text.split(/\r?\n/)) if (l.startsWith('KF ')) console.log('  ' + l);
if (r.status !== 0 || errors.length) {
  console.error(errors.slice(0, 30).join('\n') || `Unity exited with ${r.status} — see ${log}`);
  process.exit(1);
}
const out = path.join(root, 'plugin', 'StudioBridge', 'res', 'kfeffects.bundle');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.copyFileSync(path.join(project, 'Build', 'kfeffects'), out);
console.log(`→ ${path.relative(root, out)} (${(fs.statSync(out).size / 1024).toFixed(1)} KB)`);
