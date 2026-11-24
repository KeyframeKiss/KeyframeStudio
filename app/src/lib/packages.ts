import { ask } from '../components/Dialogs';
import { call, saveSceneFile, toast } from '../state/store';
import type { PkgInspect, PkgWritten } from './translate';

// Moving work to another PC, or sharing it: a scene package (the scene + the audio, poses and motion clips it uses)
// and a backup of the library (looks, rigs, clips, faces, outfits, templates, translations). The zips are made and
// unpacked by the app's main process; the bridge says which files a scene uses.

interface Collected {
  scene: string | null;
  files: { path: string; rel: string; what: string; size: number }[];
  missing: { path: string; what: string }[];
}

const mb = (n: number) => `${(n / 1024 / 1024).toFixed(1)} MB`;
const fileName = (p: string) => p.split(/[\\/]/).pop() ?? p;

function saved(r: PkgWritten, what: string) {
  toast(`${what} saved: ${fileName(r.path)} (${r.files} file${r.files === 1 ? '' : 's'}, ${mb(r.bytes)})`, 'done');
  void window.studioEx?.showItem?.(r.path).catch(() => {});
}

export const canPackage = () => !!window.studioEx?.pkg;

/** The open scene, saved first, with every file it uses from outside itself, as one zip. */
export async function exportScenePackage() {
  const pkg = window.studioEx?.pkg;
  if (!pkg) return;
  if (!(await ask('Export the open scene as a package? Studio saves it first (as a new file), then the scene and the audio, poses and motion clips it uses go into one zip.', { ok: 'Save and export' }))) return;
  if ((await saveSceneFile()) === undefined) return;
  const info = await call<Collected>('package.collect');
  if (!info) return;
  if (!info.scene) return toast('The scene has no saved file to pack. Save it in Studio and try again', 'error');
  if (info.missing.length)
    toast(`${info.missing.length} file${info.missing.length === 1 ? '' : 's'} the scene uses ${info.missing.length === 1 ? 'is' : 'are'} missing and can't be packed: ${info.missing.map((m) => fileName(m.path)).join(', ')}`, 'error');
  try {
    const r = await pkg.exportScene({ scene: info.scene, files: info.files.map((f) => f.path) });
    if (r) saved(r, 'Scene package');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** Keyframe Studio's library and the app's translations, as one zip. */
export async function exportLibrary() {
  const pkg = window.studioEx?.pkg;
  if (!pkg) return;
  try {
    const r = await pkg.exportLibrary();
    if (r) saved(r, 'Library backup');
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

/** Open a scene package or a library backup and put its files in place (asking before replacing anything). */
export async function importPackage(): Promise<string | null> {
  const pkg = window.studioEx?.pkg;
  if (!pkg) return null;
  let p: PkgInspect | null;
  try {
    p = await pkg.open();
  } catch (e) {
    toast((e as Error).message, 'error');
    return null;
  }
  if (!p) return null;
  let replace = false;
  if (p.differ.length) {
    const list = p.differ.slice(0, 6).map(fileName).join(', ') + (p.differ.length > 6 ? `, and ${p.differ.length - 6} more` : '');
    replace = await ask(`${p.differ.length} file${p.differ.length === 1 ? '' : 's'} in the ${p.kind === 'library' ? 'backup' : 'package'} already exist${p.differ.length === 1 ? 's' : ''} here but differ${p.differ.length === 1 ? 's' : ''}: ${list}. Replace them with the ${p.kind === 'library' ? 'backup' : 'package'}'s? Keep leaves yours as they are.`, { ok: 'Replace', danger: true, title: 'Files that differ' });
  }
  try {
    const r = await pkg.apply(p.token, replace);
    const skipped = p.rejected.length ? ` ${p.rejected.length} unexpected file${p.rejected.length === 1 ? ' was' : 's were'} left out.` : '';
    toast(`${p.kind === 'library' ? 'Library restored' : 'Package imported'}: ${r.copied} file${r.copied === 1 ? '' : 's'} added${p.same ? `, ${p.same} already here` : ''}${r.kept ? `, ${r.kept} of yours kept` : ''}.${skipped}`, 'done');
    return r.scenePath;
  } catch (e) {
    toast((e as Error).message, 'error');
    return null;
  }
}
