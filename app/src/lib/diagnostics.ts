import { bridge } from '../bridge/client';
import type { Feature } from '../bridge/types';
import { recentAppLog } from './log';

export interface DiagInfo {
  plugin: string;
  protocol: number;
  bepinex: string;
  unity: string;
  os: string;
  paths: { game: string; userData: string; bepinexLog: string };
  features: Feature[];
  scene: { objects: number; fps: number };
  plugins: { guid: string; name: string; version: string }[];
}

/** Hide the Windows user name (C:\Users\<name>\…) and the home folder in anything shared. */
export function redact(text: string, home?: string) {
  let t = text;
  if (home) t = t.split(home).join('~');
  return t.replace(/([A-Za-z]:[\/]+Users[\/]+)[^\/\s"']+/gi, '$1<user>');
}

/** A plain-text report for bug reports: versions, mods, features, recent logs from both sides. */
export async function buildReport(status: string): Promise<string> {
  const info = (await window.studioEx?.appInfo?.().catch(() => undefined)) ?? undefined;
  const out: string[] = [];
  const h = (s: string) => out.push('', `== ${s} ==`);
  out.push(`Studio EX diagnostics — ${new Date().toISOString()}`);
  h('App');
  if (info) out.push(`Studio EX ${info.version} · Electron ${info.electron} · Chrome ${info.chrome} · ${info.os}`);
  else out.push('Running outside Electron (browser dev mode)');
  out.push(`Bridge: ${status}`);

  let diag: DiagInfo | null = null;
  let bridgeLog: string[] = [];
  if (status === 'open') {
    diag = await bridge.request<DiagInfo>('diag.info').catch(() => null);
    bridgeLog = (await bridge.request<string[]>('diag.log', { max: 200 }).catch(() => [])) ?? [];
  }
  h('CharaStudio');
  if (diag) {
    out.push(`Bridge plugin ${diag.plugin} (protocol ${diag.protocol}) · BepInEx ${diag.bepinex} · Unity ${diag.unity} · ${diag.os}`);
    out.push(`Scene: ${diag.scene.objects} objects · ${diag.scene.fps} fps`);
    out.push(`Game folder: ${diag.paths.game}`);
    h('Features');
    for (const f of diag.features) out.push(`${f.status.padEnd(9)} ${f.label} — ${f.mod}${f.version ? ' ' + f.version : ''}${f.reason ? `\n          ${f.reason}` : ''}`);
    h(`Installed plugins (${diag.plugins.length})`);
    for (const p of diag.plugins) out.push(`${p.name} ${p.version}  (${p.guid})`);
  } else out.push('Not connected — start CharaStudio to include its versions and log.');

  h('Bridge log (recent warnings/errors and Studio EX messages)');
  out.push(...(bridgeLog.length ? bridgeLog : ['(empty)']));
  h('App log (recent)');
  const fileLines = (await window.studioEx?.log?.tail(200).catch(() => null)) ?? null;
  out.push(...(fileLines?.length ? fileLines : recentAppLog().length ? recentAppLog() : ['(empty)']));
  return redact(out.join('\n'), info?.home);
}
