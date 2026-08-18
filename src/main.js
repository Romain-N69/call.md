const { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./database');
const keychain = require('./keychain');
const { startSystemAudio } = require('./system-audio');
const { markdown } = require('./insights');
const { finalizeMicrophone, finalizeVideo, isSystemAudioLeak, mergeOverlappingSegments, nearestSystemChunk, suppressCrosstalk } = require('./media');
const { cleanSegments, parakeetState, parakeetTranscribe, whisperTranscribe, modelState, selectedModel, MODELS } = require('./transcription');
const { normalizeWritingOptions, polishInstructions, splitText, writingStats } = require('./writing');
const synapse = require('./synapse');

let window;
let db;
let activeMeeting;
let activeWriting;
let systemAudio;
let pendingTranscriptions = new Set();
let allowClose = false;
const recordingsRoot = () => path.join(app.getPath('userData'), 'recordings');
const modelsRoot = () => path.join(app.getPath('userData'), 'models');
const preferencesPath = () => path.join(app.getPath('userData'), 'preferences.json');
const writingRoot = () => path.join(app.getPath('userData'), 'writings');
function preferences() { try { return JSON.parse(fs.readFileSync(preferencesPath(), 'utf8')); } catch { return { provider: 'synapse', recognitionEngine: 'whisper', model: 'small', language: 'auto', modelsPath: modelsRoot() }; } }
function savePreferences(value) { fs.writeFileSync(preferencesPath(), JSON.stringify(value)); return value; }
function validWritingId(id) { if (!/^[0-9a-f-]{36}$/.test(id || '')) throw new Error('Identifiant de texte invalide'); return id; }
function configuredModelsRoot() { return preferences().modelsPath || modelsRoot(); }
async function transcribe(file, language = activeMeeting?.language || 'auto', prompt = '', final = false) {
  if (!hasSpeech(file)) return [];
  const config = { ...preferences(), language };
  const provider = config.provider || config.engine || 'synapse';
  const recognitionEngine = config.recognitionEngine || 'whisper';
  if (provider === 'local') {
    if (recognitionEngine === 'parakeet') return parakeetTranscribe(file, { modelsDir: config.modelsPath || modelsRoot() });
    return whisperTranscribe(file, { modelPath: selectedModel(config.modelsPath || modelsRoot(), config.model), language: config.language });
  }
  const segments = await synapse.transcribe(file, getKey(), { language: config.language, model: final ? synapse.TRANSCRIPTION_MODEL : config.synapseModel || synapse.TRANSCRIPTION_MODEL, prompt });
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
    width: 980,
    height: 680,
    minWidth: 720,
    minHeight: 520,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 18, y: 18 },
    backgroundColor: '#f4f0e8',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  });
  window.on('close', event => {
    if ((!activeMeeting && !activeWriting) || allowClose) return;
    event.preventDefault();
    window.webContents.send('app:close-requested', false);
  });
  await window.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  window.webContents.setZoomFactor(0.85);
}

app.whenReady().then(async () => {
  fs.mkdirSync(recordingsRoot(), { recursive: true });
  fs.mkdirSync(modelsRoot(), { recursive: true });
  fs.mkdirSync(writingRoot(), { recursive: true });
  db = openDatabase(path.join(app.getPath('userData'), 'meetings.db'));
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => callback({}), { useSystemPicker: true });
  await createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if ((activeMeeting || activeWriting) && !allowClose) { event.preventDefault(); window.webContents.send('app:close-requested', true); return; }
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
ipcMain.handle('meeting:start', async (_event, { title, language, vocabulary }) => {
  if (activeMeeting || activeWriting) throw new Error('Un autre enregistrement est déjà en cours');
  if (typeof title !== 'string' || !title.trim()) throw new Error('A meeting title is required');
  if (!/^(auto|fr|en|de|es|it|pt|nl|pl|uk|ja|zh|ko|ar|hi|tr|ru)$/.test(language || 'auto')) throw new Error('Unsupported meeting language');
  const id = randomUUID();
  const folder = path.join(recordingsRoot(), id);
  fs.mkdirSync(folder, { recursive: true });
  activeMeeting = { id, title: title.trim().slice(0, 120), folder, startedAt: Date.now(), language: language || 'auto', requestedLanguage: language || 'auto', vocabulary: String(vocabulary || '').trim().slice(0, 800) };
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
  progress('Transcription haute précision', 65, 'Relecture de la piste microphone complète avec son contexte…');
  try { await finalizeVideo(path.join(meeting.folder, 'screen-full.webm')); }
  catch (error) { console.error('Video finalization failed:', error); }
  db.finishMeeting(meeting.id, Date.now());
  let transcript = suppressCrosstalk(db.getTranscript(meeting.id));
  const systemFile = path.join(meeting.folder, 'system-full.wav'), microphone = await finalizeMicrophone(meeting.folder);
  const [finalMic, diarized] = await Promise.all([
    microphone ? transcribe(microphone.path, meeting.language, meeting.vocabulary, true).catch(error => { console.error('Final microphone transcription failed:', error); return []; }) : [],
    synapse.diarize(systemFile, getKey(), meeting.language).catch(error => { console.error('Diarization failed:', error); return []; }),
  ]);
  if (finalMic.length) {
    const offset = Math.max(0, (microphone.startedAt - meeting.startedAt) / 1000);
    transcript = [...transcript.filter(segment => segment.channel !== 'me'), ...finalMic.map(segment => ({ channel: 'me', start_time: offset + segment.start, end_time: offset + segment.end, text: segment.text }))].sort((a, b) => a.start_time - b.start_time);
  }
  progress('Analyse des intervenants', 75, 'Séparation des voix distantes…');
  if (diarized.length) {
    const speakers = [...new Set(diarized.map(segment => segment.speaker))];
    const names = Object.fromEntries(speakers.map((speaker, index) => [speaker, `Intervenant ${index + 1}`]));
    transcript = [...transcript.filter(segment => segment.channel === 'me'), ...diarized.map(segment => ({ channel: 'them', start_time: segment.start, end_time: segment.end, text: segment.text, speaker: names[segment.speaker] }))].sort((a, b) => a.start_time - b.start_time);
  }
  transcript = suppressCrosstalk(mergeOverlappingSegments(transcript));
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
ipcMain.handle('meeting:list', (_event, query, archived) => db.listMeetings(query, archived));
ipcMain.handle('meeting:get', (_event, id) => db.getMeeting(id));
ipcMain.handle('meeting:update', (_event, id, changes) => db.updateMeeting(id, changes));
ipcMain.handle('meeting:archive', (_event, id, archived) => db.archiveMeeting(id, archived));
ipcMain.handle('meeting:bookmark', (_event, meetingId, atTime, note) => db.addBookmark(meetingId, atTime, note));
ipcMain.handle('meeting:delete-bookmark', (_event, id) => db.deleteBookmark(id));
ipcMain.handle('meeting:rename-speaker', (_event, meetingId, speaker, name) => {
  if (!name?.trim()) throw new Error('A speaker name is required');
  return db.renameSpeaker(meetingId, speaker, name.trim().slice(0, 40));
});
ipcMain.handle('meeting:delete', (_event, id) => {
  const folder = db.deleteMeeting(id);
  if (folder) fs.rmSync(folder, { recursive: true, force: true });
  return true;
});
ipcMain.handle('meeting:retranscribe', async (_event, id, language = 'auto') => {
  const meeting = db.getMeeting(id);
  if (!meeting) throw new Error('Meeting not found');
  const files = fs.readdirSync(meeting.folder).filter(file => /^(mic-|system-\d).+\.(webm|wav)$/.test(file)).sort();
  if (!files.length) throw new Error('No source audio files were found');
  const segments = [];
  const microphone = await finalizeMicrophone(meeting.folder);
  if (microphone) {
    const finalMic = await transcribe(microphone.path, language, '', true);
    const offset = Math.max(0, (microphone.startedAt - meeting.started_at) / 1000);
    finalMic.forEach(item => segments.push({ channel: 'me', start_time: offset + item.start, end_time: offset + item.end, text: item.text }));
  }
  for (const file of files) {
    const match = file.match(/^(mic|system(?:_audio)?)-(\d+)/);
    if (!match) continue;
    const startedAt = Number(match[2]), channel = match[1] === 'mic' ? 'me' : 'them';
    if (channel === 'me') continue;
    const source = path.join(meeting.folder, file);
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

ipcMain.handle('writing:start', (_event, value) => {
  if (activeWriting || activeMeeting) throw new Error('Un autre enregistrement est déjà en cours');
  const options = normalizeWritingOptions(value), id = randomUUID(), createdAt = Date.now();
  const folder = path.join(writingRoot(), id), audioPath = path.join(folder, 'mic-full.wav');
  fs.mkdirSync(folder, { recursive: true });
  activeWriting = { id, createdAt, folder, audioPath, offset: 0, options };
  db.createWriting({ id, createdAt, audioPath, ...options });
  return { id, createdAt };
});
ipcMain.handle('writing:segment', async (_event, { id, bytes }) => {
  validWritingId(id);
  if (!activeWriting || id !== activeWriting.id) throw new Error('Aucune dictée active');
  if (!bytes || !Number.isFinite(bytes.byteLength) || bytes.byteLength > 20 * 1024 * 1024) throw new Error('Segment audio invalide');
  const chunk = path.join(activeWriting.folder, `mic-${Date.now()}.webm`), offset = activeWriting.offset;
  fs.writeFileSync(chunk, Buffer.from(bytes));
  const segments = await transcribe(chunk, activeWriting.options.sourceLanguage);
  const duration = segments.reduce((max, segment) => Math.max(max, Number(segment.end || 0)), 0);
  activeWriting.offset += Math.max(duration, 0.1);
  const text = segments.map(segment => segment.text).join(' ').trim(), writing = db.getWriting(id);
  if (text) db.updateWriting(id, { verbatim: `${writing.verbatim} ${text}`.trim() });
  return { text, offset, detectedLanguage: segments.detectedLanguage };
});
ipcMain.handle('writing:stop', async (_event, id) => {
  validWritingId(id);
  if (!activeWriting || id !== activeWriting.id) return db.getWriting(id);
  const writing = activeWriting; activeWriting = null;
  let verbatim = db.getWriting(id)?.verbatim || '';
  try {
    const microphone = fs.readdirSync(writing.folder).some(file => /^mic-\d+\.webm$/.test(file)) ? await finalizeMicrophone(writing.folder) : null;
    const final = microphone ? await transcribe(microphone.path, writing.options.sourceLanguage, '', true) : [];
    const text = final.map(segment => segment.text).join(' ').trim();
    if (text) verbatim = text;
  } catch (error) { console.error('Final writing transcription failed:', error); }
  const updated = db.updateWriting(id, { verbatim, status: 'draft' });
  return { ...updated, stats: writingStats(verbatim, writing.createdAt) };
});
ipcMain.handle('writing:polish', async (_event, id, value) => {
  validWritingId(id);
  if (!getKey()) throw new Error('Ajoutez une clé Synapse dans Réglages pour corriger le texte');
  let writing = db.getWriting(id);
  if (!writing && !activeWriting) {
    const options = normalizeWritingOptions(value), createdAt = Date.now(), folder = path.join(writingRoot(), id || randomUUID());
    fs.mkdirSync(folder, { recursive: true });
    writing = db.createWriting({ id: id || path.basename(folder), createdAt, audioPath: path.join(folder, 'mic-full.wav'), ...options });
  }
  if (!writing) throw new Error('Dictée introuvable');
  const options = normalizeWritingOptions({ ...writing, ...value });
  const verbatim = String(value.verbatim ?? writing.verbatim).trim();
  if (!verbatim) throw new Error('Dictez ou saisissez un texte avant de le corriger');
  const chunks = splitText(verbatim), polished = [];
  for (const chunk of chunks) polished.push(await synapse.complete([{ role: 'system', content: polishInstructions(options) }, { role: 'user', content: `<dictee>\n${chunk}\n</dictee>` }], getKey()));
  return db.updateWriting(id, { ...options, verbatim, polished: polished.join('\n\n'), status: 'ready' });
});
ipcMain.handle('writing:update', (_event, id, value) => db.updateWriting(validWritingId(id), value));
ipcMain.handle('writing:get', (_event, id) => db.getWriting(validWritingId(id)));
ipcMain.handle('writing:list', () => db.listWritings());
ipcMain.handle('writing:delete', (_event, id) => {
  validWritingId(id);
  const audioPath = db.deleteWriting(id);
  if (audioPath) fs.rmSync(path.dirname(audioPath), { recursive: true, force: true });
  return true;
});
ipcMain.handle('writing:export', async (_event, id) => {
  const writing = db.getWriting(validWritingId(id));
  if (!writing) throw new Error('Dictée introuvable');
  const result = await dialog.showSaveDialog(window, { title: 'Exporter le texte', defaultPath: `${writing.title.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'texte'}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Texte', extensions: ['txt'] }] });
  if (result.canceled) return null;
  fs.writeFileSync(result.filePath, writing.polished || writing.verbatim);
  return result.filePath;
});
