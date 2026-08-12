const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parakeetState } = require('../src/transcription');

test('detects an existing Parakeet ONNX model folder', () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'parakeet-'));
  fs.writeFileSync(path.join(folder, 'parakeet-ctc.onnx'), 'model');
  fs.writeFileSync(path.join(folder, 'tokens.txt'), 'tokens');
  assert.equal(parakeetState(folder).installed, true);
  fs.rmSync(folder, { recursive: true });
});
