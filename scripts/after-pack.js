const { execFileSync } = require('node:child_process');
const path = require('node:path');

exports.default = async context => {
  if (context.electronPlatformName !== 'darwin') return;
  const app = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
  execFileSync('codesign', [
    '--deep', '--force', '--sign', '-',
    '--entitlements', path.resolve('build/entitlements.mac.plist'), app,
  ], { stdio: 'inherit' });
};
