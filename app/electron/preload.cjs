const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioEx', {
  isElectron: true,
  setAlwaysOnTop: (on) => ipcRenderer.invoke('window:setAlwaysOnTop', on),
  getAlwaysOnTop: () => ipcRenderer.invoke('window:getAlwaysOnTop'),
  log: {
    write: (lines) => ipcRenderer.invoke('log:write', lines),
    tail: (n) => ipcRenderer.invoke('log:tail', n),
    openFolder: () => ipcRenderer.invoke('log:openFolder'),
  },
  appInfo: () => ipcRenderer.invoke('app:info'),
  translate: {
    batch: (engine, items, settings) => ipcRenderer.invoke('translate:batch', engine, items, settings),
    models: (settings) => ipcRenderer.invoke('translate:models', settings),
  },
});
