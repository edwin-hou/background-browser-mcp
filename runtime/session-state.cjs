'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

// A persistent Chromium profile does not guarantee session-cookie survival across browser restarts.
// Keep only session cookies; leave persistent cookies/local storage to Chromium's profile storage.
// Installation provisions session-handoff with a restrictive, non-inherited Windows ACL.
// The file and every temporary write stay inside that private folder. They must never be logged,
// exposed as a browser artifact, or copied outside this protected profile directory.
function createSessionPersistence(context, profileDirectory, { intervalMs = 1000 } = {}) {
  const privateDirectory = path.join(profileDirectory, 'session-handoff');
  const filename = path.join(privateDirectory, 'cookies.json');
  let queue = Promise.resolve(), timer, promptTimer, periodicPending = false, checkpointWanted = false, stopped = false, restored = false;
  const pageHandlers = new Map();
  const serialize = operation => {
    const result = queue.then(operation);
    queue = result.catch(() => {});
    return result;
  };
  async function restore() {
    if (restored) throw new Error('Session cookies may only be restored once per browser launch.');
    restored = true;
    let state;
    try { state = JSON.parse(await fs.readFile(filename, 'utf8')); }
    catch (error) {
      if (error.code === 'ENOENT') return { restored: 0 };
      throw new Error('Saved session-cookie state could not be read.');
    }
    if (state.version !== 1 || !Array.isArray(state.cookies) || state.cookies.length > 5000 || state.cookies.some(cookie => !cookie || cookie.expires !== -1 || typeof cookie.name !== 'string' || typeof cookie.value !== 'string' || typeof cookie.domain !== 'string' || typeof cookie.path !== 'string')) throw new Error('Saved session-cookie state is invalid.');
    // Do not manufacture an expiration date or clear durable browser data. addCookies is supported.
    if (state.cookies.length) {
      try { await context.addCookies(state.cookies); }
      catch { throw new Error('Saved session cookies could not be restored.'); }
    }
    return { restored: state.cookies.length };
  }
  function checkpoint() {
    return serialize(async () => {
      const cookies = (await context.cookies()).filter(cookie => cookie.expires === -1);
      const state = { version: 1, savedAt: new Date().toISOString(), cookies };
      await fs.mkdir(privateDirectory, { recursive: true });
      const temporary = filename + '.' + process.pid + '.' + randomUUID() + '.tmp';
      try {
        await fs.writeFile(temporary, JSON.stringify(state), { flag: 'wx', mode: 0o600 });
        await fs.rename(temporary, filename);
      } finally { await fs.unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; }); }
      // An empty current cookie jar deliberately replaces older snapshots: never resurrect logout.
      return { saved: cookies.length };
    });
  }
  function runCheckpoint() {
    if (stopped) return;
    if (periodicPending) { checkpointWanted = true; return; }
    checkpointWanted = false;
    periodicPending = true;
    checkpoint().catch(() => {}).finally(() => {
      periodicPending = false;
      if (checkpointWanted && !stopped) schedulePromptCheckpoint();
    });
  }
  function schedulePromptCheckpoint() {
    if (stopped) return;
    checkpointWanted = true;
    if (promptTimer) return;
    // Coalesce redirect chains/cookie responses while capturing soon enough for a quick window close.
    promptTimer = setTimeout(() => { promptTimer = undefined; runCheckpoint(); }, 25);
    promptTimer.unref();
  }
  function watchPage(page) {
    if (pageHandlers.has(page)) return;
    const onNavigation = frame => { if (frame === page.mainFrame()) schedulePromptCheckpoint(); };
    pageHandlers.set(page, onNavigation);
    page.on('framenavigated', onNavigation);
  }
  async function onResponse(response) {
    try {
      // Inspect header NAMES only; cookie/header contents never enter status files or logs.
      if ((await response.headersArray()).some(header => header.name.toLowerCase() === 'set-cookie')) schedulePromptCheckpoint();
    } catch { /* A response can disappear while the owner closes Chrome. */ }
  }
  function start() {
    if (!restored) throw new Error('Restore session cookies before starting checkpoints.');
    if (stopped || timer) return;
    for (const page of context.pages()) watchPage(page);
    context.on('page', watchPage);
    context.on('response', onResponse);
    timer = setInterval(runCheckpoint, intervalMs);
    timer.unref();
  }
  async function stop({ save = false } = {}) {
    stopped = true;
    clearInterval(timer); timer = undefined;
    clearTimeout(promptTimer); promptTimer = undefined;
    context.removeListener('page', watchPage);
    context.removeListener('response', onResponse);
    for (const [page, handler] of pageHandlers) page.removeListener('framenavigated', handler);
    pageHandlers.clear();
    await queue;
    if (save) return checkpoint();
  }
  context.once('close', () => { stop().catch(() => {}); });
  return { restore, start, checkpoint, stop };
}
module.exports = { createSessionPersistence };
