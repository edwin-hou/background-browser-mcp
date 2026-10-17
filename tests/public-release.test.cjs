'use strict';
// Inspect source or Git's index only. Never read a live browser installation.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const git = process.platform === 'win32' ? 'git.exe' : 'git';
const forbiddenDirectories = new Set(['node_modules', 'profiles', 'artifacts', 'backups', 'logs', 'work', '.cache']);
const forbiddenNames = new Set([
  'access-token.txt', 'owner-secret.txt', 'transport-secret.json', 'oauth-state.json',
  'config.json', 'runtime-settings.json', 'installation.json', 'node-path.txt',
  'availability-config.json', 'availability-state.json', 'availability-broker-state.json',
  'availability-launcher-state.json', 'service-state.json', 'login-state.json',
  'status.json', 'sites.json', 'cookies.json', 'storage-state.json', 'local state',
  'cookies', 'login data', 'history', 'preferences', '.app.json'
]);
function pathRisks(filename, mode) {
  const normalized = filename.replace(/\\/g, '/'), parts = normalized.toLowerCase().split('/');
  const risks = [];
  if (filename !== normalized || path.isAbsolute(filename) || parts.includes('..')) risks.push('unsafe export path');
  if (parts.some(part => forbiddenDirectories.has(part))) risks.push('private/generated dependency or browser directory');
  if (forbiddenNames.has(parts.at(-1)) || /^\.env(?:\.|$)/.test(parts.at(-1))) risks.push('private/generated configuration or browser state');
  if (/\.(?:exe|dll|zip|7z|lnk|url|log|lock|stop|tmp|sqlite3?|db|sst|dat|pfx|p12|pem|key)$/i.test(filename)) risks.push('binary, private shortcut, credential, or generated runtime file');
  if (mode && !['100644', '100755'].includes(mode)) risks.push('non-regular file in export');
  return risks;
}
function contentRisks(text) {
  const findings = [];
  text.split('\n').forEach((line, index) => {
    const add = risk => findings.push({ line: index + 1, risk });
    if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line)) add('private key material');
    if (/\b(?:gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{30,}|sk-[A-Za-z0-9_-]{30,})\b/.test(line)) add('credential-shaped literal');
    if (/\b(?:plugins?_|dev-|app-)[a-f0-9]{24,}\b/i.test(line)) add('private app/plugin binding');
    if (/OpenAI\.Codex_[A-Za-z0-9]{8,}/.test(line)) add('machine-specific packaged-app identity');
    for (const match of line.matchAll(/\b[A-Z]:[\\/]+Users[\\/]+([^\\/\s"'\x60]+)/gi)) {
      if (!/^(?:Public|YourName|YourUser|Username|<[^>]+>|test-user)$/i.test(match[1])) add('personal Windows profile path');
    }
    for (const match of line.matchAll(/\b([a-z0-9][a-z0-9-]*)\.ngrok-free\.(?:app|dev)\b/gi)) {
      if (!/^(?:[a-z]|evil|assigned|name)$|(?:^|-)(?:example|test|fixture|integration|assigned|your|placeholder|sample)(?:-|$)/i.test(match[1])) add('non-placeholder assigned tunnel hostname');
    }
    const literal = /\b(?:authtoken|access_token|refresh_token|owner_secret|client_secret|passphrase|token)\s*[:=]\s*(['"])([^'"\r\n]{12,})\1/gi;
    for (const match of line.matchAll(literal)) {
      if (/^[A-Za-z0-9._~+\/=:-]{12,}$/.test(match[2]) && !/^(?:FAKE|TEST|FIXTURE|EXAMPLE|YOUR|PLACEHOLDER|NOT[_ -]A[_ -]REAL|NEVER|DO_NOT)/i.test(match[2])) add('hardcoded credential-like value');
    }
  });
  return findings;
}
function workingEntries(directory = root, relative = '') {
  const entries = [];
  for (const item of fs.readdirSync(directory, { withFileTypes: true })) {
    if (item.name === '.git' || item.name === 'node_modules') continue;
    const filename = relative ? relative + '/' + item.name : item.name;
    if (item.isDirectory()) {
      if (forbiddenDirectories.has(item.name.toLowerCase())) {
        const children = fs.readdirSync(path.join(directory, item.name));
        if (children.length) entries.push({ filename, blockedDirectory: true });
      } else entries.push(...workingEntries(path.join(directory, item.name), filename));
    } else entries.push({ filename, mode: item.isSymbolicLink() ? '120000' : '100644' });
  }
  return entries;
}
function stagedEntries() {
  const output = execFileSync(git, ['ls-files', '--stage', '-z'], { cwd: root, shell: false, windowsHide: true }).toString('utf8');
  return output.split('\0').filter(Boolean).map(record => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(record);
    assert.ok(match && match[3] === '0', 'Resolve the staged manifest before publication.');
    return { mode: match[1], filename: match[4] };
  });
}
function selfTest() {
  assert.ok(pathRisks('runtime/profiles/default/Cookies').length);
  assert.ok(pathRisks('runtime/setup/access-token.txt').length);
  assert.ok(pathRisks('runtime/BrowserAvailability.exe').length);
  assert.ok(pathRisks('runtime/link.cjs', '120000').length);
  assert.equal(pathRisks('runtime/package-lock.json', '100644').length, 0);
  assert.ok(contentRisks(['-----BEGIN', 'PRIVATE KEY-----'].join(' ')).length);
  assert.ok(contentRisks('ghp_' + 'x'.repeat(40)).length);
  assert.ok(contentRisks('plugins_' + 'a'.repeat(32)).length);
  assert.ok(contentRisks(['C:', 'Users', 'ExamplePerson', 'private'].join('/')).length);
  assert.ok(contentRisks(['unexpected-literal-hostname', 'ngrok-free.app'].join('.')).length);
  assert.equal(contentRisks("const token = 'FAKE_TOKEN_FOR_UNIT_TEST_ONLY';").length, 0);
}
function main() {
  selfTest();
  const working = process.argv.includes('--working-tree');
  const entries = working ? workingEntries() : stagedEntries();
  assert.ok(entries.length, 'The export manifest is empty; stage the intended source files first.');
  const findings = [];
  let inspected = 0;
  for (const entry of entries) {
    const risks = entry.blockedDirectory ? ['private/generated directory in source checkout'] : pathRisks(entry.filename, entry.mode);
    if (risks.length) { findings.push(...risks.map(risk => ({ file: entry.filename, line: 0, risk }))); continue; }
    const bytes = working ? fs.readFileSync(path.join(root, entry.filename)) : execFileSync(git, ['show', ':' + entry.filename], { cwd: root, shell: false, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
    if (bytes.includes(0)) { findings.push({ file: entry.filename, line: 0, risk: 'binary content in source export' }); continue; }
    inspected++;
    findings.push(...contentRisks(bytes.toString('utf8')).map(finding => ({ file: entry.filename, ...finding })));
  }
  if (findings.length) {
    // Never print the source line or matching credential value.
    for (const finding of findings) console.error(finding.file + ':' + finding.line + ' ' + finding.risk);
    process.exitCode = 1;
  } else console.log('PASS: public release ' + (working ? 'working-tree' : 'Git-staged') + ' privacy checks; ' + inspected + ' regular source files; no private values displayed.');
}
module.exports = { pathRisks, contentRisks };
if (require.main === module) main();
