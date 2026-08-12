const test = require('node:test');
const assert = require('node:assert/strict');
const { metrics, markdown } = require('../src/insights');

const transcript = [
  { channel: 'me', start_time: 0, end_time: 30, text: 'Can we ship this Friday?' },
  { channel: 'them', start_time: 30, end_time: 90, text: 'Yes we can ship it Friday.' },
];

test('computes meeting metrics', () => {
  assert.deepEqual(metrics(transcript), { talkRatio: 33, wordsPerMinute: 10, questions: 1, longestMonologue: 60 });
});

test('exports complete markdown', () => {
  const output = markdown({ title: 'Launch', started_at: 0, summary: 'Ready.', key_points: '["Friday"]', action_items: '["Ship"]' }, transcript, [{ at_time: 12, note: 'Decision' }]);
  assert.match(output, /# Launch/);
  assert.match(output, /- \[ \] Ship/);
  assert.match(output, /00:12 — Decision/);
  assert.match(output, /\*\*You · 00:00\*\*/);
});
