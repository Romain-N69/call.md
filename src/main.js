const { app, BrowserWindow, ipcMain, safeStorage, shell, systemPreferences } = require('electron');
const { randomUUID } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('./database');
const { startSystemAudio } = require('./system-audio');
const { markdown } = require('./insights');
const synapse = require('./synapse');

let window;
let db;
let activeMeeting;
let systemAudio;
const keyPath = () => path.join(app.getPath('userData'), 'synapse-key.bin');
const recordingsRoot = () => path.join(app.getPath('userData'), 'recordings');

function getKey() {
  if (fs.existsSync(keyPath()) && safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(fs.readFileSync(keyPath()));
  return process.env.THALES_SYNAPSE_SYNAPSE_LLM_KEY || '';
}

function saveKey(key) {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('macOS Keychain is unavailable');
  fs.writeFileSync(keyPath(), safeStorage.encryptString(key));
}

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
  db = openDatabase(path.join(app.getPath('userData'), 'meetings.db'));

  await createWindow();
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', () => db?.close());

ipcMain.handle('config:get', () => ({ configured: Boolean(getKey()), source: fs.existsSync(keyPath()) ? 'keychain' : process.env.THALES_SYNAPSE_SYNAPSE_LLM_KEY ? 'environment' : null, baseUrl: synapse.BASE_URL, chatModel: synapse.CHAT_MODEL, transcriptionModel: synapse.TRANSCRIPTION_MODEL }));
ipcMain.handle('config:save-key', async (_event, key) => {
  await synapse.validateKey(key);
  saveKey(key);
  return { configured: true, source: 'keychain' };
});
ipcMain.handle('config:test', () => synapse.validateKey(getKey()));
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
ipcMain.handle('meeting:start', async (_event, title) => {
  if (activeMeeting) throw new Error('A meeting is already recording');
  const id = randomUUID();
  const folder = path.join(recordingsRoot(), id);
  fs.mkdirSync(folder, { recursive: true });
  activeMeeting = { id, title: title || 'Untitled meeting', folder, startedAt: Date.now() };
  db.startMeeting(activeMeeting);
  systemAudio = startSystemAudio({
    app, folder, startedAt: activeMeeting.startedAt,
    onSegment: async segment => {
      try {
        const segments = await synapse.transcribe(segment.path, getKey());
        db.addSegments(activeMeeting.id, 'them', (segment.startedAt - activeMeeting.startedAt) / 1000, segments);
        window.webContents.send('meeting:transcript', db.getTranscript(activeMeeting.id));
      } catch (error) { window.webContents.send('meeting:error', error.message); }
    },
    onError: message => window.webContents.send('meeting:error', message),
  });
  try { await systemAudio.ready; }
  catch (error) { systemAudio.stop(); systemAudio = null; db.deleteMeeting(activeMeeting.id); activeMeeting = null; throw error; }
  return activeMeeting;
});
ipcMain.handle('meeting:segment', async (_event, { channel, bytes, startedAt }) => {
  if (!activeMeeting) throw new Error('No active meeting');
  const file = path.join(activeMeeting.folder, `${channel}-${startedAt}.webm`);
  fs.writeFileSync(file, Buffer.from(bytes));
  const segments = await synapse.transcribe(file, getKey());
  const offset = (startedAt - activeMeeting.startedAt) / 1000;
  db.addSegments(activeMeeting.id, channel === 'mic' ? 'me' : 'them', offset, segments);
  window.webContents.send('meeting:transcript', db.getTranscript(activeMeeting.id));
  return true;
});
ipcMain.handle('meeting:stop', async () => {
  if (!activeMeeting) return null;
  const meeting = activeMeeting;
  systemAudio?.stop(); systemAudio = null;
  await new Promise(resolve => setTimeout(resolve, 1000));
  db.finishMeeting(meeting.id, Date.now());
  const transcript = db.getTranscript(meeting.id);
  let summary = null;
  try {
    summary = await synapse.summarize(transcript, getKey());
    db.saveSummary(meeting.id, summary);
  } catch (error) { console.error(error); }
  activeMeeting = null;
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
ipcMain.handle('meeting:export', async (_event, id) => {
  const meeting = db.getMeeting(id);
  if (!meeting) throw new Error('Meeting not found');
  const file = path.join(meeting.folder, `${meeting.title.replace(/[^a-z0-9-_ ]/gi, '').trim() || 'meeting'}.md`);
  fs.writeFileSync(file, markdown(meeting, meeting.transcript, meeting.bookmarks));
  await shell.showItemInFolder(file);
  return file;
});
ipcMain.handle('meeting:open-folder', (_event, folder) => shell.openPath(folder));
