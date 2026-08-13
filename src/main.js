const { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./database');
const keychain = require('./keychain');
const { startSystemAudio } = require('./system-audio');
const { markdown } = require('./insights');
const { finalizeVideo, isSystemAudioLeak, nearestSystemChunk, suppressCrosstalk } = require('./media');
const { cleanSegments, parakeetState, parakeetTranscribe, whisperTranscribe, modelState, selectedModel, MODELS } = require('./transcription');
const synapse = require('./synapse');

let window;
let db;
let activeMeeting;
let systemAudio;
let pendingTranscriptions = new Set();
let allowClose = false;
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
  const segments = await synapse.transcribe(file, getKey(), { language: config.language, model: config.synapseModel || synapse.TRANSCRIPTION_MODEL });
  segments.forEach(segment => { segment.expectedLatin = /^(fr|en|de|es|it|pt|nl|pl|tr)$/.test(config.language); });
  const cleaned = cleanSegments(segments);
  cleaned.detectedLanguage = segments.detectedLanguage;
  return cleaned;
}
function learnLanguage(meeting, segments) {
  if ((meeting.requestedLanguage || meeting.language) !== 'auto' || !/^[a-z]{2}$/.test(segments.detectedLanguage || '')) return;
  meeting.languageVotes ||= {};
  meeting.languageVotes[segments.detectedLanguage] = (meeting.languageVotes[segments.detectedLanguage] || 0) + 1;
  if (meeting.languageVotes[segments.detectedLanguage] >= 3) meeting.language = segments.detectedLanguage;
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
    width: 1080,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#dce8ec',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  window.on('close', event => {
    if (!activeMeeting || allowClose) return;
    event.preventDefault();
    window.webContents.send('app:close-requested', false);
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
app.on('before-quit', event => {
  if (activeMeeting && !allowClose) { event.preventDefault(); window.webContents.send('app:close-requested', true); return; }
  systemAudio?.stop(); db?.close();
});

ipcMain.handle('app:close', (_event, quit) => { allowClose = true; quit ? app.quit() : window.close(); });
ipcMain.handle('config:get', () => ({ configured: Boolean(getKey()), source: keychain.get(app) ? 'keychain' : process.env.THALES_SYNAPSE_SYNAPSE_LLM_KEY ? 'environment' : null, baseUrl: synapse.BASE_URL, chatModel: synapse.CHAT_MODEL, transcriptionModel: synapse.TRANSCRIPTION_MODEL }));
ipcMain.handle('config:save-key', async (_event, key) => {
  if (typeof key !== 'string' || !key.trim()) throw new Error('A Synapse key is required');
  await synapse.validateKey(key.trim());
  saveKey(key.trim());
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
  if (typeof title !== 'string' || !title.trim()) throw new Error('A meeting title is required');
  if (!/^(auto|fr|en|de|es|it|pt|nl|pl|uk|ja|zh|ko|ar|hi|tr|ru)$/.test(language || 'auto')) throw new Error('Unsupported meeting language');
  const id = randomUUID();
  const folder = path.join(recordingsRoot(), id);
  fs.mkdirSync(folder, { recursive: true });
  activeMeeting = { id, title: title.trim().slice(0, 120), folder, startedAt: Date.now(), language: language || 'auto', requestedLanguage: language || 'auto', speakerNames: [] };
  db.startMeeting(activeMeeting);
  systemAudio = startSystemAudio({
    app, folder, startedAt: activeMeeting.startedAt,
    onSegment: segment => track((async () => {
      try {
        const meeting = activeMeeting;
        const segments = await transcribe(segment.path, meeting.language);
        learnLanguage(meeting, segments);
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
ipcMain.handle('meeting:speaker-names', (_event, names) => {
  if (!activeMeeting) return false;
  activeMeeting.speakerNames = names.filter(Boolean).map(name => String(name).trim().slice(0, 40)).slice(0, 8);
  return true;
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
      const transcriptChannel = channel === 'mic' ? 'me' : 'them';
      if (transcriptChannel === 'me' && await isSystemAudioLeak(file, nearestSystemChunk(meeting.folder, startedAt))) return;
      const segments = await transcribe(file, meeting.language);
      learnLanguage(meeting, segments);
      const offset = (startedAt - meeting.startedAt) / 1000;
      db.addSegments(meeting.id, transcriptChannel, offset, segments);
      const transcript = suppressCrosstalk(db.getTranscript(meeting.id));
      db.replaceTranscript(meeting.id, transcript);
      window.webContents.send('meeting:transcript', transcript);
    } catch (error) { window.webContents.send('meeting:error', error.message); }
  })());
  return true;
});
ipcMain.handle('meeting:stop', async () => {
  if (!activeMeeting) return null;
  const meeting = activeMeeting;
  const progress = (stage, percent, detail) => window.webContents.send('meeting:processing', { stage, percent, detail });
  progress('Enregistrement des médias', 20, 'Fermeture du microphone, de l’audio système et de la vidéo…');
  await systemAudio?.stop(); systemAudio = null;
  progress('Finalisation de la transcription', 55, pendingTranscriptions.size ? `${pendingTranscriptions.size} segment${pendingTranscriptions.size === 1 ? '' : 's'} audio encore en cours…` : 'Tous les segments audio sont prêts.');
  await Promise.allSettled([...pendingTranscriptions]);
  progress('Analyse des intervenants', 68, 'Séparation des voix et application des noms…');
  try { await finalizeVideo(path.join(meeting.folder, 'screen-full.webm')); }
  catch (error) { console.error('Video finalization failed:', error); }
  db.finishMeeting(meeting.id, Date.now());
  let transcript = suppressCrosstalk(db.getTranscript(meeting.id));
  const systemFile = path.join(meeting.folder, 'system-full.wav');
  try {
    const diarized = await synapse.diarize(systemFile, getKey(), meeting.language);
    if (diarized.length) {
      const speakers = [...new Set(diarized.map(segment => segment.speaker))];
      const names = Object.fromEntries(speakers.map((speaker, index) => [speaker, meeting.speakerNames[index] || `Intervenant ${index + 1}`]));
      transcript = [...transcript.filter(segment => segment.channel === 'me'), ...diarized.map(segment => ({ channel: 'them', start_time: segment.start, end_time: segment.end, text: segment.text, speaker: names[segment.speaker] }))].sort((a, b) => a.start_time - b.start_time);
    }
  } catch (error) { console.error('Diarization failed:', error); }
  db.replaceTranscript(meeting.id, transcript);
  transcript = db.getTranscript(meeting.id);
  let summary = null;
  try {
    progress('Création du compte rendu', 88, 'Extraction des points clés et des actions avec Synapse…');
    summary = await synapse.summarize(transcript, getKey());
    db.saveSummary(meeting.id, summary);
  } catch (error) {
    console.error(error);
    progress('Compte rendu indisponible', 95, 'L’enregistrement et la transcription sont sauvegardés. Vous pourrez réessayer.');
  }
  activeMeeting = null;
  progress('Réunion sauvegardée', 100, 'L’enregistrement, la transcription et les notes sont prêts.');
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
    const source = path.join(meeting.folder, file);
    if (channel === 'me' && await isSystemAudioLeak(source, nearestSystemChunk(meeting.folder, startedAt))) continue;
    const transcript = await transcribe(source, language);
    const offset = Math.max(0, (startedAt - meeting.started_at) / 1000);
    transcript.forEach(item => segments.push({ channel, start_time: offset + Number(item.start || 0), end_time: offset + Number(item.end || item.start || 0), text: item.text || '' }));
  }
  let finalSegments = suppressCrosstalk(segments.sort((a, b) => a.start_time - b.start_time));
  try {
    const diarized = await synapse.diarize(path.join(meeting.folder, 'system-full.wav'), getKey(), language);
    const speakers = [...new Set(diarized.map(segment => segment.speaker))];
    const names = Object.fromEntries(speakers.map((speaker, index) => [speaker, `Intervenant ${index + 1}`]));
    finalSegments = [...finalSegments.filter(segment => segment.channel === 'me'), ...diarized.map(segment => ({ channel: 'them', start_time: segment.start, end_time: segment.end, text: segment.text, speaker: names[segment.speaker] }))].sort((a, b) => a.start_time - b.start_time);
  } catch (error) { console.error('Diarization failed:', error); }
  db.replaceTranscript(id, finalSegments);
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
