const { execFile } = require('node:child_process');
const fs = require('node:fs');
const { promisify } = require('node:util');
const exec = promisify(execFile);

const BASE_URL = 'https://llm.synapse.thalescloud.io/v1';
const TRANSCRIPTION_MODEL = 'whisper-1@v2-large';
const CHAT_MODEL = 'gpt-4o@2024-11-20';
const TIMEOUT_MS = 90_000;
const AUDIO_TIMEOUT_MS = 10 * 60_000;
function request(url, { timeoutMs = TIMEOUT_MS, ...options } = {}) { return fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) }); }

async function models(apiKey) {
  const response = await request(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`Synapse rejected this key (${response.status})`);
  return (await response.json()).data || [];
}

async function validateKey(apiKey) { await models(apiKey); return true; }

async function transcribe(path, apiKey, options = {}) {
  const compressed = `${path}.cloud.mp3`, needsCompression = fs.statSync(path).size > 20 * 1024 * 1024;
  try {
    if (needsCompression) await exec('/opt/homebrew/bin/ffmpeg', ['-y', '-v', 'error', '-i', path, '-ac', '1', '-ar', '16000', '-b:a', '48k', compressed]);
    const upload = needsCompression ? compressed : path, form = new FormData(), model = options.model || TRANSCRIPTION_MODEL;
    form.append('model', model);
    if (model.startsWith('whisper-')) form.append('response_format', 'verbose_json');
    if (options.language && options.language !== 'auto') form.append('language', options.language);
    if (options.prompt) form.append('prompt', options.prompt.slice(0, 1000));
    form.append('temperature', '0');
    if (model.startsWith('whisper-') && !options.prompt) form.append('prompt', 'Natural conversation. Ignore silence, background noise, music, subtitles, and repeated outro phrases.');
    form.append('file', new Blob([fs.readFileSync(upload)]), upload.split('/').pop());
    const response = await request(`${BASE_URL}/audio/transcriptions`, { timeoutMs: AUDIO_TIMEOUT_MS, method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    if (!response.ok) throw new Error(`Transcription failed: ${response.status} ${await response.text()}`);
    const result = await response.json();
    const segments = result.segments?.length ? result.segments : [{ start: 0, end: result.duration || 0, text: result.text || '' }];
    segments.detectedLanguage = result.language || result.detected_language;
    return segments;
  } finally { fs.rmSync(compressed, { force: true }); }
}

function speakerSegments(result) {
  return (result.segments || []).map(segment => ({ start: Number(segment.start || 0), end: Number(segment.end || segment.start || 0), text: segment.text || '', speaker: segment.speaker || 'speaker_0' }));
}
async function diarize(path, apiKey, language = 'auto') {
  const compressed = `${path}.diarize.mp3`;
  try {
    await exec('/opt/homebrew/bin/ffmpeg', ['-y', '-v', 'error', '-i', path, '-ac', '1', '-ar', '16000', '-b:a', '32k', compressed]);
    const form = new FormData();
    form.append('model', 'gpt-4o-transcribe-diarize');
    form.append('response_format', 'diarized_json');
    form.append('chunking_strategy', 'auto');
    if (language !== 'auto') form.append('language', language);
    form.append('file', new Blob([fs.readFileSync(compressed)]), 'meeting.mp3');
    const response = await request(`${BASE_URL}/audio/transcriptions`, { timeoutMs: AUDIO_TIMEOUT_MS, method: 'POST', headers: { Authorization: `Bearer ${apiKey}` }, body: form });
    if (!response.ok) throw new Error(`Diarization failed: ${response.status} ${await response.text()}`);
    return speakerSegments(await response.json());
  } finally { fs.rmSync(compressed, { force: true }); }
}

async function complete(messages, apiKey, options = {}) {
  const response = await request(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: options.model || CHAT_MODEL, temperature: options.temperature ?? 0.2, ...options.body, messages }),
  });
  if (!response.ok) throw new Error(`Writing failed: ${response.status} ${await response.text()}`);
  return (await response.json()).choices?.[0]?.message?.content?.trim() || '';
}

async function summarize(transcript, apiKey) {
  if (!transcript.length) return null;
  const content = transcript.map(s => `[${s.channel === 'me' ? 'You' : 'Them'}] ${s.text}`).join('\n');
  const response = await request(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CHAT_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return JSON with summary (string), key_points (string[]), action_items (string[]). Write in the predominant language of the meeting. Be concise, factual, and omit uncertain claims.' },
        { role: 'user', content: `Analyze this meeting:\n${content}` },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Summary failed: ${response.status} ${await response.text()}`);
  return JSON.parse((await response.json()).choices[0].message.content);
}

module.exports = { models, validateKey, transcribe, diarize, speakerSegments, complete, summarize, BASE_URL, TRANSCRIPTION_MODEL, CHAT_MODEL };
