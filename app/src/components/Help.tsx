/**
 * A small "?" beside a heading: hover (or focus) it for the explanation, in the app's tooltip. Explanations live
 * here instead of as paragraphs, so the screen stays for the controls.
 */
export function Help({ text }: { text: string }) {
  return (
    <span className="help-q" tabIndex={0} title={text} aria-label={text} role="note" onClick={(e) => e.stopPropagation()}>
      ?
    </span>
  );
}
