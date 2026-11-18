/**
 * App log: lines go to the Studio EX log file (Electron main writes it) in small batches, and the last few
 * hundred stay in memory for "Copy diagnostics". Uncaught errors and console errors/warnings are captured.
 */
export type Level = 'error' | 'warn' | 'info';

const recent: string[] = [];
let queue: { level: Level; source: string; text: string }[] = [];
let timer = 0;

export function log(level: Level, text: string, source = 'app') {
  const line = `${new Date().toLocaleTimeString()} [${level}] ${source}: ${text}`;
  recent.push(line.length > 2000 ? line.slice(0, 2000) + '…' : line);
  if (recent.length > 400) recent.splice(0, recent.length - 400);
  queue.push({ level, source, text: text.length > 4000 ? text.slice(0, 4000) + '…' : text });
  if (!timer) timer = window.setTimeout(flush, 1000);
}

function flush() {
  timer = 0;
  const batch = queue;
  queue = [];
  if (batch.length) window.studioEx?.log?.write(batch).catch(() => {});
}

export const recentAppLog = () => recent.slice();

const describe = (v: unknown) => (v instanceof Error ? v.stack || v.message : typeof v === 'string' ? v : (() => { try { return JSON.stringify(v); } catch { return String(v); } })());

let installed = false;
export function installLogging() {
  if (installed) return;
  installed = true;
  window.addEventListener('error', (e) => log('error', `uncaught: ${describe(e.error ?? e.message)}`, 'renderer'));
  window.addEventListener('unhandledrejection', (e) => log('error', `unhandled rejection: ${describe(e.reason)}`, 'renderer'));
  for (const level of ['error', 'warn'] as const) {
    const orig = console[level].bind(console);
    console[level] = (...args: unknown[]) => {
      orig(...args);
      log(level, args.map(describe).join(' '), 'console');
    };
  }
  window.addEventListener('beforeunload', flush);
}
