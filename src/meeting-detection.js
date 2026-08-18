const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');

const APPS = [
  [/^us\.zoom\./i, 'Zoom'], [/^com\.microsoft\.teams/i, 'Teams'],
  [/^com\.tinyspeck\.slackmacgap/i, 'Slack'], [/^com\.apple\.facetime/i, 'FaceTime'],
  [/^net\.whatsapp\./i, 'WhatsApp'], [/^com\.hnc\.discord/i, 'Discord'],
  [/^com\.google\.chrome/i, 'Chrome'], [/^com\.microsoft\.edgemac/i, 'Edge'],
  [/^com\.brave\.browser/i, 'Brave'], [/^org\.mozilla\.firefox/i, 'Firefox'],
  [/^com\.apple\.webkit/i, 'Safari'],
];

function meetingApp(owner = {}) {
  const identity = `${owner.bundleId || ''} ${path.basename(owner.path || '')}`;
  return APPS.find(([pattern]) => pattern.test(identity))?.[1] || null;
}

function startMeetingDetection({ helperPath, isCapturing, onDetected, onCallEnded }) {
  if (process.platform !== 'darwin' || !fs.existsSync(helperPath)) return () => {};
  const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'ignore'] });
  const lines = readline.createInterface({ input: child.stdout });
  let currentApp = null, notified = false, promptTimer, endTimer, externalSeen = false;

  const clear = timer => { if (timer) clearTimeout(timer); };
  lines.on('line', line => {
    let state;
    try { state = JSON.parse(line); } catch { return; }
    currentApp = (state.owners || []).map(meetingApp).find(Boolean) || null;
    if (!state.micInUse) {
      notified = externalSeen = false;
      clear(promptTimer); clear(endTimer); promptTimer = endTimer = null;
      return;
    }
    if (isCapturing()) {
      clear(promptTimer); promptTimer = null;
      if (currentApp) { externalSeen = true; clear(endTimer); endTimer = null; }
      else if (externalSeen && !endTimer) endTimer = setTimeout(() => { endTimer = null; if (isCapturing() && !currentApp) onCallEnded(); }, 15_000);
      return;
    }
    externalSeen = false;
    if (!currentApp || notified || promptTimer) return;
    promptTimer = setTimeout(() => {
      promptTimer = null;
      if (!isCapturing() && currentApp && !notified) { notified = true; onDetected(currentApp); }
    }, 4_000);
  });
  child.on('error', error => console.error('Meeting detection unavailable:', error.message));
  return () => { clear(promptTimer); clear(endTimer); lines.close(); child.stdin.end(); };
}

module.exports = { meetingApp, startMeetingDetection };
