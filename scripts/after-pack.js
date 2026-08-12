const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  const identities = execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], { encoding: 'utf8' });
  const identity = process.env.CSC_NAME || (identities.includes('Synapse Call Local Development') ? 'Synapse Call Local Development' : '-');
  execFileSync('codesign', [
    '--deep', '--force', '--sign', identity,
    '--entitlements', path.resolve('build/entitlements.mac.plist'), app,
  ], { stdio: 'inherit' });
};
