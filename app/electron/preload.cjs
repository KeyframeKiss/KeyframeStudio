const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('studioEx', {
  isElectron: true,
  // the window has no system title bar: the header must leave room for the window buttons
  frameless: true,
  setAlwaysOnTop: (on) => ipcRenderer.invoke('window:setAlwaysOnTop', on),
  // mini mode: a small always-on-top timeline strip; false puts the full window back
  setMini: (on) => ipcRenderer.invoke('window:mini', on),
  getAlwaysOnTop: () => ipcRenderer.invoke('window:getAlwaysOnTop'),
  // Windows' window buttons in the header's colours (hex), when the theme changes
  setTitleBarColors: (c) => ipcRenderer.invoke('window:titleBarColors', c),
  getBounds: () => ipcRenderer.invoke('window:getBounds'),
  setBounds: (b) => ipcRenderer.invoke('window:setBounds', b),
  log: {
    write: (lines) => ipcRenderer.invoke('log:write', lines),
    tail: (n) => ipcRenderer.invoke('log:tail', n),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
  },
  appInfo: () => ipcRenderer.invoke('app:info'),
  // one-click setup: find Koikatsu, check / install the bridge plugin
  setup: {
    status: (dir) => ipcRenderer.invoke('setup:status', dir),
    install: (dir) => ipcRenderer.invoke('setup:install', dir),
    pick: () => ipcRenderer.invoke('setup:pick'),
  },
  openAudio: () => ipcRenderer.invoke('dialog:openAudio'),
  // the full path of a file dropped onto the window (Studio reads and copies it itself)
  pathForFile: (f) => webUtils.getPathForFile(f),
  bridgeToken: () => ipcRenderer.invoke('bridge:token'),
  // newest release on the project's GitHub page vs this version (main process; nothing about the user is sent)
  checkUpdate: () => ipcRenderer.invoke('update:check'),
  openImage: () => ipcRenderer.invoke('dialog:openImage'),
  savePng: (name, dataUrl) => ipcRenderer.invoke('dialog:savePng', name, dataUrl),
  openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),
  showItem: (p) => ipcRenderer.invoke('shell:showItem', p),
  // scene packages and library backups (zips laid out like the Koikatsu folder)
  pkg: {
    exportScene: (info) => ipcRenderer.invoke('pkg:exportScene', info),
    exportLibrary: () => ipcRenderer.invoke('pkg:exportLibrary'),
    open: () => ipcRenderer.invoke('pkg:open'),
    apply: (token, replace) => ipcRenderer.invoke('pkg:apply', token, replace),
    cancel: (token) => ipcRenderer.invoke('pkg:cancel', token),
  },
  translate: {
    batch: (engine, items, settings) => ipcRenderer.invoke('translate:batch', engine, items, settings),
    models: (settings) => ipcRenderer.invoke('translate:models', settings),
  },
});
