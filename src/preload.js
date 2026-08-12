const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callLocal', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    saveKey: key => ipcRenderer.invoke('config:save-key', key),
    test: () => ipcRenderer.invoke('config:test'),
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
    list: query => ipcRenderer.invoke('meeting:list', query),
    get: id => ipcRenderer.invoke('meeting:get', id),
    update: (id, changes) => ipcRenderer.invoke('meeting:update', id, changes),
    bookmark: (id, atTime, note) => ipcRenderer.invoke('meeting:bookmark', id, atTime, note),
    deleteBookmark: id => ipcRenderer.invoke('meeting:delete-bookmark', id),
    delete: id => ipcRenderer.invoke('meeting:delete', id),
    export: id => ipcRenderer.invoke('meeting:export', id),
    openFolder: folder => ipcRenderer.invoke('meeting:open-folder', folder),
    onTranscript: callback => {
      const listener = (_event, transcript) => callback(transcript);
      ipcRenderer.on('meeting:transcript', listener);
      return () => ipcRenderer.removeListener('meeting:transcript', listener);
    },
  },
});
