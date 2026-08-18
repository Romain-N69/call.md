const test = require('node:test');
const assert = require('node:assert/strict');
const { meetingApp } = require('../src/meeting-detection');

test('recognizes meeting apps and browser audio processes', () => {
  assert.equal(meetingApp({ bundleId: 'us.zoom.xos' }), 'Zoom');
  assert.equal(meetingApp({ bundleId: 'com.google.Chrome.helper' }), 'Chrome');
  assert.equal(meetingApp({ bundleId: 'com.apple.TextEdit' }), null);
});
