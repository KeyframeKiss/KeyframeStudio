import { useEffect, useMemo, useState } from 'react';
import type { KeyInfo } from '../bridge/types';
import { fromFlat, presetFor, PRESETS, toFlat } from '../lib/curve';
import {
  applyCurveToSelected,
  deleteSelectedKeys,
  displayName,
  getKeyInfo,
  keyTracks,
  moveSelectedKeys,
  parseKeyId,
  removeTracks,
  seekNow,
  setTrackProps,
  useStore,
} from '../state/store';
import { CurveEditor, CurveThumb } from './CurveEditor';
import { Icon } from './Icon';
import { parseTime } from '../lib/time';

export function Inspector() {
  const selKeys = useStore((s) => s.selKeys);
  const selTracks = useStore((s) => s.selTracks);
  const tracks = useStore((s) => s.tracks);

  const first = useMemo(() => {
    let best: { track: number; t: number } | null = null;
    for (const id of selKeys) {
      const r = parseKeyId(id);
      if (!best || r.t < best.t) best = r;
    }
    return best;
  }, [selKeys]);

  if (first) return <KeyInspector first={first} count={selKeys.size} />;
  if (selTracks.size) {
    const tr = tracks.find((t) => selTracks.has(t.id));
    if (tr) return <TrackInspector id={tr.id} count={selTracks.size} />;
  }
  return <Tips />;
}

function KeyInspector({ first, count }: { first: { track: number; t: number }; count: number }) {
  const tracks = useStore((s) => s.tracks);
  const nodes = useStore((s) => s.nodes);
  const fps = useStore((s) => s.tl?.fps ?? 60);
  const track = tracks.find((t) => t.id === first.track);
  const key = track?.keys.find((k) => Math.abs(k[0] - first.t) < 1e-4);
  const curve = useMemo(() => fromFlat(key?.[1]), [key]);
  const preset = presetFor(curve);
  const [info, setInfo] = useState<KeyInfo | null>(null);
  const [timeText, setTimeText] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    setInfo(null);
    const h = window.setTimeout(() => {
      getKeyInfo(first)
        .then((i) => alive && setInfo(i))
        .catch(() => {});
    }, 60);
    return () => {
      alive = false;
      window.clearTimeout(h);
    };
  }, [first.track, first.t, key]);

  if (!track) return <Tips />;
  const obj = track.oci >= 0 ? nodes[track.oci] : undefined;
  const isLast = track.keys[track.keys.length - 1]?.[0] === key?.[0];

  return (
    <div className="panel-body">
      <div className="section">
        <h3>
          <Icon name="key" size={11} /> Keyframe{count > 1 ? `s (${count})` : ''}
        </h3>
        <div className="kv">
          <label>Track</label>
          <span className="value" title={track.name}>
            {displayName(track)}
          </span>
          <label>Object</label>
          <span className="value">{obj ? displayName(obj) : track.oci === -1 ? 'Scene (global)' : `#${track.oci}`}</span>
          <label>Time</label>
          <input
            className="input mono"
            value={timeText ?? `${first.t.toFixed(3)}s  f${Math.round(first.t * fps)}`}
            onFocus={(e) => {
              setTimeText(first.t.toFixed(3));
              requestAnimationFrame(() => e.target.select());
            }}
            onChange={(e) => setTimeText(e.target.value)}
            onBlur={() => {
              const t = timeText != null ? parseTime(timeText, fps) : null;
              setTimeText(null);
              if (t != null && Math.abs(t - first.t) > 1e-5) moveSelectedKeys(t - first.t);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
            title={count > 1 ? 'Moves all selected keys by the same offset' : 'Type seconds, 0:01.5 or f90'}
          />
          <label>Value</label>
          <div style={{ minWidth: 0 }}>
            {info ? <ValueView value={info.value} /> : <span className="value" style={{ color: 'var(--text-3)' }}>…</span>}
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10 }}>
          <button
            className="btn solid"
            style={{ flex: 1 }}
            title="Go to this key's time"
            onClick={() => seekNow(first.t)}
          >
            Go to key
          </button>
          <button
            className="btn solid"
            style={{ flex: 1 }}
            title="Replace this key's value with the pose currently shown in Studio"
            onClick={() => keyTracks([track.id], first.t)}
          >
            Update from pose
          </button>
          <button className="btn solid icon danger" title="Delete selected keys (Del)" onClick={deleteSelectedKeys}>
            <Icon name="trash" size={14} />
          </button>
        </div>
      </div>

      <div className="section">
        <h3>
          Easing to next key <span className="spacer" />
          <span style={{ textTransform: 'none', letterSpacing: 0, fontWeight: 600, color: preset ? 'var(--accent)' : 'var(--text-2)' }}>
            {preset ? preset.label : 'Custom'}
          </span>
        </h3>
        {isLast && count === 1 && <div className="hint" style={{ marginTop: 0, marginBottom: 8 }}>This is the last key on its track, so its easing has no effect yet.</div>}
        <CurveEditor curve={curve} onCommit={(c) => applyCurveToSelected(toFlat(c))} />
        <div className="preset-grid">
          {PRESETS.map((p) => (
            <button key={p.id} className={`preset ${preset?.id === p.id ? 'on' : ''}`} onClick={() => applyCurveToSelected(toFlat(p.curve))} title={p.hotkey ? `Hotkey: ${p.hotkey}` : undefined}>
              <CurveThumb curve={p.curve} />
              {p.label}
            </button>
          ))}
        </div>
        {count > 1 && <div className="hint">Changes apply to all {count} selected keys.</div>}
      </div>
    </div>
  );
}

function ValueView({ value }: { value: Record<string, string> }) {
  const entries = Object.entries(value).filter(([k]) => !k.startsWith('_'));
  if (!entries.length) return <span className="value">{value._text ?? '—'}</span>;
  const fmt = (s: string) => {
    const n = Number(s);
    return Number.isFinite(n) && s.trim() !== '' ? (Math.abs(n) >= 1000 ? n.toFixed(1) : n.toFixed(3)) : s;
  };
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr', gap: '1px 8px', fontFamily: 'var(--mono)', fontSize: 11 }}>
      {entries.slice(0, 16).map(([k, v]) => (
        <div key={k} style={{ display: 'contents' }}>
          <span style={{ color: 'var(--text-3)' }}>{k.replace(/^value/, '') || 'v'}</span>
          <span style={{ color: 'var(--text-1)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={v}>
            {fmt(v)}
          </span>
        </div>
      ))}
    </div>
  );
}

function TrackInspector({ id, count }: { id: number; count: number }) {
  const track = useStore((s) => s.tracks.find((t) => t.id === id));
  const nodes = useStore((s) => s.nodes);
  const [alias, setAlias] = useState<string | null>(null);
  if (!track) return <Tips />;
  const obj = track.oci >= 0 ? nodes[track.oci] : undefined;
  return (
    <div className="panel-body">
      <div className="section">
        <h3>Track{count > 1 ? `s (${count} selected)` : ''}</h3>
        <div className="kv">
          <label>Name</label>
          <input
            className="input"
            value={alias ?? (track.alias || displayName({ name: track.name, nameEn: track.nameEn }))}
            onChange={(e) => setAlias(e.target.value)}
            onBlur={() => {
              if (alias != null) setTrackProps(track.id, { alias: alias.trim() });
              setAlias(null);
            }}
            onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          />
          <label>Original</label>
          <span className="value" title={track.name}>
            {track.name}
          </span>
          <label>Object</label>
          <span className="value">{obj ? displayName(obj) : 'Scene (global)'}</span>
          <label>Source</label>
          <span className="value" title={`${track.owner} / ${track.model}`}>
            {track.owner} / {track.model}
          </span>
          <label>Keys</label>
          <span className="value">{track.keys.length}</span>
          <label>Enabled</label>
          <div>
            <button className={`btn solid ${track.enabled ? 'on' : ''}`} onClick={() => setTrackProps(track.id, { enabled: !track.enabled })}>
              <Icon name={track.enabled ? 'eye' : 'eyeOff'} size={14} />
              {track.enabled ? 'Playing' : 'Muted'}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          <button className="btn primary" style={{ flex: 1 }} onClick={() => keyTracks([...useStore.getState().selTracks])}>
            <Icon name="key" size={13} /> Key at playhead
          </button>
          <button className="btn solid danger" onClick={() => removeTracks([...useStore.getState().selTracks])}>
            <Icon name="trash" size={14} /> Delete
          </button>
        </div>
      </div>
      <Tips compact />
    </div>
  );
}

function Tips({ compact }: { compact?: boolean }) {
  return (
    <div className="panel-body">
      <div className="section">
        <div className="hint" style={{ marginTop: 0, fontSize: 12, lineHeight: 1.8 }}>
          {!compact && (
            <>
              1. Pick an object in <b>Scene</b>.<br />
              2. Click <b>+ Track</b> above the dope sheet and pick what to animate (it gets a key at the playhead).
              <br />
              3. Move the playhead, pose in Studio, press <span className="kbd">K</span>.<br />
              <br />
            </>
          )}
          <span className="kbd">Space</span> play · <span className="kbd">K</span> key selected tracks · <span className="kbd">Shift K</span> key whole object
          <br />
          Drag keys to retime · <span className="kbd">Alt</span> drag = no snapping
          <br />
          Double-click a row to insert a key · <span className="kbd">1</span>–<span className="kbd">5</span> easing presets
          <br />
          <span className="kbd">Ctrl</span>+wheel zoom · <span className="kbd">Shift</span>+wheel / middle-drag pan · <span className="kbd">?</span> all shortcuts
        </div>
      </div>
    </div>
  );
}
