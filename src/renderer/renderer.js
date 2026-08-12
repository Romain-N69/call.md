const api = window.callLocal;
const $ = id => document.getElementById(id);
let streams = [], recorders = [], videoRecorder, segmentTimers = [], currentTranscript = [];
let recording = false, startedAt = 0, activeMeetingId, timer, searchTimer;
let sending = Promise.resolve();
const segmentMs = 20000;

function error(message = '') { $('error').textContent = message; }
function formatTime(seconds) { const n=Math.max(0,Math.floor(Number(seconds)||0)); return `${String(Math.floor(n/60)).padStart(2,'0')}:${String(n%60).padStart(2,'0')}`; }
function escapeHtml(value = '') { const div=document.createElement('div'); div.textContent=value; return div.innerHTML; }
function list(value) { return Array.isArray(value) ? value : []; }
function showView(id) { document.querySelectorAll('.view').forEach(v=>v.hidden=v.id!==id); document.querySelectorAll('.tab').forEach(t=>t.classList.toggle('active',t.dataset.view===id)); if(id==='libraryView') loadHistory(); }

function calculateMetrics(items) {
  const values={me:{seconds:0,words:0},them:{seconds:0,words:0}}; let questions=0,longest=0;
  items.forEach(item=>{ const duration=Math.max(0,item.end_time-item.start_time); values[item.channel].seconds+=duration; values[item.channel].words+=(item.text.match(/\S+/g)||[]).length; questions+=(item.text.match(/\?/g)||[]).length; longest=Math.max(longest,duration); });
  const total=values.me.seconds+values.them.seconds;
  return { talkRatio:total?Math.round(values.me.seconds/total*100):0,wpm:values.me.seconds?Math.round(values.me.words/values.me.seconds*60):0,questions,longest:Math.round(longest) };
}
function renderTranscript(items) {
  currentTranscript=items;
  $('transcript').innerHTML=items.map(item=>`<div class="line"><b>${item.channel==='me'?'YOU':'THEM'}</b><time>${formatTime(item.start_time)}</time><span>${escapeHtml(item.text)}</span></div>`).join('');
  $('transcript').scrollTop=$('transcript').scrollHeight;
  const m=calculateMetrics(items); $('talkRatio').textContent=`${m.talkRatio}%`; $('wpm').textContent=m.wpm; $('questions').textContent=m.questions; $('monologue').textContent=`${m.longest}s`;
  const message=m.talkRatio>70?'You are doing most of the talking. Invite the other person in.':m.longest>90?'Long speaking turn detected. Pause and check understanding.':m.wpm>180?'Your pace is high. Slow down for clarity.':'';
  $('nudge').hidden=!message; $('nudge').textContent=message;
}
function createRecorder(stream, channel) {
  const recorder=new MediaRecorder(stream,{mimeType:'audio/webm;codecs=opus'}), segmentStartedAt=Date.now();
  recorder.ondataavailable=event=>{ if(!event.data.size)return; sending=sending.then(async()=>api.meeting.sendSegment({channel,bytes:await event.data.arrayBuffer(),startedAt:segmentStartedAt})).catch(e=>error(e.message)); };
  recorder.onstop=()=>{ recorders=recorders.filter(item=>item!==recorder); if(recording)createRecorder(stream,channel); };
  recorder.start(); recorders.push(recorder);
  const segmentTimer=setTimeout(()=>{ segmentTimers=segmentTimers.filter(t=>t!==segmentTimer); if(recorder.state!=='inactive')recorder.stop(); },segmentMs); segmentTimers.push(segmentTimer);
}
function createVideoRecorder(stream) {
  videoRecorder=new MediaRecorder(new MediaStream(stream.getVideoTracks()),{mimeType:'video/webm;codecs=vp9'});
  videoRecorder.ondataavailable=event=>{ if(!event.data.size)return; const startedAt=Date.now()-segmentMs; sending=sending.then(async()=>api.meeting.sendVideoSegment({bytes:await event.data.arrayBuffer(),startedAt})).catch(e=>error(e.message)); };
  videoRecorder.start(segmentMs);
}
function meter(stream, element) {
  const context=new AudioContext(), analyser=context.createAnalyser(); analyser.fftSize=256; context.createMediaStreamSource(stream).connect(analyser); const data=new Uint8Array(analyser.frequencyBinCount);
  const tick=()=>{ if(!streams.includes(stream))return context.close(); analyser.getByteFrequencyData(data); element.style.width=`${Math.max(4,Math.min(100,data.reduce((a,b)=>a+b,0)/data.length))}%`; requestAnimationFrame(tick); }; tick();
}
async function refreshPermissions() { const state=await api.permissions.get(); [['micStatus',state.microphone],['screenStatus',state.screen]].forEach(([id,ok])=>{ $(id).classList.toggle('granted',ok); $(id).textContent=id==='micStatus'?`Microphone · ${ok?'ready':'needed'}`:`System audio · ${ok?'ready':'needed'}`; }); }
async function refreshKeyStatus(message) { const config=await api.config.get(); $('keyStatus').className=`connection-status ${config.configured?'ok':'bad'}`; $('keyStatus').textContent=message||(config.configured?`Synapse key active · ${config.source==='keychain'?'macOS Keychain':'environment variable'}`:'No Synapse key configured'); $('models').textContent=`${config.baseUrl} · ${config.transcriptionModel} · ${config.chatModel}`; }
async function refreshTranscription() { const state=await api.transcription.get(), prefs=state.preferences; $('modelsPath').value=prefs.modelsPath; $('recognitionEngine').value=prefs.recognitionEngine; document.querySelector(`input[name="provider"][value="${prefs.provider}"]`).checked=true; const whisper=prefs.recognitionEngine==='whisper'; $('localModels').hidden=!whisper; $('parakeetStatus').hidden=whisper; $('parakeetStatus').className=`connection-status ${state.parakeet.installed?'ok':'bad'}`; $('parakeetStatus').textContent=state.parakeet.installed?`Parakeet ready · ${state.parakeet.model}`:'Parakeet model not found. Select a folder containing a NeMo Parakeet ONNX model and tokens.txt.'; $('localModels').innerHTML=Object.entries(state.models).map(([id,m])=>`<label class="model-option"><input type="radio" name="localModel" value="${escapeHtml(id)}" ${prefs.model===id?'checked':''}><span><strong>${escapeHtml(m.label)}</strong><span>${escapeHtml(m.detail)}${m.installed?` · ${escapeHtml(m.path)}`:''}</span></span>${m.installed?'<b>Ready</b>':`<button type="button" data-download="${id}">Download</button>`}</label>`).join(''); if(!document.querySelector('input[name="localModel"]:checked'))document.querySelector('input[name="localModel"]')?.click(); document.querySelectorAll('[data-download]').forEach(button=>button.onclick=async event=>{ event.preventDefault(); button.disabled=true; button.textContent='Downloading…'; try{ await api.transcription.download(button.dataset.download); await refreshTranscription(); }catch(e){ alert(e.message); button.disabled=false; button.textContent='Download'; } }); }
async function start() {
  error();
  try {
    const config=await api.config.get(); if(!config.configured)throw new Error('Open Settings and save your Synapse key first.');
    const mic=await navigator.mediaDevices.getUserMedia({audio:{echoCancellation:true,noiseSuppression:true},video:false});
    const display=await navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
    streams=[mic,display]; const meeting=await api.meeting.start({title:$('title').value.trim(),language:$('meetingLanguage').value}); activeMeetingId=meeting.id; startedAt=meeting.startedAt; recording=true;
    createRecorder(mic,'mic'); createVideoRecorder(display); meter(mic,$('micMeter')); $('systemMeter').style.width='100%'; $('setup').hidden=true; $('live').hidden=false;
    timer=setInterval(()=>$('clock').textContent=formatTime((Date.now()-startedAt)/1000),1000);
  } catch(e) { streams.forEach(s=>s.getTracks().forEach(t=>t.stop())); streams=[]; error(e.message); }
}
async function stop() {
  recording=false; segmentTimers.forEach(clearTimeout); segmentTimers=[]; recorders.forEach(r=>r.state!=='inactive'&&r.stop()); if(videoRecorder?.state!=='inactive')videoRecorder.stop(); await new Promise(r=>setTimeout(r,500)); await sending;
  streams.forEach(s=>s.getTracks().forEach(t=>t.stop())); streams=[]; recorders=[]; videoRecorder=null; clearInterval(timer); $('clock').textContent='00:00';
  const result=await api.meeting.stop(); $('live').hidden=true; $('setup').hidden=false; $('meetingLanguage').value='auto'; activeMeetingId=null; currentTranscript=[]; if(result)await openMeeting(result.id); await loadHistory();
}
async function bookmarkLive() { if(!activeMeetingId)return; const note=prompt('Bookmark note (optional)')||''; await api.meeting.bookmark(activeMeetingId,(Date.now()-startedAt)/1000,note); }
async function loadHistory() {
  const meetings=await api.meeting.list($('search').value.trim());
  $('meetings').innerHTML=meetings.map(m=>`<article class="meeting" data-meeting="${m.id}">${m.favorite?'<i class="star">★</i>':''}<strong>${escapeHtml(m.title)}</strong><span>${new Date(m.started_at).toLocaleString()} · ${m.segment_count} segments</span><p>${escapeHtml(m.summary||m.notes||'Open to view transcript and notes.')}</p></article>`).join('')||'<p>No matching meetings.</p>';
  document.querySelectorAll('[data-meeting]').forEach(card=>card.onclick=()=>openMeeting(card.dataset.meeting));
}
async function openMeeting(id) {
  const m=await api.meeting.get(id); if(!m)return;
  $('detailBody').innerHTML=`<div class="detail-head"><small>${new Date(m.started_at).toLocaleString()}</small><h2>${escapeHtml(m.title)}</h2></div>
    <div class="detail-actions"><button id="favoriteDetail" class="secondary ${m.favorite?'favorite':''}">${m.favorite?'★ Favorited':'☆ Favorite'}</button><button id="exportDetail">Export Markdown</button><button id="retranscribeDetail">Retranscribe</button><button id="folderDetail" class="secondary">Open files</button><button id="deleteDetail" class="danger">Delete</button></div>
    <div class="metrics-strip"><span><b>${m.metrics.talkRatio}%</b>You talk</span><span><b>${m.metrics.wordsPerMinute}</b>WPM</span><span><b>${m.metrics.questions}</b>Questions</span><span><b>${m.metrics.longestMonologue}s</b>Longest turn</span></div>
    <div class="detail-grid"><div><section class="summary-box"><h3>Summary</h3><p>${escapeHtml(m.summary||'No summary available.')}</p><h3>Key points</h3><ul class="list">${list(m.key_points).map(x=>`<li>${escapeHtml(x)}</li>`).join('')||'<li>None</li>'}</ul><h3>Action items</h3><ul class="list">${list(m.action_items).map(x=>`<li><input type="checkbox"> ${escapeHtml(x)}</li>`).join('')||'<li>None</li>'}</ul></section>
      <label>Notes<textarea id="notesDetail">${escapeHtml(m.notes)}</textarea></label><button id="saveNotes">Save notes</button><section class="bookmarks-box"><h3>Bookmarks</h3><div id="bookmarkList">${m.bookmarks.map(b=>`<div class="bookmark"><span>${formatTime(b.at_time)} · ${escapeHtml(b.note||'Important moment')}</span><button class="danger" data-delete-bookmark="${b.id}">×</button></div>`).join('')||'<p>No bookmarks.</p>'}</div></section></div>
      <div><h3>Transcript</h3><div class="detail-transcript">${m.transcript.map(item=>`<div class="line"><b>${item.channel==='me'?'YOU':'THEM'}</b><time>${formatTime(item.start_time)}</time><span>${escapeHtml(item.text)}</span></div>`).join('')||'<p>No transcript.</p>'}</div></div></div>`;
  $('detail').showModal();
  $('favoriteDetail').onclick=async()=>{ await api.meeting.update(id,{title:m.title,notes:$('notesDetail').value,favorite:!m.favorite}); openMeeting(id); loadHistory(); };
  $('saveNotes').onclick=async()=>{ await api.meeting.update(id,{title:m.title,notes:$('notesDetail').value,favorite:m.favorite}); $('saveNotes').textContent='Saved'; loadHistory(); };
  $('exportDetail').onclick=()=>api.meeting.export(id); $('retranscribeDetail').onclick=async()=>{ const language=prompt('Language code, or auto','auto')||'auto'; $('retranscribeDetail').disabled=true; $('retranscribeDetail').textContent='Transcribing…'; try{ await api.meeting.retranscribe(id,language); await openMeeting(id); loadHistory(); }catch(e){ alert(e.message); $('retranscribeDetail').disabled=false; $('retranscribeDetail').textContent='Retranscribe'; } }; $('folderDetail').onclick=()=>api.meeting.openFolder(m.folder);
  $('deleteDetail').onclick=async()=>{ if(confirm('Delete this meeting, transcript, and local recordings?')){ await api.meeting.delete(id); $('detail').close(); loadHistory(); } };
  document.querySelectorAll('[data-delete-bookmark]').forEach(button=>button.onclick=async()=>{ await api.meeting.deleteBookmark(Number(button.dataset.deleteBookmark)); openMeeting(id); });
}

document.querySelectorAll('.tab').forEach(tab=>tab.onclick=()=>showView(tab.dataset.view));
$('micPermission').onclick=async()=>{ await api.permissions.microphone(); refreshPermissions(); }; $('screenPermission').onclick=async()=>{ await api.permissions.screen(); refreshPermissions(); };
$('saveKey').onclick=async()=>{ if(!$('key').value)return; try{ $('keyStatus').textContent='Validating with Synapse…'; await api.config.saveKey($('key').value); $('key').value=''; await refreshKeyStatus('Synapse key validated and active · macOS Keychain'); }catch(e){ $('keyStatus').className='connection-status bad'; $('keyStatus').textContent=e.message; } };
$('testKey').onclick=async()=>{ try{ $('keyStatus').textContent='Testing saved key…'; await api.config.test(); await refreshKeyStatus('Synapse connection successful · saved key is active'); }catch(e){ $('keyStatus').className='connection-status bad'; $('keyStatus').textContent=e.message; } };
$('chooseModelsPath').onclick=async()=>{ const folder=await api.transcription.chooseFolder(); if(folder){ const current=await api.transcription.get(); await api.transcription.save({...current.preferences,modelsPath:folder}); await refreshTranscription(); } };
$('modelsPath').onchange=async()=>{ const current=await api.transcription.get(); await api.transcription.save({...current.preferences,modelsPath:$('modelsPath').value.trim()}); await refreshTranscription(); };
$('recognitionEngine').onchange=()=>{ const whisper=$('recognitionEngine').value==='whisper'; $('localModels').hidden=!whisper; $('parakeetStatus').hidden=whisper; };
$('saveTranscription').onclick=async()=>{ const provider=document.querySelector('input[name="provider"]:checked').value, recognitionEngine=$('recognitionEngine').value, model=document.querySelector('input[name="localModel"]:checked')?.value; const state=await api.transcription.get(); if(provider==='synapse'&&recognitionEngine==='parakeet')return alert('Parakeet runs locally. Select Local · Apple Silicon.'); if(provider==='local'&&recognitionEngine==='whisper'&&!state.models[model]?.installed)return alert('Select an installed Whisper model first.'); if(provider==='local'&&recognitionEngine==='parakeet'&&!state.parakeet.installed)return alert('Select a folder containing a Parakeet ONNX model and tokens.txt first.'); await api.transcription.save({provider,recognitionEngine,model,language:'auto',modelsPath:$('modelsPath').value.trim()}); $('saveTranscription').textContent='Settings saved'; };
$('start').onclick=start; $('stop').onclick=stop; $('bookmarkLive').onclick=bookmarkLive;
$('search').oninput=()=>{ clearTimeout(searchTimer); searchTimer=setTimeout(loadHistory,180); };
api.meeting.onTranscript(renderTranscript); api.meeting.onError(error);
refreshKeyStatus(); refreshTranscription(); refreshPermissions(); loadHistory();
