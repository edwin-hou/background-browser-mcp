'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs/promises');
const net = require('node:net');
const { SOURCE_FILES, parseArgs, validateDestination, assertPortsFree, findChrome } = require('./setup.cjs');

test('release copy list excludes private runtime data and downloaded binaries', () => {
  assert(SOURCE_FILES.includes('runtime-paths.cjs'));
  for (const filename of SOURCE_FILES) assert(!/(?:secret|token|oauth-state|sites\.json|profile|\.exe$|\.log$)/i.test(filename), filename);
});
test('installer refuses ambiguous options before changing files', () => {
  assert.throws(() => parseArgs(['--unknown']), /Unknown/);
  assert.throws(() => parseArgs(['--install-directory']), /Supply/);
  assert.deepEqual(parseArgs(['--install-directory', 'C:\\fresh', '--no-start', '--skip-dependencies']), { installDirectory: 'C:\\fresh', noStart: true, skipDependencies: true });
});
test('destination cannot overwrite the source checkout or parent', () => {
  const repository = path.resolve(__dirname, '..');
  assert.throws(() => validateDestination(repository, repository), /separate/);
  assert.throws(() => validateDestination(path.dirname(repository), repository), /separate/);
  assert.throws(() => validateDestination(path.join(repository, 'runtime'), repository), /separate/);
  assert.throws(() => validateDestination(os.homedir(), repository), /dedicated/);
  assert.throws(() => validateDestination('relative-install', repository), /absolute/);
});
test('port collision check preserves the existing listener and releases its own probes', async () => {
  const occupied = net.createServer();
  await new Promise(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const occupiedPort = occupied.address().port;
  await assert.rejects(assertPortsFree([occupiedPort]), /already in use/);
  assert(occupied.listening);
  await new Promise(resolve => occupied.close(resolve));
  await assertPortsFree([occupiedPort]);
  await assertPortsFree([occupiedPort]);
});
test('explicit Chrome executable is validated without running it', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'background-browser-setup-test-'));
  const executable = path.join(directory, 'chrome.exe');
  try {
    await fs.writeFile(executable, 'fixture only');
    assert.equal(await findChrome(executable), executable);
    await assert.rejects(findChrome(path.join(directory, 'missing.exe')), /Chrome/);
  } finally {
    // Exact known fixture files only; no recursive deletion or profile access.
    await fs.unlink(executable);
    await fs.rmdir(directory);
  }
});
