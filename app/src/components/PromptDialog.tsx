import { useState } from 'react';

/** A small text-input dialog (Electron doesn't support window.prompt). */
export interface PromptState {
  title: string;
  hint?: string;
  value: string;
  placeholder?: string;
  ok: (v: string) => void;
}

export function PromptDialog({ p, onClose }: { p: PromptState; onClose: () => void }) {
  const [v, setV] = useState(p.value);
  return (
    <div className="overlay" onClick={onClose}>
      <form
        className="dialog"
        style={{ width: 400 }}
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onClose();
          p.ok(v);
        }}
      >
        <h2>{p.title}</h2>
        {p.hint && <p className="hint">{p.hint}</p>}
        <input className="input" autoFocus value={v} placeholder={p.placeholder} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && onClose()} style={{ width: '100%', marginBottom: 12 }} />
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <button className="btn" type="button" onClick={onClose}>
            Cancel
          </button>
          <button className="btn primary" type="submit">
            OK
          </button>
        </div>
      </form>
    </div>
  );
}
