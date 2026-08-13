const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { finalizeMicrophone } = require('../src/media');

test('builds one continuous microphone WAV from ordered chunks', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'call-mic-'));
  try {
    for (const [timestamp, frequency] of [[1000, 440], [2000, 660]]) execFileSync('/opt/homebrew/bin/ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', `sine=frequency=${frequency}:duration=0.2`, '-c:a', 'libopus', path.join(folder, `mic-${timestamp}.webm`)]);
    const result = await finalizeMicrophone(folder);
    assert.equal(result.startedAt, 1000);
    assert.equal(fs.existsSync(result.path), true);
    const duration = Number(execFileSync('/opt/homebrew/bin/ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', result.path], { encoding: 'utf8' }));
    assert.ok(duration >= .39);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});
