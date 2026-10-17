'use strict';
// User initiated only: opens a visible browser for the selected site's password/MFA.
const fs = require('node:fs');
const { chromeExecutable } = require('./runtime-paths.cjs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { launchManualChrome } = require('./manual-chrome.cjs');
const { createSessionPersistence } = require('./session-state.cjs');
const { LOGIN_PIPE, parseLoginOptions, createLoginCommandServer } = require('./login-control.cjs');
const root = __dirname, token = randomUUID(), pause = path.join(root, 'login.pause');
const profile = path.join(root, 'profiles', 'default');
const stateFile = path.join(root, 'login-state.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let context, manualChrome, commands, ownsPause = false, sessionPersistence, options, finishPromise;
let status = 'starting', startedAt, savedAt, active = false, ownedPipe = false;
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function removeOwned() { if (read(pause)?.token === token) { try { fs.unlinkSync(pause); } catch {} } }
function metadata() { return { pid: process.pid, status, active, siteId: options.siteId, siteName: options.siteName, url: options.displayUrl, startedAt, savedAt, loginMode: 'standard-chrome', authenticationVerified: false }; }
function state(next, extra = {}) {
  status = next;
  const temporary = stateFile + '.' + process.pid + '.tmp';
  fs.writeFileSync(temporary, JSON.stringify({ ...metadata(), ...extra, updatedAt: new Date().toISOString() }, null, 2));
  fs.renameSync(temporary, stateFile);
}
function snapshotStat() {
  try { const stat = fs.statSync(path.join(profile, 'session-handoff', 'cookies.json')); return { mtimeMs: stat.mtimeMs, ino: stat.ino }; } catch { return null; }
}
async function finishCurrent() {
  if (!context || status !== 'login-open') throw new Error('Sign-in window is not ready.');
  finishPromise = (async () => {
    state('saving-session');
    try {
      // An explicit Finish command saves while the context is alive, then closes Chrome.
      await sessionPersistence.stop({ save: true });
      savedAt = new Date().toISOString();
      await manualChrome.close();
      const exit = await manualChrome.closed;
      if (exit.exitCode !== 0 || exit.signal) throw new Error('The sign-in browser did not close cleanly.');
      context = null;
      active = false;
      state('session-saved', { finishedVia: 'finish-command' });
    } catch (error) { state('login-open', { error: 'The session could not be saved. Keep this window open and retry Finish.' }); throw error; }
  })();
  return finishPromise;
}
async function main() {
  options = parseLoginOptions(process.argv.slice(2));
  startedAt = new Date().toISOString();
  commands = createLoginCommandServer({ token, getMetadata: metadata, onFinish: finishCurrent });
  try { await new Promise((resolve, reject) => { commands.server.once('error', reject); commands.server.listen(LOGIN_PIPE, resolve); }); }
  catch { throw new Error('A profile sign-in window is already open.'); }
  ownedPipe = true;
  // Owning the live singleton pipe proves any older marker is stale.
  try { fs.unlinkSync(pause); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  fs.writeFileSync(pause, JSON.stringify({ pid: process.pid, token, started: startedAt, siteId: options.siteId }), { flag: 'wx' });
  ownsPause = true; active = true;
  process.on('exit', removeOwned);
  state('waiting-for-profile');
  let paused = false;
  for (let attempt = 0; attempt < 240; attempt++) {
    const service = read(path.join(root, 'service-state.json'));
    if (service?.status === 'paused-for-login' && service.loginToken === token && !service.serverPid) { paused = true; break; }
    if (service?.status === 'stopped') throw new Error('The background browser service is stopped.');
    await sleep(250);
  }
  if (!paused) throw new Error('The background manager did not release the profile.');
  state('opening-sign-in');
  // Start installed Chrome directly, then attach through Chrome's supported debugging protocol.
  // The user still performs sign-in; no browser fingerprint or automation properties are changed.
  manualChrome = await launchManualChrome({ executablePath: chromeExecutable(root), profileDirectory: profile });
  context = manualChrome.context;
  sessionPersistence = createSessionPersistence(context, profile);
  await sessionPersistence.restore();
  const previousSnapshot = snapshotStat();
  sessionPersistence.start();
  const closed = manualChrome.closed;
  const page = context.pages()[0] || await context.newPage();
  await page.goto(options.url, { waitUntil: 'domcontentloaded', timeout: 60000 });
  state('login-open');
  const exit = await closed;
  if (finishPromise) await finishPromise;
  else {
    await sessionPersistence.stop();
    const latest = snapshotStat();
    active = false;
    if (exit.exitCode !== 0 || exit.signal) state('error', { error: 'The sign-in window stopped unexpectedly. Reopen this website and verify the session.' });
    else if (latest && (!previousSnapshot || latest.mtimeMs !== previousSnapshot.mtimeMs || latest.ino !== previousSnapshot.ino)) {
      savedAt = new Date(latest.mtimeMs).toISOString();
      state('session-saved', { finishedVia: 'window-close' });
    } else state('error', { error: 'No new session checkpoint was confirmed. Reopen sign-in and use Finish after signing in.' });
  }
  sessionPersistence = null;
  context = null;
}
main().catch(error => {
  if (error.ownedChrome) manualChrome = error.ownedChrome;
  process.exitCode = 1;
  if (ownedPipe) { active = false; state('error', { error: 'Sign-in did not finish. Reopen the selected site and try again.' }); }
  // Navigation error stacks can include sensitive URL query strings: persist no raw stack/URL.
  fs.writeFileSync(path.join(root, 'login-error.txt'), new Date().toISOString() + ' Sign-in did not finish.');
}).finally(async () => {
  // Pause remains owned until Chrome and its checkpoint writer have fully finished.
  if (context) {
    await sessionPersistence?.stop({ save: true }).catch(() => {});
  } else await sessionPersistence?.stop().catch(() => {});
  if (manualChrome) {
    try { await manualChrome.close(); }
    catch {
      // Never let the manager reopen a profile still owned by this login process.
      active = true;
      state('error', { error: 'The sign-in browser is still open. Close that separate Chrome window to return to background browsing.' });
      await manualChrome.closed;
      active = false;
      state('error', { error: 'Sign-in did not finish. Reopen this website and verify the session.' });
    }
  }
  if (ownsPause) removeOwned();
  if (commands) await commands.close();
});
