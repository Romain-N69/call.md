const test = require('node:test');
const assert = require('node:assert/strict');
const { displayStreams } = require('../src/capture');

test('requests Electron loopback audio with the selected screen', async () => {
  const screen = { id: 'screen:0' };
  const streams = await displayStreams({ getSources: async () => [screen] });
  assert.deepEqual(streams, { video: screen, audio: 'loopback' });
});

test('fails clearly when no screen is available', async () => {
  await assert.rejects(() => displayStreams({ getSources: async () => [] }), /No screen/);
});
