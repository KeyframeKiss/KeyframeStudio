import { useEffect, useRef, useState } from 'react';
import { call, liveTime, toast, useStore, type Angle } from '../../state/store';
import { ContextMenu, type MenuItem } from '../ContextMenu';
import { ANGLE_DRAG, useCam } from '../CameraPanel';
import { Help } from '../Help';
import { Icon } from '../Icon';
import { addShotWithAngle, fromAngle } from './actions';

type State = { shots: unknown[]; liveCuts: boolean; angles: Angle[] };
const apply = (r: State | undefined) => r && useStore.setState({ angles: r.angles });

/**
 * Shoot › Shots: the angles — named camera setups to reuse across shots. Click one to put Studio's camera there,
 * drag it onto a shot to give the shot that camera, or onto the empty track for a new shot. Each new angle is
 * also kept in a free saved view of Studio's.
 */
export function AnglesBin() {
  const angles = useStore((s) => s.angles);
  const status = useStore((s) => s.status);
  const sel = useStore((s) => s.selShotId);
  const { st } = useCam();
  const [menu, setMenu] = useState<{ x: number; y: number; a: Angle } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const linked = new Set(angles.map((a) => a.slot).filter((x) => x != null));
  const importable = (st?.slots ?? []).filter((s) => s.used && !linked.has(s.index)).length;

  const add = async () => {
    const r = await call<State>('angles.add', {});
    apply(r);
    if (r) toast('Angle added. Drag it onto a shot');
  };
  const rename = async (a: Angle, name: string) => {
    setRenaming(null);
    if (!name.trim() || name.trim() === a.name) return;
    apply(await call<State>('angles.set', { angles: angles.map((x) => ({ id: x.id, name: x.id === a.id ? name.trim() : x.name })), label: 'Rename angle' }));
  };
  const remove = async (a: Angle) => {
    apply(await call<State>('angles.set', { angles: angles.filter((x) => x.id !== a.id).map((x) => ({ id: x.id })), label: 'Delete angle' }));
    toast(`Deleted “${a.name}”. Shots keep their camera`);
  };
  const items = (a: Angle): MenuItem[] => [
    { header: true, label: a.name },
    { label: 'Go to this angle', action: () => call('angles.view', { id: a.id }) },
    ...(sel ? [{ label: 'Use for the picked shot', action: () => fromAngle(sel, a.id) }] : []),
    { label: 'New shot at playhead with it', action: () => addShotWithAngle(liveTime(), a.id) },
    { sep: true },
    { label: 'Update from Studio’s view', action: () => call<State>('angles.update', { id: a.id }).then(apply) },
    { label: 'Rename', kbd: 'F2', action: () => setRenaming(a.id) },
    { sep: true },
    { label: 'Delete', danger: true, action: () => remove(a) },
  ];

  return (
    <section className="ang" aria-label="Angles">
      <header className="ang-head">
        <b>
          Angles
          <Help text="Camera setups to reuse. Frame Studio's view and press + to keep it as an angle. Click an angle to go there; drag it onto a shot to give the shot that camera, or onto the empty track for a new shot. New angles also fill a free saved view in Studio (its view keys keep working)." />
        </b>
        <span className="ang-gap" />
        <button className="btn small primary" disabled={status !== 'open'} onClick={add} title="Keep Studio's camera as it is now as a new angle">
          <Icon name="plus" size={12} /> From Studio’s view
        </button>
      </header>
      {angles.length > 0 ? (
        <div className="ang-grid">
          {angles.map((a) => (
            <div
              key={a.id}
              className="ang-card"
              draggable={renaming !== a.id}
              onDragStart={(e) => {
                e.dataTransfer.setData(ANGLE_DRAG, a.id);
                e.dataTransfer.effectAllowed = 'copy';
              }}
              onClick={() => call('angles.view', { id: a.id })}
              onDoubleClick={() => setRenaming(a.id)}
              onContextMenu={(e) => {
                e.preventDefault();
                setMenu({ x: e.clientX, y: e.clientY, a });
              }}
              onKeyDown={(e) => {
                if (e.key === 'F2') setRenaming(a.id);
                if (e.key === 'Enter') call('angles.view', { id: a.id });
              }}
              tabIndex={0}
              title={`${a.name}${a.slot != null ? ` · saved view ${a.slot + 1}` : ''}\nClick to go there · drag onto a shot · double-click to rename · right-click for more`}
            >
              <div className="ang-img">
                {a.thumb ? <img src={a.thumb} alt="" draggable={false} /> : <Icon name="camera" size={16} />}
                {a.slot != null && <i>{a.slot + 1}</i>}
              </div>
              {renaming === a.id ? <RenameBox value={a.name} onDone={(v) => rename(a, v)} /> : <span className="ang-name">{a.name}</span>}
            </div>
          ))}
        </div>
      ) : (
        <div className="ang-empty">Frame a view in Studio and press <b>+ From Studio’s view</b> to keep it as an angle.</div>
      )}
      {importable > 0 && (
        <button className="btn small solid ang-import" onClick={() => call<number>('angles.import', {}).then((n) => n && toast(`${n} saved view${n > 1 ? 's' : ''} added as angles`))}>
          Add Studio’s {importable} saved view{importable > 1 ? 's' : ''} as angles
        </button>
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={items(menu.a)} onClose={() => setMenu(null)} />}
    </section>
  );
}

function RenameBox({ value, onDone }: { value: string; onDone: (v: string) => void }) {
  const [v, setV] = useState(value);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      className="input ang-rename"
      value={v}
      aria-label="Angle name"
      onChange={(e) => setV(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onBlur={() => onDone(v)}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Enter') onDone(v);
        if (e.key === 'Escape') onDone(value);
      }}
    />
  );
}
