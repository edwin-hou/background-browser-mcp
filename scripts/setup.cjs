'use strict';

// A fresh installation copies source only. Profiles, cookies, credentials, OAuth
// grants, logs, binaries and the author's machine configuration are never inputs.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const SOURCE_FILES = Object.freeze([
  'package.json', 'package-lock.json', 'service.cjs', 'login.cjs',
  'login-control.cjs', 'manual-chrome.cjs', 'session-state.cjs', 'mcp-guardian.cjs',
  'availability.cjs', 'connection-status.cjs', 'availability-processes.ps1', 'BrowserAvailability.cs', 'runtime-paths.cjs',
  'gateway/server.mjs', 'gateway/backend.mjs', 'gateway/local-bridge.mjs', 'gateway/account-status.mjs', 'gateway/config.example.json',
  'setup/portal.cjs', 'setup/dashboard.cjs', 'setup/compact-styles.cjs', 'setup/dashboard-client.js', 'setup/session-view.js', 'setup/health.cjs', 'setup/sites.cjs', 'setup/ngrok.example.yml'
]);
const POWERSHELL = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

function parseArgs(args) {
  const options = { installDirectory: path.join(os.homedir(), '.background-browser'), noStart: false, skipDependencies: false };
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    if (argument === '--no-start') options.noStart = true;
    else if (argument === '--skip-dependencies') options.skipDependencies = true;
    else if (argument === '--install-directory' || argument === '--chrome-path') {
      const value = args[++index];
      if (!value || value.startsWith('--')) throw new Error(`Supply a value for ${argument}.`);
      options[argument === '--install-directory' ? 'installDirectory' : 'chromePath'] = value;
    } else throw new Error(`Unknown installer option: ${argument}`);
  }
  return options;
}
function isWithin(parent, child) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative !== '' && !relative.startsWith('..' + path.sep) && relative !== '..' && !path.isAbsolute(relative);
}
function validateDestination(destination, repository) {
  const resolved = path.resolve(destination);
  if (!path.isAbsolute(destination)) throw new Error('Choose an absolute installation directory.');
  if (resolved === path.parse(resolved).root || resolved.toLowerCase() === os.homedir().toLowerCase()) throw new Error('Choose a dedicated installation folder.');
  if (resolved.toLowerCase() === path.resolve(repository).toLowerCase() || isWithin(resolved, repository) || isWithin(repository, resolved)) throw new Error('Keep the installation separate from this source checkout.');
  if (/\\AppData\\Local\\(?:Packages\\|PlaywrightMCP(?:\\|$))/i.test(resolved)) throw new Error('Choose a normal user folder outside packaged-app AppData, such as your home folder.');
  return resolved;
}
async function exists(filename) { try { await fs.access(filename); return true; } catch { return false; } }
async function findChrome(explicitPath) {
  const candidates = explicitPath ? [explicitPath] : [
    process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join((process.env.SystemDrive || 'C:') + '\\', 'Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join((process.env.SystemDrive || 'C:') + '\\', 'Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
  ].filter(Boolean);
  for (const candidate of candidates) if (path.isAbsolute(candidate) && (await fs.stat(candidate).catch(() => null))?.isFile()) return path.resolve(candidate);
  throw new Error('Install Google Chrome first, or supply -ChromePath with the full chrome.exe path.');
}
async function assertPortsFree(ports = [8933, 8934, 8935, 8936]) {
  // Reserve all listeners together, then release. No existing process is stopped.
  const reservations = [];
  try {
    for (const port of ports) {
      const server = net.createServer();
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port, exclusive: true }, resolve); }).catch(() => { throw new Error(`Local port ${port} is already in use. Stop the existing background-browser installation, or choose another machine. No process was changed.`); });
      reservations.push(server);
    }
  } finally { await Promise.all(reservations.map(server => new Promise(resolve => server.close(resolve)))); }
}
async function run(executable, arguments_, options = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(executable, arguments_, { shell: false, windowsHide: true, stdio: 'inherit', ...options });
    child.once('error', () => reject(new Error(`Could not run ${path.basename(executable)}.`)));
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`${path.basename(executable)} exited with code ${code}.`)));
  });
}
async function writeJson(filename, value) { await fs.writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); }
async function compileLauncher(root) {
  const framework = path.join(process.env.SystemRoot || 'C:\\Windows', 'Microsoft.NET');
  const candidates = ['Framework64', 'Framework'].map(name => path.join(framework, name, 'v4.0.30319', 'csc.exe'));
  const compiler = (await Promise.all(candidates.map(async candidate => await exists(candidate) ? candidate : null))).find(Boolean);
  if (!compiler) throw new Error('The Windows .NET Framework C# compiler is missing. Enable .NET Framework 4.x in Windows, then retry.');
  await run(compiler, ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+', '/debug-', '/reference:System.Web.Extensions.dll', '/out:' + path.join(root, 'BrowserAvailability.exe'), path.join(root, 'BrowserAvailability.cs')], { cwd: root });
}
async function main(args = process.argv.slice(2)) {
  const options = parseArgs(args);
  if (options.skipDependencies && !options.noStart) throw new Error('--skip-dependencies requires --no-start.');
  if (process.platform !== 'win32') throw new Error('This installer supports Windows 10 and 11.');
  if (Number(process.versions.node.split('.')[0]) < 22) throw new Error('Node.js 22 or newer is required. Install Node.js 24 LTS or a newer supported release.');
  const repository = path.resolve(__dirname, '..');
  const source = path.join(repository, 'runtime');
  const root = validateDestination(options.installDirectory, repository);
  if (await exists(root)) throw new Error('This installation folder already exists. Existing profiles and configuration are preserved; choose a fresh folder.');
  // Check every input before creating the destination. A release ships source,
  // lockfiles and this explicit allowlist, never a copied live installation.
  for (const relative of SOURCE_FILES) if (!(await fs.stat(path.join(source, relative)).catch(() => null))?.isFile()) throw new Error(`Release source is missing runtime/${relative}.`);
  const chromePath = await findChrome(options.chromePath);
  if (!options.noStart) await assertPortsFree();
  const npmCli = path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  if (!options.skipDependencies && !(await exists(npmCli))) throw new Error('The Node.js npm installation is missing. Reinstall the official Node.js distribution.');
  await fs.mkdir(root, { recursive: false });
  // Restrict private runtime data before generating anything sensitive. The
  // helper grants the current user and SYSTEM access, without elevation.
  await run(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows-task.ps1'), '-Action', 'SecureDirectory', '-InstallDirectory', root]);
  for (const relative of SOURCE_FILES) {
    const target = path.join(root, relative === 'setup/ngrok.example.yml' ? 'setup/ngrok.yml' : relative);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.copyFile(path.join(source, relative), target, require('node:fs').constants.COPYFILE_EXCL);
  }
  await fs.mkdir(path.join(root, 'scripts'));
  for (const filename of ['manage.ps1', 'windows-task.ps1']) await fs.copyFile(path.join(__dirname, filename), path.join(root, 'scripts', filename));
  await fs.mkdir(path.join(root, 'ngrok'));
  await fs.mkdir(path.join(root, 'profiles'));
  const identifier = crypto.randomUUID();
  const hash = crypto.createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 8);
  const installation = { version: 1, id: identifier, taskName: 'Background Browser ' + hash, nodeExecutable: process.execPath, root, installedAt: new Date().toISOString(), dependenciesInstalled: false };
  await writeJson(path.join(root, 'installation.json'), installation);
  await writeJson(path.join(root, 'runtime-settings.json'), { chromeExecutable: chromePath });
  await fs.writeFile(path.join(root, 'node-path.txt'), process.execPath + '\n', { flag: 'wx', mode: 0o600 });
  await writeJson(path.join(root, 'availability-config.json'), { version: 1, enabled: false, updatedAt: new Date().toISOString() });
  const codexExample = '# Merge this section into your Codex MCP configuration. Existing settings are not changed.\n[mcp_servers.playwright_background]\ncommand = ' + JSON.stringify(process.execPath) + '\nargs = [' + JSON.stringify(path.join(root, 'gateway', 'local-bridge.mjs')) + ']\nstartup_timeout_sec = 90\ntool_timeout_sec = 120\ndisabled_tools = ["browser_run_code_unsafe", "browser_file_upload", "browser_drop"]\n';
  await fs.writeFile(path.join(root, 'codex-config.example.toml'), codexExample, { flag: 'wx' });
  if (!options.skipDependencies) {
    console.log('Installing the exact locked dependencies...');
    await run(process.execPath, [npmCli, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: root });
  }
  console.log('Building the hidden Windows launcher...');
  await compileLauncher(root);
  installation.dependenciesInstalled = !options.skipDependencies;
  const metadataTemporary = path.join(root, 'installation.complete.tmp');
  await writeJson(metadataTemporary, installation);
  await fs.rename(metadataTemporary, path.join(root, 'installation.json'));
  if (!options.noStart) {
    await run(POWERSHELL, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', path.join(root, 'scripts', 'manage.ps1'), '-Action', 'Start', '-InstallDirectory', root]);
  }
  console.log('Installed source and a fresh, separate browser profile at: ' + root);
  console.log(options.noStart ? 'Staged only. No task, browser, tunnel, or dashboard was started.' : 'Background Browser is starting through Windows Task Scheduler.');
  console.log('Local MCP address: http://127.0.0.1:8933/mcp');
  console.log('Your Codex settings were not changed. See codex-config.example.toml in the installation folder.');
  if (options.skipDependencies) console.log('Dependencies were skipped for a development fixture. Run the full installer into a fresh folder for a working installation.');
}

module.exports = { SOURCE_FILES, parseArgs, isWithin, validateDestination, assertPortsFree, findChrome };
if (require.main === module) main().catch(error => { console.error('Setup: ' + error.message); process.exitCode = 1; });
