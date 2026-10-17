'use strict';
const fs = require('node:fs');
const { chromeExecutable } = require('./runtime-paths.cjs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const { createSessionPersistence } = require('./session-state.cjs');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { createMcpGuardian } = require('./mcp-guardian.cjs');
const root = __dirname, token = randomUUID();
const managerStartedAt = Date.now() / 1000 - process.uptime();
const profile = path.join(root, 'profiles', 'default');
const artifacts = path.join(root, 'artifacts');
const lock = path.join(root, 'service.lock'), pause = path.join(root, 'login.pause');
const stopIndex = process.argv.indexOf('--stop-file');
if (stopIndex >= 0 && !process.argv[stopIndex + 1]) throw new Error('--stop-file needs a path');
const stopFile = stopIndex < 0 ? path.join(root, 'service.stop') : path.resolve(process.argv[stopIndex + 1]);
const managerPipe = '\\\\.\\pipe\\BackgroundBrowserMCP-manager-v1';
const loginPipe = '\\\\.\\pipe\\BackgroundBrowserMCP-login-v1';
const url = 'http://127.0.0.1:8933/mcp', cdpUrl = 'http://127.0.0.1:8935';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
let context = null, server = null, stopping = false, lastStatus = '', manager, sessionPersistence = null, guardian = null;
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function removeOwned(file, owner) { if (read(file)?.token === owner) { try { fs.unlinkSync(file); } catch {} } }
function state(status, extra = {}) {
  lastStatus = status;
  const record = { status, managerPid: process.pid, managerToken: token, serverPid: server?.process.pid ?? null,
    url, cdpUrl, profile, headless: true, managerStartedAt, clientGuardian: guardian?.isAlive() === true,
    updated: new Date().toISOString(), ...extra };
  const temporary = path.join(root, 'service-state.' + process.pid + '.tmp');
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2));
  fs.renameSync(temporary, path.join(root, 'service-state.json'));
}
function log(error) { fs.appendFileSync(path.join(root, 'manager.log'), new Date().toISOString() + ' ' + String(error?.stack || error) + '\n'); }
function listen(serverObject, address) {
  return new Promise((resolve, reject) => { serverObject.once('error', reject); serverObject.listen(address, resolve); });
}
async function freePort(port) {
  const probe = net.createServer();
  await listen(probe, { host: '127.0.0.1', port });
  await new Promise(resolve => probe.close(resolve));
}
function pauseOwnerAlive(owner) {
  return new Promise(resolve => {
    const socket = net.connect(loginPipe); let text = '', finished = false;
    const finish = alive => { if (!finished) { finished = true; socket.destroy(); resolve(alive); } };
    socket.setTimeout(1000, () => finish(false));
    socket.on('data', data => { text += data; if (text.includes('\n')) { try { finish(JSON.parse(text).token === owner); } catch { finish(false); } } });
    socket.on('error', () => finish(false)); socket.on('end', () => finish(false));
  });
}
async function activePause() {
  if (!fs.existsSync(pause)) return null;
  const record = read(pause);
  if (record?.token && await pauseOwnerAlive(record.token)) return record;
  if (record?.token) removeOwned(pause, record.token);
  else { try { fs.unlinkSync(pause); } catch {} }
  return null;
}
async function stopOwned() {
  // This process owns the Playwright context and can flush and close it directly.
  // The MCP child only attaches over CDP; it never launches the browser.
  let checkpointError;
  if (context) {
    // Snapshot while the context is alive; a close event is too late to read session cookies.
    try { await sessionPersistence?.stop({ save: true }); }
    catch { checkpointError = new Error('Session cookies could not be saved before browser close.'); }
    sessionPersistence = null;
    await context.close(); context = null;
  } else if (sessionPersistence) { await sessionPersistence.stop(); sessionPersistence = null; }
  // Only after the owned context has been saved/closed may the final MCP
  // backend client disconnect. This cannot race routine collector teardown.
  if (guardian) {
    const currentGuardian = guardian; guardian = null;
    await currentGuardian.stop().catch(log);
  }
  if (server) {
    const current = server;
    if (!current.closed) current.process.kill();
    await Promise.race([current.done, sleep(5000)]);
    if (!current.closed) throw new Error('Owned MCP server has not exited; profile stays unavailable for login.');
    if (server === current) server = null;
  }
  if (checkpointError) throw checkpointError;
}
async function startOwned() {
  state('starting');
  await freePort(8933); await freePort(8935);
  context = await chromium.launchPersistentContext(profile, { executablePath: chromeExecutable(root), headless: true, acceptDownloads: false,
    args: ['--remote-debugging-port=8935', '--remote-debugging-address=127.0.0.1'] });
  sessionPersistence = createSessionPersistence(context, profile);
  await sessionPersistence.restore();
  sessionPersistence.start();
  const ownedContext = context;
  ownedContext.on('close', () => { if (context === ownedContext) context = null; });
  const logFile = path.join(root, 'service.log');
  if (fs.existsSync(logFile) && fs.statSync(logFile).size > 1048576) {
    try { fs.unlinkSync(logFile + '.previous'); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    fs.renameSync(logFile, logFile + '.previous');
  }
  const fd = fs.openSync(logFile, 'a');
  let child;
  try { child = spawn(process.execPath, [path.join(root, 'node_modules', '@playwright', 'mcp', 'cli.js'),
    '--cdp-endpoint', cdpUrl, '--shared-browser-context', '--host', '127.0.0.1', '--port', '8933',
    '--allowed-hosts', 'localhost:8933,127.0.0.1:8933', '--output-dir', artifacts, '--no-webmcp', '--codegen', 'none'],
    { cwd: root, shell: false, windowsHide: true, stdio: ['ignore', fd, fd] }); }
  finally { fs.closeSync(fd); }
  const current = { process: child, closed: false, error: null };
  current.done = new Promise(resolve => child.once('close', (code, signal) => { current.closed = true; current.exitCode = code; current.signal = signal; resolve(); }));
  child.on('error', error => { current.error = error; });
  server = current;
  guardian = createMcpGuardian({ Client, Transport: StreamableHTTPClientTransport, url });
  let lastError;
  for (let attempt = 0; attempt < 60; attempt++) {
    if (stopping || fs.existsSync(stopFile) || fs.existsSync(pause)) return;
    if (current.closed || current.error || !context) throw current.error || new Error('Browser/server exited during startup');
    try { await guardian.start(); state('running', { ready: true }); return; }
    catch (error) { lastError = error; if (guardian.hasFailed()) throw error; }
    await sleep(250);
  }
  throw new Error('MCP readiness failed: ' + lastError?.message);
}
async function main() {
  fs.mkdirSync(profile, { recursive: true }); fs.mkdirSync(artifacts, { recursive: true });
  // A Windows named pipe is the live singleton lock: no stale-file or PID-reuse ambiguity.
  manager = net.createServer(socket => socket.end(JSON.stringify({ pid: process.pid, token }) + '\n'));
  try { await listen(manager, managerPipe); } catch (error) { if (error.code === 'EADDRINUSE') return; throw error; }
  fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, token, started: new Date().toISOString() }));
  process.on('exit', () => removeOwned(lock, token));
  process.on('SIGINT', () => { stopping = true; }); process.on('SIGTERM', () => { stopping = true; });
  let failures = 0, retryAt = 0, pausedToken = null;
  try {
    state('starting');
    while (!stopping) {
      if (fs.existsSync(stopFile)) { try { fs.unlinkSync(stopFile); } catch {} stopping = true; break; }
      try {
        const paused = await activePause();
        if (paused) {
          if (context || server) { state('pausing-for-login'); await stopOwned(); }
          if (lastStatus !== 'paused-for-login' || pausedToken !== paused.token) {
            state('paused-for-login', { loginToken: paused.token, ready: false }); pausedToken = paused.token;
          }
        } else {
          if (lastStatus === 'retrying' && Date.now() < retryAt) { await sleep(250); continue; }
          if (lastStatus === 'retrying' && (context || server)) await stopOwned();
          if ((server && (server.closed || server.error)) || (server && !context)) {
            const error = server.error || new Error('Owned browser/server exited');
            await stopOwned(); throw error;
          }
          if (server && context && guardian && !guardian.isAlive()) {
            await stopOwned(); throw new Error('Private browser lifecycle guardian disconnected.');
          }
          if (!context && !server && Date.now() >= retryAt) {
            await startOwned(); if (lastStatus === 'running') failures = 0;
          }
        }
      } catch (error) {
        log(error); await stopOwned().catch(log); failures++;
        retryAt = Date.now() + Math.min(30000, failures * 1000);
        state('retrying', { error: error.message, retryAt: new Date(retryAt).toISOString(), ready: false });
      }
      await sleep(250);
    }
  } finally {
    state('stopping', { ready: false });
    await stopOwned(); state('stopped', { ready: false });
    removeOwned(lock, token); await new Promise(resolve => manager.close(resolve));
  }
}
main().catch(error => { log(error); process.exitCode = 1; manager?.close(); });
