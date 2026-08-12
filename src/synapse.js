const fs = require('node:fs');

const BASE_URL = 'https://llm.synapse.thalescloud.io/v1';
const TRANSCRIPTION_MODEL = 'whisper-1@v2-large';
const CHAT_MODEL = 'gpt-4o@2024-11-20';

async function validateKey(apiKey) {
  const response = await fetch(`${BASE_URL}/models`, { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) throw new Error(`Synapse rejected this key (${response.status})`);
  return true;
}

async function transcribe(path, apiKey) {
  const form = new FormData();
  form.append('model', TRANSCRIPTION_MODEL);
  form.append('response_format', 'verbose_json');
  form.append('file', new Blob([fs.readFileSync(path)]), path.split('/').pop());
  const response = await fetch(`${BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}` },
    body: form,
  });
  if (!response.ok) throw new Error(`Transcription failed: ${response.status} ${await response.text()}`);
  const result = await response.json();
  return result.segments?.length
    ? result.segments
    : [{ start: 0, end: result.duration || 0, text: result.text || '' }];
}

async function summarize(transcript, apiKey) {
  if (!transcript.length) return null;
  const content = transcript.map(s => `[${s.channel === 'me' ? 'You' : 'Them'}] ${s.text}`).join('\n');
  const response = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: CHAT_MODEL,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: 'Return JSON with summary (string), key_points (string[]), action_items (string[]).' },
        { role: 'user', content: `Analyze this meeting:\n${content}` },
      ],
    }),
  });
  if (!response.ok) throw new Error(`Summary failed: ${response.status} ${await response.text()}`);
  return JSON.parse((await response.json()).choices[0].message.content);
}

module.exports = { validateKey, transcribe, summarize, BASE_URL, TRANSCRIPTION_MODEL, CHAT_MODEL };
