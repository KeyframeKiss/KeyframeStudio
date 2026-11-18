// Electron shell for Keyframe Studio. The UI is a plain web app; this just gives it its own window.
const { app, BrowserWindow, ipcMain, shell, protocol, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

// The app is called Keyframe Studio (it was Studio EX). Keep the data folder it has always used
// (%APPDATA%\studio-ex: window position, settings, logs) so nothing is lost by the rename.
app.setPath('userData', path.join(app.getPath('appData'), 'studio-ex'));
app.setName('Keyframe Studio');
if (process.platform === 'win32') app.setAppUserModelId('KeyframeStudio');
const APP_ICON = path.join(__dirname, '..', 'build', 'icon.ico');

// sximg://thumb/?p=<absolute path> → downscaled JPEG thumbnail of a Studio scene/pose PNG.
// Restricted to .png files inside a UserData\studio folder so the renderer can't read arbitrary files.
// Keyframe Studio is a companion window: it must keep painting and updating while CharaStudio has focus or
// covers it. Chromium's occlusion detection otherwise stops painting it (blank window, frozen playhead).
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-renderer-backgrounding');
app.commandLine.appendSwitch('disable-background-timer-throttling');
// Development/tests: KF_DEBUG_PORT=9333 opens Chromium's remote debugging on localhost (the stress test reads
// the renderer's frame timings through it). Never on by default.
if (/^\d{4,5}$/.test(process.env.KF_DEBUG_PORT || '')) {
  app.commandLine.appendSwitch('remote-debugging-port', process.env.KF_DEBUG_PORT);
  app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
}

protocol.registerSchemesAsPrivileged([{ scheme: 'sximg', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
const thumbCache = new Map();

function thumbHandler(request) {
  try {
    const p = new URL(request.url).searchParams.get('p') || '';
    const norm = path.normalize(p);
    // Local drive paths only (a \\server\share path would make Windows send credentials to that server),
    // a .png inside a UserData\studio folder, or one of Keyframe Studio's cached pose thumbnails
    // (UserData\StudioEX\pose-thumbs\*.jpg) — checked again after resolving junctions/symlinks.
    const allowed = (f) =>
      /^[a-z]:\\/i.test(f) &&
      ((/\.png$/i.test(f) && /[\\/]userdata[\\/]studio[\\/]/i.test(f)) || (/\.jpg$/i.test(f) && /[\\/]userdata[\\/]studioex[\\/]pose-thumbs[\\/]/i.test(f)));
    if (!path.isAbsolute(norm) || !allowed(norm)) return new Response('forbidden', { status: 403 });
    if (!allowed(fs.realpathSync(norm))) return new Response('forbidden', { status: 403 });
    const stat = fs.statSync(norm);
    const key = `${norm}|${stat.mtimeMs}`;
    let buf = thumbCache.get(key);
    if (!buf) {
      const img = nativeImage.createFromPath(norm);
      if (img.isEmpty()) return new Response('not an image', { status: 415 });
      buf = img.resize({ width: 384, quality: 'good' }).toJPEG(82);
      if (thumbCache.size > 600) thumbCache.delete(thumbCache.keys().next().value);
      thumbCache.set(key, buf);
    }
    return new Response(buf, { headers: { 'content-type': 'image/jpeg', 'cache-control': 'max-age=3600' } });
  } catch {
    return new Response('not found', { status: 404 });
  }
}

const stateFile = path.join(app.getPath('userData'), 'window-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { return {}; }
}

function saveState(win) {
  if (win.isDestroyed()) return;
  const s = { bounds: win.getNormalBounds(), maximized: win.isMaximized(), alwaysOnTop: win.isAlwaysOnTop() };
  try { fs.writeFileSync(stateFile, JSON.stringify(s)); } catch { /* ignore */ }
}

function createWindow() {
  const state = loadState();
  // Saved position on a monitor that's no longer connected: fall back to the default placement.
  if (state.bounds) {
    const { screen } = require('electron');
    const b = state.bounds;
    const visible = screen.getAllDisplays().some(({ workArea: a }) => b.x + 80 < a.x + a.width && b.x + b.width - 80 > a.x && b.y >= a.y - 10 && b.y + 40 < a.y + a.height);
    if (!visible) delete state.bounds;
  }
  const win = new BrowserWindow({
    width: 1400,
    height: 820,
    ...(state.bounds || {}),
    minWidth: 900,
    minHeight: 500,
    backgroundColor: '#15161a',
    title: 'Keyframe Studio',
    icon: APP_ICON,
    autoHideMenuBar: true,
    alwaysOnTop: !!state.alwaysOnTop,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  });
  if (state.maximized) win.maximize();

  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) win.loadURL(devUrl);
  else win.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));

  // Surface renderer problems in the terminal (a blank window is otherwise impossible to diagnose).
  win.webContents.on('console-message', (_e, level, message, line, source) => {
    if (level >= 2) console.error(`[renderer] ${message} (${source}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, d) => console.error('[renderer] process gone:', d.reason));
  win.webContents.on('did-fail-load', (_e, code, desc, url) => console.error('[renderer] failed to load', url, code, desc));
  win.webContents.on('did-finish-load', () => {
    setTimeout(() => {
      win.webContents
        .executeJavaScript(
          '(() => { const r = document.getElementById("root"); if (!r) return "no root"; const a = r.firstElementChild; const cs = getComputedStyle(document.body); const as = a ? getComputedStyle(a) : null;' +
            ' return r.childElementCount + " root children, " + document.body.innerText.length + " chars | body color " + cs.color + " bg " + cs.backgroundColor + " | first child ." + (a && a.className) + " display " + (as && as.display) + " size " + (a && a.getBoundingClientRect().width) + "x" + (a && a.getBoundingClientRect().height) + " | sheets " + document.styleSheets.length + " | text: " + document.body.innerText.slice(0, 120).replace(/\\n/g, " / "); })()',
        )
        .then((r) => {
          console.log('[renderer] mounted:', r);
          // Debug aid: STUDIOEX_CAPTURE=<file.png> saves what the renderer actually painted.
          if (process.env.STUDIOEX_CAPTURE)
            win.webContents.capturePage().then((img) => fs.writeFileSync(process.env.STUDIOEX_CAPTURE, img.toPNG()));
        })
        .catch((err) => console.error('[renderer] probe failed', err));
    }, 2500);
  });

  // Links open in the real browser — web links only (never file:, ms-*, or other protocol handlers).
  const isWeb = (url) => /^https?:\/\//i.test(url) && !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/i.test(url);
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (isWeb(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  // Never navigate the app window away (a PNG dropped on it would otherwise replace the whole UI).
  win.webContents.on('will-navigate', (e, url) => {
    const appUrl = devUrl || require('url').pathToFileURL(path.join(__dirname, '..', 'dist', 'index.html')).href;
    const own = url.split('#')[0].startsWith(appUrl);
    if (own) return;
    e.preventDefault();
    if (isWeb(url)) shell.openExternal(url);
  });
  win.on('close', () => saveState(win));

  ipcMain.handle('window:setAlwaysOnTop', (_e, on) => { win.setAlwaysOnTop(!!on); saveState(win); return win.isAlwaysOnTop(); });
  ipcMain.handle('window:getAlwaysOnTop', () => win.isAlwaysOnTop());
}

app.whenReady().then(() => {
  protocol.handle('sximg', thumbHandler);
  require('./log.cjs').register(ipcMain);
  require('./translate.cjs').register(ipcMain);
  createWindow();
});
app.on('window-all-closed', () => app.quit());
app.on('child-process-gone', (_e, d) => console.error('[electron] child process gone:', d.type, d.reason));
