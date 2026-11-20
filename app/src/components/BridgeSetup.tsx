import { useEffect, useState } from 'react';
import type { BridgeSetup } from '../lib/translate';
import { toast, useStore } from '../state/store';

/**
 * One-click setup: the Koikatsu folder, whether BepInEx is there, and the Keyframe Studio bridge plugin compared
 * with the copy this app carries — Install or Update puts it in place (even while CharaStudio runs; it loads on
 * Studio's next start).
 */
export function BridgeSetupCard() {
  const status = useStore((s) => s.status);
  const api = window.studioEx?.setup;
  const [st, setSt] = useState<BridgeSetup | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  useEffect(() => {
    api?.status().then(setSt).catch(() => setSt(null));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps
  if (!api) return null;

  const run = async (fn: () => Promise<BridgeSetup | null>, after?: () => void) => {
    setBusy(true);
    try {
      const r = await fn();
      if (r) setSt(r);
      after?.();
    } catch (e) {
      toast(String((e as Error).message).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''), 'error');
    } finally {
      setBusy(false);
    }
  };
  const install = () =>
    run(
      () => api.install(st!.gameDir!),
      () => {
        setDone(true);
        toast(status === 'open' ? 'Bridge updated — it loads the next time CharaStudio starts' : 'Bridge installed — start CharaStudio and Keyframe Studio connects', 'done');
      },
    );

  const plugin = !st ? '…' : !st.found ? '—' : !st.installed ? 'Not installed' : st.upToDate ? 'Installed — the same as this app' : 'Installed — a different version';
  const needs = !!st && st.found && st.bepinex && st.bundled && (!st.installed || !st.upToDate);

  return (
    <section className="diag-card bridge-setup">
      <div className="bridge-setup-head">
        <b>Studio bridge</b>
        <small>The small plugin inside CharaStudio that Keyframe Studio talks to.</small>
      </div>
      <div className="diag-row">
        <span>Koikatsu folder</span>
        <b className="bridge-path" title={st?.gameDir ?? ''}>
          {st ? st.gameDir ?? 'Not found — choose it' : 'Looking…'}
        </b>
        <button className="btn small solid" disabled={busy} onClick={() => run(() => api.pick())}>
          Choose…
        </button>
      </div>
      {st?.found && (
        <div className="diag-row">
          <span>BepInEx</span>
          <b className={st.bepinex ? '' : 'bridge-warn'}>{st.bepinex ? 'Installed' : 'Missing — install BepInEx (HF Patch or BetterRepack) first'}</b>
        </div>
      )}
      {st?.found && (
        <div className="diag-row">
          <span>Bridge plugin</span>
          <b className={st.installed && !st.upToDate ? 'bridge-warn' : ''}>{plugin}</b>
        </div>
      )}
      {needs && (
        <button className="btn primary bridge-go" disabled={busy} onClick={install}>
          {busy ? 'Working…' : st!.installed ? 'Update the bridge' : 'Install the bridge'}
        </button>
      )}
      {done && <small className="pn-note">{status === 'open' ? 'Restart CharaStudio to load the new bridge.' : 'Start CharaStudio — Keyframe Studio connects by itself.'}</small>}
      {st && !st.bundled && <small className="pn-note">This development build doesn’t carry a bridge plugin to install.</small>}
    </section>
  );
}
