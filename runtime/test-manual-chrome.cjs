'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const { chromium } = require('playwright');
const { launchManualChrome, chromeArguments, validDebuggerUrl } = require('./manual-chrome.cjs');
const { chromeExecutable } = require('./runtime-paths.cjs');
const { createSessionPersistence } = require('./session-state.cjs');

async function main() {
  let checks = 0;
  const check = (condition, message) => { assert.ok(condition, message); checks++; };
  const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'background-browser-manual-test-'));
  const profile = path.join(fixture, 'profile');
  const live = new Set();
  let serviceContext;
  const server = http.createServer((request, response) => {
    if (request.url === '/login') response.setHeader('Set-Cookie', 'fixture_session=fixture-only; HttpOnly; SameSite=Lax; Path=/');
    if (request.url === '/logout') response.setHeader('Set-Cookie', 'fixture_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/');
    response.end('<!doctype html><title>Local sign-in fixture</title>');
  });
  const reserve = () => new Promise((resolve, reject) => {
    const socket = net.createServer(); socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => resolve(socket));
  });
  const freshPort = async () => { const socket = await reserve(); const port = socket.address().port; await new Promise(resolve => socket.close(resolve)); return port; };
  const launch = async () => {
    const result = await launchManualChrome({ executablePath: chromeExecutable(), profileDirectory: profile, port: await freshPort(), headlessForTests: true });
    live.add(result); return result;
  };
  try {
    const args = chromeArguments(profile, 8935);
    check(args.includes('--remote-debugging-port=8935') && args.includes('--remote-debugging-address=127.0.0.1'), 'fixed loopback CDP endpoint');
    check(args.includes('--user-data-dir=' + profile) && args.at(-1) === 'about:blank', 'explicit dedicated profile and blank start');
    check(!args.some(arg => /automation|headless|user-agent|disable-blink-features|restore-last-session/i.test(arg)), 'normal login has no automation/stealth/identity flags');
    assert.throws(() => chromeArguments(profile, 0), { code: 'INVALID_PORT' }); checks++;
    check(validDebuggerUrl('ws://127.0.0.1:8935/devtools/browser/abc-123', 8935), 'owned loopback debugger URL accepted');
    check(!validDebuggerUrl('ws://127.0.0.1:9999/devtools/browser/abc-123', 8935) && !validDebuggerUrl('ws://example.com:8935/devtools/browser/abc-123', 8935), 'foreign debugger URL rejected');
    const occupied = await reserve(); let requests = 0;
    occupied.on('connection', socket => { requests++; socket.destroy(); });
    try {
      await assert.rejects(launchManualChrome({ executablePath: chromeExecutable(), profileDirectory: profile, port: occupied.address().port, headlessForTests: true }), { code: 'PORT_IN_USE' }); checks++;
      check(requests === 0, 'port conflict never connects to existing listener');
    } finally { await new Promise(resolve => occupied.close(resolve)); }
    await assert.rejects(launchManualChrome({ executablePath: chromeExecutable(), profileDirectory: path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Google', 'Chrome', 'User Data'), port: await freshPort(), headlessForTests: true }), { code: 'PERSONAL_PROFILE' }); checks++;
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const url = 'http://127.0.0.1:' + server.address().port;
    let browser = await launch();
    const page = browser.context.pages()[0] || await browser.context.newPage();
    check(await page.url() === 'about:blank', 'helper does not navigate before restore');
    let persistence = createSessionPersistence(browser.context, profile);
    await persistence.restore(); persistence.start();
    await page.goto(url + '/login');
    let cookies = await browser.context.cookies(url);
    check(cookies.some(cookie => cookie.name === 'fixture_session' && cookie.httpOnly && cookie.expires === -1), 'fixture created genuine HttpOnly session-only cookie');
    await persistence.stop({ save: true });
    const firstExit = await browser.close(); await browser.closed; live.delete(browser);
    check(!browser.browser.isConnected(), 'graceful close waits for owned browser exit/disconnect');
    check(firstExit.exitCode === 0 && !firstExit.signal, 'close returns exact native process exit metadata');
    // Match the actual service transition, not just a second native launch.
    serviceContext = await chromium.launchPersistentContext(profile, {
      executablePath: chromeExecutable(), headless: true, acceptDownloads: false,
      args: ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + await freshPort(),
        '--proxy-server=http://127.0.0.1:9', '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
    });
    persistence = createSessionPersistence(serviceContext, profile);
    const restored = await persistence.restore(); persistence.start();
    cookies = await serviceContext.cookies(url);
    check(restored.restored >= 1 && cookies.some(cookie => cookie.name === 'fixture_session' && cookie.httpOnly && cookie.expires === -1), 'native login checkpoint restores exact session semantics in actual headless service launch');
    const logoutPage = serviceContext.pages()[0] || await serviceContext.newPage();
    await logoutPage.goto(url + '/logout');
    check(!(await serviceContext.cookies(url)).some(cookie => cookie.name === 'fixture_session'), 'logout removes current session cookie');
    await persistence.stop({ save: true }); await serviceContext.close(); serviceContext = null;
    browser = await launch();
    persistence = createSessionPersistence(browser.context, profile);
    await persistence.restore();
    check(!(await browser.context.cookies(url)).some(cookie => cookie.name === 'fixture_session'), 'logout remains cleared after native close/relaunch');
    await persistence.stop({ save: true });
    const closeOne = browser.close(), closeTwo = browser.close();
    check(closeOne === closeTwo, 'concurrent close is serialized');
    const finalExit = await closeOne; await browser.closed; live.delete(browser);
    check(finalExit.exitCode === 0 && !finalExit.signal, 'idempotent close confirms owned native process exit');
    browser = await launch();
    const externalClose = await browser.browser.newBrowserCDPSession();
    await externalClose.send('Browser.close').catch(() => {});
    const userCloseExit = await browser.closed;
    check(userCloseExit.exitCode === 0 && !userCloseExit.signal, 'externally requested graceful window/browser close waits exact child exit');
    await browser.close(); live.delete(browser);
    console.log(JSON.stringify({ ok: true, checks, disposableHeadlessOnly: true, realProfilesOpened: false, googleSignInVerified: false }));
  } finally {
    for (const browser of live) await browser.close().catch(() => {});
    await serviceContext?.close().catch(() => {});
    if (server.listening) await new Promise(resolve => server.close(resolve));
    const resolved = path.resolve(fixture), intended = path.resolve(os.tmpdir());
    if (path.dirname(resolved) !== intended || !path.basename(resolved).startsWith('background-browser-manual-test-')) throw new Error('Fixture cleanup boundary failed.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(JSON.stringify({ ok: false, code: error.code || 'TEST_FAILED', message: error.message })); process.exitCode = 1; });
