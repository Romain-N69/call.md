const test = require('node:test');
const assert = require('node:assert/strict');
const { mergeOverlappingSegments, mergeSpeakerTurns, similarText, suppressCrosstalk } = require('../src/media');

test('detects equivalent text across microphone and system channels', () => {
  assert.equal(similarText('Bonjour, comment allez-vous ?', 'Bonjour comment allez vous'), true);
  assert.equal(similarText('Je valide le budget', 'Le serveur est indisponible'), false);
});

test('removes repeated overlapping windows', () => {
  const result = mergeOverlappingSegments([{ channel: 'me', start_time: 1, text: 'Ship on Friday' }, { channel: 'me', start_time: 1.8, text: 'Ship on Friday.' }, { channel: 'me', start_time: 5, text: 'Next topic' }]);
  assert.deepEqual(result.map(segment => segment.text), ['Ship on Friday', 'Next topic']);
});

test('keeps the system copy when both channels transcribe the same speech', () => {
  const segments = suppressCrosstalk([
    { channel: 'them', start_time: 10, text: 'Nous validons la livraison jeudi.' },
    { channel: 'me', start_time: 11, text: 'Nous validons livraison jeudi' },
    { channel: 'me', start_time: 18, text: 'Je prends la validation finale.' },
  ]);
  assert.deepEqual(segments.map(segment => segment.channel), ['them', 'me']);
  assert.equal(segments[1].text, 'Je prends la validation finale.');
});

test('groups adjacent segments from the same speaker into readable turns', () => {
  const result = mergeSpeakerTurns([
    { channel: 'them', speaker: 'Alex', start_time: 1, end_time: 3, text: 'First sentence.' },
    { channel: 'them', speaker: 'Alex', start_time: 3.4, end_time: 5, text: 'Second sentence.' },
    { channel: 'them', speaker: 'Sam', start_time: 5.2, end_time: 6, text: 'Reply.' },
  ]);
  assert.deepEqual(result.map(segment => segment.text), ['First sentence. Second sentence.', 'Reply.']);
});
