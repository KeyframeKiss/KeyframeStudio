import { useEffect, useState } from 'react';
import { Columns, Page, Panel, Section } from './Page';
import { ask } from './Dialogs';
import { bridge } from '../bridge/client';
import { ALL_PARTS, applyTemplate, gatherTemplate, TEMPLATE_PARTS, templateSummary, type TemplateData, type TemplatePart } from '../lib/templates';
import { call, refreshAudio, refreshShots, refreshTimeline, selectedCharacters, toast, useStore } from '../state/store';

interface Template {
  file: string;
  name: string;
  note: string;
  favorite?: boolean;
  lastUsed?: number;
  data: TemplateData;
}

const req = <T,>(cmd: string, args?: Record<string, unknown>) => bridge.request<T>(cmd, args);

/** Shoot › Templates: save this scene's staging, apply it to another scene. */
export function TemplatesPanel() {
  const status = useStore((s) => s.status);
  const [list, setList] = useState<Template[]>([]);
  const [name, setName] = useState('');
  const [open, setOpen] = useState<string | null>(null);
  const [parts, setParts] = useState<Set<TemplatePart>>(new Set(ALL_PARTS));

  useEffect(() => {
    if (status === 'open') call<Template[]>('store.list', { kind: 'templates' }).then((r) => r && setList(r));
  }, [status]);

  const save = async () => {
    const n = name.trim();
    if (!n) return toast('Name the template first');
    if (list.some((t) => t.name === n) && !(await ask(`Replace the template “${n}”?`))) return;
    const data = await gatherTemplate(req);
    const r = await call<Template[]>('store.save', { kind: 'templates', name: n, data });
    if (r) {
      setList(r);
      setName('');
      toast(`Saved template “${n}”: ${templateSummary(data) || 'empty scene settings'}`, 'done');
    }
  };

  const apply = async (t: Template) => {
    const { done, problems } = await applyTemplate(req, t.data, parts, selectedCharacters());
    await Promise.all([refreshTimeline(), refreshShots(), refreshAudio()]);
    window.dispatchEvent(new CustomEvent('studioex:look-changed'));
    call<Template[]>('store.update', { kind: 'templates', file: t.file, used: true }).then((r) => r && setList(r));
    toast(`“${t.name}”: ${done.length ? done.join(', ') : 'nothing applied'}${problems.length ? ` — ${problems.join('; ')}` : ''}`, problems.length ? 'info' : done.length ? 'done' : undefined);
  };

  return (
    <Page max={1000}>
      <Section
        title="Templates"
        help="A template is a scene's staging without its characters: timeline length, shots and cameras, look, lighting rigs, render settings and audio. Save one, then apply any part of it to another scene."
      >
        <Columns widths="minmax(0, 1fr) minmax(0, 1.3fr)">
          <Panel title="Save this scene">
            <div className="pn-note">Keeps the timeline length, shots and cameras, look, lighting rigs, render settings and audio — not the characters.</div>
            <div style={{ display: 'flex', gap: 6 }}>
              <input className="input" style={{ flex: 1, minWidth: 0 }} placeholder="Template name…" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && save()} />
              <button className="btn primary" disabled={!name.trim()} onClick={save}>
                Save
              </button>
            </div>
          </Panel>
          <Panel title="Saved templates" help="Click one to choose which parts to apply">
            {!list.length && <div className="pn-note">None yet — save this scene's staging on the left.</div>}
        <div className="clip-list">
          {list.map((t) => (
            <div key={t.file} className={`clip-item ${open === t.file ? 'open' : ''}`}>
              <div className="clip-row" role="button" tabIndex={0} onClick={() => setOpen(open === t.file ? null : t.file)} onKeyDown={(e) => e.key === 'Enter' && setOpen(open === t.file ? null : t.file)}>
                <span className="clip-text">
                  <b>{t.name}</b>
                  <small>{templateSummary(t.data) || 'empty'}</small>
                </span>
              </div>
              {open === t.file && (
                <div className="clip-apply">
                  {TEMPLATE_PARTS.filter((p) => t.data[p.id] !== undefined).map((p) => (
                    <label key={p.id} className="rigs-opt" style={{ margin: '0 0 4px' }}>
                      <input
                        type="checkbox"
                        checked={parts.has(p.id)}
                        onChange={(e) =>
                          setParts((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(p.id);
                            else n.delete(p.id);
                            return n;
                          })
                        }
                      />{' '}
                      {p.label}
                    </label>
                  ))}
                  <div style={{ display: 'flex', gap: 4, marginTop: 6 }}>
                    <button className="btn primary" style={{ flex: 1 }} onClick={() => apply(t)}>
                      Apply to this scene
                    </button>
                    <button className="btn" title="Delete this template" onClick={async () => (await ask(`Delete the template “${t.name}”?`)) && call<Template[]>('store.delete', { kind: 'templates', file: t.file }).then((r) => r && setList(r))}>
                      ✕
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
          </Panel>
        </Columns>
      </Section>
    </Page>
  );
}
