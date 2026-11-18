// Minimal Chrome DevTools Protocol client: evaluate JavaScript in the Keyframe Studio window.
// The app must be started with KF_DEBUG_PORT=<port> (development only; see app/electron/main.cjs).
export async function connectRenderer(port) {
  const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
  const page = list.find((p) => p.type === 'page' && !/devtools/.test(p.url));
  if (!page) throw new Error('no app window found on the debugging port');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error('debugging connection failed'));
  });
  let id = 1;
  const pending = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  };
  const send = (method, params = {}) =>
    new Promise((res) => {
      const i = id++;
      pending.set(i, res);
      ws.send(JSON.stringify({ id: i, method, params }));
    });
  return {
    /** Evaluate an expression (may be async) and return its JSON value. */
    async eval(expr) {
      const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? 'renderer error');
      return r.result?.result?.value;
    },
    /** Any DevTools Protocol command, e.g. Page.captureScreenshot. */
    cmd: async (method, params) => (await send(method, params)).result,
    close: () => ws.close(),
  };
}

/** p50/p95/max of a list of numbers. */
export function stats(a) {
  if (!a?.length) return { n: 0, p50: 0, p95: 0, max: 0 };
  const s = [...a].sort((x, y) => x - y);
  const q = (p) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { n: s.length, p50: q(0.5), p95: q(0.95), max: s[s.length - 1] };
}
