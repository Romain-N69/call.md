const test = require('node:test');
const assert = require('node:assert/strict');
const { cleanSegments } = require('../src/transcription');

test('filters common silence and promotional hallucinations', () => {
  const result = cleanSegments([
    { start: 0, end: 2, text: 'Sous-titres réalisés par la communauté Amara.org' },
    { start: 2, end: 4, text: '[MUSIQUE]' },
    { start: 4, end: 7, text: ' Nous parlons bien français. ', no_speech_prob: 0.1 },
    { start: 7, end: 8, text: 'hallucination', no_speech_prob: 0.9 },
  ]);
  assert.deepEqual(result, [{ start: 4, end: 7, text: 'Nous parlons bien français.' }]);
});

test('filters unexpected non-Latin scripts for a Latin-language meeting', () => {
  const result = cleanSegments([{ text: '보내주신.', start: 0, end: 1, expectedLatin: true }, { text: 'That is a good job.', start: 1, end: 2, expectedLatin: true }]);
  assert.deepEqual(result.map(segment => segment.text), ['That is a good job.']);
});

test('normalizes alternate timestamp field names', () => {
  assert.deepEqual(cleanSegments([{ text: 'Timed segment', start_time: 1.5, end_time: 3.25 }]), [{ text: 'Timed segment', start: 1.5, end: 3.25 }]);
});
