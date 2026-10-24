const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('serial', {
  list: () => ipcRenderer.invoke('serial:list'),
  connect: options => ipcRenderer.invoke('serial:connect', options),
  disconnect: () => ipcRenderer.invoke('serial:disconnect'),
  write: data => ipcRenderer.invoke('serial:write', data),
  copy: text => ipcRenderer.invoke('serial:copy', text),
  save: text => ipcRenderer.invoke('serial:save', text),
  onData: callback => { const listener = (_, data) => callback(data); ipcRenderer.on('serial:data', listener); return () => ipcRenderer.removeListener('serial:data', listener); },
  onStatus: callback => { const listener = (_, status) => callback(status); ipcRenderer.on('serial:status', listener); return () => ipcRenderer.removeListener('serial:status', listener); },
});
