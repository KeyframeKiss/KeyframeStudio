import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';

/**
 * Themed replacements for the browser's own pop-ups: ask() instead of window.confirm (a white system box that
 * ignores the app's look), and tooltips for every `title` attribute instead of the system tooltip.
 */

interface Ask {
  message: string;
  title?: string;
  ok: string;
  danger: boolean;
  resolve: (yes: boolean) => void;
}

let queue: Ask[] = [];
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

/** Words a question starts with that make a good OK button, and whether it destroys something. */
const VERBS: Record<string, boolean> = { Delete: true, Remove: true, Replace: false, Swap: false, Overwrite: false, 'Re-translate': false, Make: false };

/**
 * Yes/no question in the app's style. The OK button is named after the question's first word when it's an
 * action ("Delete …?" → Delete, shown as dangerous); otherwise OK.
 */
export function ask(message: string, opts: { title?: string; ok?: string; danger?: boolean } = {}): Promise<boolean> {
  const verb = Object.keys(VERBS).find((v) => message.startsWith(v + ' '));
  return new Promise((resolve) => {
    queue = [...queue, { message, title: opts.title, ok: opts.ok ?? verb ?? 'OK', danger: opts.danger ?? (verb ? VERBS[verb] : false), resolve }];
    emit();
  });
}

function useQueue() {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    () => queue,
  );
}

/** Mounted once (App): shows the oldest pending question. */
export function DialogHost() {
  const q = useQueue();
  const cur = q[0];
  const okRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    okRef.current?.focus();
  }, [cur]);
  if (!cur) return <TooltipHost />;
  const answer = (yes: boolean) => {
    queue = queue.slice(1);
    emit();
    cur.resolve(yes);
  };
  const [first, ...rest] = cur.message.split('\n\n');
  return (
    <>
      <TooltipHost />
      <div className="overlay" onMouseDown={() => answer(false)}>
        <div
          className="dialog ask"
          role="alertdialog"
          aria-modal="true"
          onMouseDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            if (e.key === 'Escape') answer(false);
            e.stopPropagation(); // keep Space/Delete/… from reaching the timeline behind
          }}
        >
          {cur.title && <h2>{cur.title}</h2>}
          <p className="ask-msg">{first}</p>
          {rest.map((p, i) => (
            <p key={i} className="hint">
              {p}
            </p>
          ))}
          <div className="ask-buttons">
            <button className="btn" onClick={() => answer(false)}>
              Cancel
            </button>
            <button ref={okRef} className={`btn ${cur.danger ? 'danger-solid' : 'primary'}`} onClick={() => answer(true)}>
              {cur.ok}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------------------------------------------------------
// Tooltips: the `title` of whatever is under the pointer, shown after a short pause, in the app's style. The
// attribute moves to data-tip while hovered so the system tooltip doesn't show as well.

function TooltipHost() {
  const [tip, setTip] = useState<{ text: string; rect: DOMRect } | null>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let timer = 0;
    let target: HTMLElement | null = null;
    const restore = () => {
      if (target && target.dataset.tip !== undefined && !target.hasAttribute('title')) target.setAttribute('title', target.dataset.tip);
      if (target) delete target.dataset.tip;
      target = null;
    };
    const hide = () => {
      window.clearTimeout(timer);
      restore();
      setTip(null);
    };
    const over = (e: PointerEvent) => {
      const el = (e.target as Element | null)?.closest?.('[title],[data-tip]') as HTMLElement | null;
      if (el === target) return;
      hide();
      if (!el) return;
      const text = el.getAttribute('title') ?? el.dataset.tip ?? '';
      if (!text.trim()) return;
      target = el;
      el.dataset.tip = text;
      el.removeAttribute('title');
      // a "?" is there to be read: show it almost at once
      timer = window.setTimeout(() => {
        if (target === el && el.isConnected) setTip({ text, rect: el.getBoundingClientRect() });
      }, el.classList.contains('help-q') ? 120 : 550);
    };
    const out = (e: PointerEvent) => {
      if (target && !target.contains(e.relatedTarget as Node | null)) hide();
    };
    const focus = (e: FocusEvent) => {
      const el = e.target as HTMLElement | null;
      if (!el?.classList?.contains('help-q')) return;
      const text = el.getAttribute('title') ?? el.dataset.tip ?? '';
      if (text) setTip({ text, rect: el.getBoundingClientRect() });
    };
    window.addEventListener('focusin', focus);
    window.addEventListener('focusout', hide);
    window.addEventListener('pointerover', over, true);
    window.addEventListener('pointerout', out, true);
    window.addEventListener('pointerdown', hide, true);
    window.addEventListener('wheel', hide, { capture: true, passive: true });
    window.addEventListener('keydown', hide, true);
    window.addEventListener('blur', hide);
    return () => {
      hide();
      window.removeEventListener('focusin', focus);
      window.removeEventListener('focusout', hide);
      window.removeEventListener('pointerover', over, true);
      window.removeEventListener('pointerout', out, true);
      window.removeEventListener('pointerdown', hide, true);
      window.removeEventListener('wheel', hide, true);
      window.removeEventListener('keydown', hide, true);
      window.removeEventListener('blur', hide);
    };
  }, []);

  // below the element, or above when there's no room; always inside the window
  useLayoutEffect(() => {
    if (!tip || !ref.current) return setPos(null);
    const w = ref.current.offsetWidth,
      h = ref.current.offsetHeight;
    const r = tip.rect;
    let top = r.bottom + 6;
    if (top + h > window.innerHeight - 6) top = r.top - h - 6;
    const left = Math.max(6, Math.min(window.innerWidth - w - 6, r.left + r.width / 2 - w / 2));
    setPos({ left, top: Math.max(6, top) });
  }, [tip]);

  if (!tip) return null;
  return (
    <div ref={ref} className="tooltip" role="tooltip" style={pos ?? { left: -9999, top: 0 }}>
      {tip.text}
    </div>
  );
}
