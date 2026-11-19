import type { CSSProperties, ReactNode } from 'react';
import { Help } from './Help';

// One page structure for every tab: sections with one header style, fixed columns by task (they collapse to one
// column when the centre is narrow), and panels — never an auto-filling grid that leaves ragged gaps.

/** A scrolling page, centred, at most `max` wide. */
export function Page({ max = 1240, children }: { max?: number; children: ReactNode }) {
  return (
    <div className="pg">
      <div className="pg-inner" style={{ maxWidth: max }}>
        {children}
      </div>
    </div>
  );
}

/** A titled group of things on a page. `actions` sit at the right end of the header. */
export function Section({ title, help, actions, children }: { title: ReactNode; help?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="pg-section">
      <header className="pg-head">
        <h2>
          {title}
          {help && <Help text={help} />}
        </h2>
        {actions && <div className="pg-actions">{actions}</div>}
      </header>
      {children}
    </section>
  );
}

/**
 * Side-by-side columns, each a <Col>. `widths` is a grid template (default: equal). Below `stackAt` pixels of
 * centre width they stack into one column.
 */
export function Columns({ widths, stackAt = 'normal', children }: { widths?: string; stackAt?: 'normal' | 'wide'; children: ReactNode }) {
  const n = Array.isArray(children) ? children.filter(Boolean).length : 1;
  return (
    <div className={`pg-cols ${stackAt === 'wide' ? 'stack-wide' : ''}`} style={{ '--pg-cols': widths ?? `repeat(${n}, minmax(0, 1fr))` } as CSSProperties}>
      {children}
    </div>
  );
}

/** One column: an optional small label, then its panels stacked. */
export function Col({ label, help, children }: { label?: string; help?: string; children: ReactNode }) {
  return (
    <div className="pg-col">
      {label && (
        <div className="pg-col-label">
          {label}
          {help && <Help text={help} />}
        </div>
      )}
      {children}
    </div>
  );
}

/** A card. `on` (with onToggle) dims the body when off; `actions` sit in the header. */
export function Panel({ title, help, actions, children, dim, className = '' }: { title?: ReactNode; help?: string; actions?: ReactNode; children?: ReactNode; dim?: boolean; className?: string }) {
  return (
    <div className={`pn ${dim ? 'dim' : ''} ${className}`}>
      {(title || actions) && (
        <div className="pn-head">
          {title && (
            <b>
              {title}
              {help && <Help text={help} />}
            </b>
          )}
          {actions && <div className="pn-actions">{actions}</div>}
        </div>
      )}
      {children !== undefined && <div className="pn-body">{children}</div>}
    </div>
  );
}

/** A label + control row inside a panel (label column is the same width everywhere). */
export function Field({ label, help, children, wide }: { label: ReactNode; help?: string; children: ReactNode; wide?: boolean }) {
  return (
    <div className={`pn-field ${wide ? 'wide' : ''}`}>
      <label>
        {label}
        {help && <Help text={help} />}
      </label>
      <div className="pn-control">{children}</div>
    </div>
  );
}
