const api = window.callLocal;
const $ = id => document.getElementById(id);
let streams = [];
let recorders = [];
let segmentTimers = [];
let recording = false;
let startedAt = 0;
let timer;
let sending = Promise.resolve();
const segmentMs = 8000;

function error(message = '') { $('error').textContent = message; }
function formatTime(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2,'0')}:${String(Math.floor(seconds % 60)).padStart(2,'0')}`; }
function renderTranscript(items) {
  $('transcript').innerHTML = items.map(item => `<div class="line"><b>${item.channel === 'me' ? 'YOU' : 'THEM'}</b>${escapeHtml(item.text)}</div>`).join('');
  $('transcript').scrollTop = $('transcript').scrollHeight;
}
function escapeHtml(value) { const div=document.createElement('div'); div.textContent=value; return div.innerHTML; }

function createRecorder(stream, channel) {
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
  const segmentStartedAt = Date.now();
  recorder.ondataavailable = event => {
    if (!event.data.size) return;
    sending = sending.then(async () => {
      const bytes = await event.data.arrayBuffer();
      await api.meeting.sendSegment({ channel, bytes, startedAt: segmentStartedAt });
    }).catch(e => error(e.message));
  };
  recorder.onstop = () => {
    recorders = recorders.filter(item => item !== recorder);
    if (recording) createRecorder(stream, channel);
  };
  recorder.start();
  recorders.push(recorder);
  const segmentTimer = setTimeout(() => {
    segmentTimers = segmentTimers.filter(timer => timer !== segmentTimer);
    if (recorder.state !== 'inactive') recorder.stop();
  }, segmentMs);
  segmentTimers.push(segmentTimer);
}

function meter(stream, element) {
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 256;
  context.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  const tick = () => {
    if (!streams.includes(stream)) return context.close();
    analyser.getByteFrequencyData(data);
    element.style.width = `${Math.max(4, Math.min(100, data.reduce((a,b)=>a+b,0)/data.length))}%`;
    requestAnimationFrame(tick);
  };
  tick();
}

async function start() {
  error();
  try {
    const config = await api.config.get();
    if (!config.configured) throw new Error('Save your Synapse key first.');
    const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const systemTracks = display.getAudioTracks();
    if (!systemTracks.length) throw new Error('System audio was not shared. Select a screen and enable audio sharing.');
    const system = new MediaStream(systemTracks);
    streams = [mic, display, system];
    const meeting = await api.meeting.start($('title').value.trim());
    startedAt = meeting.startedAt;
    recording = true;
    createRecorder(mic, 'mic');
    createRecorder(system, 'system_audio');
    meter(mic, $('micMeter')); meter(system, $('systemMeter'));
    $('setup').hidden = true; $('live').hidden = false;
    timer = setInterval(() => $('clock').textContent = formatTime((Date.now() - startedAt) / 1000), 1000);
  } catch (e) { streams.forEach(s => s.getTracks().forEach(t => t.stop())); streams=[]; error(e.message); }
}

async function stop() {
  recording = false;
  segmentTimers.forEach(clearTimeout); segmentTimers = [];
  recorders.forEach(r => r.state !== 'inactive' && r.stop());
  await new Promise(resolve => setTimeout(resolve, 500));
  await sending;
  streams.forEach(s => s.getTracks().forEach(t => t.stop())); streams=[]; recorders=[];
  clearInterval(timer); $('clock').textContent='00:00';
  const result = await api.meeting.stop();
  $('live').hidden=true; $('setup').hidden=false;
  if (result?.summary) alert(`${result.summary.summary}\n\nActions:\n${(result.summary.action_items || []).join('\n')}`);
  await loadHistory();
}

async function loadHistory() {
  const meetings = await api.meeting.list();
  $('meetings').innerHTML = meetings.map(m => `<article class="meeting"><strong>${escapeHtml(m.title)}</strong><span>${new Date(m.started_at).toLocaleString()} · ${m.segment_count} segments</span><button class="secondary" data-folder="${escapeHtml(m.folder)}">Open files</button></article>`).join('') || '<p>No meetings yet.</p>';
  document.querySelectorAll('[data-folder]').forEach(button => button.onclick = () => api.meeting.openFolder(button.dataset.folder));
}

$('micPermission').onclick = async () => { await api.permissions.microphone(); };
$('screenPermission').onclick = async () => { await api.permissions.screen(); };
$('saveKey').onclick = async () => { if ($('key').value) { await api.config.saveKey($('key').value); $('key').value=''; error('Key saved to macOS Keychain.'); } };
$('start').onclick = start; $('stop').onclick = stop; $('refresh').onclick = loadHistory;
api.meeting.onTranscript(renderTranscript);
loadHistory();
