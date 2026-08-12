const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const Module = require('node:module');
const { PassThrough } = require('node:stream');

test('waits for the native helper to flush before stop resolves', async () => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null; child.killed = false;
  child.stdin = { end() { setTimeout(() => { child.exitCode = 0; child.emit('exit', 0); }, 20); } };
  child.kill = () => { child.killed = true; child.emit('exit', 0); };
  const original = Module._load;
  Module._load = (request, parent, main) => request === 'node:child_process' ? { spawn: () => child } : original(request, parent, main);
  delete require.cache[require.resolve('../src/system-audio')];
  const { startSystemAudio } = require('../src/system-audio');
  Module._load = original;
  const capture = startSystemAudio({ app: { isPackaged: false, getAppPath: () => '/tmp' }, folder: '/tmp', startedAt: 0, onSegment() {}, onLevel() {}, onError() {} });
  child.stdout.write('{"ready":true}\n');
  await capture.ready;
  let resolved = false;
  const stopping = capture.stop().then(() => { resolved = true; });
  await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(resolved, false);
  await stopping;
  assert.equal(resolved, true);
});
