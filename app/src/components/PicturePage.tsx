import { useCallback, useEffect, useState } from 'react';
import { Help } from './Help';
import { Page } from './Page';
import { LookPanel, Switch } from './LookPanel';
import { EffectsPage } from './EffectsPage';
import { ScopesPanel } from './ScopesPanel';
import { bridge } from '../bridge/client';
import { call, displayName, showTab, toast, useStore } from '../state/store';

/**
 * Look › Picture: everything that shapes the final picture, as a short list (one line per effect: on or off and a
 * few words of what it's set to) and the picked effect's settings beside it. Where Studio and Keyframe Studio both
 * have an effect (depth of field, vignette, fog) it's one entry with both inside. Lights live under Lighting;
 * materials under Materials.
 */

type Named = { id: number; name: string; nameEn?: string | null };
interface LookState {
  effects: Record<string, unknown> & { lut: number; lut2: number; lutBlend: number };
  toon: { ramp: number };
  luts: Named[];
  ramps: Named[];
}
type FxVals = Record<string, number | boolean | number[]>;
interface FxState {
  effects: Record<string, FxVals>;
}

interface Item {
  id: string;
  title: string;
  group: 'Colour' | 'Lens' | 'Atmosphere' | 'Characters' | 'Mods';
  help: string;
  /** Studio's cards (LookPanel ids) and Keyframe Studio's (EffectsPage ids) shown in the editor */
  studio?: string[];
  ours?: string[];
  /** the one switch the list row can flip */
  toggle?: { studio: string } | { fx: string };
}

const ITEMS: Item[] = [
  { id: 'lut', title: 'Color grade', group: 'Colour', help: "Studio's LUT tints the whole picture (a second can blend in with KK_TwoLut); LUT files (.cube / PNG) from UserData/StudioEX/luts go on top.", studio: ['lut'], ours: ['lut'] },
  { id: 'grade', title: 'Colour correction', group: 'Colour', help: 'Exposure, white balance, contrast and saturation on the final picture, after the colour grade.', ours: ['grade'], toggle: { fx: 'grade' } },
  { id: 'bloom', title: 'Bloom', group: 'Colour', help: 'Bright areas glow.', studio: ['bloom'], toggle: { studio: 'bloom' } },
  { id: 'dof', title: 'Depth of field', group: 'Lens', help: "Blur away from the focus. Keyframe Studio's follows a character's eyes and looks the same in stills; Studio's own is simpler. Use one of them.", ours: ['dof'], studio: ['dof'] },
  { id: 'vignette', title: 'Vignette', group: 'Lens', help: "Darkened corners. Keyframe Studio's has strength, roundness and colour; Studio's is on or off.", ours: ['vignette'], studio: ['vignette'] },
  { id: 'aberration', title: 'Chromatic aberration', group: 'Lens', help: 'Coloured fringes towards the edges, like a real lens.', ours: ['aberration'], toggle: { fx: 'aberration' } },
  { id: 'distortion', title: 'Lens distortion', group: 'Lens', help: 'Barrel or pincushion, refitted to fill the frame.', ours: ['distortion'], toggle: { fx: 'distortion' } },
  { id: 'sharpen', title: 'Sharpen', group: 'Lens', help: 'Crisper detail without halos.', ours: ['sharpen'], toggle: { fx: 'sharpen' } },
  { id: 'grain', title: 'Film grain', group: 'Lens', help: 'Fine moving noise, like film. Hides banding in gradients.', ours: ['grain'], toggle: { fx: 'grain' } },
  { id: 'fog', title: 'Fog', group: 'Atmosphere', help: "Haze with distance. Keyframe Studio's two-tone fog fades from a near colour to a far one; Studio's own is one colour.", ours: ['fog'], studio: ['fog'] },
  { id: 'sun', title: 'Sun shafts', group: 'Atmosphere', help: 'Light rays from a sun caster set in Studio.', studio: ['sun'], toggle: { studio: 'sunShafts' } },
  { id: 'ssao', title: 'Ambient occlusion', group: 'Atmosphere', help: 'Soft shadows where things meet.', studio: ['ssao'], toggle: { studio: 'ssao' } },
  { id: 'toon', title: 'Toon shading', group: 'Characters', help: 'Shadow ramp, shadow colour and outlines for every character.', studio: ['toon'] },
  { id: 'xukmi', title: 'xukmi FX', group: 'Mods', help: "Effects placed as items by the xukmi FX mod. They stack with Keyframe Studio's effects of the same kind.", ours: ['xukmi'] },
];

const n2 = (v: unknown) => (typeof v === 'number' ? v.toFixed(2) : '');

export function PicturePage() {
  const status = useStore((s) => s.status);
  const revision = useStore((s) => s.revision);
  const [look, setLook] = useState<LookState | null>(null);
  const [fx, setFx] = useState<FxState | null>(null);
  const [xukmi, setXukmi] = useState<{ installed: boolean; items: { visible: boolean }[] } | null>(null);
  const [pick, setPickState] = useState(() => {
    try {
      return localStorage.getItem('kf.picture.pick') || 'lut';
    } catch {
      return 'lut';
    }
  });
  const [scopes, setScopesState] = useState(() => {
    try {
      return localStorage.getItem('kf.scopes.open') === '1';
    } catch {
      return false;
    }
  });
  const setScopes = (v: boolean) => {
    setScopesState(v);
    try {
      localStorage.setItem('kf.scopes.open', v ? '1' : '0');
    } catch {
      /* not remembered; fine */
    }
  };
  const setPick = (id: string) => {
    setPickState(id);
    try {
      localStorage.setItem('kf.picture.pick', id);
    } catch {
      /* not remembered; fine */
    }
  };

  const load = useCallback(() => {
    call<LookState>('look.get').then((l) => l && setLook(l));
    bridge
      .request<FxState>('fx.get')
      .then(setFx)
      .catch(() => setFx(null));
    call<{ installed: boolean; items: { visible: boolean }[] }>('fx.xukmi').then((x) => x && setXukmi(x));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, revision, load]);
  // edits in the cards: the list's summaries catch up a moment later (not on every frame of a drag)
  useEffect(() => {
    let t = 0;
    const h = () => {
      window.clearTimeout(t);
      t = window.setTimeout(load, 350);
    };
    window.addEventListener('kf:picture-edited', h);
    return () => {
      window.clearTimeout(t);
      window.removeEventListener('kf:picture-edited', h);
    };
  }, [load]);
  useEffect(() => {
    const h = () => load();
    for (const ev of ['studioex:look-changed', 'kf:history', 'kf:picture-changed', 'focus']) window.addEventListener(ev, h);
    const off = bridge.on('fx.changed', (d) => setFx(d as FxState));
    return () => {
      for (const ev of ['studioex:look-changed', 'kf:history', 'kf:picture-changed', 'focus']) window.removeEventListener(ev, h);
      off?.();
    };
  }, [load]);

  const e = look?.effects;
  const ours = (id: string) => fx?.effects[id];
  const name = (list: Named[] | undefined, id: number) => {
    const x = list?.find((n) => n.id === id);
    return x ? displayName({ name: x.name, nameEn: x.nameEn ?? undefined }) : '';
  };

  /** Is it doing anything, and what, in a few words. */
  const state = (it: Item): { on: boolean; text: string } => {
    const s = (k: string) => e?.[k] === true;
    const o = (k: string) => ours(k)?.on === true;
    switch (it.id) {
      case 'lut': {
        const files = o('lut') ? [ours('lut')?.a, ours('lut')?.b].filter((x) => typeof x === 'string' && x).map((x) => String(x).replace(/^.*\//, '').replace(/\.(cube|png)$/i, '')) : [];
        return { on: true, text: [name(look?.luts, e?.lut ?? -1), (e?.lutBlend ?? 0) > 0 ? `→ ${name(look?.luts, e?.lut2 ?? -1)} ${n2(e?.lutBlend)}` : '', files.length ? `+ ${files.join(', ')}` : ''].filter(Boolean).join(' ') };
      }
      case 'bloom':
        return { on: s('bloom'), text: s('bloom') ? `Intensity ${n2(e?.bloomIntensity)}` : 'Off' };
      case 'sun':
        return { on: s('sunShafts'), text: s('sunShafts') ? 'On' : 'Off' };
      case 'ssao':
        return { on: s('ssao'), text: s('ssao') ? `Radius ${n2(e?.ssaoRadius)}` : 'Off' };
      case 'toon':
        return { on: true, text: name(look?.ramps, look?.toon.ramp ?? -1) || 'Ramp' };
      case 'xukmi': {
        const n = xukmi?.items.filter((i) => i.visible).length ?? 0;
        return { on: n > 0, text: n ? `${n} showing` : 'None showing' };
      }
      case 'dof':
      case 'vignette':
      case 'fog': {
        const studioKey = it.id;
        const a = o(it.id);
        const b = s(studioKey);
        const what = it.id === 'dof' ? ['Fixed', 'view centre', 'eyes'][Math.round(Number(ours('dof')?.autoFocus ?? 0))] : it.id === 'vignette' ? `${n2(ours('vignette')?.intensity)}` : 'two-tone';
        return { on: a || b, text: a && b ? 'Both on: they stack' : a ? `Keyframe Studio, ${what}` : b ? 'Studio’s own' : 'Off' };
      }
      default: {
        const v = ours(it.id);
        if (!v?.on) return { on: false, text: 'Off' };
        const first = Object.entries(v).find(([k, x]) => k !== 'on' && typeof x === 'number');
        return { on: true, text: first ? `${first[0].charAt(0).toUpperCase()}${first[0].slice(1)} ${n2(first[1])}` : 'On' };
      }
    }
  };

  const flip = async (it: Item, v: boolean) => {
    if (!it.toggle) return;
    try {
      if ('studio' in it.toggle) {
        await bridge.request('look.set', { effects: { [it.toggle.studio]: v } });
        window.dispatchEvent(new Event('studioex:look-changed'));
      } else {
        await bridge.request('fx.set', { effect: it.toggle.fx, values: { on: v } });
        window.dispatchEvent(new Event('kf:picture-changed'));
      }
    } catch (err) {
      toast((err as Error).message, 'error');
    }
  };

  const items = ITEMS.filter((it) => it.id !== 'xukmi' || xukmi?.installed);
  const cur = items.find((it) => it.id === pick) ?? items[0];
  const groups = [...new Set(items.map((it) => it.group))];

  return (
    <Page max={1400}>
      <div className="look-page-bar">
        <span style={{ flex: 1 }} />
        <button className={`btn solid ${scopes ? 'on' : ''}`} aria-pressed={scopes} title="Histogram, waveform, RGB parade and vectorscope of Studio's view" onClick={() => setScopes(!scopes)}>
          Scopes
        </button>
        <Help text="Changes show in Studio right away, are undoable (Ctrl+Z) and are saved with the scene. Settings tagged Studio are Studio's own; Keyframe Studio's effects run after them, and ◆ beside a value adds a Timeline track for it." />
        <button
          className="btn solid"
          title="Studio's settings back to Studio's default look (undoable)"
          onClick={() => call('look.resetDefault').then((r) => r !== undefined && window.dispatchEvent(new Event('studioex:look-changed')))}
        >
          Reset Studio settings
        </button>
        <button
          className="btn solid"
          title="Switch off Studio's own bloom, ambient occlusion, depth of field, vignette, fog and sun shafts in one go (one undo step) — to build the look from Keyframe Studio's effects alone. The LUT and toon shading stay"
          onClick={() =>
            bridge
              .request('look.set', { effects: { bloom: false, ssao: false, dof: false, vignette: false, fog: false, sunShafts: false } })
              .then(() => window.dispatchEvent(new Event('studioex:look-changed')))
              .catch((err) => toast((err as Error).message, 'error'))
          }
        >
          Studio effects off
        </button>
        <button className="btn solid" title="Turn every Keyframe Studio effect off and back to its starting values" onClick={() => bridge.request('fx.reset').then(() => window.dispatchEvent(new Event('kf:history')))}>
          Reset effects
        </button>
        <button className="btn solid" title="Save these settings as a look you can apply to other scenes" onClick={() => showTab('look', 'presets')}>
          Save as a look…
        </button>
      </div>

      <div className="pic2">
        <nav className="pic-list" aria-label="Effects">
          {groups.map((g) => (
            <section key={g}>
              <h3 className="pic-list-group">{g}</h3>
              {items
                .filter((it) => it.group === g)
                .map((it) => {
                  const st = state(it);
                  return (
                    <div key={it.id} className={`pic-item ${cur?.id === it.id ? 'on' : ''} ${st.on ? 'active' : ''}`}>
                      <button className="pic-item-btn" aria-pressed={cur?.id === it.id} onClick={() => setPick(it.id)}>
                        <span className={`pic-dot ${st.on ? 'on' : ''}`} />
                        <span className="pic-item-name">{it.title}</span>
                        <small className="pic-item-sum">{st.text}</small>
                      </button>
                      {it.toggle && <Switch on={st.on} onChange={(v) => flip(it, v)} />}
                    </div>
                  );
                })}
            </section>
          ))}
        </nav>

        {cur && (
          <section className="pic-editor" aria-label={cur.title}>
            {scopes && <ScopesPanel />}
            <header className="pic-editor-head">
              <h2>{cur.title}</h2>
              <p>{cur.help}</p>
            </header>
            <div className="pic-editor-cards">
              {cur.ours && <EffectsPage key={`o${cur.id}`} only={cur.ours} />}
              {cur.studio && <LookPanel key={`s${cur.id}`} cards={cur.studio} />}
            </div>
          </section>
        )}
      </div>
    </Page>
  );
}
