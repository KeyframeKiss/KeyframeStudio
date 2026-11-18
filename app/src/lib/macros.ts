import { useSyncExternalStore } from 'react';

/**
 * Quick actions (macros): record the changes made through Keyframe Studio, then replay them. Only commands
 * that change something are recorded (reads, polling and previews are skipped). A quick action can replay on
 * the objects it was recorded with, or on whatever is selected when it runs.
 */
export interface MacroStep {
  cmd: string;
  args: Record<string, unknown>;
}
export interface Macro {
  name: string;
  steps: MacroStep[];
  /** replace recorded object ids (id/ids/oci) with the current selection */
  useSelection: boolean;
  created: number;
}

/** Reads and transient things that make no sense to replay. */
const SKIP = /\.(get|list|status|state|presets|files|peaks|envelope|keyValues|models|changes|snapshot|anchors|pick|view|shapes|meta|fingerprint|queueStatus|rigs|sceneRigs|thumbsStatus|keyInfo|tick|log|info|preview|previewEnd|seek)$|^(hello|ping|diag\.|undo$|redo$|cards\.list|chara\.animations|scene\.select|motion\.sample|render\.(start|stop|queue))/;

let recording: MacroStep[] | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};
let version = 0;

/** Called by the bridge client for every request. */
export function noteRequest(cmd: string, args: Record<string, unknown>) {
  if (!recording || SKIP.test(cmd) || (args as { noUndo?: boolean }).noUndo) return;
  recording.push({ cmd, args: JSON.parse(JSON.stringify(args)) });
  version++;
  emit();
}

export const isRecording = () => recording !== null;
export function startRecording() {
  recording = [];
  version++;
  emit();
}
/** Stops and returns what was recorded (null if nothing). */
export function stopRecording(): MacroStep[] | null {
  const r = recording;
  recording = null;
  version++;
  emit();
  return r && r.length ? r : null;
}
export function useRecording() {
  return useSyncExternalStore(subscribe, () => version) >= 0 ? { on: recording !== null, steps: recording?.length ?? 0 } : { on: false, steps: 0 };
}

const KEY = 'kf.macros';
export function macros(): Macro[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '[]');
  } catch {
    return [];
  }
}
function saveAll(list: Macro[]) {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* storage unavailable */
  }
  version++;
  emit();
}
export function useMacros() {
  useSyncExternalStore(subscribe, () => version);
  return macros();
}
export function saveMacro(name: string, steps: MacroStep[], useSelection = true) {
  saveAll([...macros().filter((m) => m.name !== name), { name, steps, useSelection, created: Date.now() }].sort((a, b) => a.name.localeCompare(b.name)));
}
export function updateMacro(name: string, patch: Partial<Macro>) {
  saveAll(macros().map((m) => (m.name === name ? { ...m, ...patch } : m)));
}
export function deleteMacro(name: string) {
  saveAll(macros().filter((m) => m.name !== name));
}

/** The step's arguments with recorded object ids swapped for the current selection (when asked to). */
export function retarget(args: Record<string, unknown>, selection: number[]): Record<string, unknown> {
  if (!selection.length) return args;
  const out = { ...args };
  if (Array.isArray(out.ids)) out.ids = selection;
  if (typeof out.id === 'number') out.id = selection[0];
  if (typeof out.oci === 'number' && out.oci >= 0) out.oci = selection[0];
  return out;
}

/** A short, readable line per step, e.g. "chara.set blush, eyesPtn". */
export const describeStep = (s: MacroStep) =>
  `${s.cmd} ${Object.keys(s.args)
    .filter((k) => !['id', 'ids', 'undoLabel'].includes(k))
    .slice(0, 4)
    .join(', ')}`.trim();
