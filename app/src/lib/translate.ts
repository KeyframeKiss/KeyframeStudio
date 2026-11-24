// Batch machine translation for Keyframe Studio.
//
// Engines run in the Electron main process (see electron/translate.cjs). Results are stored by the
// plugin in BepInEx/Translation/en/Text/zy_StudioEX_Machine.txt and pushed into AutoTranslator, so the
// in-game UI benefits too. Your own edits (zz_StudioEX_Overrides.txt) always win over machine results.
import { call, refreshScene, refreshTimeline, toast, useStore } from '../state/store';

export type Engine = 'google' | 'deepl' | 'llm';

export interface TranslateSettings {
  engine: Engine;
  deeplKey: string;
  llmUrl: string;
  llmModel: string;
  llmKey: string;
  /** Translate new Japanese names automatically as they show up. */
  auto: boolean;
}

export interface Entry {
  text: string;
  translation: string | null;
  override: boolean;
  source: 'mine' | 'machine' | 'game' | null;
  engine: string | null;
  context: string;
}

interface Bridge {
  batch(engine: Engine, items: { text: string; context?: string }[], settings: TranslateSettings): Promise<(string | null)[]>;
  models(settings: TranslateSettings): Promise<string[]>;
}

/** Where the Keyframe Studio bridge plugin stands in the Koikatsu folder (one-click setup). */
export interface BridgeSetup {
  gameDir: string | null;
  found: boolean;
  bepinex: boolean;
  installed: boolean;
  upToDate: boolean;
  bundled: boolean;
}

/** The newest release on the project's GitHub page compared with this app (electron/updates.cjs). */
export interface UpdateInfo {
  current: string;
  latest: string | null;
  newer: boolean;
  name: string | null;
  publishedAt: string | null;
  summary: string;
  security: boolean;
  url: string;
  releasesUrl: string;
}

declare global {
  interface Window {
    studioEx?: {
      isElectron: boolean;
      /** no system title bar: the header is the title bar (window buttons drawn over its right end) */
      frameless?: boolean;
      setAlwaysOnTop(on: boolean): Promise<boolean>;
      setMini?(on: boolean): Promise<boolean>;
      getAlwaysOnTop(): Promise<boolean>;
      getBounds?(): Promise<{ x: number; y: number; width: number; height: number }>;
      setBounds?(b: { x: number; y: number; width: number; height: number }): Promise<boolean>;
      translate?: Bridge;
      log?: {
        write(lines: { level: string; source: string; text: string }[]): Promise<void>;
        tail(n: number): Promise<string[]>;
        openFolder(): Promise<string>;
      };
      openAudio?(): Promise<string | null>;
      pathForFile?(file: File): string;
      /** the secret the bridge asks every connection for (%APPDATA%\studio-ex\bridge-token, written by the bridge) */
      bridgeToken?(): Promise<string>;
      openImage?(): Promise<string | null>;
      openFolder?(path: string): Promise<string>;
      /** Show a scene file in Explorer, selected. */
      showItem?(path: string): Promise<string>;
      setup?: {
        status(dir?: string): Promise<BridgeSetup>;
        install(dir: string): Promise<BridgeSetup>;
        pick(): Promise<BridgeSetup | null>;
      };
      appInfo?(): Promise<{ version: string; electron: string; chrome: string; node: string; os: string; logFile: string; home: string }>;
      checkUpdate?(): Promise<UpdateInfo>;
      savePng?(name: string, dataUrl: string): Promise<string | null>;
    };
  }
}

export const ENGINE_LABEL: Record<Engine, string> = { google: 'Google', deepl: 'DeepL', llm: 'Local AI' };
/** Items per request. Google: newline-joined text; DeepL: up to 50 texts; LLM: small so JSON stays reliable. */
const BATCH: Record<Engine, number> = { google: 40, deepl: 50, llm: 20 };

const KEY = 'studioex.translate';
const DEFAULTS: TranslateSettings = { engine: 'google', deeplKey: '', llmUrl: 'http://127.0.0.1:11434/v1', llmModel: '', llmKey: '', auto: true };

export function engineAvailable() {
  return !!window.studioEx?.translate;
}

export function loadSettings(): TranslateSettings {
  try {
    return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(KEY) || '{}') };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveSettings(s: TranslateSettings) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
  window.dispatchEvent(new Event('studioex:translate-settings'));
}

export function listModels(s: TranslateSettings) {
  if (!window.studioEx?.translate) return Promise.reject(new Error('Only available in the Keyframe Studio window'));
  return window.studioEx.translate.models(s);
}

// "01_おいで" / "[Mod] 名前" — the plugin translates the part after the prefix and re-attaches it,
// so we only need to translate the core text once.
const PREFIX = /^((?:\d+[_\-. ]+|\[[^\]]*\]\s*|【[^】]*】\s*)+)(.+)$/;
const needs = (s: string) => /[　-￿]/.test(s);

function coreOf(text: string) {
  const m = PREFIX.exec(text);
  return m && m[2] ? m[2] : text;
}

function cores(entries: { text: string; context: string }[]) {
  const map = new Map<string, string>();
  for (const e of entries) {
    const core = coreOf(e.text);
    if (needs(core) && !map.has(core)) map.set(core, e.context || '');
  }
  return [...map].map(([text, context]) => ({ text, context }));
}

let cancelled = false;
export function cancelTranslation() {
  cancelled = true;
  autoPausedUntil = Date.now() + 10 * 60_000; // the user said stop: don't let auto mode restart it right away
}

const BUSY = 'A translation is already running';

/** Strings that failed this session, so auto mode doesn't retry them forever. */
const failed = new Set<string>();

/**
 * Translate entries with an engine and store the results as machine translations.
 * Returns how many were saved. Throws on engine errors (bad key, server not running, ...).
 */
export async function translateEntries(entries: { text: string; context: string }[], engine: Engine, opts: { quiet?: boolean } = {}) {
  const api = window.studioEx?.translate;
  if (!api) throw new Error('Auto-translation needs the Keyframe Studio window (not a browser tab)');
  if (useStore.getState().translateJob) throw new Error(BUSY);
  const items = cores(entries);
  if (!items.length) return 0;
  if (useStore.getState().translateJob) throw new Error(BUSY);
  const settings = loadSettings();
  const size = BATCH[engine];
  cancelled = false;
  let saved = 0;
  useStore.setState({ translateJob: { done: 0, total: items.length, engine: ENGINE_LABEL[engine] } });
  try {
    for (let i = 0; i < items.length && !cancelled; i += size) {
      const chunk = items.slice(i, i + size);
      const out = await api.batch(engine, chunk, settings);
      if (cancelled) break; // Stop pressed while this batch was running: don't save it
      const results = chunk.map((c, k) => ({ text: c.text, value: out[k] ?? '' })).filter((r) => r.value && r.value !== r.text);
      // Only "the engine answered but couldn't translate it" counts as failed; a dropped request is retried later.
      chunk.forEach((c, k) => {
        if (out[k] != null && !results.some((r) => r.text === c.text)) failed.add(c.text);
      });
      if (results.length) saved += (await call<number>('translation.setMachine', { items: results, engine })) ?? 0;
      useStore.setState({ translateJob: { done: Math.min(items.length, i + size), total: items.length, engine: ENGINE_LABEL[engine] } });
      if (engine === 'google' && i + size < items.length) await new Promise((r) => setTimeout(r, 400)); // be polite to the free endpoint
    }
  } finally {
    useStore.setState({ translateJob: null });
    if (saved) {
      refreshScene();
      refreshTimeline();
      useStore.setState((s) => ({ revision: s.revision + 1 }));
    }
  }
  if (!opts.quiet || saved) toast(saved ? `Translated ${saved} name${saved > 1 ? 's' : ''} with ${ENGINE_LABEL[engine]}` : 'Nothing new to translate');
  return saved;
}

/** Translate every Japanese string the app has shown that has no translation yet. */
export async function translateMissing(engine: Engine, quiet = false) {
  const list = (await call<Entry[]>('translation.list', { onlyUntranslated: true })) ?? [];
  const todo = quiet ? list.filter((e) => !failed.has(coreOf(e.text))) : list;
  if (!todo.length) {
    if (!quiet) toast('Everything shown so far already has a translation');
    return 0;
  }
  return translateEntries(todo, engine, { quiet });
}

// ---------------------------------------------------------------- auto mode
let autoTimer: number | undefined;
let autoBroken = false;
let autoPausedUntil = 0;
const TRANSIENT = /\(429\)|rate limit|HTTP 5\d\d|timed out|fetch failed|ECONNRESET|net::ERR_(?!CONNECTION_REFUSED)/i;

/** Background loop: every few seconds, translate newly seen Japanese names with the chosen engine. */
export function startAutoTranslate() {
  if (autoTimer || !engineAvailable()) return;
  const tick = async () => {
    const s = loadSettings();
    const st = useStore.getState();
    if (s.auto && !autoBroken && Date.now() >= autoPausedUntil && st.status === 'open' && !st.translateJob) {
      try {
        await translateMissing(s.engine, true);
      } catch (e) {
        const msg = (e as Error).message;
        if (msg === BUSY) return; // a manual run is going: just skip this tick
        if (TRANSIENT.test(msg)) {
          // Temporary (rate limit, network): back off quietly and try again later.
          autoPausedUntil = Date.now() + 2 * 60_000;
          console.warn('[translate] auto paused for 2 min:', msg);
        } else {
          autoBroken = true; // config problem (key, model, server): wait until settings change
          toast(`Auto-translate paused: ${msg}`, 'error');
        }
      }
    }
  };
  window.addEventListener('studioex:translate-settings', () => {
    autoBroken = false;
    autoPausedUntil = 0;
  });
  autoTimer = window.setInterval(tick, 15000);
  window.setTimeout(tick, 4000);
}
