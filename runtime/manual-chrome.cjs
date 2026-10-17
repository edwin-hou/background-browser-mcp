'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const HOST = '127.0.0.1';
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
function failure(code, message) { const error = new Error(message); error.code = code; return error; }
function bounded(value, fallback, maximum) {
  if (value === undefined) return fallback;
  if (!Number.isInteger(value) || value < 250 || value > maximum) throw failure('INVALID_OPTIONS', 'Invalid browser timeout.');
  return value;
}
function chromeArguments(profileDirectory, port, headlessForTests = false) {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('INVALID_PORT', 'Use a fixed nonzero loopback debugging port.');
  const args = [
    '--user-data-dir=' + profileDirectory,
    '--remote-debugging-address=' + HOST,
    '--remote-debugging-port=' + port,
    '--no-first-run', '--no-default-browser-check',
  ];
  if (headlessForTests) {
    // Disposable fixture mode only. Block non-loopback traffic, never modify identity.
    args.push('--headless=new', '--proxy-server=http://127.0.0.1:9',
      '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1');
  }
  return [...args, '--new-window', 'about:blank'];
}
async function validateProfile(profileDirectory) {
  if (typeof profileDirectory !== 'string' || !path.isAbsolute(profileDirectory)) throw failure('INVALID_PROFILE', 'An explicit separate browser profile is required.');
  const profile = path.resolve(profileDirectory);
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const personalRoots = [path.join(local, 'Google', 'Chrome', 'User Data'), path.join(local, 'Chromium', 'User Data')];
  const canonical = async value => (await fs.realpath(value).catch(() => path.resolve(value))).toLowerCase();
  const check = async () => {
    const actual = await canonical(profile);
    for (const personal of personalRoots) {
      const candidate = await canonical(personal);
      if (actual === candidate || actual.startsWith(candidate + path.sep)) throw failure('PERSONAL_PROFILE', 'The personal Chrome profile cannot be used for this sign-in flow.');
    }
  };
  await check();
  await fs.mkdir(profile, { recursive: true });
  await check(); // Resolve a newly created leaf through any existing junction too.
  return profile;
}
async function assertFreePort(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(failure('PORT_IN_USE', 'The sign-in debugging port is already in use.')));
    server.listen({ host: HOST, port, exclusive: true }, () => server.close(error => error ? reject(failure('PORT_CHECK_FAILED', 'The sign-in debugging port could not be checked.')) : resolve()));
  });
}
function validDebuggerUrl(value, port) {
  try {
    const url = new URL(value);
    return url.protocol === 'ws:' && url.hostname === HOST && Number(url.port) === port &&
      !url.username && !url.password && !url.search && !url.hash && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(url.pathname);
  } catch { return false; }
}
async function browserPid(endpoint, timeoutMs) {
  // Validate browser identity before attaching Playwright: a port can be taken in
  // the small interval between the free-port check and Chrome's own bind.
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(endpoint);
    let complete = false;
    const timer = setTimeout(() => finish(failure('CDP_TIMEOUT', 'Chrome did not confirm its process identity.')), timeoutMs);
    const finish = (error, value) => {
      if (complete) return;
      complete = true; clearTimeout(timer); socket.close();
      error ? reject(error) : resolve(value);
    };
    socket.addEventListener('open', () => socket.send(JSON.stringify({ id: 1, method: 'SystemInfo.getProcessInfo' })), { once: true });
    socket.addEventListener('error', () => finish(failure('CDP_UNAVAILABLE', 'Chrome debugging is unavailable.')));
    socket.addEventListener('close', () => { if (!complete) finish(failure('CDP_UNAVAILABLE', 'Chrome debugging closed before confirming ownership.')); });
    socket.addEventListener('message', event => {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > 1024 * 1024) return finish(failure('CDP_INVALID', 'Invalid Chrome process metadata.'));
      let response;
      try { response = JSON.parse(event.data); } catch { return finish(failure('CDP_INVALID', 'Invalid Chrome process metadata.')); }
      if (response.id !== 1) return;
      const entry = response.result?.processInfo?.find(item => item.type === 'browser');
      if (!entry || !Number.isSafeInteger(entry.id)) return finish(failure('CDP_INVALID', 'Chrome did not identify its browser process.'));
      finish(null, entry.id);
    });
  });
}
async function withTimeout(promise, ms, code, message) {
  let timer;
  try { return await Promise.race([promise, new Promise((resolve, reject) => { timer = setTimeout(() => reject(failure(code, message)), ms); })]); }
  finally { clearTimeout(timer); }
}

async function launchManualChrome({ executablePath, profileDirectory, port = 8935, startupTimeoutMs, closeTimeoutMs, headlessForTests = false } = {}) {
  if (typeof executablePath !== 'string' || !path.isAbsolute(executablePath) || !(await fs.stat(executablePath).catch(() => null))?.isFile()) throw failure('CHROME_UNAVAILABLE', 'The configured Chrome executable is unavailable.');
  if (typeof headlessForTests !== 'boolean') throw failure('INVALID_OPTIONS', 'Invalid fixture browser mode.');
  const startupLimit = bounded(startupTimeoutMs, 15000, 60000);
  const closeLimit = bounded(closeTimeoutMs, 15000, 30000);
  const args = chromeArguments(await validateProfile(profileDirectory), port, headlessForTests);
  await assertFreePort(port); // Never attach to an already-running browser on this port.
  const child = spawn(executablePath, args, { shell: false, windowsHide: true, stdio: 'ignore' });
  let exited = false, spawnFailed = false, browser, closing;
  const closed = new Promise(resolve => {
    child.on('error', () => {
      // After a successful spawn, an error (for example failed termination) is
      // not evidence of exit. Only the bound child's exit event releases it.
      if (!child.pid) { spawnFailed = true; exited = true; resolve({ exitCode: null, signal: null }); }
    });
    child.once('exit', (exitCode, signal) => { exited = true; resolve({ exitCode, signal }); });
  });
  const endpoint = 'http://' + HOST + ':' + port;
  let disconnected = false;
  const close = () => {
    if (closing) return closing;
    closing = (async () => {
      const deadline = Date.now() + closeLimit;
      if (!exited && browser && !disconnected) {
        // browser.close() disconnects an attached CDP client; Browser.close is
        // the supported graceful browser shutdown command for our owned process.
        await withTimeout((async () => {
          const session = await browser.newBrowserCDPSession();
          await session.send('Browser.close');
        })(), closeLimit, 'CHROME_CLOSE_TIMEOUT', 'Chrome did not respond to its close request.').catch(() => {});
      }
      const result = await withTimeout(closed, Math.max(1, deadline - Date.now()), 'CHROME_STILL_RUNNING', 'The sign-in browser has not finished closing.');
      await withTimeout(browser?.close().catch(() => {}), 1000, 'CDP_DISCONNECT_TIMEOUT', 'Chrome debugging did not disconnect.').catch(() => {});
      return result;
    })();
    closing.catch(() => { closing = undefined; }); // A failed Finish can be retried.
    return closing;
  };
  try {
    const deadline = Date.now() + startupLimit;
    let debuggerUrl;
    while (Date.now() < deadline && !exited) {
      try {
        const response = await fetch(endpoint + '/json/version', { redirect: 'error', signal: AbortSignal.timeout(Math.min(1000, Math.max(1, deadline - Date.now()))) });
        if (response.ok) {
          const text = await response.text();
          if (Buffer.byteLength(text) > 65536) throw failure('CDP_INVALID', 'Invalid Chrome debugging metadata.');
          const value = JSON.parse(text).webSocketDebuggerUrl;
          if (!validDebuggerUrl(value, port)) throw failure('CDP_INVALID', 'Unexpected Chrome debugging endpoint.');
          debuggerUrl = value; break;
        }
      } catch (error) { if (error.code === 'CDP_INVALID') throw error; }
      await pause(50);
    }
    if (!debuggerUrl || exited) throw failure(spawnFailed ? 'CHROME_START_FAILED' : 'CHROME_START_TIMEOUT', 'The separate sign-in browser did not start.');
    const ownedPid = await browserPid(debuggerUrl, Math.max(1, deadline - Date.now()));
    if (ownedPid !== child.pid || exited) throw failure('CHROME_OWNERSHIP', 'The debugging endpoint belongs to another browser process.');
    browser = await chromium.connectOverCDP(debuggerUrl, { noDefaults: true, timeout: Math.max(1, deadline - Date.now()) });
    browser.once('disconnected', () => { disconnected = true; });
    const context = browser.contexts()[0];
    if (!context || exited) throw failure('CHROME_CONTEXT', 'The separate browser context is unavailable.');
    await withTimeout((async () => {
      const session = await browser.newBrowserCDPSession();
      await session.send('Browser.setDownloadBehavior', { behavior: 'deny' });
      await session.detach();
    })(), Math.max(1, deadline - Date.now()), 'CHROME_START_TIMEOUT', 'Chrome did not apply the sign-in download policy.');
    return { browser, context, pid: child.pid, closed, close };
  } catch (error) {
    await withTimeout(browser?.close().catch(() => {}), 1000, 'CDP_DISCONNECT_TIMEOUT', 'Chrome debugging did not disconnect.').catch(() => {});
    // Only this exact spawned ChildProcess handle is eligible for startup cleanup.
    // No broad image-name/PID search or termination of an existing browser occurs.
    if (!exited) { try { child.kill(); } catch {} }
    await withTimeout(closed, closeLimit, 'CHROME_STILL_RUNNING', 'The failed sign-in browser has not finished closing.').catch(() => {});
    const result = error.code && /^[A-Z_]+$/.test(error.code) ? error : failure('CHROME_START_FAILED', 'The separate sign-in browser could not be connected.');
    // A timeout is not proof that the profile was released. Let the login owner
    // retain its pause/lifecycle until this exact process actually exits.
    if (!exited) result.ownedChrome = { browser, pid: child.pid, closed, close };
    throw result;
  }
}

module.exports = { launchManualChrome, chromeArguments, validDebuggerUrl };
