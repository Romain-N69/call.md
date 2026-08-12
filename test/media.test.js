const test = require('node:test');
const assert = require('node:assert/strict');
const { similarText, suppressCrosstalk } = require('../src/media');

test('detects equivalent text across microphone and system channels', () => {
  assert.equal(similarText('Bonjour, comment allez-vous ?', 'Bonjour comment allez vous'), true);
  assert.equal(similarText('Je valide le budget', 'Le serveur est indisponible'), false);
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
