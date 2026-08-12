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
