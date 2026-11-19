const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('studioEx', {
  isElectron: true,
  // the window has no system title bar: the header must leave room for the window buttons
  frameless: true,
  setAlwaysOnTop: (on) => ipcRenderer.invoke('window:setAlwaysOnTop', on),
  getAlwaysOnTop: () => ipcRenderer.invoke('window:getAlwaysOnTop'),
  getBounds: () => ipcRenderer.invoke('window:getBounds'),
  setBounds: (b) => ipcRenderer.invoke('window:setBounds', b),
  log: {
    write: (lines) => ipcRenderer.invoke('log:write', lines),
    tail: (n) => ipcRenderer.invoke('log:tail', n),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
  },
  appInfo: () => ipcRenderer.invoke('app:info'),
  openAudio: () => ipcRenderer.invoke('dialog:openAudio'),
  // the full path of a file dropped onto the window (Studio reads and copies it itself)
  pathForFile: (f) => webUtils.getPathForFile(f),
  openImage: () => ipcRenderer.invoke('dialog:openImage'),
  openFolder: (p) => ipcRenderer.invoke('shell:openFolder', p),
  translate: {
    batch: (engine, items, settings) => ipcRenderer.invoke('translate:batch', engine, items, settings),
    models: (settings) => ipcRenderer.invoke('translate:models', settings),
  },
});
