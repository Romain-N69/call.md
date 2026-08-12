const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callLocal', {
  config: {
    get: () => ipcRenderer.invoke('config:get'),
    saveKey: key => ipcRenderer.invoke('config:save-key', key),
    test: () => ipcRenderer.invoke('config:test'),
    models: () => ipcRenderer.invoke('config:models'),
  },
  transcription: {
    get: () => ipcRenderer.invoke('transcription:get'),
    save: value => ipcRenderer.invoke('transcription:save', value),
    download: model => ipcRenderer.invoke('transcription:download', model),
    chooseFolder: () => ipcRenderer.invoke('transcription:choose-folder'),
  },
  permissions: {
    get: () => ipcRenderer.invoke('permissions:get'),
    microphone: () => ipcRenderer.invoke('permissions:microphone'),
    screen: () => ipcRenderer.invoke('permissions:screen'),
  },
  meeting: {
    start: options => ipcRenderer.invoke('meeting:start', options),
    sendSegment: payload => ipcRenderer.invoke('meeting:segment', payload),
    sendVideoSegment: payload => ipcRenderer.invoke('meeting:video-segment', payload),
    stop: () => ipcRenderer.invoke('meeting:stop'),
    list: query => ipcRenderer.invoke('meeting:list', query),
    get: id => ipcRenderer.invoke('meeting:get', id),
    update: (id, changes) => ipcRenderer.invoke('meeting:update', id, changes),
    bookmark: (id, atTime, note) => ipcRenderer.invoke('meeting:bookmark', id, atTime, note),
    deleteBookmark: id => ipcRenderer.invoke('meeting:delete-bookmark', id),
    delete: id => ipcRenderer.invoke('meeting:delete', id),
    export: id => ipcRenderer.invoke('meeting:export', id),
    retranscribe: (id, language) => ipcRenderer.invoke('meeting:retranscribe', id, language),
    openFolder: folder => ipcRenderer.invoke('meeting:open-folder', folder),
    onTranscript: callback => {
      const listener = (_event, transcript) => callback(transcript);
      ipcRenderer.on('meeting:transcript', listener);
      return () => ipcRenderer.removeListener('meeting:transcript', listener);
    },
    onProcessing: callback => {
      const listener = (_event, status) => callback(status);
      ipcRenderer.on('meeting:processing', listener);
      return () => ipcRenderer.removeListener('meeting:processing', listener);
    },
    onSystemLevel: callback => {
      const listener = (_event, level) => callback(level);
      ipcRenderer.on('meeting:system-level', listener);
      return () => ipcRenderer.removeListener('meeting:system-level', listener);
    },
    onError: callback => {
      const listener = (_event, message) => callback(message);
      ipcRenderer.on('meeting:error', listener);
      return () => ipcRenderer.removeListener('meeting:error', listener);
    },
  },
});
