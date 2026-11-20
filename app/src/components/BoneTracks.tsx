import { useEffect, useMemo, useState } from 'react';
import { bridge } from '../bridge/client';
import { addBoneTrack, listBones, useStore, type BoneEntry } from '../state/store';
import { Icon } from './Icon';

// the order groups appear in, the way people think of a body
const ORDER = ['Head & neck', 'Body', 'Left arm', 'Right arm', 'Left fingers', 'Right fingers', 'Left leg', 'Right leg', 'IK targets', 'Chest', 'Hair', 'Skirt'];
const OPEN_BY_DEFAULT = new Set(['Head & neck', 'Body']);

interface Picked {
  kind: string;
  id: number;
  index: number;
  label: string;
}

/**
 * A character's own bones and IK targets, to animate one directly — the head's turn, a hand, a finger. Adding one
 * makes a "GO Rotation (bone)" track (Position for IK targets), keyed at the playhead, the same kind "Key changes"
 * creates. The joint picked in Studio's view is offered at the top.
 */
export function BoneTracks({ oci, query }: { oci: number; query: string }) {
  const status = useStore((s) => s.status);
  const trackCount = useStore((s) => s.tracks.length);
  const [bones, setBones] = useState<BoneEntry[]>([]);
  const [open, setOpen] = useState<Set<string>>(() => new Set(OPEN_BY_DEFAULT));
  const [picked, setPicked] = useState<Picked | null>(null);

  useEffect(() => {
    if (status !== 'open') return;
    let alive = true;
    listBones(oci).then((b) => alive && setBones(b));
    return () => {
      alive = false;
    };
  }, [oci, status, trackCount]);

  // the joint / IK target clicked in Studio's view
  useEffect(() => {
    if (status !== 'open') return;
    bridge
      .request<{ target: Picked | null }>('gizmo.get')
      .then((g) => setPicked(g?.target ?? null))
      .catch(() => {});
    return bridge.on('gizmo.target', (t) => setPicked((t as Picked) ?? null));
  }, [status]);

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const m = new Map<string, BoneEntry[]>();
    for (const b of bones) {
      if (q && !`${b.label} ${b.name} ${b.group}`.toLowerCase().includes(q)) continue;
      let l = m.get(b.group);
      if (!l) m.set(b.group, (l = []));
      l.push(b);
    }
    return [...m.entries()].sort((a, b) => (ORDER.indexOf(a[0]) + 99) % 99 - (ORDER.indexOf(b[0]) + 99) % 99);
  }, [bones, query]);

  if (!bones.length) return null;
  const searching = !!query.trim();
  const pickedBone = picked && picked.id === oci && (picked.kind === 'bone' || picked.kind === 'ik') ? bones.find((b) => b.kind === picked.kind && b.index === picked.index) : undefined;

  // also shows that joint in Studio's view (overlays on)
  const show = (b: BoneEntry) => bridge.request('gizmo.target', { kind: b.kind, id: oci, index: b.index }).catch(() => {});

  const row = (b: BoneEntry, highlight = false) => {
    const rot = b.kind === 'bone' || b.canRotate;
    return (
      <div key={`${b.kind}${b.index}`} className={`model-row bone-row ${highlight ? 'bone-picked' : ''}`} title={`${b.name}\nClick a button: add its track + key at the playhead`}>
        <span className="name" onClick={() => show(b)} style={{ cursor: 'pointer' }}>
          {b.label}
        </span>
        {b.animated.length > 0 && (
          <span className="sub">
            <Icon name="key" size={9} /> {b.animated.map((x) => (x === 'rot' ? 'rotation' : x === 'pos' ? 'position' : 'scale')).join(', ')}
          </span>
        )}
        <span className="bone-actions">
          {b.kind === 'ik' && (
            <button className="btn small solid" disabled={b.animated.includes('pos')} onClick={() => addBoneTrack(oci, b, 'pos')} title="Animate where it is">
              Position
            </button>
          )}
          {rot && (
            <button className="btn small solid" disabled={b.animated.includes('rot')} onClick={() => addBoneTrack(oci, b, 'rot')} title="Animate how it's turned">
              Rotation
            </button>
          )}
        </span>
      </div>
    );
  };

  return (
    <div className="model-group bone-tracks">
      <div className="model-group-title">Bones · {bones.length}</div>
      {pickedBone && !searching && (
        <>
          <div className="bone-picked-title">Picked in Studio’s view</div>
          {row(pickedBone, true)}
        </>
      )}
      {groups.map(([g, list]) => {
        const isOpen = searching || open.has(g);
        return (
          <div key={g} className="bone-group">
            <button
              className="bone-group-head"
              aria-expanded={isOpen}
              onClick={() =>
                setOpen((o) => {
                  const n = new Set(o);
                  if (n.has(g)) n.delete(g);
                  else n.add(g);
                  return n;
                })
              }
            >
              <Icon name={isOpen ? 'chevronDown' : 'chevronRight'} size={11} />
              {g}
              <span className="sub">{list.length}</span>
              {list.some((b) => b.animated.length) && <Icon name="key" size={9} />}
            </button>
            {isOpen && list.map((b) => row(b))}
          </div>
        );
      })}
    </div>
  );
}
