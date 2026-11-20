import { useEffect, useRef, useState } from 'react';
import { Help } from './Help';
import { Slider } from './CharacterPanel';
import { bridge } from '../bridge/client';
import { call, toast } from '../state/store';
import type { Framing, RenderVersion } from '../lib/renderVersions';

const MODES: { id: Framing['mode']; label: string; hint: string }[] = [
  { id: 'timeline', label: "Timeline's camera", hint: 'The camera as animated on the timeline' },
  { id: 'adjust', label: 'Adjusted', hint: 'The animated camera, shifted and zoomed for this shape — e.g. re-centre a vertical cut' },
  { id: 'fixed', label: 'Own view', hint: 'One view you set in Studio, held for the whole video' },
];

/**
 * Render › Framing: each version's camera. "Preview" shows that framing live in Studio's window, with the frame guide
 * set to the version's shape, so a vertical cut can be lined up before rendering.
 */
export function FramingCard({ versions, setVersions, running, native }: { versions: RenderVersion[]; setVersions: (v: RenderVersion[]) => void; running: boolean; native: [number, number] | null }) {
  const [previewing, setPreviewing] = useState<number | null>(null);
  const guideBefore = useRef<number | null>(null);

  const aspectOf = (v: RenderVersion) => (v.w && v.h ? v.w / v.h : native ? native[0] / native[1] : 16 / 9);
  const sendPreview = (v: RenderVersion | null) => bridge.request('render.framingPreview', { framing: v && v.framing.mode !== 'timeline' ? v.framing : null }).catch(() => undefined);

  const startPreview = async (i: number) => {
    if (guideBefore.current == null) {
      const st = await call<{ guides: { aspect: number } }>('camtools.get');
      guideBefore.current = st?.guides.aspect ?? 0;
    }
    setPreviewing(i);
    await sendPreview(versions[i]);
    await call('camtools.set', { guides: { aspect: aspectOf(versions[i]) } });
  };
  const stopPreview = async () => {
    setPreviewing(null);
    await sendPreview(null);
    if (guideBefore.current != null) await call('camtools.set', { guides: { aspect: guideBefore.current } });
    guideBefore.current = null;
  };
  // the preview follows edits, and ends with the page
  const latest = useRef(versions);
  latest.current = versions;
  useEffect(() => {
    if (previewing != null && versions[previewing]) sendPreview(versions[previewing]);
    if (previewing != null && !versions[previewing]) stopPreview();
  }, [versions]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(
    () => () => {
      bridge.request('render.framingPreview', { framing: null }).catch(() => undefined);
      if (guideBefore.current != null) bridge.request('camtools.set', { guides: { aspect: guideBefore.current } }).catch(() => undefined);
    },
    [],
  );

  const update = (i: number, framing: Framing) => setVersions(versions.map((v, k) => (k === i ? { ...v, framing } : v)));
  const grabView = async (i: number) => {
    const view = await call<{ pos: number[]; rot: number[]; fov: number }>('render.view');
    if (!view) return;
    update(i, { mode: 'fixed', ...view });
    toast(`“${versions[i].label}” will use this view`);
  };

  return (
    <div className="look-card">
      <div className="look-card-head">
        <div>
          <b>
            Framing
            <Help text="Each version's camera. Adjusted follows the animated camera, shifted and zoomed — handy when a vertical cut needs the subject re-centred. Own view holds one view you set in Studio. Preview shows it live in Studio's window with the frame guide set to that shape. Nothing here changes the timeline's camera." />
          </b>
        </div>
      </div>
      <div className="look-card-body render-framing">
        {versions.map((v, i) => {
          const f = v.framing;
          const on = previewing === i;
          return (
            <div key={`${v.label}-${v.w}x${v.h}`} className="render-version">
              <div className="render-version-head">
                <b>{v.label}</b>
                <small>{v.w ? `${v.w}×${v.h}` : native ? `${native[0]}×${native[1]}` : ''}</small>
                <span style={{ flex: 1 }} />
                <button className={`btn small ${on ? 'on' : 'solid'}`} disabled={running} onClick={() => (on ? stopPreview() : startPreview(i))} title="Show this framing in Studio's window, with the frame guide set to this shape">
                  {on ? '■ Stop preview' : 'Preview in Studio'}
                </button>
              </div>
              <div className="seg render-modes">
                {MODES.map((m) => (
                  <button
                    key={m.id}
                    className={f.mode === m.id ? 'on' : ''}
                    disabled={running}
                    title={m.hint}
                    onClick={() => update(i, m.id === 'timeline' ? { mode: 'timeline' } : m.id === 'adjust' ? (f.mode === 'adjust' ? f : { mode: 'adjust', x: 0, y: 0, zoom: 1 }) : f.mode === 'fixed' ? f : { mode: 'fixed' })}
                  >
                    {m.label}
                  </button>
                ))}
              </div>
              {f.mode === 'adjust' && (
                <>
                  <div className="cleanup-row" title="Slides the picture sideways, as a share of this version's frame (+ shows more of the right) — like moving the cut-out across a wider shot; the camera itself doesn't move">
                    <span>Sideways</span>
                    <Slider value={f.x} min={-1} max={1} step={0.01} onChange={(x) => update(i, { ...f, x })} />
                  </div>
                  <div className="cleanup-row" title="Slides the picture up or down, as a share of this version's frame">
                    <span>Up / down</span>
                    <Slider value={f.y} min={-1} max={1} step={0.01} onChange={(y) => update(i, { ...f, y })} />
                  </div>
                  <div className="cleanup-row">
                    <span>Zoom</span>
                    <Slider value={f.zoom} min={0.5} max={2.5} step={0.01} onChange={(zoom) => update(i, { ...f, zoom })} />
                  </div>
                  {(f.x !== 0 || f.y !== 0 || f.zoom !== 1) && (
                    <button className="btn small" onClick={() => update(i, { mode: 'adjust', x: 0, y: 0, zoom: 1 })}>
                      Reset
                    </button>
                  )}
                </>
              )}
              {f.mode === 'fixed' && (
                <div className="cleanup-row">
                  <span />
                  <button className="btn small solid" disabled={running} onClick={() => grabView(i)} title="Frame the shot in Studio, then press this">
                    {f.pos ? 'Use Studio’s view now (replace)' : 'Use Studio’s view now'}
                  </button>
                  <small className="hint" style={{ margin: 0 }}>
                    {f.pos ? 'View set — held for the whole video' : 'Not set yet — until then it uses the timeline’s camera'}
                  </small>
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
