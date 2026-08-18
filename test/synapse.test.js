const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE_URL, CHAT_MODEL, TRANSCRIPTION_MODEL, meetingContext, mergeDiarizedChunks, speakerSegments } = require('../src/synapse');

test('uses the approved Synapse gateway and models', () => {
  assert.equal(BASE_URL, 'https://llm.synapse.thalescloud.io/v1');
  assert.equal(CHAT_MODEL, 'gpt-4o@2024-11-20');
  assert.equal(TRANSCRIPTION_MODEL, 'whisper-1@v2-large');
});

test('preserves diarized speaker identities', () => {
  assert.deepEqual(speakerSegments({ segments: [{ start: 1, end: 2, text: 'Hello', speaker: 'speaker_1' }] }), [{ start: 1, end: 2, text: 'Hello', speaker: 'speaker_1' }]);
});

test('builds timestamped meeting context with personal notes', () => {
  const context = meetingContext({ title: 'Review', notes: 'Ask about launch', transcript: [{ channel: 'them', speaker: 'Alex', start_time: 65, text: 'Ship Friday' }] });
  assert.match(context, /Personal notes: Ask about launch/);
  assert.match(context, /\[01:05\] Alex: Ship Friday/);
});

test('keeps speaker identities stable across overlapping diarization chunks', () => {
  const result = mergeDiarizedChunks([
    { offset: 0, segments: [{ start: 1172, end: 1178, text: 'First', speaker: 'A' }, { start: 1180, end: 1190, text: 'Second', speaker: 'B' }] },
    { offset: 1170, segments: [{ start: 2, end: 8, text: 'First', speaker: 'X' }, { start: 10, end: 20, text: 'Second', speaker: 'Y' }, { start: 35, end: 42, text: 'Continues', speaker: 'X' }] },
  ]);
  assert.deepEqual(result.map(segment => [segment.text, segment.speaker]), [['First', 'speaker_0'], ['Second', 'speaker_1'], ['Continues', 'speaker_0']]);
});
