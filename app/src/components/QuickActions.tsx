import { useState } from 'react';
import { ask } from './Dialogs';
import { bridge } from '../bridge/client';
import { deleteMacro, describeStep, isRecording, retarget, saveMacro, startRecording, stopRecording, updateMacro, useMacros, useRecording, type Macro } from '../lib/macros';
import { refreshTimeline, toast, useStore } from '../state/store';
import { PromptDialog, type PromptState } from './PromptDialog';

/** Replay a quick action, step by step; stops at the first step Studio refuses. */
export async function runMacro(m: Macro) {
  const sel = useStore.getState().studioSelection;
  if (m.useSelection && !sel.length && m.steps.some((s) => 'id' in s.args || 'ids' in s.args)) return toast(`Select what “${m.name}” should work on first`);
  let n = 0;
  for (const step of m.steps) {
    try {
      await bridge.request(step.cmd, m.useSelection ? retarget(step.args, sel) : step.args);
      n++;
    } catch (e) {
      toast(`“${m.name}” stopped at step ${n + 1} (${step.cmd}): ${(e as Error).message}`, 'error');
      break;
    }
  }
  await refreshTimeline();
  useStore.setState((s) => ({ revision: s.revision + 1 }));
  if (n === m.steps.length) toast(`Ran “${m.name}” (${n} step${n > 1 ? 's' : ''}) — Ctrl+Z undoes it step by step`);
}

/** Start recording, or stop and ask for a name to save it under. */
export function toggleRecording(setPrompt: (p: PromptState | null) => void) {
  if (!isRecording()) {
    startRecording();
    toast('Recording a quick action — do the steps, then stop recording (status bar or Ctrl+K)');
    return;
  }
  const rec = stopRecording();
  if (!rec) return toast('Nothing was recorded');
  setPrompt({
    title: 'Name this quick action',
    hint: `${rec.length} step${rec.length > 1 ? 's' : ''}: ${rec.slice(0, 3).map(describeStep).join(' · ')}${rec.length > 3 ? ' …' : ''}`,
    value: '',
    placeholder: 'e.g. Big smile + blush',
    ok: (v) => {
      saveMacro(v.trim() || 'Quick action', rec);
      toast(`Saved “${v.trim() || 'Quick action'}” — run it from Ctrl+K or Library › Quick actions`);
    },
  });
}

/** Status-bar indicator while recording, with Stop. */
export function RecordingBadge() {
  const rec = useRecording();
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  if (!rec.on && !prompt) return null;
  return (
    <>
      {rec.on && (
        <span className="macro-rec">
          ● Recording quick action · {rec.steps} step{rec.steps === 1 ? '' : 's'}
          <button className="btn small" onClick={() => toggleRecording(setPrompt)}>
            Stop
          </button>
        </span>
      )}
      {prompt && <PromptDialog p={prompt} onClose={() => setPrompt(null)} />}
    </>
  );
}

/** Library › Quick actions */
export function QuickActionsPage() {
  const list = useMacros();
  const rec = useRecording();
  const [prompt, setPrompt] = useState<PromptState | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="page">
      <div className="page-inner narrow" style={{ padding: 20, overflow: 'auto' }}>
        <h2 className="page-title">Quick actions</h2>
        <div className="hint" style={{ marginTop: 0 }}>
          Record a sequence of changes made in Keyframe Studio (expression, outfit, look, keys…) and replay it with one click or from Ctrl+K. With “Use the selection”, it works on whatever is selected when you run it.
        </div>
        <button
          className={`btn ${rec.on ? 'solid on' : 'primary'}`}
          style={{ margin: '10px 0' }}
          onClick={() => toggleRecording(setPrompt)}
        >
          {rec.on ? `Stop recording (${rec.steps} steps)` : '● Record a quick action'}
        </button>
        {!list.length && <div className="empty">No quick actions yet.</div>}
        <div className="macro-list">
          {list.map((m) => (
            <div key={m.name} className="macro-item">
              <div className="macro-head">
                <b>{m.name}</b>
                <small>
                  {m.steps.length} step{m.steps.length > 1 ? 's' : ''}
                </small>
                <span style={{ flex: 1 }} />
                <label title="Replace the objects it was recorded with by the current selection">
                  <input type="checkbox" checked={m.useSelection} onChange={(e) => updateMacro(m.name, { useSelection: e.target.checked })} /> Use the selection
                </label>
                <button className="btn small primary" onClick={() => runMacro(m)}>
                  Run
                </button>
                <button className="btn small" onClick={() => setOpen(open === m.name ? null : m.name)}>
                  {open === m.name ? 'Hide' : 'Steps'}
                </button>
                <button className="btn small" onClick={async () => (await ask(`Delete “${m.name}”?`)) && deleteMacro(m.name)}>
                  ✕
                </button>
              </div>
              {open === m.name && (
                <ol className="macro-steps">
                  {m.steps.map((s, i) => (
                    <li key={i}>{describeStep(s)}</li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
      </div>
      {prompt && <PromptDialog p={prompt} onClose={() => setPrompt(null)} />}
    </div>
  );
}
