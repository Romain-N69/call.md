const api = window.callLocal;
const $ = id => document.getElementById(id);
let streams = [], recorders = [], videoRecorder, segmentTimers = [], currentTranscript = [];
let recording = false, stopping = false, startedAt = 0, activeMeetingId, timer, searchTimer, lastFocused;
let liveBookmarks = [];
let writingStream, writingRecorder, writingTimer, writingSegmentTimer, writingStartedAt = 0, activeWritingId, writingRecording = false, writingBusy = false, polishPending = false, polishAgain = false;
let writingDraft = { verbatim: '', polished: '' }, writingVersion = 'verbatim';
let sending = Promise.resolve(), writingSending = Promise.resolve();
const segmentMs = 5000, writingSegmentMs = 12000;

function setError(message = '') {
  $('error').textContent = message;
  $('error').hidden = !message;
  if (message) $('error').focus();
}
function toast(message) {
  $('toast').textContent = message;
  $('toast').hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $('toast').hidden = true, 4000);
}
function processing(status) {
  const percent = Math.max(0, Math.min(100, status.percent));
  $('processing').hidden = false;
  $('processingStage').textContent = status.stage;
  $('processingDetail').textContent = status.detail;
  $('processingBar').style.transform = `scaleX(${percent / 100})`;
  $('processingPercent').textContent = `${percent} %`;
  $('processingTrack').setAttribute('aria-valuenow', percent);
}
function formatTime(seconds) {
  const n = Math.max(0, Math.floor(Number(seconds) || 0));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}
function escapeHtml(value = '') {
  const div = document.createElement('div');
  div.textContent = value;
  return div.innerHTML;
}
function list(value) { return Array.isArray(value) ? value : []; }
function dateLabel(value) { return new Intl.DateTimeFormat(window.i18n.locale(), { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function defaultWritingTitle() { return window.i18n.language === 'en' ? 'New voice document' : 'Nouveau texte vocal'; }
function localizeDefaultTitles() {
  if (['Réunion sans titre', 'Untitled meeting'].includes($('title').value)) $('title').value = window.i18n.language === 'en' ? 'Untitled meeting' : 'Réunion sans titre';
  if (['Nouveau texte vocal', 'New voice document'].includes($('writingTitle').value)) $('writingTitle').value = defaultWritingTitle();
}
function durationLabel(start, end) {
  if (!end) return 'Durée inconnue';
  const minutes = Math.max(1, Math.round((end - start) / 60000));
  return `${minutes} min`;
}
async function withLoading(button, label, task) {
  const original = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  try { return await task(); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = original; }
}
function showView(id, focus = true) {
  document.querySelectorAll('.view').forEach(view => view.hidden = view.id !== id);
  document.querySelectorAll('.tab').forEach(tab => {
    const active = tab.dataset.view === id;
    tab.classList.toggle('active', active);
    tab.setAttribute('aria-selected', active);
    tab.tabIndex = active ? 0 : -1;
  });
  if (id === 'libraryView') loadHistory();
  if (id === 'writeView') loadWritings();
  if (focus) document.querySelector(`#${id} h2`)?.focus();
}
function ask({ title, description, confirm = 'Confirmer', danger = false, label, value = '' }) {
  return new Promise(resolve => {
    lastFocused = document.activeElement;
    $('actionTitle').textContent = title;
    $('actionDescription').textContent = description;
    $('actionConfirm').textContent = confirm;
    $('actionConfirm').className = danger ? 'danger' : 'primary';
    $('actionField').innerHTML = label ? `<label for="actionInput">${escapeHtml(label)}<input id="actionInput" value="${escapeHtml(value)}" autocomplete="off"></label>` : '';
    const finish = result => { $('actionDialog').close(); cleanup(); resolve(result); setTimeout(() => lastFocused?.focus(), 0); };
    const cleanup = () => { $('actionForm').onsubmit = null; $('actionCancel').onclick = null; $('actionDialog').onclose = null; };
    $('actionForm').onsubmit = event => { event.preventDefault(); finish(label ? $('actionInput').value : true); };
    $('actionCancel').onclick = () => finish(false);
    $('actionDialog').onclose = () => { if ($('actionForm').onsubmit) finish(false); };
    $('actionDialog').showModal();
    setTimeout(() => (label ? $('actionInput') : $('actionCancel')).focus(), 0);
  });
}

function calculateMetrics(items) {
  const values = { me: { seconds: 0, words: 0 }, them: { seconds: 0, words: 0 } };
  let questions = 0, longest = 0;
  items.forEach(item => {
    const duration = Math.max(0, item.end_time - item.start_time);
    if (!values[item.channel]) return;
    values[item.channel].seconds += duration;
    values[item.channel].words += (item.text.match(/\S+/g) || []).length;
    questions += (item.text.match(/\?/g) || []).length;
    longest = Math.max(longest, duration);
  });
  const total = values.me.seconds + values.them.seconds;
  return { talkRatio: total ? Math.round(values.me.seconds / total * 100) : 0, wpm: values.me.seconds ? Math.round(values.me.words / values.me.seconds * 60) : 0, questions, longest: Math.round(longest) };
}
function speakerButton(item, meetingId = '') {
  const name = item.channel === 'me' ? 'VOUS' : item.speaker || 'EUX';
  return item.channel === 'me' || name === 'EUX' ? `<b class="speaker ${item.channel}">${escapeHtml(name)}</b>` : `<button class="speaker ${item.channel}" data-speaker="${escapeHtml(name)}" data-meeting="${meetingId}" title="Renommer ${escapeHtml(name)}">${escapeHtml(name)}</button>`;
}
function renderTranscript(items) {
  const container = $('transcript'), appendOnly = items.length >= currentTranscript.length && currentTranscript.every((item, index) => item.start_time === items[index]?.start_time && item.text === items[index]?.text);
  if (!items.length) container.innerHTML = '<div class="empty-state compact"><strong>En attente de paroles</strong><p>La transcription apparaîtra ici après quelques secondes.</p></div>';
  else if (appendOnly) {
    if (!currentTranscript.length) container.textContent = '';
    const fragment = document.createDocumentFragment();
    items.slice(currentTranscript.length).forEach(item => { const line = document.createElement('div'); line.className = 'line'; line.innerHTML = `${speakerButton(item)}<time>${formatTime(item.start_time)}</time><span>${escapeHtml(item.text)}</span>`; fragment.append(line); });
    container.append(fragment);
  } else container.innerHTML = items.map(item => `<div class="line">${speakerButton(item)}<time>${formatTime(item.start_time)}</time><span>${escapeHtml(item.text)}</span></div>`).join('');
  currentTranscript = items;
  container.scrollTop = container.scrollHeight;
  const metric = calculateMetrics(items);
  $('talkRatio').textContent = `${metric.talkRatio} %`;
  $('wpm').textContent = metric.wpm;
  $('questions').textContent = metric.questions;
  $('monologue').textContent = `${metric.longest} s`;
  const message = metric.talkRatio > 70 ? 'Vous occupez la majorité du temps de parole. Invitez votre interlocuteur à répondre.' : metric.longest > 90 ? 'Votre dernier tour de parole est long. Faites une pause pour vérifier la compréhension.' : metric.wpm > 180 ? 'Votre débit est élevé. Ralentissez légèrement pour gagner en clarté.' : '';
  $('nudge').hidden = !message;
  $('nudge').textContent = message;
}
function createRecorder(stream, channel) {
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' }), segmentStartedAt = Date.now();
  recorder.ondataavailable = event => {
    if (!event.data.size) return;
    sending = sending.then(async () => api.meeting.sendSegment({ channel, bytes: await event.data.arrayBuffer(), startedAt: segmentStartedAt })).catch(error => setError(`Transcription interrompue. ${error.message}`));
  };
  recorder.onstop = () => { recorders = recorders.filter(item => item !== recorder); if (recording) createRecorder(stream, channel); };
  recorder.start();
  recorders.push(recorder);
  const segmentTimer = setTimeout(() => { segmentTimers = segmentTimers.filter(value => value !== segmentTimer); if (recorder.state !== 'inactive') recorder.stop(); }, segmentMs);
  segmentTimers.push(segmentTimer);
}
function createVideoRecorder(stream) {
  const [track] = stream.getVideoTracks();
  track.onended = () => { if (recording && !stopping) { toast('Le partage d’écran est terminé. Finalisation de la réunion…'); stop(); } };
  videoRecorder = new MediaRecorder(new MediaStream([track]), { mimeType: 'video/webm;codecs=vp9' });
  videoRecorder.ondataavailable = event => {
    if (!event.data.size) return;
    sending = sending.then(async () => api.meeting.sendVideoSegment({ bytes: await event.data.arrayBuffer(), startedAt })).catch(error => setError(`Vidéo interrompue. ${error.message}`));
  };
  videoRecorder.start(1000);
}
function updateMeter(element, output, value) {
  const percent = Math.max(4, Math.min(100, value));
  element.style.transform = `scaleX(${percent / 100})`;
  element.setAttribute('aria-valuenow', Math.round(percent));
  output.textContent = percent > 12 ? 'actif' : 'calme';
}
function meter(stream, element) {
  const context = new AudioContext(), analyser = context.createAnalyser();
  analyser.fftSize = 256;
  context.createMediaStreamSource(stream).connect(analyser);
  const data = new Uint8Array(analyser.frequencyBinCount);
  let last = 0;
  const tick = now => {
    if (!streams.includes(stream)) return context.close();
    if (now - last > 100) {
      analyser.getByteFrequencyData(data);
      updateMeter(element, $('micValue'), data.reduce((a, b) => a + b, 0) / data.length);
      last = now;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
async function refreshPermissions() {
  try {
    const state = await api.permissions.get();
    [['micStatus', state.microphone, 'Microphone'], ['screenStatus', state.screen, 'Écran et audio système']].forEach(([id, allowed, label]) => {
      $(id).classList.toggle('granted', allowed);
      $(id).textContent = `${label} · ${allowed ? 'autorisé' : 'requis'}`;
      $(id).nextElementSibling.hidden = allowed;
    });
  } catch (error) { setError(`Autorisations indisponibles. ${error.message}`); }
}
async function refreshKeyStatus(message) {
  try {
    const config = await api.config.get();
    $('keyStatus').className = `connection-status ${config.configured ? 'ok' : 'bad'}`;
    $('keyStatus').textContent = message || (config.configured ? `Clé Synapse active · ${config.source === 'keychain' ? 'Trousseau macOS' : 'variable d’environnement'}` : 'Aucune clé Synapse configurée. Collez une clé pour utiliser les modèles cloud.');
    $('models').textContent = `${config.baseUrl} · ${config.transcriptionModel} · ${config.chatModel}`;
  } catch (error) { $('keyStatus').className = 'connection-status bad'; $('keyStatus').textContent = `Connexion non vérifiée. ${error.message}`; }
}
async function refreshTranscription() {
  try {
    const state = await api.transcription.get(), preferences = state.preferences;
    $('modelsPath').value = preferences.modelsPath;
    $('recognitionEngine').value = preferences.recognitionEngine;
    document.querySelector(`input[name="provider"][value="${preferences.provider}"]`).checked = true;
    await renderProvider(preferences.provider, preferences);
    const whisper = preferences.recognitionEngine === 'whisper';
    $('localModels').hidden = preferences.provider === 'synapse' || !whisper;
    $('parakeetStatus').hidden = preferences.provider === 'synapse' || whisper;
    $('parakeetStatus').className = `connection-status ${state.parakeet.installed ? 'ok' : 'bad'}`;
    $('parakeetStatus').textContent = state.parakeet.installed ? `Parakeet prêt · ${state.parakeet.model}` : 'Modèle Parakeet introuvable. Choisissez un dossier avec un modèle NeMo Parakeet ONNX et tokens.txt.';
    $('localModels').innerHTML = Object.entries(state.models).map(([id, model]) => `<label class="model-option"><input type="radio" name="localModel" value="${escapeHtml(id)}" ${preferences.model === id ? 'checked' : ''}><span><strong>${escapeHtml(model.label)}</strong><small>${escapeHtml(model.detail)}${model.installed ? ` · ${escapeHtml(model.path)}` : ''}</small></span>${model.installed ? '<b class="status-tag">Prêt</b>' : `<button type="button" class="secondary" data-download="${id}">Télécharger</button>`}</label>`).join('');
    if (!document.querySelector('input[name="localModel"]:checked')) document.querySelector('input[name="localModel"]')?.click();
    document.querySelectorAll('[data-download]').forEach(button => button.onclick = event => { event.preventDefault(); withLoading(button, 'Téléchargement…', async () => { try { await api.transcription.download(button.dataset.download); await refreshTranscription(); toast('Modèle téléchargé'); } catch (error) { toast(`Téléchargement impossible. ${error.message}`); } }); });
  } catch (error) { $('localModels').innerHTML = `<div class="connection-status bad">Modèles indisponibles. ${escapeHtml(error.message)}</div>`; }
}
async function renderProvider(provider, preferences = {}) {
  const cloud = provider === 'synapse';
  $('synapseModels').hidden = !cloud;
  $('modelsPath').closest('label').hidden = cloud;
  $('recognitionEngine').closest('label').hidden = cloud;
  if (!cloud) return;
  $('synapseModels').innerHTML = '<div class="meeting-skeleton compact" aria-label="Chargement des modèles"><i></i><i></i></div>';
  try {
    const models = await api.config.models();
    $('synapseModels').innerHTML = models.map(model => `<label class="model-option"><input type="radio" name="synapseModel" value="${escapeHtml(model.id)}" ${preferences.synapseModel === model.id || (!preferences.synapseModel && model.id === 'whisper-1@v2-large') ? 'checked' : ''}><span><strong>${escapeHtml(model.id)}</strong><small>Transcription audio</small></span></label>`).join('') || '<div class="empty-state compact"><strong>Aucun modèle disponible</strong><p>Testez la connexion Synapse puis réessayez.</p></div>';
  } catch (error) { $('synapseModels').innerHTML = `<div class="connection-status bad">Modèles Synapse indisponibles. ${escapeHtml(error.message)}</div>`; }
}

async function start() {
  setError();
  await withLoading($('start'), 'Préparation…', async () => {
    try {
      const config = await api.config.get();
      if (!config.configured) throw new Error('Ouvrez Réglages et enregistrez votre clé Synapse avant de démarrer.');
      const title = $('title').value.trim();
      if (!title) throw new Error('Ajoutez un titre à la réunion.');
      const mic = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
      const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      streams = [mic, display];
      const meeting = await api.meeting.start({ title, language: $('meetingLanguage').value, vocabulary: $('vocabulary').value });
      activeMeetingId = meeting.id;
      startedAt = meeting.startedAt;
      recording = true;
      createRecorder(mic, 'mic');
      createVideoRecorder(display);
      meter(mic, $('micMeter'));
      $('setup').hidden = true;
      $('live').hidden = false;
      $('stop').focus();
      liveBookmarks = []; renderTimeline();
      timer = setInterval(() => { const seconds = (Date.now() - startedAt) / 1000; $('clock').textContent = formatTime(seconds); $('timelineProgress').style.transform = `scaleX(${Math.min(1, seconds / 3600)})`; }, 1000);
      toast('Réunion démarrée');
    } catch (error) {
      streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
      streams = [];
      setError(`Impossible de démarrer. ${error.message}`);
    }
  });
}
async function stop() {
  if (!recording || stopping) return;
  stopping = true;
  $('stop').disabled = true;
  $('stop').textContent = 'Finalisation…';
  processing({ stage: 'Enregistrement des médias', detail: 'Fermeture du microphone, de l’audio système et de la vidéo…', percent: 10 });
  try {
    recording = false;
    segmentTimers.forEach(clearTimeout);
    segmentTimers = [];
    recorders.forEach(recorder => recorder.state !== 'inactive' && recorder.stop());
    if (videoRecorder?.state !== 'inactive') videoRecorder.stop();
    await new Promise(resolve => setTimeout(resolve, 500));
    await sending;
    streams.forEach(stream => stream.getTracks().forEach(track => track.stop()));
    streams = []; recorders = []; videoRecorder = null;
    clearInterval(timer);
    $('clock').textContent = '00:00';
    const result = await api.meeting.stop();
    $('live').hidden = true; $('setup').hidden = false; $('meetingLanguage').value = 'auto';
    activeMeetingId = null; currentTranscript = []; $('processing').hidden = true;
    toast('Réunion sauvegardée');
    if (result) await openMeeting(result.id);
    await loadHistory();
  } catch (error) {
    $('processing').hidden = true;
    setError(`La réunion n’a pas pu être finalisée. ${error.message} Vos fichiers locaux ont été conservés.`);
    toast('Finalisation interrompue');
  } finally {
    stopping = false;
    $('stop').disabled = false;
    $('stop').textContent = 'Terminer la réunion';
  }
}
function renderTimeline() {
  const duration = Math.max(1, (Date.now() - startedAt) / 1000);
  $('liveTimeline').querySelectorAll('.timeline-marker').forEach(marker => marker.remove());
  liveBookmarks.forEach((bookmark, index) => { const marker = document.createElement('button'); marker.className = 'timeline-marker'; marker.style.left = `${Math.min(98, bookmark.at_time / duration * 100)}%`; marker.title = `${formatTime(bookmark.at_time)} · ${bookmark.note || 'Repère'}`; marker.setAttribute('aria-label', marker.title); marker.dataset.index = index; $('liveTimeline').append(marker); });
}
async function bookmarkLive() {
  if (!activeMeetingId) return;
  const atTime = (Date.now() - startedAt) / 1000;
  const note = await ask({ title: `Repère à ${formatTime(atTime)}`, description: 'Ajoutez une note courte à ce point de la timeline.', confirm: 'Ajouter', label: 'Note facultative' });
  if (note === false) return;
  await api.meeting.bookmark(activeMeetingId, atTime, note.trim());
  liveBookmarks.push({ at_time: atTime, note: note.trim() }); renderTimeline(); toast('Repère ajouté à la timeline');
}
function writingOptions() {
  return { title: $('writingTitle').value, sourceLanguage: $('writingLanguage').value, targetLanguage: $('writingTarget').value, format: document.querySelector('input[name="writingFormat"]:checked').value, tone: $('writingTone').value, intensity: $('writingIntensity').value, styleExample: $('styleExample').value };
}
function writingStatus(text, active = false) {
  $('writingState').textContent = text; $('writingState').classList.toggle('active', active);
}
function renderWriting(version = writingVersion) {
  writingVersion = version;
  const polished = version === 'polished';
  $('verbatimTab').classList.toggle('active', !polished); $('polishedTab').classList.toggle('active', polished);
  $('verbatimTab').setAttribute('aria-selected', !polished); $('polishedTab').setAttribute('aria-selected', polished);
  $('editorLabel').textContent = polished ? 'Version corrigée, prête à utiliser' : 'Vos mots, sans modification';
  $('writingText').value = writingDraft[version] || '';
  $('writingText').placeholder = polished ? 'Cliquez sur « Corriger avec Synapse » pour créer cette version.' : 'Commencez à parler ou écrivez ici…';
  const words = (writingDraft.verbatim.match(/\S+/g) || []).length, spoken = writingStartedAt ? (Date.now() - writingStartedAt) / 60000 : 0, saved = Math.max(0, words / 40 - spoken);
  $('writingWords').textContent = words; $('writingSaved').textContent = saved.toFixed(1); $('savedTime').textContent = words > 20 && spoken ? `${Math.max(1, Math.round(words / 40 / spoken))}×` : '5×';
}
function persistStyle() {
  localStorage.setItem('writing-style-example', $('styleExample').value);
  localStorage.setItem('writing-options', JSON.stringify(writingOptions()));
}
function createWritingRecorder(stream) {
  const recorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' }); writingRecorder = recorder;
  recorder.ondataavailable = event => {
    clearTimeout(writingSegmentTimer);
    if (!event.data.size || !activeWritingId) return;
    writingBusy = true; writingStatus('Transcription…', true);
    writingSending = writingSending.then(async () => {
      const result = await api.writing.sendSegment({ id: activeWritingId, bytes: await event.data.arrayBuffer() });
      if (result.text) writingDraft.verbatim = `${writingDraft.verbatim} ${result.text}`.trim();
      if (result.detectedLanguage) $('writingLanguageLock').textContent = `Langue détectée · ${result.detectedLanguage.toUpperCase()}`;
      if (writingVersion === 'verbatim') renderWriting('verbatim'); else $('writingWords').textContent = (writingDraft.verbatim.match(/\S+/g) || []).length;
      if ($('livePolish').checked && writingDraft.verbatim) polishWriting(true);
    }).catch(error => { $('writingError').textContent = `Transcription interrompue. ${error.message}`; }).finally(() => { writingBusy = false; if (writingRecording) writingStatus('À l’écoute', true); });
  };
  recorder.onstop = () => { if (writingRecorder === recorder) writingRecorder = null; if (writingRecording) createWritingRecorder(stream); };
  recorder.start();
  writingSegmentTimer = setTimeout(() => recorder.state !== 'inactive' && recorder.stop(), writingSegmentMs);
}
async function toggleDictation() {
  if (writingRecording) return stopDictation();
  $('writingError').textContent = '';
  try {
    writingStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
    const writing = await api.writing.start(writingOptions()); activeWritingId = writing.id; writingStartedAt = writing.createdAt; writingDraft = { verbatim: '', polished: '' };
    writingRecording = true; $('dictate').classList.add('recording'); $('dictate').querySelector('span:nth-child(2)').textContent = 'Arrêter la dictée'; $('writingWave').hidden = false; writingStatus('À l’écoute', true); renderWriting('verbatim'); createWritingRecorder(writingStream);
    writingTimer = setInterval(() => { $('writingClock').textContent = formatTime((Date.now() - writingStartedAt) / 1000); renderWriting(writingVersion); }, 1000);
  } catch (error) { $('writingError').textContent = `Impossible de démarrer la dictée. ${error.message}`; }
}
async function stopDictation() {
  if (!writingRecording) return;
  writingRecording = false; clearTimeout(writingSegmentTimer); clearInterval(writingTimer);
  const finalRecorder = writingRecorder;
  if (finalRecorder?.state !== 'inactive') {
    await new Promise(resolve => { finalRecorder.addEventListener('stop', resolve, { once: true }); finalRecorder.stop(); });
  }
  writingStream?.getTracks().forEach(track => track.stop()); writingStream = null;
  $('dictate').disabled = true; writingStatus('Finalisation…', true);
  try {
    await writingSending; const result = await api.writing.stop(activeWritingId);
    writingDraft.verbatim = result?.verbatim || writingDraft.verbatim; renderWriting('verbatim'); writingStatus('Brouillon prêt');
    if ($('livePolish').checked && writingDraft.verbatim) await polishWriting();
    await loadWritings();
  } catch (error) { $('writingError').textContent = `Finalisation interrompue. ${error.message}`; writingStatus('Brouillon conservé'); }
  finally { $('dictate').disabled = false; $('dictate').classList.remove('recording'); $('dictate').querySelector('span:nth-child(2)').textContent = 'Commencer à dicter'; $('writingWave').hidden = true; }
}
async function polishWriting(background = false) {
  if (writingVersion === 'verbatim') writingDraft.verbatim = $('writingText').value;
  if (!writingDraft.verbatim.trim()) return toast('Dictez ou saisissez un texte avant de le corriger');
  if (writingBusy && !background) return;
  if (background && polishPending) { polishAgain = true; return; }
  const button = $('polish'), run = async () => {
    if (!activeWritingId) { const writing = await api.writing.start(writingOptions()); activeWritingId = writing.id; writingStartedAt = writing.createdAt; await api.writing.stop(activeWritingId); }
    const source = writingDraft.verbatim; polishPending = true;
    const result = await api.writing.polish(activeWritingId, { ...writingOptions(), verbatim: source });
    if (source === writingDraft.verbatim) writingDraft.polished = result.polished;
    renderWriting(background && writingVersion === 'verbatim' ? 'verbatim' : 'polished'); writingStatus('Texte corrigé'); persistStyle(); await loadWritings();
  };
  try { writingStatus('Correction…', true); background ? await run() : await withLoading(button, 'Correction…', run); }
  catch (error) { $('writingError').textContent = `Correction impossible. ${error.message}`; writingStatus('Brouillon conservé'); }
  finally { polishPending = false; if (polishAgain) { polishAgain = false; polishWriting(true); } }
}
async function loadWritings() {
  const writings = await api.writing.list();
  $('writings').innerHTML = writings.length ? writings.map(item => `<article class="writing-card"><button data-writing="${item.id}" type="button"><span><strong>${escapeHtml(item.title)}</strong><small>${dateLabel(item.updated_at)}</small></span><p>${escapeHtml(item.polished || item.verbatim || 'Dictée vide')}</p><b>${item.polished ? 'Corrigé' : 'Verbatim'}</b></button><button class="writing-delete" data-delete-writing="${item.id}" aria-label="Supprimer ${escapeHtml(item.title)}" type="button">×</button></article>`).join('') : '<div class="empty-state compact"><strong>Aucun texte pour le moment</strong><p>Votre première dictée apparaîtra ici.</p></div>';
  document.querySelectorAll('[data-writing]').forEach(card => card.onclick = () => openWriting(card.dataset.writing));
  document.querySelectorAll('[data-delete-writing]').forEach(button => button.onclick = async () => { if (!await ask({ title: 'Supprimer ce texte ?', description: 'Le texte et son enregistrement audio local seront supprimés définitivement.', confirm: 'Supprimer définitivement', danger: true })) return; await api.writing.delete(button.dataset.deleteWriting); if (activeWritingId === button.dataset.deleteWriting) newWriting(); await loadWritings(); toast('Texte supprimé'); });
}
async function openWriting(id) {
  const item = await api.writing.get(id); if (!item) return;
  activeWritingId = id; writingStartedAt = item.created_at; writingDraft = { verbatim: item.verbatim, polished: item.polished };
  $('writingTitle').value = item.title; $('writingLanguage').value = item.source_language; $('writingTarget').value = item.target_language; $('writingTone').value = item.tone; $('writingIntensity').value = item.intensity;
  document.querySelector(`input[name="writingFormat"][value="${item.format}"]`).checked = true; renderWriting(item.polished ? 'polished' : 'verbatim'); writingStatus(item.polished ? 'Texte corrigé' : 'Brouillon prêt');
}
function newWriting() {
  activeWritingId = null; writingStartedAt = 0; writingDraft = { verbatim: '', polished: '' }; $('writingTitle').value = defaultWritingTitle(); $('writingClock').textContent = '00:00'; $('writingLanguageLock').textContent = 'Langue automatique'; renderWriting('verbatim'); writingStatus('Prêt');
}
const libraryIcons = {
  edit: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="m4 16-.8 4 4-.8L18 8.4 15.6 6 4 16zM14 7.5l2.5 2.5"/></svg>',
  archive: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 8h16v12H4zM3 4h18v4H3zM9 12h6"/></svg>',
  restore: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 8h16v12H4zM3 4h18v4H3zM8 14l3-3 3 3M11 11v6"/></svg>',
  delete: '<svg aria-hidden="true" viewBox="0 0 24 24"><path d="M4 7h16M9 7V4h6v3M7 7l1 13h8l1-13M10 11v5M14 11v5"/></svg>',
};
async function editMeetingQuick(meeting) {
  const title = await ask({ title: 'Modifier la réunion', description: 'Changez son titre. La transcription et les fichiers restent inchangés.', confirm: 'Sauvegarder', label: 'Titre', value: meeting.title });
  if (!title?.trim() || title.trim() === meeting.title) return;
  await api.meeting.update(meeting.id, { title: title.trim().slice(0, 120), notes: meeting.notes, favorite: meeting.favorite }); toast('Titre modifié'); loadHistory();
}
async function archiveMeetingQuick(meeting) {
  await api.meeting.archive(meeting.id, !Boolean(meeting.archived)); toast(meeting.archived ? 'Réunion restaurée' : 'Réunion archivée'); loadHistory();
}
async function deleteMeetingQuick(meeting) {
  if (!await ask({ title: 'Supprimer cette réunion ?', description: 'La transcription et tous les enregistrements locaux seront supprimés définitivement.', confirm: 'Supprimer définitivement', danger: true })) return;
  await api.meeting.delete(meeting.id); toast('Réunion supprimée'); loadHistory();
}
async function loadHistory() {
  try {
    const query = $('search').value.trim(), archived = $('libraryScope').value === 'archived', meetings = await api.meeting.list(query, archived), byId = new Map(meetings.map(meeting => [meeting.id, meeting]));
    $('meetings').innerHTML = meetings.length ? meetings.map(meeting => `<article class="meeting-card"><button class="meeting-main" type="button" data-meeting="${meeting.id}" aria-label="Ouvrir ${escapeHtml(meeting.title)}"><span class="meeting-head"><strong>${escapeHtml(meeting.title)}</strong>${meeting.favorite ? '<span class="favorite-mark">Favori</span>' : ''}</span><span class="meeting-meta"><time>${dateLabel(meeting.started_at)}</time><i>·</i><span>${meeting.segment_count} segment${meeting.segment_count === 1 ? '' : 's'}</span></span><p>${escapeHtml(meeting.summary || meeting.notes || 'Aucun compte rendu.')}</p></button><div class="meeting-quick" aria-label="Actions rapides"><button data-edit-meeting="${meeting.id}" title="Modifier (E)" aria-label="Modifier ${escapeHtml(meeting.title)}">${libraryIcons.edit}</button><button data-archive-meeting="${meeting.id}" title="${archived ? 'Restaurer' : 'Archiver'} (A)" aria-label="${archived ? 'Restaurer' : 'Archiver'} ${escapeHtml(meeting.title)}">${archived ? libraryIcons.restore : libraryIcons.archive}</button><button data-delete-meeting="${meeting.id}" class="quick-danger" title="Supprimer (Suppr)" aria-label="Supprimer ${escapeHtml(meeting.title)}">${libraryIcons.delete}</button></div></article>`).join('') : `<div class="empty-state compact"><span class="empty-icon" aria-hidden="true"></span><h3>${query ? 'Aucun résultat' : archived ? 'Aucune réunion archivée' : 'Aucune réunion'}</h3><p>${query ? 'Essayez un autre mot-clé.' : archived ? 'Les réunions archivées apparaîtront ici.' : 'Démarrez une réunion pour la retrouver ici.'}</p>${query ? '<button id="clearSearch" class="secondary" type="button">Effacer la recherche</button>' : !archived ? '<button id="emptyStart" class="primary" type="button">Démarrer une réunion</button>' : ''}</div>`;
    $('meetings').querySelectorAll('[data-meeting]').forEach(card => { const meeting = byId.get(card.dataset.meeting); card.onclick = () => openMeeting(meeting.id); card.onkeydown = event => { if (event.key.toLowerCase() === 'e') { event.preventDefault(); editMeetingQuick(meeting); } else if (event.key.toLowerCase() === 'a') { event.preventDefault(); archiveMeetingQuick(meeting); } else if (['Delete', 'Backspace'].includes(event.key)) { event.preventDefault(); deleteMeetingQuick(meeting); } }; });
    $('meetings').querySelectorAll('[data-edit-meeting]').forEach(button => button.onclick = () => editMeetingQuick(byId.get(button.dataset.editMeeting)));
    $('meetings').querySelectorAll('[data-archive-meeting]').forEach(button => button.onclick = () => archiveMeetingQuick(byId.get(button.dataset.archiveMeeting)));
    $('meetings').querySelectorAll('[data-delete-meeting]').forEach(button => button.onclick = () => deleteMeetingQuick(byId.get(button.dataset.deleteMeeting)));
    $('clearSearch')?.addEventListener('click', () => { $('search').value = ''; loadHistory(); $('search').focus(); });
    $('emptyStart')?.addEventListener('click', () => showView('recordView'));
  } catch (error) { $('meetings').innerHTML = `<div class="empty-state"><h3>Bibliothèque indisponible</h3><p>${escapeHtml(error.message)}</p><button id="retryHistory" class="secondary" type="button">Réessayer</button></div>`; $('retryHistory').onclick = loadHistory; }
}
async function openMeeting(id) {
  try {
    const meeting = await api.meeting.get(id);
    if (!meeting) return;
    const duration = Math.max(1, (meeting.ended_at - meeting.started_at) / 1000);
    const speakers = [...new Set(meeting.transcript.filter(item => item.channel === 'them' && item.speaker).map(item => item.speaker))];
    $('detailBody').innerHTML = `<div class="detail-head"><small>${dateLabel(meeting.started_at)} · ${durationLabel(meeting.started_at, meeting.ended_at)}</small><h2 id="detailTitle">${escapeHtml(meeting.title)}</h2></div>
      <div class="detail-actions"><button id="editDetail" class="secondary">Modifier</button><button id="favoriteDetail" class="secondary ${meeting.favorite ? 'favorite' : ''}">${meeting.favorite ? 'Retirer des favoris' : 'Ajouter aux favoris'}</button><button id="archiveDetail" class="secondary">${meeting.archived ? 'Restaurer' : 'Archiver'}</button><button id="exportDetail" class="primary">Exporter</button><button id="retranscribeDetail" class="secondary">Retranscrire</button><button id="folderDetail" class="secondary">Fichiers</button><button id="deleteDetail" class="danger push-right">Supprimer</button></div>
      <div class="speaker-toolbar"><span>Voix reconnues</span>${speakers.map(speaker => `<button class="speaker them" data-speaker="${escapeHtml(speaker)}" data-meeting="${id}" title="Renommer ${escapeHtml(speaker)}">${escapeHtml(speaker)}</button>`).join('') || '<small>Aucune voix séparée</small>'}</div>
      <div class="detail-timeline timeline">${meeting.bookmarks.map(bookmark => `<button class="timeline-marker" style="left:${Math.min(98, bookmark.at_time / duration * 100)}%" title="${formatTime(bookmark.at_time)} · ${escapeHtml(bookmark.note || 'Repère')}" data-scroll-time="${bookmark.at_time}" aria-label="Aller au repère ${formatTime(bookmark.at_time)}"></button>`).join('')}</div>
      <div class="metrics-strip"><span><b>${meeting.metrics.talkRatio} %</b>Votre temps de parole</span><span><b>${meeting.metrics.wordsPerMinute}</b>Mots par minute</span><span><b>${meeting.metrics.questions}</b>Questions</span><span><b>${meeting.metrics.longestMonologue} s</b>Tour le plus long</span></div>
      <div class="detail-grid"><div><section class="summary-box"><h3>Compte rendu</h3><p>${escapeHtml(meeting.summary || 'Aucun compte rendu disponible. Relancez la transcription pour réessayer.')}</p><h3>Points clés</h3><ul class="list">${list(meeting.key_points).map(point => `<li>${escapeHtml(point)}</li>`).join('') || '<li>Aucun point clé détecté.</li>'}</ul><h3>Actions</h3><ul class="list actions">${list(meeting.action_items).map((item, index) => `<li><input id="action-${index}" type="checkbox"><label for="action-${index}">${escapeHtml(item)}</label></li>`).join('') || '<li>Aucune action détectée.</li>'}</ul></section>
        <label for="notesDetail">Notes<textarea id="notesDetail">${escapeHtml(meeting.notes)}</textarea></label><button id="saveNotes" class="primary">Enregistrer les notes</button><section class="bookmarks-box"><h3>Repères</h3><div id="bookmarkList">${meeting.bookmarks.map(bookmark => `<div class="bookmark"><span><time>${formatTime(bookmark.at_time)}</time>${escapeHtml(bookmark.note || 'Moment important')}</span><button class="danger icon-button" aria-label="Supprimer le repère à ${formatTime(bookmark.at_time)}" data-delete-bookmark="${bookmark.id}"><svg aria-hidden="true" viewBox="0 0 24 24"><path d="m6 6 12 12M18 6 6 18"/></svg></button></div>`).join('') || '<p>Aucun repère.</p>'}</div></section></div>
        <div><h3>Transcription</h3><div class="detail-transcript">${meeting.transcript.map(item => `<div class="line" data-at="${item.start_time}">${speakerButton(item, id)}<time>${formatTime(item.start_time)}</time><span>${escapeHtml(item.text)}</span></div>`).join('') || '<div class="empty-state compact"><strong>Aucune transcription</strong><p>Relancez la transcription à partir des fichiers audio conservés.</p></div>'}</div></div></div>`;
    $('detail').dataset.meetingId = id;
    if (!$('detail').open) $('detail').showModal();
    $('detailTitle').focus();
    $('editDetail').onclick = async () => { const title = await ask({ title: 'Modifier la réunion', description: 'Changez son titre.', confirm: 'Sauvegarder', label: 'Titre', value: meeting.title }); if (!title?.trim() || title.trim() === meeting.title) return; await api.meeting.update(id, { title: title.trim().slice(0, 120), notes: $('notesDetail').value, favorite: meeting.favorite }); toast('Titre modifié'); await openMeeting(id); loadHistory(); };
    $('favoriteDetail').onclick = async () => { await api.meeting.update(id, { title: meeting.title, notes: $('notesDetail').value, favorite: !meeting.favorite }); toast(meeting.favorite ? 'Retiré des favoris' : 'Ajouté aux favoris'); await openMeeting(id); loadHistory(); };
    $('archiveDetail').onclick = async () => { await api.meeting.archive(id, !meeting.archived); $('detail').close(); toast(meeting.archived ? 'Réunion restaurée' : 'Réunion archivée'); loadHistory(); };
    $('saveNotes').onclick = () => withLoading($('saveNotes'), 'Enregistrement…', async () => { await api.meeting.update(id, { title: meeting.title, notes: $('notesDetail').value, favorite: meeting.favorite }); toast('Notes enregistrées'); loadHistory(); });
    $('exportDetail').onclick = async () => { await api.meeting.export(id); toast('Export Markdown créé'); };
    $('retranscribeDetail').onclick = async () => { const language = await ask({ title: 'Relancer la transcription', description: 'Utilisez « auto » ou un code de langue, par exemple fr ou en.', confirm: 'Relancer', label: 'Langue', value: 'auto' }); if (language === false) return; await withLoading($('retranscribeDetail'), 'Transcription…', async () => { try { await api.meeting.retranscribe(id, language.trim() || 'auto'); toast('Transcription terminée'); await openMeeting(id); loadHistory(); } catch (error) { toast(`Transcription impossible. ${error.message}`); } }); };
    $('folderDetail').onclick = () => api.meeting.openFolder(meeting.folder);
    $('deleteDetail').onclick = async () => { const confirmed = await ask({ title: 'Supprimer cette réunion ?', description: 'La transcription, les notes et tous les enregistrements locaux seront supprimés définitivement.', confirm: 'Supprimer définitivement', danger: true }); if (!confirmed) return; await api.meeting.delete(id); $('detail').close(); toast('Réunion supprimée'); loadHistory(); };
    document.querySelectorAll('[data-delete-bookmark]').forEach(button => button.onclick = async () => { await api.meeting.deleteBookmark(Number(button.dataset.deleteBookmark)); toast('Repère supprimé'); openMeeting(id); });
    document.querySelectorAll('[data-scroll-time]').forEach(marker => marker.onclick = () => { const target = [...document.querySelectorAll('.detail-transcript .line')].find(line => Number(line.dataset.at) >= Number(marker.dataset.scrollTime)); target?.scrollIntoView({ block: 'center' }); target?.classList.add('highlight'); setTimeout(() => target?.classList.remove('highlight'), 1200); });
    document.querySelectorAll('[data-speaker][data-meeting]').forEach(button => button.onclick = async () => { const name = await ask({ title: 'Renommer cette voix', description: 'Le nouveau nom sera appliqué à toutes ses interventions.', confirm: 'Renommer', label: 'Nom', value: button.dataset.speaker }); if (!name || name === button.dataset.speaker) return; await api.meeting.renameSpeaker(id, button.dataset.speaker, name); toast(`Voix renommée ${name}`); openMeeting(id); });
  } catch (error) { toast(`Réunion indisponible. ${error.message}`); }
}

const tabs = [...document.querySelectorAll('.tab')];
tabs.forEach((tab, index) => {
  tab.onclick = () => showView(tab.dataset.view, false);
  tab.onkeydown = event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus(); tabs[next].click();
  };
});
$('micPermission').onclick = () => withLoading($('micPermission'), 'Ouverture…', async () => { await api.permissions.microphone(); await refreshPermissions(); });
$('screenPermission').onclick = () => withLoading($('screenPermission'), 'Ouverture…', async () => { await api.permissions.screen(); await refreshPermissions(); });
$('saveKey').onclick = async () => {
  if (!$('key').value) { $('key').focus(); $('keyStatus').className = 'connection-status bad'; $('keyStatus').textContent = 'Collez une nouvelle clé Synapse avant de l’enregistrer.'; return; }
  await withLoading($('saveKey'), 'Validation…', async () => { try { $('keyStatus').textContent = 'Validation auprès de Synapse…'; await api.config.saveKey($('key').value); $('key').value = ''; await refreshKeyStatus('Clé Synapse validée et enregistrée dans le Trousseau macOS.'); toast('Clé Synapse enregistrée'); } catch (error) { $('keyStatus').className = 'connection-status bad'; $('keyStatus').textContent = `Clé refusée. ${error.message} Vérifiez la clé puis réessayez.`; } });
};
$('testKey').onclick = () => withLoading($('testKey'), 'Test…', async () => { try { await api.config.test(); await refreshKeyStatus('Connexion Synapse réussie. La clé actuelle est active.'); toast('Connexion Synapse réussie'); } catch (error) { $('keyStatus').className = 'connection-status bad'; $('keyStatus').textContent = `Connexion impossible. ${error.message} Vérifiez votre réseau ou remplacez la clé.`; } });
$('chooseModelsPath').onclick = async () => { const folder = await api.transcription.chooseFolder(); if (folder) { const current = await api.transcription.get(); await api.transcription.save({ ...current.preferences, modelsPath: folder }); await refreshTranscription(); toast('Dossier des modèles mis à jour'); } };
$('modelsPath').onchange = async () => { const current = await api.transcription.get(); await api.transcription.save({ ...current.preferences, modelsPath: $('modelsPath').value.trim() }); await refreshTranscription(); };
document.querySelectorAll('input[name="provider"]').forEach(input => input.onchange = async () => { const state = await api.transcription.get(); await renderProvider(input.value, state.preferences); const cloud = input.value === 'synapse', whisper = $('recognitionEngine').value === 'whisper'; $('localModels').hidden = cloud || !whisper; $('parakeetStatus').hidden = cloud || whisper; });
$('recognitionEngine').onchange = () => { const whisper = $('recognitionEngine').value === 'whisper'; $('localModels').hidden = !whisper; $('parakeetStatus').hidden = whisper; };
$('saveTranscription').onclick = () => withLoading($('saveTranscription'), 'Enregistrement…', async () => {
  const provider = document.querySelector('input[name="provider"]:checked').value, recognitionEngine = $('recognitionEngine').value, model = document.querySelector('input[name="localModel"]:checked')?.value, state = await api.transcription.get();
  if (provider === 'synapse' && recognitionEngine === 'parakeet') return toast('Parakeet fonctionne en local. Sélectionnez Local · Apple Silicon.');
  if (provider === 'local' && recognitionEngine === 'whisper' && !state.models[model]?.installed) return toast('Sélectionnez d’abord un modèle Whisper installé.');
  if (provider === 'local' && recognitionEngine === 'parakeet' && !state.parakeet.installed) return toast('Choisissez un dossier contenant un modèle Parakeet ONNX et tokens.txt.');
  await api.transcription.save({ provider, recognitionEngine, model, synapseModel: document.querySelector('input[name="synapseModel"]:checked')?.value, language: 'auto', modelsPath: $('modelsPath').value.trim() });
  toast('Réglages de transcription enregistrés');
});
$('start').onclick = start; $('stop').onclick = stop; $('bookmarkLive').onclick = bookmarkLive;
$('dictate').onclick = toggleDictation; $('polish').onclick = () => polishWriting();
$('verbatimTab').onclick = () => renderWriting('verbatim'); $('polishedTab').onclick = () => renderWriting('polished');
$('writingText').oninput = () => { writingDraft[writingVersion] = $('writingText').value; renderWriting(writingVersion); if (activeWritingId) api.writing.update(activeWritingId, { [writingVersion]: writingDraft[writingVersion] }); };
$('copyWriting').onclick = async () => { const text = writingDraft[writingVersion].trim(); if (!text) return toast('Aucun texte à copier'); await navigator.clipboard.writeText(text); toast('Texte copié'); };
$('exportWriting').onclick = async () => { if (!activeWritingId) return toast('Enregistrez d’abord une dictée'); const file = await api.writing.export(activeWritingId); if (file) toast('Texte exporté'); };
$('clearWriting').onclick = async () => { if (writingRecording) return; if ((writingDraft.verbatim || writingDraft.polished) && !await ask({ title: 'Créer un nouveau texte ?', description: 'La dictée actuelle reste enregistrée dans les textes récents.', confirm: 'Créer un texte' })) return; newWriting(); };
$('styleExample').oninput = persistStyle;
$('search').oninput = () => { clearTimeout(searchTimer); searchTimer = setTimeout(loadHistory, 180); };
$('libraryScope').onchange = loadHistory;
document.querySelectorAll('[data-ui-language]').forEach(button => button.onclick = () => window.i18n.setLanguage(button.dataset.uiLanguage));
window.addEventListener('app-language', () => { localizeDefaultTitles(); loadHistory(); loadWritings(); window.i18n.apply(); });
api.meeting.onTranscript(renderTranscript);
api.meeting.onProcessing(processing);
api.meeting.onSystemLevel(db => updateMeter($('systemMeter'), $('systemValue'), (db + 60) / 60 * 100));
api.meeting.onError(message => setError(`Erreur de capture. ${message}`));
api.app.onCloseRequested(async quit => {
  const confirmed = await ask({ title: 'Terminer avant de quitter ?', description: writingRecording ? 'La dictée doit être finalisée pour conserver les dernières paroles.' : 'La réunion doit être finalisée pour conserver la vidéo et les dernières paroles.', confirm: 'Terminer et quitter', danger: true });
  if (!confirmed) return;
  if (writingRecording) await stopDictation(); else await stop();
  await api.app.close(quit);
});
$('detail').addEventListener('close', () => lastFocused?.focus());
document.addEventListener('keydown', event => { if (event.metaKey && event.key === '1') { event.preventDefault(); showView('recordView'); } if (event.metaKey && event.key === '2') { event.preventDefault(); showView('writeView'); } if (event.metaKey && event.key === '3') { event.preventDefault(); showView('libraryView'); } if (event.metaKey && event.key.toLowerCase() === 'd' && !['INPUT','TEXTAREA'].includes(document.activeElement.tagName)) { event.preventDefault(); showView('writeView', false); toggleDictation(); } if (event.metaKey && event.key === ',') { event.preventDefault(); showView('settingsView'); } });

try { const saved = JSON.parse(localStorage.getItem('writing-options') || '{}'); $('styleExample').value = localStorage.getItem('writing-style-example') || ''; ['writingLanguage','writingTarget','writingTone','writingIntensity'].forEach(id => { const key = { writingLanguage: 'sourceLanguage', writingTarget: 'targetLanguage', writingTone: 'tone', writingIntensity: 'intensity' }[id]; if (saved[key] && [...$(id).options].some(option => option.value === saved[key])) $(id).value = saved[key]; }); if (saved.format) document.querySelector(`input[name="writingFormat"][value="${saved.format}"]`)?.click(); } catch {}
localizeDefaultTitles();
showView('recordView', false);
refreshKeyStatus();
refreshTranscription();
refreshPermissions();
loadHistory();
loadWritings();
