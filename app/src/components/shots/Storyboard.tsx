import { useState } from 'react';
import { saveShots, toast, useStore, type Shot } from '../../state/store';
import { byStart, reorder } from '../../lib/shots';
import { ContextMenu } from '../ContextMenu';
import { ANGLE_DRAG } from '../CameraPanel';
import { camLabel, effMode, fromAngle, lookThrough, selectShot, shotMenu, STATUSES, TRANSITIONS } from './actions';

const SHOT_DRAG = 'application/x-kf-shot';

/** Shoot › Shots, storyboard view: big pictures with notes, in order; drag a card to reorder the shots. */
export function Storyboard() {
  const shots = useStore((s) => s.shots);
  const sel = useStore((s) => s.selShotId);
  const duration = useStore((s) => s.tl?.duration ?? 10);
  const sorted = byStart(shots);
  const [over, setOver] = useState<{ id: string; after: boolean; view: boolean } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; id: string } | null>(null);

  const drop = async (e: React.DragEvent, target: Shot) => {
    e.preventDefault();
    const where = over;
    setOver(null);
    const angle = e.dataTransfer.getData(ANGLE_DRAG);
    if (angle) return fromAngle(target.id, angle);
    const id = e.dataTransfer.getData(SHOT_DRAG);
    if (!id || id === target.id) return;
    const order = sorted.map((s) => s.id).filter((x) => x !== id);
    const at = order.indexOf(target.id) + (where?.after ? 1 : 0);
    order.splice(at, 0, id);
    if (order.join() === sorted.map((s) => s.id).join()) return;
    const start = sorted[0]?.start ?? 0;
    if (await saveShots(reorder(shots, order, duration), 'Reorder shots'))
      toast(`Shots reordered, back to back from ${start.toFixed(2)} s. The animation didn't move`);
  };

  if (!sorted.length) return <div className="sq-board-empty">No shots yet. Add one with + Shot at playhead, then they show here as a storyboard.</div>;

  return (
    <div className="sq-board">
      {sorted.map((s, i) => {
        const st = STATUSES.find((x) => x.id === (s.status ?? 'idea'))!;
        const o = over?.id === s.id ? over : null;
        return (
          <div
            key={s.id}
            className={`sq-card ${sel === s.id ? 'sel' : ''} ${o ? (o.view ? 'drop-view' : o.after ? 'drop-after' : 'drop-before') : ''}`}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(SHOT_DRAG, s.id);
              e.dataTransfer.effectAllowed = 'move';
              selectShot(s.id);
            }}
            onDragOver={(e) => {
              const view = e.dataTransfer.types.includes(ANGLE_DRAG);
              if (!view && !e.dataTransfer.types.includes(SHOT_DRAG)) return;
              e.preventDefault();
              const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
              const after = e.clientX > r.left + r.width / 2;
              if (!o || o.after !== after || o.view !== view) setOver({ id: s.id, after, view });
            }}
            onDragLeave={(e) => {
              if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setOver((x) => (x?.id === s.id ? null : x));
            }}
            onDragEnd={() => setOver(null)}
            onDrop={(e) => drop(e, s)}
            onClick={() => selectShot(s.id)}
            onDoubleClick={() => lookThrough(s.id)}
            onContextMenu={(e) => {
              e.preventDefault();
              selectShot(s.id);
              setMenu({ x: e.clientX, y: e.clientY, id: s.id });
            }}
            title="Click to pick · double-click to look through · drag to reorder · right-click for more"
          >
            <div className="sq-card-img">
              {s.thumb && effMode(s) === 'still' ? <img src={s.thumb} alt="" draggable={false} /> : <span>{camLabel(s) || 'No camera yet'}</span>}
              <i>{i + 1}</i>
              <em className={`sq-chip st-${st.id}`}>{st.label}</em>
            </div>
            <div className="sq-card-text">
              <b>{s.name}</b>
              <small>
                {s.start.toFixed(2)}–{s.end.toFixed(2)} s · {(s.end - s.start).toFixed(2)} s{camLabel(s) && effMode(s) === 'still' ? ` · ${camLabel(s)}` : ''}
              </small>
              {s.trans && s.trans.type !== 'cut' && (
                <small className="sq-card-trans">
                  {TRANSITIONS.find((x) => x.id === s.trans!.type)?.glyph} {TRANSITIONS.find((x) => x.id === s.trans!.type)?.label} in · {s.trans.dur.toFixed(2)} s
                </small>
              )}
              {s.notes && <p>{s.notes}</p>}
            </div>
          </div>
        );
      })}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={shotMenu(menu.id)} onClose={() => setMenu(null)} />}
    </div>
  );
}

/** One picture of the whole storyboard (PNG data URL): numbered frames with names, times, status and notes. */
export async function storyboardImage(shots: Shot[], title: string): Promise<string> {
  const sorted = byStart(shots);
  const cols = sorted.length <= 4 ? 2 : 3;
  const cw = 400;
  const ih = 225;
  const th = 118;
  const gap = 28;
  const pad = 40;
  const head = 92;
  const rows = Math.ceil(sorted.length / cols);
  const W = pad * 2 + cols * cw + (cols - 1) * gap;
  const H = pad + head + rows * (ih + th) + (rows - 1) * gap + pad;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;
  const ink = '#1d1f24';
  const soft = '#6b707c';
  g.fillStyle = '#fbfaf8';
  g.fillRect(0, 0, W, H);
  g.fillStyle = ink;
  g.font = '600 30px "Segoe UI", system-ui, sans-serif';
  g.textBaseline = 'top';
  g.fillText(title, pad, pad);
  const total = sorted.reduce((n, s) => n + (s.end - s.start), 0);
  g.font = '15px "Segoe UI", system-ui, sans-serif';
  g.fillStyle = soft;
  g.fillText(`${sorted.length} shot${sorted.length === 1 ? '' : 's'} · ${total.toFixed(1)} s · ${new Date().toLocaleDateString()}`, pad, pad + 42);

  const load = (src?: string) =>
    new Promise<HTMLImageElement | null>((res) => {
      if (!src) return res(null);
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => res(null);
      im.src = src;
    });
  const colors: Record<string, string> = { idea: '#8a8f9c', blocked: '#3d8bf0', framed: '#7a63f0', final: '#2fa86a' };
  const wrap = (text: string, maxW: number, lines: number) => {
    const words = text.replace(/\s+/g, ' ').trim().split(' ');
    const out: string[] = [];
    let line = '';
    for (const w of words) {
      const t = line ? `${line} ${w}` : w;
      if (g.measureText(t).width > maxW && line) {
        out.push(line);
        line = w;
        if (out.length === lines) break;
      } else line = t;
    }
    if (out.length < lines && line) out.push(line);
    if (out.length === lines && words.join(' ').length > out.join(' ').length) out[lines - 1] = out[lines - 1].replace(/\s*\S*$/, '') + '…';
    return out;
  };

  for (let i = 0; i < sorted.length; i++) {
    const s = sorted[i];
    const x = pad + (i % cols) * (cw + gap);
    const y = pad + head + Math.floor(i / cols) * (ih + th + gap);
    const im = await load(s.thumb);
    g.fillStyle = '#e4e2de';
    g.fillRect(x, y, cw, ih);
    if (im) {
      // cover the 16:9 frame
      const k = Math.max(cw / im.width, ih / im.height);
      const w = im.width * k;
      const h = im.height * k;
      g.save();
      g.beginPath();
      g.rect(x, y, cw, ih);
      g.clip();
      g.drawImage(im, x + (cw - w) / 2, y + (ih - h) / 2, w, h);
      g.restore();
    } else {
      g.fillStyle = soft;
      g.font = '15px "Segoe UI", system-ui, sans-serif';
      g.fillText(s.camMode === 'keys' ? 'Camera keys' : 'No camera', x + 16, y + ih / 2 - 8);
    }
    g.strokeStyle = '#cfccc6';
    g.lineWidth = 1;
    g.strokeRect(x + 0.5, y + 0.5, cw - 1, ih - 1);
    // number
    g.fillStyle = 'rgba(20,20,24,0.78)';
    g.fillRect(x, y, 44, 30);
    g.fillStyle = '#fff';
    g.font = '600 17px "Segoe UI", system-ui, sans-serif';
    g.fillText(String(i + 1), x + 14, y + 6);
    // text
    const ty = y + ih + 12;
    g.fillStyle = ink;
    g.font = '600 18px "Segoe UI", system-ui, sans-serif';
    g.fillText(wrap(s.name, cw - 110, 1)[0] ?? '', x, ty);
    const status = s.status ?? 'idea';
    g.font = '600 12px "Segoe UI", system-ui, sans-serif';
    const label = STATUSES.find((v) => v.id === status)?.label ?? status;
    const lw = g.measureText(label).width + 16;
    g.fillStyle = colors[status] ?? soft;
    g.beginPath();
    g.roundRect(x + cw - lw, ty, lw, 20, 10);
    g.fill();
    g.fillStyle = '#fff';
    g.fillText(label, x + cw - lw + 8, ty + 3);
    g.fillStyle = soft;
    g.font = '14px "Segoe UI", system-ui, sans-serif';
    g.fillText(`${s.start.toFixed(2)}–${s.end.toFixed(2)} s · ${(s.end - s.start).toFixed(2)} s`, x, ty + 26);
    if (s.notes) {
      g.fillStyle = ink;
      g.font = '14px "Segoe UI", system-ui, sans-serif';
      wrap(s.notes, cw, 3).forEach((l, k) => g.fillText(l, x, ty + 50 + k * 19));
    }
  }
  return c.toDataURL('image/png');
}
