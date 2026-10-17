'use strict';
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { chromium } = require('playwright');
const { createSessionPersistence } = require('./session-state.cjs');

async function main() {
  const work = path.join(__dirname, 'work');
  await fs.mkdir(work, { recursive: true });
  const fixture = await fs.mkdtemp(path.join(work, 'session-state-test-'));
  const profile = path.join(fixture, 'profile');
  const value = randomBytes(24).toString('hex');
  let context, persistence, listener;
  let checks = 0;
  const ok = (condition, message) => { assert.ok(condition, message); checks++; };
  const launch = () => chromium.launchPersistentContext(profile, { executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, acceptDownloads: false,
    args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=127.0.0.1;localhost', '--host-resolver-rules=MAP * 127.0.0.1'] });
  const waitSnapshot = async count => {
    for (let i = 0; i < 80; i++) {
      try {
        const state = JSON.parse(await fs.readFile(path.join(profile, 'session-handoff', 'cookies.json'), 'utf8'));
        if (state.cookies.length === count) return state;
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error('Periodic session checkpoint did not reach expected synthetic fixture state.');
  };
  try {
    listener = http.createServer((req, res) => {
      if (req.url === '/login') res.setHeader('Set-Cookie', `fixture_session=${value}; HttpOnly; SameSite=Lax; Path=/`);
      if (req.url === '/logout') res.setHeader('Set-Cookie', 'fixture_session=; Max-Age=0; HttpOnly; SameSite=Lax; Path=/');
      if (req.url === '/private' && !req.headers.cookie?.split(';').some(cookie => cookie.trim() === `fixture_session=${value}`)) { res.writeHead(401); return res.end('Signed out'); }
      res.writeHead(200, { 'Content-Type': 'text/plain' }); res.end(req.url === '/private' ? 'Authenticated synthetic fixture' : 'Fixture ready');
    });
    await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${listener.address().port}`;
    context = await launch();
    // Disable the normal one-second fallback here: prompt navigation/Set-Cookie events must save it.
    persistence = createSessionPersistence(context, profile, { intervalMs: 60000 });
    ok((await persistence.restore()).restored === 0, 'New profile needs no snapshot.');
    persistence.start();
    const page = context.pages()[0] || await context.newPage();
    await page.goto(url + '/login');
    const cookie = (await context.cookies()).find(cookie => cookie.name === 'fixture_session');
    ok(cookie?.expires === -1 && cookie.httpOnly === true, 'Fixture cookie is HttpOnly and session-only.');
    const saved = await waitSnapshot(1);
    ok(saved.cookies[0].expires === -1 && saved.cookies[0].httpOnly === true, 'Prompt event checkpoint preserves native cookie flags/expiration before polling.');
    // Simulate the user closing their window: no explicit pre-close checkpoint.
    await context.close(); context = undefined;
    await persistence.stop(); persistence = undefined;
    context = await launch();
    const nativeSessionCookieSurvived = (await context.cookies()).some(cookie => cookie.name === 'fixture_session');
    persistence = createSessionPersistence(context, profile, { intervalMs: 60000 });
    ok((await persistence.restore()).restored === 1, 'Saved session cookie is restored after actual Chrome close/relaunch.');
    persistence.start();
    const page2 = context.pages()[0] || await context.newPage();
    ok((await page2.goto(url + '/private')).status() === 200, 'Restored HttpOnly session authenticates the local fixture.');
    await Promise.all([persistence.checkpoint(), persistence.checkpoint(), persistence.checkpoint()]);
    ok(!(await fs.readdir(path.join(profile, 'session-handoff'))).some(name => name.startsWith('cookies.json.') && name.endsWith('.tmp')), 'Serialized atomic checkpoints leave no partial temporary state.');
    await page2.goto(url + '/logout');
    ok((await waitSnapshot(0)).cookies.length === 0, 'Prompt event checkpoint replaces old state after logout before polling.');
    await page2.evaluate(() => fetch('/login').then(response => response.text()));
    ok((await waitSnapshot(1)).cookies.length === 1, 'Set-Cookie response without main-frame navigation triggers a prompt checkpoint.');
    await page2.evaluate(() => fetch('/logout').then(response => response.text()));
    ok((await waitSnapshot(0)).cookies.length === 0, 'AJAX logout replaces the snapshot without waiting for navigation or polling.');
    await persistence.stop({ save: true }); persistence = undefined;
    await context.close(); context = undefined;
    context = await launch();
    persistence = createSessionPersistence(context, profile);
    ok((await persistence.restore()).restored === 0, 'Logout snapshot restores no stale session cookies.');
    const page3 = context.pages()[0] || await context.newPage();
    ok((await page3.goto(url + '/private')).status() === 401, 'Logged-out session remains logged out after another Chrome restart.');
    await assert.rejects(() => persistence.restore(), /once per browser launch/); checks++;
    await persistence.stop({ save: true }); persistence = undefined;
    await context.close(); context = undefined;
    console.log(JSON.stringify({ ok: true, checks, realChromeHeadless: true, syntheticLoopbackHttpFixtureOnly: true, nativeSessionCookieSurvived, sessionCookieFlagsPreserved: true, authenticationRestoredAcrossRestart: true, logoutPreservedAcrossRestart: true, actualUserProfileAccessed: false }));
  } finally {
    if (persistence) await persistence.stop().catch(() => {});
    if (context) await context.close().catch(() => {});
    if (listener) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
    const resolved = path.resolve(fixture), boundary = path.resolve(work) + path.sep;
    if (!resolved.startsWith(boundary)) throw new Error('Unsafe fixture cleanup target.');
    await fs.rm(resolved, { recursive: true, force: true });
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
