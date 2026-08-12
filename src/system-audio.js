const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

function startSystemAudio({ app, folder, startedAt, onSegment, onLevel, onError }) {
  const binary = app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'SystemAudioCapture')
    : path.join(app.getAppPath(), 'build', 'bin', 'SystemAudioCapture');
  const child = spawn(binary, [folder, String(startedAt)], { stdio: ['pipe', 'pipe', 'pipe'] });
  let readyResolve, readyReject;
  const ready = new Promise((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  const lines = readline.createInterface({ input: child.stdout });
  lines.on('line', line => {
    try {
      const event = JSON.parse(line);
      if (event.ready) readyResolve();
      else if (event.path) onSegment(event);
      else if (Number.isFinite(event.levelDb)) onLevel(event.levelDb);
      else if (event.error) { readyReject(new Error(event.error)); onError(event.error); }
    } catch { /* ignore malformed helper output */ }
  });
  child.stderr.on('data', data => onError(data.toString().trim()));
  child.once('error', error => { readyReject(error); onError(error.message); });
  child.once('exit', code => { if (code && code !== 0) readyReject(new Error(`System audio helper exited (${code})`)); });
  return { ready, stop: () => { if (!child.killed) { child.stdin.end('\n'); setTimeout(() => child.kill(), 3000); } } };
}

module.exports = { startSystemAudio };
