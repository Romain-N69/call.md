const { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./database');
const keychain = require('./keychain');
const { startSystemAudio } = require('./system-audio');
const { markdown } = require('./insights');
const { cleanSegments, parakeetState, parakeetTranscribe, whisperTranscribe, modelState, selectedModel, MODELS } = require('./transcription');
const synapse = require('./synapse');

let window;
let db;
let activeMeeting;
let systemAudio;
let pendingTranscriptions = new Set();
const recordingsRoot = () => path.join(app.getPath('userData'), 'recordings');
const modelsRoot = () => path.join(app.getPath('userData'), 'models');
const preferencesPath = () => path.join(app.getPath('userData'), 'preferences.json');
function preferences() { try { return JSON.parse(fs.readFileSync(preferencesPath(), 'utf8')); } catch { return { provider: 'synapse', recognitionEngine: 'whisper', model: 'small', language: 'auto', modelsPath: modelsRoot() }; } }
function savePreferences(value) { fs.writeFileSync(preferencesPath(), JSON.stringify(value)); return value; }
function configuredModelsRoot() { return preferences().modelsPath || modelsRoot(); }
async function transcribe(file, language = activeMeeting?.language || 'auto') {
  if (!hasSpeech(file)) return [];
  const config = { ...preferences(), language };
  const provider = config.provider || config.engine || 'synapse';
  const recognitionEngine = config.recognitionEngine || 'whisper';
  if (provider === 'local') {
    if (recognitionEngine === 'parakeet') return parakeetTranscribe(file, { modelsDir: config.modelsPath || modelsRoot() });
    return whisperTranscribe(file, { modelPath: selectedModel(config.modelsPath || modelsRoot(), config.model), language: config.language });
  }
  return cleanSegments(await synapse.transcribe(file, getKey(), { language: config.language, model: config.synapseModel || synapse.TRANSCRIPTION_MODEL }));
}
function hasSpeech(file) {
  try {
    const { stderr } = require('node:child_process').spawnSync('/opt/homebrew/bin/ffmpeg', ['-hide_banner', '-i', file, '-af', 'silencedetect=noise=-42dB:d=0.4', '-f', 'null', '-'], { encoding: 'utf8' });
    const duration = Number((stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/) || []).slice(1).reduce((total, value, index) => total + Number(value) * [3600, 60, 1][index], 0));
    const silence = [...stderr.matchAll(/silence_duration: ([\d.]+)/g)].reduce((total, match) => total + Number(match[1]), 0);
    return !duration || duration - silence >= 0.35;
  } catch { return true; }
}
function track(promise) { pendingTranscriptions.add(promise); promise.finally(() => pendingTranscriptions.delete(promise)); return promise; }

function getKey() {
  return keychain.get(app) || process.env.THALES_SYNAPSE_SYNAPSE_LLM_KEY || '';
}

function saveKey(key) { keychain.set(app, key); }

async function createWindow() {
  window = new BrowserWindow({
    width: 1260,
    height: 820,
    minWidth: 880,
    minHeight: 620,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#dce8ec',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  await window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  fs.mkdirSync(recordingsRoot(), { recursive: true });
  fs.mkdirSync(modelsRoot(), { recursive: true });
  db = openDatabase(path.join(app.getPath('userData'), 'meetings.db'));
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: true });
  await createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => db?.close());

ipcMain.handle('config:get', () => ({ configured: Boolean(getKey()), source: keychain.get(app) ? 'keychain' : process.env.THALES_SYNAPSE_SYNAPSE_LLM_KEY ? 'environment' : null, baseUrl: synapse.BASE_URL, chatModel: synapse.CHAT_MODEL, transcriptionModel: synapse.TRANSCRIPTION_MODEL }));
ipcMain.handle('config:save-key', async (_event, key) => {
  await synapse.validateKey(key);
  saveKey(key);
  return { configured: true, source: 'keychain' };
});
ipcMain.handle('config:test', () => synapse.validateKey(getKey()));
ipcMain.handle('config:models', async () => (await synapse.models(getKey())).filter(model => model.mode === 'audio_transcription' || /transcri|whisper|chirp|voxtral/i.test(model.id)));
ipcMain.handle('transcription:get', () => ({ preferences: { ...preferences(), provider: preferences().provider || preferences().engine || 'synapse', recognitionEngine: preferences().recognitionEngine || 'whisper', modelsPath: configuredModelsRoot() }, models: modelState(configuredModelsRoot()), parakeet: parakeetState(configuredModelsRoot()) }));
ipcMain.handle('transcription:save', (_event, value) => {
  if (!path.isAbsolute(value.modelsPath)) throw new Error('Models folder must be an absolute path');
  fs.mkdirSync(value.modelsPath, { recursive: true });
  return savePreferences(value);
});
ipcMain.handle('transcription:choose-folder', async () => {
  const result = await dialog.showOpenDialog(window, { title: 'Choose Whisper models folder', defaultPath: configuredModelsRoot(), properties: ['openDirectory', 'createDirectory'] });
  return result.canceled ? null : result.filePaths[0];
});
ipcMain.handle('transcription:download', async (_event, modelId) => {
  const model = MODELS[modelId];
  if (!model) throw new Error('Unknown local model');
  const destination = path.join(configuredModelsRoot(), model.file);
  const { response } = await dialog.showMessageBox(window, { type: 'question', buttons: ['Download', 'Cancel'], defaultId: 0, cancelId: 1, title: model.label, message: `Download ${model.label}?`, detail: `${model.detail}. The model is stored locally and may require several GB.` });
  if (response !== 0) return false;
  const download = await fetch(model.url);
  if (!download.ok) throw new Error(`Model download failed (${download.status})`);
  fs.writeFileSync(destination, Buffer.from(await download.arrayBuffer()));
  await dialog.showMessageBox(window, { type: 'info', message: `${model.label} is ready`, detail: 'Transcription can now run locally on this Mac.' });
  return true;
});
ipcMain.handle('permissions:get', () => ({
  microphone: process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('microphone') === 'granted',
  screen: process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted',
}));
ipcMain.handle('permissions:microphone', () => process.platform !== 'darwin' || systemPreferences.askForMediaAccess('microphone'));
ipcMain.handle('permissions:screen', async () => {
  if (process.platform !== 'darwin' || systemPreferences.getMediaAccessStatus('screen') === 'granted') return true;
  await shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture');
  return false;
});
ipcMain.handle('meeting:start', async (_event, { title, language }) => {
  if (activeMeeting) throw new Error('A meeting is already recording');
  const id = randomUUID();
  const folder = path.join(recordingsRoot(), id);
  fs.mkdirSync(folder, { recursive: true });
  activeMeeting = { id, title: title || 'Untitled meeting', folder, startedAt: Date.now(), language: language || 'auto' };
  db.startMeeting(activeMeeting);
  systemAudio = startSystemAudio({
    app, folder, startedAt: activeMeeting.startedAt,
    onSegment: segment => track((async () => {
      try {
        const meeting = activeMeeting;
        const segments = await transcribe(segment.path, meeting.language);
        db.addSegments(meeting.id, 'them', (segment.startedAt - meeting.startedAt) / 1000, segments);
        window.webContents.send('meeting:transcript', db.getTranscript(meeting.id));
      } catch (error) { window.webContents.send('meeting:error', error.message); }
    })()),
    onLevel: levelDb => window.webContents.send('meeting:system-level', levelDb),
    onError: message => window.webContents.send('meeting:error', message),
  });
  try { await systemAudio.ready; }
  catch (error) { systemAudio.stop(); systemAudio = null; db.deleteMeeting(activeMeeting.id); activeMeeting = null; throw error; }
  return activeMeeting;
});
ipcMain.handle('meeting:video-segment', (_event, { bytes, startedAt }) => {
  if (!activeMeeting) throw new Error('No active meeting');
  fs.appendFileSync(path.join(activeMeeting.folder, 'screen-full.webm'), Buffer.from(bytes));
  return true;
});
ipcMain.handle('meeting:segment', async (_event, { channel, bytes, startedAt }) => {
  if (!activeMeeting) throw new Error('No active meeting');
  const file = path.join(activeMeeting.folder, `${channel}-${startedAt}.webm`);
  fs.writeFileSync(file, Buffer.from(bytes));
  const meeting = activeMeeting;
  track((async () => {
    try {
      const segments = await transcribe(file, meeting.language);
      const offset = (startedAt - meeting.startedAt) / 1000;
      db.addSegments(meeting.id, channel === 'mic' ? 'me' : 'them', offset, segments);
      window.webContents.send('meeting:transcript', db.getTranscript(meeting.id));
    } catch (error) { window.webContents.send('meeting:error', error.message); }
  })());
  return true;
});
ipcMain.handle('meeting:stop', async () => {
  if (!activeMeeting) return null;
  const meeting = activeMeeting;
  const progress = (stage, percent, detail) => window.webContents.send('meeting:processing', { stage, percent, detail });
  progress('Saving recordings', 20, 'Closing microphone, system audio, and screen files…');
  systemAudio?.stop(); systemAudio = null;
  await new Promise(resolve => setTimeout(resolve, 1200));
  progress('Finishing transcript', 55, pendingTranscriptions.size ? `Waiting for ${pendingTranscriptions.size} audio segment${pendingTranscriptions.size === 1 ? '' : 's'}…` : 'All audio segments are ready.');
  await Promise.allSettled([...pendingTranscriptions]);
  db.finishMeeting(meeting.id, Date.now());
  const transcript = db.getTranscript(meeting.id);
  let summary = null;
  try {
    progress('Creating summary', 82, 'Extracting key points and action items with Synapse…');
    summary = await synapse.summarize(transcript, getKey());
    db.saveSummary(meeting.id, summary);
  } catch (error) {
    console.error(error);
    progress('Summary unavailable', 95, 'The recording and transcript are saved. You can retry later.');
  }
  activeMeeting = null;
  progress('Meeting saved', 100, 'Recording, transcript, and notes are ready.');
  return { ...meeting, transcript, summary };
});
ipcMain.handle('meeting:list', (_event, query) => db.listMeetings(query));
ipcMain.handle('meeting:get', (_event, id) => db.getMeeting(id));
ipcMain.handle('meeting:update', (_event, id, changes) => db.updateMeeting(id, changes));
ipcMain.handle('meeting:bookmark', (_event, meetingId, atTime, note) => db.addBookmark(meetingId, atTime, note));
ipcMain.handle('meeting:delete-bookmark', (_event, id) => db.deleteBookmark(id));
ipcMain.handle('meeting:delete', (_event, id) => {
  const folder = db.deleteMeeting(id);
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  return true;
});
ipcMain.handle('meeting:retranscribe', async (_event, id, language = 'auto') => {
  const meeting = db.getMeeting(id);
  if (!meeting) throw new Error('Meeting not found');
  const files = fs.readdirSync(meeting.folder).filter(file => /^(mic-|system-).+\.(webm|wav)$/.test(file)).sort();
  if (!files.length) throw new Error('No source audio files were found');
  const segments = [];
  for (const file of files) {
    const match = file.match(/^(mic|system(?:_audio)?)-(\d+)/);
    if (!match) continue;
    const startedAt = Number(match[2]), channel = match[1] === 'mic' ? 'me' : 'them';
    const transcript = await transcribe(path.join(meeting.folder, file), language);
    const offset = Math.max(0, (startedAt - meeting.started_at) / 1000);
    transcript.forEach(item => segments.push({ channel, start_time: offset + Number(item.start || 0), end_time: offset + Number(item.end || item.start || 0), text: item.text || '' }));
  }
  db.replaceTranscript(id, segments.sort((a, b) => a.start_time - b.start_time));
  const transcript = db.getTranscript(id);
  const summary = await synapse.summarize(transcript, getKey());
  db.saveSummary(id, summary);
  return db.getMeeting(id);
});
ipcMain.handle('meeting:export', async (_event, id) => {
  const meeting = db.getMeeting(id);
  if (!meeting) throw new Error('Meeting not found');
  const file = path.join(meeting.folder, `${meeting.title.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'meeting'}.md`);
  fs.writeFileSync(file, markdown(meeting, meeting.transcript, meeting.bookmarks));
  await shell.showItemInFolder(file);
  return file;
});
ipcMain.handle('meeting:open-folder', (_event, folder) => shell.openPath(folder));
