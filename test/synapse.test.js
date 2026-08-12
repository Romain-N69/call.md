const test = require('node:test');
const assert = require('node:assert/strict');
const { BASE_URL, CHAT_MODEL, TRANSCRIPTION_MODEL } = require('../src/synapse');

test('uses the approved Synapse gateway and models', () => {
  assert.equal(BASE_URL, 'https://llm.synapse.thalescloud.io/v1');
  assert.equal(CHAT_MODEL, 'gpt-4o@2024-11-20');
  assert.equal(TRANSCRIPTION_MODEL, 'whisper-1@v2-large');
});
