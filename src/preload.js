const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callLocal', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    saveKey: key => ipcRenderer.invoke('config:save-key', key),
  },
  permissions: {
    get: () => ipcRenderer.invoke('permissions:get'),
    microphone: () => ipcRenderer.invoke('permissions:microphone'),
    screen: () => ipcRenderer.invoke('permissions:screen'),
  },
  meeting: {
    start: title => ipcRenderer.invoke('meeting:start', title),
    sendSegment: payload => ipcRenderer.invoke('meeting:segment', payload),
    stop: () => ipcRenderer.invoke('meeting:stop'),
    list: () => ipcRenderer.invoke('meeting:list'),
    transcript: id => ipcRenderer.invoke('meeting:transcript', id),
    openFolder: folder => ipcRenderer.invoke('meeting:open-folder', folder),
    onTranscript: callback => {
      const listener = (_event, transcript) => callback(transcript);
      ipcRenderer.on('meeting:transcript', listener);
      return () => ipcRenderer.removeListener('meeting:transcript', listener);
    },
  },
});
