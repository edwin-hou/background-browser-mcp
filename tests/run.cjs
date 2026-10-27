'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const browser = process.argv.includes('--browser');
if (process.argv.slice(2).some(argument => argument !== '--browser')) throw new Error('Unknown test argument.');
const tests = [
  'runtime/test-login-control.cjs',
  'runtime/test-mcp-guardian.cjs',
  'runtime/test-availability.cjs',
  'runtime/test-availability-detachment.cjs',
  'runtime/setup/test.cjs',
  'runtime/setup/sites-test.cjs',
  'runtime/gateway/test.mjs',
  'runtime/gateway/transport-test.mjs',
  'runtime/gateway/local-bridge.test.mjs',
  'scripts/test-setup.cjs',
  'tests/public-release.test.cjs',
];
if (browser) tests.push(
  'runtime/test-manual-chrome.cjs',
  'runtime/test-session-state.cjs',
  'runtime/setup/browser-test.cjs',
  'runtime/gateway/browser-consent-test.mjs',
);
for (const test of tests) {
  if (!fs.existsSync(path.join(root, test))) throw new Error('Missing test: ' + test);
  console.log('\n' + test);
  execFileSync(process.execPath, [path.join(root, test)], {
    cwd: root, shell: false, windowsHide: true, stdio: 'inherit', timeout: 120000,
  });
}
console.log('\nAll ' + tests.length + ' suites passed. Real-account integration is opt-in and excluded.');
