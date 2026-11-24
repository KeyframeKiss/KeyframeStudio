import { bridge } from '../bridge/client';
import { echoToastsToStudio, keyAllOfSelectedObjects, keyChanged, keySelected, liveTime, setAutoKey, togglePlay, useStore } from '../state/store';
import { toggleGuides } from '../components/CameraToolsCards';

/**
 * Keyframe Studio's keys pressed while CharaStudio is the active window (the bridge notices them; set in Mod
 * settings › Hotkeys in Studio, Ctrl+K by default). Each does what the app's own key does, and what it says
 * shows for a moment in Studio's window too, where you're looking.
 */
export function installStudioHotkeys() {
  const flash = (text: string) => bridge.request('studio.flash', { text }).catch(() => {});
  const off = bridge.on('hotkey', async (d) => {
    const action = (d as { action?: string })?.action;
    const st = useStore.getState();
    echoToastsToStudio();
    if (action === 'key') {
      if (st.selTracks.size || st.selKeys.size) {
        const n = st.selTracks.size || new Set([...st.selKeys].map((k) => k.split('|')[0])).size;
        await keySelected();
        flash(`Keyed ${n} track${n === 1 ? '' : 's'} at ${liveTime().toFixed(2)} s`);
      } else await keyChanged();
    } else if (action === 'keyAll') {
      const sel = new Set(st.studioSelection);
      const n = st.tracks.filter((t) => sel.has(t.oci)).length;
      await keyAllOfSelectedObjects();
      if (n) flash(`Keyed the whole object (${n} track${n === 1 ? '' : 's'})`);
    } else if (action === 'autoKey') await setAutoKey(!st.autoKey);
    else if (action === 'play') {
      togglePlay();
      flash(useStore.getState().tl?.playing ? 'Playing' : 'Paused');
    } else if (action === 'guides') await toggleGuides();
  });
  return () => off?.();
}
