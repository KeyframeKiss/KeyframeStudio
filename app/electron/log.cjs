// Studio EX log file: what the app did and what went wrong, for bug reports.
// <userData>/logs/studioex.log, rolled over to studioex.1.log at 1 MB. Written by the main process; the
// renderer sends its lines over IPC in small batches.
const { app, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const MAX_BYTES = 1024 * 1024;
let dir = null;
let file = null;

function ensure() {
  if (file) return file;
  dir = path.join(app.getPath('userData'), 'logs');
  fs.mkdirSync(dir, { recursive: true });
  file = path.join(dir, 'studioex.log');
  return file;
}

function rollover() {
  try {
    if (fs.statSync(file).size < MAX_BYTES) return;
    fs.renameSync(file, path.join(dir, 'studioex.1.log')); // replaces the previous one
  } catch {
    /* no file yet */
  }
}

function stamp() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

/** lines: [{level, source, text}] */
function write(lines) {
  try {
    ensure();
    rollover();
    const out = lines.map((l) => `${stamp()} [${String(l.level || 'info').padEnd(5)}] ${l.source || 'app'}: ${String(l.text).replace(/\r?\n/g, '\n    ')}`).join('\n');
    fs.appendFileSync(file, out + '\n', 'utf8');
  } catch (e) {
    console.error('[log] write failed', e);
  }
}

function log(level, text, source = 'main') {
  write([{ level, source, text }]);
}

/** Last n lines of the current log (and the previous file if the current one is short). */
function tail(n = 300) {
  ensure();
  const read = (f) => {
    try {
      return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean);
    } catch {
      return [];
    }
  };
  let lines = read(file);
  if (lines.length < n) lines = read(path.join(dir, 'studioex.1.log')).concat(lines);
  return lines.slice(-n);
}

function register(ipcMain) {
  ensure();
  log('info', `Studio EX ${app.getVersion()} started (Electron ${process.versions.electron}, ${os.type()} ${os.release()} ${process.arch})`);
  ipcMain.handle('log:write', (_e, lines) => write(Array.isArray(lines) ? lines.slice(0, 500) : []));
  ipcMain.handle('log:tail', (_e, n) => tail(Math.max(1, Math.min(2000, Number(n) || 300))));
  ipcMain.handle('log:openFolder', () => shell.openPath(ensure() && dir));
  ipcMain.handle('app:info', () => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    os: `${os.type()} ${os.release()} ${process.arch}`,
    logFile: ensure(),
    home: os.homedir(),
  }));
  process.on('uncaughtException', (e) => log('error', `uncaught: ${e && e.stack ? e.stack : e}`));
  process.on('unhandledRejection', (e) => log('error', `unhandled rejection: ${e && e.stack ? e.stack : e}`));
  app.on('render-process-gone', (_e, _wc, d) => log('error', `renderer gone: ${d.reason} (exit ${d.exitCode})`));
  app.on('child-process-gone', (_e, d) => log('error', `child process gone: ${d.type} ${d.reason}`));
}

module.exports = { register, log };
