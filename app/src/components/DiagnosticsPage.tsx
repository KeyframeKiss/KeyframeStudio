import { useCallback, useEffect, useState } from 'react';
import { bridge } from '../bridge/client';
import type { Feature } from '../bridge/types';
import { buildReport, type DiagInfo } from '../lib/diagnostics';
import { toast, useStore } from '../state/store';

const STATUS: Record<Feature['status'], { label: string; cls: string }> = {
  ok: { label: 'Works', cls: 'ok' },
  untested: { label: 'Untested version', cls: 'warn' },
  off: { label: 'Off', cls: 'bad' },
  missing: { label: 'Not installed', cls: 'muted' },
};

/** Versions, which features work with the installed mods, and a one-click bug report. */
export function DiagnosticsPage() {
  const status = useStore((s) => s.status);
  const hello = useStore((s) => s.hello);
  const [diag, setDiag] = useState<DiagInfo | null>(null);
  const [app, setApp] = useState<{ version: string; electron: string; os: string; logFile: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    if (status !== 'open') return setDiag(null);
    bridge
      .request<DiagInfo>('diag.info')
      .then(setDiag)
      .catch(() => setDiag(null));
  }, [status]);
  useEffect(load, [load]);
  useEffect(() => {
    window.studioEx
      ?.appInfo?.()
      .then(setApp)
      .catch(() => {});
  }, []);

  const copy = async () => {
    setBusy(true);
    try {
      const text = await buildReport(status);
      await navigator.clipboard.writeText(text);
      toast('Diagnostics copied — paste them into your bug report');
    } catch (e) {
      toast(`Couldn’t copy diagnostics: ${(e as Error).message}`, 'error');
    } finally {
      setBusy(false);
    }
  };

  const features = diag?.features ?? hello?.features ?? [];
  return (
    <div className="page">
      <div className="page-inner narrow" style={{ padding: 20, overflow: 'auto' }}>
        <h2 className="page-title">About &amp; diagnostics</h2>

        <section className="diag-card">
          <div className="diag-row">
            <span>Studio EX</span>
            <b>{app ? `${app.version} · Electron ${app.electron} · ${app.os}` : 'browser dev mode'}</b>
          </div>
          <div className="diag-row">
            <span>Bridge plugin</span>
            <b>{diag ? `${diag.plugin} · BepInEx ${diag.bepinex} · Unity ${diag.unity}` : status === 'open' ? '…' : 'not connected'}</b>
          </div>
          {diag && (
            <div className="diag-row">
              <span>Scene</span>
              <b>
                {diag.scene.objects} objects · {diag.scene.fps} fps · {diag.plugins.length} plugins installed
              </b>
            </div>
          )}
          <div className="diag-actions">
            <button className="btn primary" disabled={busy} onClick={copy} title="Versions, mods, feature status and recent logs as text (your Windows user name is hidden)">
              {busy ? 'Collecting…' : 'Copy diagnostics'}
            </button>
            {window.studioEx?.log && (
              <button className="btn solid" onClick={() => window.studioEx?.log?.openFolder()} title="Studio EX's own log file">
                Open log folder
              </button>
            )}
            {status === 'open' && (
              <button className="btn" onClick={load}>
                Refresh
              </button>
            )}
          </div>
        </section>

        <h3 className="diag-h">Features and the mods they use</h3>
        {!features.length && <div className="empty">Start CharaStudio to see which features work with your mods.</div>}
        <div className="diag-features">
          {features.map((f) => {
            const st = STATUS[f.status];
            return (
              <div key={f.id} className="diag-feature">
                <span className={`diag-pill ${st.cls}`}>{st.label}</span>
                <div>
                  <b>{f.label}</b>
                  <small>
                    {f.mod}
                    {f.version ? ` ${f.version}` : ''}
                    {f.tested.length ? ` · tested with ${f.tested.join(', ')}` : ''}
                  </small>
                  {f.reason && f.status !== 'missing' && <small className="diag-reason">{f.reason}</small>}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
