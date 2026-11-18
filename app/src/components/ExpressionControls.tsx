import { useCallback, useEffect, useRef, useState } from 'react';
import { bridge } from '../bridge/client';
import { toast, useStore } from '../state/store';

/**
 * Face Studio › Expression: eyebrows, eyes, mouth, blush, tears and look direction for the selected
 * character(s), laid out by feature. Changes go through chara.set (undoable) and refresh the close-up.
 */

/** Option lists arrive as plain names or as {name, nameEn?} objects. */
type Option = string | { name?: string; nameEn?: string };
const optLabel = (o: Option, i: number) => (typeof o === 'string' ? o : (o?.nameEn ?? o?.name)) || `Pattern ${i}`;

interface FaceState {
  eyebrowPtn: number;
  eyebrowCount: number;
  eyesPtn: number;
  eyesOptions: Option[];
  mouthPtn: number;
  mouthCount: number;
  eyesOpen: number;
  mouthOpen: number;
  blink: boolean;
  lipSync: boolean;
  eyesLook: number;
  eyesLookOptions: Option[];
  neckLook: number;
  neckLookOptions: Option[];
  tears: number;
  blush: number;
}

export function ExpressionControls({ ids, onChanged }: { ids: number[]; onChanged: () => void }) {
  const revision = useStore((s) => s.revision);
  const id = ids[0];
  const [st, setSt] = useState<FaceState | null>(null);
  const lastEdit = useRef(-1e9);
  const want = useRef(id);
  want.current = id;

  const load = useCallback(() => {
    if (id == null) return;
    const cid = id;
    bridge
      .request<{ face: FaceState }>('chara.get', { id: cid })
      .then((r) => want.current === cid && performance.now() - lastEdit.current > 600 && setSt(r.face))
      .catch(() => {});
  }, [id]);
  useEffect(load, [load, revision]);

  // batched, once per frame (slider drags stay smooth and live)
  const pending = useRef<Record<string, unknown>>({});
  const raf = useRef(0);
  const set = (patch: Partial<FaceState>) => {
    if (!st || !ids.length) return;
    lastEdit.current = performance.now();
    setSt({ ...st, ...patch });
    Object.assign(pending.current, patch);
    if (raf.current) return;
    raf.current = requestAnimationFrame(() => {
      raf.current = 0;
      const p = pending.current;
      pending.current = {};
      bridge
        .request('chara.set', { ids, ...p })
        .then(onChanged)
        .catch((e) => toast((e as Error).message, 'error'));
    });
  };

  if (!st) return <div className="empty">Loading expression…</div>;

  const step = (key: 'eyebrowPtn' | 'mouthPtn', count: number, d: number) => set({ [key]: (((st[key] + d) % count) + count) % count });

  return (
    <div className="face-cards">
      <div className="face-card">
        <div className="face-card-head">
          <strong>Eyes &amp; brows</strong>
        </div>
        <Row label="Eyebrows">
          <Stepper value={st.eyebrowPtn} count={st.eyebrowCount} onStep={(d) => step('eyebrowPtn', st.eyebrowCount, d)} onSet={(v) => set({ eyebrowPtn: v })} />
        </Row>
        <Row label="Eyes">
          <select className="input" value={st.eyesPtn} onChange={(e) => set({ eyesPtn: Number(e.target.value) })}>
            {st.eyesOptions.map((n, i) => (
              <option key={i} value={i}>
                {optLabel(n, i)}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Eyes open">
          <Range value={st.eyesOpen} onChange={(v) => set({ eyesOpen: v })} />
        </Row>
        <Row label="Look">
          <select className="input" value={st.eyesLook} onChange={(e) => set({ eyesLook: Number(e.target.value) })}>
            {st.eyesLookOptions.map((n, i) => (
              <option key={i} value={i}>
                {optLabel(n, i)}
              </option>
            ))}
          </select>
        </Row>
        <Row label="Blink">
          <Toggle on={st.blink} onChange={(v) => set({ blink: v })} hint="Turn off to hold the eyes still while you work" />
        </Row>
      </div>

      <div className="face-card">
        <div className="face-card-head">
          <strong>Mouth</strong>
        </div>
        <Row label="Shape">
          <Stepper value={st.mouthPtn} count={st.mouthCount} onStep={(d) => step('mouthPtn', st.mouthCount, d)} onSet={(v) => set({ mouthPtn: v })} />
        </Row>
        <Row label="Open">
          <Range value={st.mouthOpen} onChange={(v) => set({ mouthOpen: v })} />
        </Row>
        <Row label="Lip sync">
          <Toggle on={st.lipSync} onChange={(v) => set({ lipSync: v })} hint="Mouth moves with the character's voice" />
        </Row>
      </div>

      <div className="face-card">
        <div className="face-card-head">
          <strong>Cheeks &amp; tears</strong>
        </div>
        <Row label="Blush">
          <Range value={st.blush} onChange={(v) => set({ blush: v })} />
        </Row>
        <Row label="Tears">
          <div className="seg">
            {[0, 1, 2, 3].map((n) => (
              <button key={n} className={st.tears === n ? 'on' : ''} onClick={() => set({ tears: n })}>
                {n === 0 ? 'None' : n}
              </button>
            ))}
          </div>
        </Row>
      </div>

      <div className="face-card">
        <div className="face-card-head">
          <strong>Head</strong>
        </div>
        <Row label="Neck">
          <select className="input" value={st.neckLook} onChange={(e) => set({ neckLook: Number(e.target.value) })}>
            {st.neckLookOptions.map((n, i) => (
              <option key={i} value={i}>
                {optLabel(n, i)}
              </option>
            ))}
          </select>
        </Row>
      </div>
      {ids.length > 1 && <div className="face-hint">Changes apply to all {ids.length} selected characters.</div>}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="expr-row">
      <span className="face-row-label">{label}</span>
      <div className="expr-ctl">{children}</div>
    </div>
  );
}

function Range({ value, onChange }: { value: number; onChange: (v: number) => void }) {
  return (
    <div className="face-axis changed">
      <input type="range" min={0} max={1} step={0.01} value={value} onChange={(e) => onChange(Number(e.target.value))} />
      <span className="mono" style={{ minWidth: 38, flex: 'none', textAlign: 'right', fontSize: 11 }}>
        {value.toFixed(2)}
      </span>
    </div>
  );
}

function Stepper({ value, count, onStep, onSet }: { value: number; count: number; onStep: (d: number) => void; onSet: (v: number) => void }) {
  return (
    <div className="expr-stepper">
      <button className="btn icon" onClick={() => onStep(-1)} title="Previous">
        ‹
      </button>
      <input
        className="input mono"
        style={{ width: 54, textAlign: 'center' }}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isInteger(n) && n >= 0 && n < count) onSet(n);
        }}
      />
      <button className="btn icon" onClick={() => onStep(1)} title="Next">
        ›
      </button>
      <span className="face-hint" style={{ margin: 0 }}>
        of {count}
      </span>
      <input type="range" min={0} max={Math.max(0, count - 1)} step={1} value={value} onChange={(e) => onSet(Number(e.target.value))} style={{ flex: 1, accentColor: 'var(--accent)' }} />
    </div>
  );
}

function Toggle({ on, onChange, hint }: { on: boolean; onChange: (v: boolean) => void; hint?: string }) {
  return (
    <button className={`switch ${on ? 'on' : ''}`} onClick={() => onChange(!on)} title={hint}>
      <span />
    </button>
  );
}
