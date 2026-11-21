import { create } from 'zustand';
import type { UpdateInfo } from './translate';

/**
 * "Is there a newer Keyframe Studio?" — asked of the project's GitHub releases at start (once every few hours at
 * most, and only when allowed in About & diagnostics), or with "Check now". The header shows a small notice while
 * a newer version is out (until skipped), and another when the connected bridge's version doesn't match the app.
 */
interface UpdateState {
  info: UpdateInfo | null;
  checking: boolean;
  error: string | null;
  auto: boolean;
  /** A version the user chose to skip: the header stays quiet about it (About still lists it). */
  skipped: string | null;
  appVersion: string | null;
}

const K_AUTO = 'kf.updates.auto';
const K_SKIP = 'kf.updates.skip';
const K_LAST = 'kf.updates.last';
const K_INFO = 'kf.updates.info';
const AUTO_EVERY = 6 * 3600 * 1000;

function read(k: string): string | null {
  try {
    return localStorage.getItem(k);
  } catch {
    return null;
  }
}
function write(k: string, v: string | null) {
  try {
    if (v == null) localStorage.removeItem(k);
    else localStorage.setItem(k, v);
  } catch {
    /* storage blocked */
  }
}
function cached(): UpdateInfo | null {
  try {
    const v = JSON.parse(read(K_INFO) ?? 'null') as UpdateInfo | null;
    return v && typeof v.latest === 'string' ? v : null;
  } catch {
    return null;
  }
}

export const useUpdates = create<UpdateState>(() => ({
  info: cached(),
  checking: false,
  error: null,
  auto: read(K_AUTO) !== '0',
  skipped: read(K_SKIP),
  appVersion: null,
}));

/** "0.1.2-beta" → [0, 1, 2]. */
export function parseVersion(v: string | null | undefined): number[] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v ?? '').trim());
  return m ? [+m[1], +m[2], +m[3]] : null;
}
/** < 0 when a is older than b, 0 when the same, > 0 when newer; null when either isn't a version. */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number | null {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

export async function checkForUpdates(): Promise<UpdateInfo | null> {
  const api = window.studioEx?.checkUpdate;
  if (!api || useUpdates.getState().checking) return useUpdates.getState().info;
  useUpdates.setState({ checking: true, error: null });
  try {
    const info = await api();
    // the cached answer is compared with the running version again on the next start (the app may have been updated)
    write(K_INFO, JSON.stringify(info));
    write(K_LAST, String(Date.now()));
    useUpdates.setState({ info, checking: false });
    return info;
  } catch (e) {
    const msg = String((e as Error).message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
    useUpdates.setState({ checking: false, error: /fetch|network|ENOTFOUND|timed? ?out|abort/i.test(msg) ? 'Couldn’t reach GitHub — check your internet connection' : msg });
    return null;
  }
}

export function setAutoUpdateCheck(on: boolean) {
  write(K_AUTO, on ? '1' : '0');
  useUpdates.setState({ auto: on });
  if (on) void checkForUpdates();
}

export function skipUpdate(version: string | null) {
  write(K_SKIP, version);
  useUpdates.setState({ skipped: version });
}

/** At start: learn this app's version, then check if allowed and the last check was a while ago. */
export function startUpdateChecks() {
  const api = window.studioEx;
  if (!api?.checkUpdate) return;
  api
    .appInfo?.()
    .then((a) => {
      useUpdates.setState((s) => ({
        appVersion: a.version,
        // a cached answer from before this app was updated is about an older version
        info: s.info && s.info.current !== a.version ? { ...s.info, current: a.version, newer: (compareVersions(s.info.latest, a.version) ?? 0) > 0 } : s.info,
      }));
    })
    .catch(() => {});
  if (!useUpdates.getState().auto) return;
  const last = Number(read(K_LAST) ?? 0);
  if (Date.now() - last < AUTO_EVERY) return;
  // a moment after start, so it never competes with connecting to Studio
  window.setTimeout(() => void checkForUpdates(), 5000);
}

/** The newer version the header should mention, or null. */
export function useNewerVersion(): UpdateInfo | null {
  return useUpdates((s) => (s.info && s.info.newer && s.info.latest !== s.skipped ? s.info : null));
}
