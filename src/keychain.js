const { execFileSync } = require('node:child_process');
const path = require('node:path');

function binary(app) {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'bin', 'KeychainStore')
    : path.join(app.getAppPath(), 'build', 'bin', 'KeychainStore');
}

function get(app) {
  try { return execFileSync(binary(app), ['get'], { encoding: 'utf8' }); }
  catch { return ''; }
}

function set(app, key) {
  execFileSync(binary(app), ['set'], { input: key, stdio: ['pipe', 'ignore', 'pipe'] });
}

module.exports = { get, set };
