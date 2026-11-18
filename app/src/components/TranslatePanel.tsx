import { useCallback, useEffect, useState } from 'react';
import { call, refreshScene, refreshTimeline, toast, useStore } from '../state/store';
import {
  cancelTranslation,
  ENGINE_LABEL,
  engineAvailable,
  listModels,
  loadSettings,
  saveSettings,
  translateEntries,
  translateMissing,
  type Engine,
  type Entry,
  type TranslateSettings,
} from '../lib/translate';

type Filter = 'all' | 'missing' | 'machine' | 'game' | 'mine';

const ENGINE_HELP: Record<Engine, string> = {
  google: 'Free, no setup. Good for sentences, weak on short names (えびぞり → “Shrimp sledding”).',
  deepl: 'Free API key: 500,000 characters a month (plenty). Better wording than Google.',
  llm: 'Free and offline with Ollama or LM Studio. Understands it is naming poses and items, so short names come out best.',
};

/**
 * Every Japanese string Keyframe Studio has shown, with its translation and where it came from.
 *  - Mine: your edits (zz_StudioEX_Overrides.txt) — always win.
 *  - Machine: Keyframe Studio engines (zy_StudioEX_Machine.txt).
 *  - Game: AutoTranslator's own cache / the repack's translation files.
 * All of them are pushed into AutoTranslator, so they fix the in-game UI too.
 */
export function TranslatePanel() {
  const query = useStore((s) => s.translateQuery);
  const revision = useStore((s) => s.revision);
  const status = useStore((s) => s.status);
  const job = useStore((s) => s.translateJob);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [filter, setFilter] = useState<Filter>('all');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [settings, setSettingsState] = useState<TranslateSettings>(loadSettings);
  const [models, setModels] = useState<string[] | null>(null);
  const [modelErr, setModelErr] = useState<string | null>(null);
  const canEngine = engineAvailable();

  const load = useCallback(() => {
    call<Entry[]>('translation.list').then((e) => e && setEntries(e));
  }, []);
  useEffect(() => {
    if (status === 'open') load();
  }, [status, revision, load]);
  useEffect(() => {
    if (!job) load();
  }, [job, load]);

  const update = (patch: Partial<TranslateSettings>) => {
    const next = { ...settings, ...patch };
    setSettingsState(next);
    saveSettings(next);
  };

  const fetchModels = useCallback(() => {
    setModelErr(null);
    listModels(loadSettings())
      .then((m) => {
        setModels(m);
        const cur = loadSettings();
        if (m.length && !m.includes(cur.llmModel)) {
          const next = { ...cur, llmModel: m[0] };
          setSettingsState(next);
          saveSettings(next);
        }
      })
      .catch((e: Error) => {
        setModels(null);
        setModelErr(e.message);
      });
  }, []);
  useEffect(() => {
    if (settings.engine === 'llm' && canEngine) fetchModels();
  }, [settings.engine, canEngine, fetchModels]);

  const q = query.trim().toLowerCase();
  const sourceOf = (e: Entry): Filter => (!e.translation ? 'missing' : e.source === 'mine' || e.override ? 'mine' : e.source === 'machine' ? 'machine' : 'game');
  const counts = { all: entries.length, missing: 0, machine: 0, game: 0, mine: 0 } as Record<Filter, number>;
  for (const e of entries) counts[sourceOf(e)]++;
  const list = entries
    .filter((e) => filter === 'all' || sourceOf(e) === filter)
    .filter((e) => !q || e.text.toLowerCase().includes(q) || (e.translation ?? '').toLowerCase().includes(q))
    .sort((a, b) => Number(!!a.translation) - Number(!!b.translation) || a.context.localeCompare(b.context));

  const run = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      toast((e as Error).message, 'error');
    }
    load();
  };

  const save = async (e: Entry, value: string) => {
    const ok = await call('translation.set', { text: e.text, value });
    if (ok === undefined) return;
    setDrafts((d) => {
      const n = { ...d };
      delete n[e.text];
      return n;
    });
    toast(value ? 'Saved as your translation — applied in-game too' : 'Your override removed');
    load();
    refreshScene();
    refreshTimeline();
  };

  const clearMachine = async (e: Entry) => {
    await call('translation.clearMachine', { texts: [e.text] });
    load();
    refreshScene();
  };

  // Rows an engine may (re)translate: never your own edits.
  const improvable = entries.filter((e) => sourceOf(e) !== 'mine');

  return (
    <>
      <div className="tr-engine">
        <div className="tr-row">
          <span className="tr-label">Engine</span>
          <div className="seg">
            {(Object.keys(ENGINE_LABEL) as Engine[]).map((k) => (
              <button key={k} className={settings.engine === k ? 'on' : ''} onClick={() => update({ engine: k })}>
                {k === 'google' ? 'Google (free)' : ENGINE_LABEL[k]}
              </button>
            ))}
          </div>
          <span className="spacer" style={{ flex: 1 }} />
          <label className="tr-auto" title="Translate new Japanese names automatically (every 15 s) with the selected engine">
            <button className={`switch ${settings.auto ? 'on' : ''}`} onClick={() => update({ auto: !settings.auto })}>
              <span />
            </button>
            Auto-translate new names
          </label>
        </div>
        <div className="tr-help">{ENGINE_HELP[settings.engine]}</div>

        {settings.engine === 'deepl' && (
          <div className="tr-row">
            <span className="tr-label">API key</span>
            <input
              className="input"
              type="password"
              style={{ flex: 1 }}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx:fx"
              value={settings.deeplKey}
              onChange={(e) => update({ deeplKey: e.target.value })}
            />
            <a className="btn" href="https://www.deepl.com/pro-api" target="_blank" rel="noreferrer" title="Sign up for DeepL API Free, then copy the key from your account page">
              Get a free key
            </a>
          </div>
        )}

        {settings.engine === 'llm' && (
          <>
            <div className="tr-row">
              <span className="tr-label">Server</span>
              <input
                className="input"
                style={{ flex: 1 }}
                placeholder="http://127.0.0.1:11434/v1"
                value={settings.llmUrl}
                onChange={(e) => update({ llmUrl: e.target.value })}
                onBlur={fetchModels}
              />
              <div className="seg">
                <button onClick={() => (update({ llmUrl: 'http://127.0.0.1:11434/v1' }), setTimeout(fetchModels))} title="Ollama's default address">
                  Ollama
                </button>
                <button onClick={() => (update({ llmUrl: 'http://127.0.0.1:1234/v1' }), setTimeout(fetchModels))} title="LM Studio's default address">
                  LM Studio
                </button>
              </div>
            </div>
            <div className="tr-row">
              <span className="tr-label">Model</span>
              {models && models.length ? (
                <select className="input" style={{ flex: 1 }} value={settings.llmModel} onChange={(e) => update({ llmModel: e.target.value })}>
                  {models.map((m) => (
                    <option key={m}>{m}</option>
                  ))}
                </select>
              ) : (
                <input className="input" style={{ flex: 1 }} placeholder="e.g. qwen2.5:7b" value={settings.llmModel} onChange={(e) => update({ llmModel: e.target.value })} />
              )}
              <button className="btn" onClick={fetchModels} title="Reload the model list from the server">
                ↻
              </button>
              <details className="tr-more">
                <summary className="btn">API key</summary>
                <input className="input" type="password" placeholder="Only for hosted services (OpenRouter, …)" value={settings.llmKey} onChange={(e) => update({ llmKey: e.target.value })} />
              </details>
            </div>
            {modelErr && (
              <div className="tr-help warn">
                {modelErr} Install <a href="https://ollama.com/download" target="_blank" rel="noreferrer">Ollama</a>, then run <code>ollama pull qwen2.5:7b</code> (≈4.7 GB; fits next to the game on an 8 GB card — use <code>qwen2.5:3b</code> if it stutters).
              </div>
            )}
          </>
        )}

        <div className="tr-row">
          {job ? (
            <>
              <div className="tr-progress">
                <span style={{ width: `${(100 * job.done) / Math.max(1, job.total)}%` }} />
              </div>
              <span className="tr-help" style={{ margin: 0 }}>
                {job.engine}: {job.done} / {job.total}
              </span>
              <button className="btn" onClick={cancelTranslation}>
                Stop
              </button>
            </>
          ) : (
            <>
              <button
                className="btn primary"
                disabled={!canEngine || !counts.missing}
                title={canEngine ? 'Translate everything that has no translation yet' : 'Only available in the Keyframe Studio window'}
                onClick={() => run(() => translateMissing(settings.engine))}
              >
                Translate missing ({counts.missing})
              </button>
              <button
                className="btn"
                disabled={!canEngine || !improvable.length}
                title={`Re-translate every Game and Machine row with ${ENGINE_LABEL[settings.engine]}. Your own edits are never touched.`}
                onClick={() => {
                  if (!window.confirm(`Re-translate ${improvable.length} names with ${ENGINE_LABEL[settings.engine]}? Your own edits stay as they are.`)) return;
                  run(() => translateEntries(improvable, settings.engine));
                }}
              >
                Improve all with {ENGINE_LABEL[settings.engine]}
              </button>
            </>
          )}
        </div>
      </div>

      <div className="tr-filters">
        <input className="input search" style={{ flex: 1 }} placeholder="Search Japanese or English…" value={query} onChange={(e) => useStore.setState({ translateQuery: e.target.value })} />
        <div className="seg">
          {(['all', 'missing', 'machine', 'game', 'mine'] as Filter[]).map((f) => (
            <button key={f} className={filter === f ? 'on' : ''} onClick={() => setFilter(f)}>
              {f[0].toUpperCase() + f.slice(1)} {counts[f]}
            </button>
          ))}
        </div>
      </div>

      <div className="panel-body tr-list">
        {list.map((e) => {
          const draft = drafts[e.text];
          const value = draft ?? e.translation ?? '';
          const src = sourceOf(e);
          return (
            <div key={e.text} className="tr-item">
              <div className="tr-ja">
                <span className="tr-text">{e.text}</span>
                <span className="tr-ctx">{e.context && e.context !== 'override' ? e.context : ''}</span>
              </div>
              <input
                className={`input ${draft !== undefined ? 'dirty' : ''}`}
                placeholder="(untranslated)"
                value={value}
                onChange={(ev) => setDrafts((d) => ({ ...d, [e.text]: ev.target.value }))}
                onKeyDown={(ev) => {
                  if (ev.key === 'Enter') save(e, value.trim());
                  if (ev.key === 'Escape')
                    setDrafts((d) => {
                      const n = { ...d };
                      delete n[e.text];
                      return n;
                    });
                }}
              />
              <span className={`tr-badge ${src}`} title={src === 'machine' && e.engine ? `Machine translation (${ENGINE_LABEL[e.engine as Engine] ?? e.engine})` : undefined}>
                {src === 'machine' ? ENGINE_LABEL[e.engine as Engine] ?? 'Machine' : src === 'mine' ? 'Yours' : src === 'game' ? 'Game' : 'Missing'}
              </span>
              <span className="tr-actions">
                {draft !== undefined ? (
                  <button className="btn primary" onClick={() => save(e, value.trim())} title="Save as your translation (Enter)">
                    Save
                  </button>
                ) : (
                  <>
                    {src !== 'mine' && canEngine && (
                      <button className="btn icon" disabled={!!job} title={`Translate this with ${ENGINE_LABEL[settings.engine]}`} onClick={() => run(() => translateEntries([e], settings.engine))}>
                        ↻
                      </button>
                    )}
                    {src === 'machine' && (
                      <button className="btn icon" title="Accept: keep this as your translation" onClick={() => save(e, value.trim())}>
                        ✓
                      </button>
                    )}
                    {src === 'mine' && (
                      <button className="btn icon" title="Remove your override" onClick={() => save(e, '')}>
                        ✕
                      </button>
                    )}
                    {src === 'machine' && (
                      <button className="btn icon" title="Discard this machine translation" onClick={() => clearMachine(e)}>
                        ✕
                      </button>
                    )}
                  </>
                )}
              </span>
            </div>
          );
        })}
        {!list.length && (
          <div className="empty">
            <strong>{entries.length ? 'Nothing matches' : 'Nothing collected yet'}</strong>
            Japanese names shown anywhere in Keyframe Studio appear here so you can translate or correct them.
          </div>
        )}
      </div>
    </>
  );
}
