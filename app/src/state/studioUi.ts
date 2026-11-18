import { create } from 'zustand';
import { bridge } from '../bridge/client';
import { toast } from './store';

/** CharaStudio's own window: clean (menus hidden, just the viewport) or normal. The plugin restores it when we disconnect. */
export interface StudioUi {
  clean: boolean;
  timeline: boolean; // keep Timeline's window while clean
  handles: boolean; // keep the move / rotate handles while clean
  hideAllUi: boolean; // HideAllUI is installed
  useHideAllUi: boolean; // …and does the hiding
  provider: string;
  hidden: number;
}

const KEY = 'kf.studioUi';
type Prefs = Pick<StudioUi, 'clean' | 'timeline' | 'handles' | 'useHideAllUi'>;

function prefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}');
  } catch {
    return {};
  }
}
function savePrefs(p: Partial<Prefs>) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...prefs(), ...p }));
  } catch {
    /* private mode */
  }
}

export const useStudioUi = create<{ ui: StudioUi | null }>(() => ({ ui: null }));

/** On connect: put Studio back the way the user left it (clean or not) — the plugin un-cleaned it when we left. */
export async function syncStudioUi() {
  try {
    const ui = await bridge.request<StudioUi>('ui.set', prefs());
    useStudioUi.setState({ ui });
  } catch {
    useStudioUi.setState({ ui: null }); // older bridge
  }
}

export async function setStudioUi(patch: Partial<Prefs>) {
  savePrefs(patch);
  try {
    const ui = await bridge.request<StudioUi>('ui.set', patch);
    useStudioUi.setState({ ui });
    return ui;
  } catch (e) {
    toast((e as Error).message, 'error');
  }
}

export function toggleCleanStudio() {
  const ui = useStudioUi.getState().ui;
  if (!ui) return;
  setStudioUi({ clean: !ui.clean }).then((r) => r && toast(r.clean ? "Studio's menus hidden — Keyframe Studio is the editor now" : "Studio's menus are back"));
}
