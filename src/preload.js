const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('callLocal', {
  app: {
    close: quit => ipcRenderer.invoke('app:close', quit),
    settings: () => ipcRenderer.invoke('app:settings'),
    saveSettings: value => ipcRenderer.invoke('app:save-settings', value),
    onMeetingToggle: callback => {
      const listener = () => callback();
      ipcRenderer.on('app:meeting-toggle', listener);
      return () => ipcRenderer.removeListener('app:meeting-toggle', listener);
    },
    onExternalCallEnded: callback => {
      const listener = () => callback();
      ipcRenderer.on('app:external-call-ended', listener);
      return () => ipcRenderer.removeListener('app:external-call-ended', listener);
    },
    onOpenMeeting: callback => {
      const listener = (_event, id) => callback(id);
      ipcRenderer.on('app:open-meeting', listener);
      return () => ipcRenderer.removeListener('app:open-meeting', listener);
    },
    onCloseRequested: callback => {
      const listener = (_event, quit) => callback(quit);
      ipcRenderer.on('app:close-requested', listener);
      return () => ipcRenderer.removeListener('app:close-requested', listener);
    },
  },
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
  writing: {
    start: options => ipcRenderer.invoke('writing:start', options),
    sendSegment: payload => ipcRenderer.invoke('writing:segment', payload),
    stop: id => ipcRenderer.invoke('writing:stop', id),
    polish: (id, options) => ipcRenderer.invoke('writing:polish', id, options),
    update: (id, changes) => ipcRenderer.invoke('writing:update', id, changes),
    get: id => ipcRenderer.invoke('writing:get', id),
    list: () => ipcRenderer.invoke('writing:list'),
    delete: id => ipcRenderer.invoke('writing:delete', id),
    export: id => ipcRenderer.invoke('writing:export', id),
  },
  meeting: {
    start: options => ipcRenderer.invoke('meeting:start', options),
    sendSegment: payload => ipcRenderer.invoke('meeting:segment', payload),
    sendVideoSegment: payload => ipcRenderer.invoke('meeting:video-segment', payload),
    stop: () => ipcRenderer.invoke('meeting:stop'),
    list: (query, archived) => ipcRenderer.invoke('meeting:list', query, archived),
    get: id => ipcRenderer.invoke('meeting:get', id),
    update: (id, changes) => ipcRenderer.invoke('meeting:update', id, changes),
    saveNotes: (id, notes) => ipcRenderer.invoke('meeting:notes', id, notes),
    ask: (id, question) => ipcRenderer.invoke('meeting:ask', id, question),
    archive: (id, archived) => ipcRenderer.invoke('meeting:archive', id, archived),
    bookmark: (id, atTime, note) => ipcRenderer.invoke('meeting:bookmark', id, atTime, note),
    deleteBookmark: id => ipcRenderer.invoke('meeting:delete-bookmark', id),
    renameSpeaker: (meetingId, speaker, name) => ipcRenderer.invoke('meeting:rename-speaker', meetingId, speaker, name),
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
