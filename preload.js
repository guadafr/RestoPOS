const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('restoNative', {
  printHTML: (html) => ipcRenderer.invoke('print-html', html)
});
