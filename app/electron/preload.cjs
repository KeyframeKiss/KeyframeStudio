const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('studioEx', {
  isElectron: true,
  setAlwaysOnTop: (on) => ipcRenderer.invoke('window:setAlwaysOnTop', on),
  getAlwaysOnTop: () => ipcRenderer.invoke('window:getAlwaysOnTop'),
  translate: {
    batch: (engine, items, settings) => ipcRenderer.invoke('translate:batch', engine, items, settings),
    models: (settings) => ipcRenderer.invoke('translate:models', settings),
  },
});
