'use strict';
const fs = require('node:fs'), path = require('node:path'), http = require('node:http');
const { spawn } = require('node:child_process');
const { randomBytes, randomUUID, timingSafeEqual, createHash } = require('node:crypto');
const ROOT = path.resolve(__dirname, '..'), ORIGIN = 'http://127.0.0.1:8936';
const STABLE = 'https://chatgpt.com/connector_platform_oauth_redirect';
const secretFile = path.join(__dirname, 'transport-secret.json'), stopFile = path.join(__dirname, 'portal.stop');
const tokenFile = path.join(__dirname, 'access-token.txt'), lockFile = path.join(__dirname, 'portal.lock');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const read = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
const esc = text => String(text ?? '').replace(/[&<>"']/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[c]));
function same(a, b) { const aa = Buffer.from(String(a ?? '')), bb = Buffer.from(String(b ?? '')); return aa.length === bb.length && timingSafeEqual(aa, bb); }
function domain(value) {
  const text = String(value ?? '').trim(), url = new URL(text.includes('://') ? text : 'https://' + text);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.search || url.hash || url.pathname !== '/' ||
      !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.ngrok-free\.(?:app|dev)$/.test(url.hostname)) throw new Error('Use your assigned free ngrok domain, ending in .ngrok-free.app or .ngrok-free.dev.');
  return url.origin;
}
function callback(value) {
  const text = String(value ?? '').trim(); if (!text) return '';
  const url = new URL(text);
  if (url.protocol !== 'https:' || url.hostname !== 'chatgpt.com' || url.port || url.username || url.password || url.search || url.hash ||
      !(text === STABLE || /^\/connector\/oauth\/[A-Za-z0-9_-]+$/.test(url.pathname))) throw new Error('Paste the exact HTTPS callback from ChatGPT on chatgpt.com.');
  return url.href;
}
function settings(input, previous = {}) {
  const authtoken = String(input.authtoken || previous.authtoken || '').trim();
  if (!/^[A-Za-z0-9._-]{10,512}$/.test(authtoken)) throw new Error('Enter your ngrok authtoken from its free dashboard.');
  return { publicBaseUrl: domain(input.domain || input.publicBaseUrl), authtoken, callback: callback(input.callback) };
}
function writeJson(file, value) { fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2), { mode: 0o600 }); fs.renameSync(file + '.tmp', file); }
// Preserve the Origin on ordinary form POSTs, while omitting paths and query tokens from Referer.
// no-referrer makes navigation/form Origin null under the Fetch standard.
const HEADERS = { 'Content-Security-Policy': "default-src 'none'; script-src 'self'; connect-src 'self'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  'X-Frame-Options':'DENY', 'X-Content-Type-Options':'nosniff', 'Referrer-Policy':'strict-origin', 'Cache-Control':'no-store, max-age=0',
  'Pragma':'no-cache', 'Cross-Origin-Opener-Policy':'same-origin', 'Permissions-Policy':'camera=(), microphone=(), geolocation=()' };
const { renderDashboard } = require('./dashboard.cjs');
const { createSiteStore, validId } = require('./sites.cjs');
const { finishLogin } = require('../login-control.cjs');
const { createDashboardHealth } = require('./health.cjs');
const { readConnectionStatus } = require('../connection-status.cjs');
const DASHBOARD_CLIENT = fs.readFileSync(path.join(__dirname, 'dashboard-client.js'), 'utf8');
const SESSION_VIEW = fs.readFileSync(path.join(__dirname, 'session-view.js'), 'utf8');
function syncSavedSession(sites, state) {
  if (!state.active && state.status === 'session-saved' && state.savedAt) sites.markSaved(state.siteId, state.savedAt);
}
function accountStates(root, sites) {
  return sites.map(site => {
    const filename = createHash('sha256').update(site.id).digest('hex') + '.json';
    const value = read(path.join(root, 'setup', 'account-observations', filename));
    const now = Date.now(), observedTime = typeof value?.observedAt === 'string' ? Date.parse(value.observedAt) : NaN;
    const validObservation = value?.version === 1 && value.siteId === site.id && ['sign-in-required', 'verified'].includes(value.state) &&
      !isNaN(observedTime) && observedTime <= now + 60000;
    const valid = validObservation && !(site.lastSavedAt && Date.parse(site.lastSavedAt) > observedTime) &&
      (value.state !== 'verified' || now - observedTime < 86400000);
    const lastVerifiedAt = validObservation && value.state === 'verified' ? new Date(observedTime).toISOString() : null;
    return { siteId: site.id, state: valid ? value.state : 'not-checked', observedAt: valid ? value.observedAt : null, savedAt: site.lastSavedAt || null, lastVerifiedAt };
  });
}
function loginView(current = {}, health = null) {
  const saved = current?.status === 'session-saved' && current.active === false;
  const failed = current?.status === 'error';
  // The authenticated pipe exists before Chrome and the page are ready.
  const paused = health?.mode === 'paused';
  const canFinish = !saved && paused && current?.status === 'login-open';
  const opening = !saved && (paused || (current?.active === true && current.helperActive === true));
  const active = canFinish || opening;
  const siteId = active && typeof current?.siteId === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(current.siteId) ? current.siteId : null;
  const name = typeof current?.siteName === 'string' ? current.siteName.trim() : '';
  const siteName = active && siteId && name && name.length <= 80 && !/[\u0000-\u001f\u007f<>]/.test(name) ? name : null;
  return { active, canFinish, failed, phase: canFinish ? 'ready' : opening ? 'opening' : 'idle', siteId, siteName };
}
const PLUGIN_URL = 'https://chatgpt.com/';
const NOTICES = { 'login-started':'Your sign-in window is opening. Sign in on the website, then return here and save your session.', 'session-saved':'Session saved. Your browser is returning to background mode.', 'site-added':'Website added. Choose Sign in when you are ready.', 'site-removed':'Website shortcut removed. Its browser data was kept.', 'transport-saved':'Connection settings saved. The free connection is starting in the background.' };
function page(ctx, message = '') { return renderDashboard(ctx, message); }
function makeHandler(ctx, { origin = ORIGIN } = {}) {
  // Tests can bind an isolated ephemeral loopback server; production always uses ORIGIN.
  const address = new URL(origin);
  if (address.protocol !== 'http:' || address.hostname !== '127.0.0.1' || address.pathname !== '/' || address.search || address.hash || address.username || address.password) throw new Error('Invalid local dashboard origin.');
  const expectedHost = address.host;
  return async (req, res) => {
    const send = (code, text, html = false, extra = {}) => { res.writeHead(code, { ...HEADERS, 'Content-Type': html ? 'text/html; charset=utf-8' : 'text/plain; charset=utf-8', ...extra }); res.end(text); };
    try {
      if (req.headers.host !== expectedHost || !['127.0.0.1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress)) return send(403, 'Local setup access only.');
      const url = new URL(req.url, origin);
      if (url.origin !== origin || url.searchParams.getAll('token').length !== 1 || !same(url.searchParams.get('token'), ctx.token)) return send(403, 'Open your private setup shortcut.');
      const rawPath = req.url.split('?')[0];
      if (!['/', '/status', '/dashboard-client.js', '/session-view.js', '/login', '/login/finish', '/sites/add', '/sites/remove', '/transport'].includes(rawPath)) return send(404, 'Not found.');
      if (req.method === 'GET' && url.pathname === '/') {
        const [connectionHealth, requestOutcomes] = await Promise.all([ctx.health ? ctx.health() : null, ctx.requests ? ctx.requests() : null]);
        const currentLogin = typeof ctx.login === 'function' ? ctx.login() : {};
        return send(200, page({ ...ctx, connectionHealth, requestOutcomes, login: loginView(currentLogin, connectionHealth) }, NOTICES[url.searchParams.get('notice')] || ''), true);
      }
      if (req.method === 'GET' && url.pathname === '/session-view.js') return send(200, SESSION_VIEW, false, { 'Content-Type': 'application/javascript; charset=utf-8' });
      if (req.method === 'GET' && url.pathname === '/dashboard-client.js') return send(200, DASHBOARD_CLIENT, false, { 'Content-Type': 'application/javascript; charset=utf-8' });
      if (req.method === 'GET' && url.pathname === '/status') {
        try {
          const health = ctx.health ? await ctx.health() : { version: 1, mode: 'checking', messageCode: 'checking', local: { state: 'checking' }, remote: { state: 'unconfigured' }, waitingForOwner: false, checkedAt: new Date().toISOString() };
          const accounts = typeof ctx.accounts === 'function' ? ctx.accounts() : [];
          const currentLogin = typeof ctx.login === 'function' ? ctx.login() : {};
          const login = loginView(currentLogin, health);
          const requests = ctx.requests ? await ctx.requests() : null;
          return send(200, JSON.stringify({ ...health, accounts, login, requests }), false, { 'Content-Type': 'application/json; charset=utf-8' });
        } catch { return send(503, JSON.stringify({ error: 'Connection status unavailable.' }), false, { 'Content-Type': 'application/json; charset=utf-8' }); }
      }
      if (req.method !== 'POST') return send(405, 'Method not allowed.');
      if (req.headers.origin !== origin || !/^application\/x-www-form-urlencoded(?:;|$)/i.test(req.headers['content-type'] || '')) return send(403, 'Invalid setup form origin.');
      let body = ''; for await (const chunk of req) { body += chunk; if (Buffer.byteLength(body) > 8192) return send(413, 'Form too large.'); }
      const form = new URLSearchParams(body);
      if ([...form.keys()].some(key => form.getAll(key).length !== 1) || !same(form.get('csrf'), ctx.token)) return send(403, 'Invalid setup form token.');
      const redirect = notice => send(303, 'Return to your dashboard.', false, { Location: '/?token=' + encodeURIComponent(ctx.token) + '&notice=' + notice });
      if (url.pathname === '/login') { await ctx.startLogin(form.get('siteId') || 'vanderbilt-brightspace'); return redirect('login-started'); }
      if (url.pathname === '/login/finish') { await ctx.finishLogin(); return redirect('session-saved'); }
      if (url.pathname === '/sites/add') { await ctx.addSite({ name: form.get('name'), url: form.get('url') }); return redirect('site-added'); }
      if (url.pathname === '/sites/remove') { await ctx.removeSite(validId(form.get('siteId'))); return redirect('site-removed'); }
      if (url.pathname === '/transport') {
        const saved = settings(Object.fromEntries(form), ctx.saved() || {}); await ctx.save(saved);
        return redirect('transport-saved');
      }
      return send(404, 'Not found.');
    } catch (error) { return send(400, page(ctx, ['A login helper is already open.', 'Keep the linked ngrok domain. Changing it requires reconnecting ChatGPT and explicitly resetting its saved authorization.', 'Enter a valid HTTPS website address.', 'Use an HTTPS website address without embedded credentials or a custom port.', 'Use a website name of 80 characters or fewer.', 'Choose a saved website.', 'You can save up to 100 websites.', 'That website is already saved.', 'Finish the open sign-in window before removing its shortcut.', 'No sign-in window is open.', 'The sign-in window is still opening. Wait a moment and try again.', 'The sign-in window did not confirm that the session was saved.'].includes(error.message) ? error.message : 'Could not apply this action. Check the details and try again.'), true); }
  };
}
function child(executable, args, env = process.env) {
  const processObject = spawn(executable, args, { cwd: ROOT, shell: false, windowsHide: true, stdio: 'ignore', env });
  const record = { process: processObject, closed: false, error: false };
  record.done = new Promise(resolve => processObject.once('close', code => { record.closed = true; record.code = code; resolve(); }));
  processObject.on('error', () => { record.error = true; }); return record;
}
async function kill(record) {
  if (!record || record.closed) return;
  record.process.kill(); await Promise.race([record.done, sleep(5000)]);
  if (!record.closed) { record.process.kill('SIGKILL'); await Promise.race([record.done, sleep(2000)]); }
  if (!record.closed) throw new Error('Owned transport has not stopped.');
}
async function gatewayReady(base) {
  const get = route => fetch('http://127.0.0.1:8934' + route, { signal: AbortSignal.timeout(1500), redirect: 'error' });
  const health = await (await get('/health')).json();
  const metadata = await (await get('/.well-known/oauth-authorization-server')).json();
  const resource = await (await get('/.well-known/oauth-protected-resource/mcp')).json();
  const unauthorized = await get('/mcp');
  return health.ok === true && health.authenticatedBrowserGateway === true && metadata.issuer === new URL(base).href &&
    resource.resource === base + '/mcp' && unauthorized.status === 401 && /^Bearer\b/.test(unauthorized.headers.get('www-authenticate') || '');
}
async function main() {
  fs.mkdirSync(__dirname, { recursive: true });
  if (!fs.existsSync(tokenFile)) fs.writeFileSync(tokenFile, randomBytes(32).toString('base64url'), { flag: 'wx', mode: 0o600 });
  const token = fs.readFileSync(tokenFile, 'utf8').trim(); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new Error('Invalid local setup token file.');
  const instance = randomUUID(); let gateway, tunnel, login, loginSite, stopping = false, fingerprint = '', retryAt = 0, failures = 0;
  let status = { message: 'ChatGPT connection awaits your free ngrok settings.' };
  const setStatus = (message, extra = {}) => { status = { message, gatewayPid: gateway?.process.pid ?? null, tunnelPid: tunnel?.process.pid ?? null, updated: new Date().toISOString(), ...extra }; writeJson(path.join(__dirname, 'status.json'), status); };
  const saved = () => read(secretFile);
  const sites = createSiteStore(path.join(__dirname, 'sites.json'));
  const health = createDashboardHealth({ root: ROOT });
  const loginState = () => {
    const latest = read(path.join(ROOT, 'login-state.json')) || {};
    const marker = read(path.join(ROOT, 'login.pause'));
    const helperActive = Boolean(login && !login.closed && !login.error);
    if (latest.status === 'session-saved' && latest.active === false && (!marker || latest.pid === marker.pid) && (!login || login.closed || latest.pid === login.process.pid)) return { ...latest, active: false, helperActive: false };
    if (marker?.pid && latest.pid === marker.pid) return { ...latest, active: true, helperActive: helperActive && latest.pid === login.process.pid };
    if (helperActive) return { active: true, helperActive: true, status: 'opening', siteId: loginSite?.id, siteName: loginSite?.name, url: loginSite?.url };
    return { ...latest, active: false, helperActive: false };
  };
  const server = http.createServer(makeHandler({ token, saved, status: () => status, pluginUrl: PLUGIN_URL,
    sites: () => { syncSavedSession(sites, loginState()); return sites.list(); }, browser: () => read(path.join(ROOT, 'service-state.json')) || {}, login: loginState,
    health: () => health.read(), requests: () => readConnectionStatus(ROOT), accounts: () => { syncSavedSession(sites, loginState()); return accountStates(ROOT, sites.list()); },
    owner: () => { try { const text = fs.readFileSync(path.join(ROOT, 'gateway', 'owner-secret.txt'), 'utf8').trim(); return /^[A-Za-z0-9_-]{43}$/.test(text) ? text : ''; } catch { return ''; } },
    save: async value => {
      const linked = read(path.join(ROOT, 'gateway', 'config.json'));
      if (fs.existsSync(path.join(ROOT, 'gateway', 'oauth-state.json')) && linked?.publicBaseUrl && linked.publicBaseUrl !== value.publicBaseUrl) throw new Error('Keep the linked ngrok domain. Changing it requires reconnecting ChatGPT and explicitly resetting its saved authorization.');
      writeJson(secretFile, value); retryAt = 0;
    },
    startLogin: async id => {
      if (loginState().active || (login && !login.closed)) throw new Error('A login helper is already open.');
      loginSite = sites.get(id);
      login = child(process.execPath, [path.join(ROOT, 'login.cjs'), '--url', loginSite.url, '--site-id', loginSite.id, '--site-name', loginSite.name]);
    },
    finishLogin: async () => {
      const marker = read(path.join(ROOT, 'login.pause'));
      if (!marker?.token) throw new Error(login && !login.closed ? 'The sign-in window is still opening. Wait a moment and try again.' : 'No sign-in window is open.');
      const result = await finishLogin({ token: marker.token, timeoutMs: 12000 });
      if (!result?.ok || result.status !== 'session-saved') throw new Error('The sign-in window did not confirm that the session was saved.');
      // The helper has closed its owned browser and flushed cookies before acknowledging.
      if (result.siteId && result.savedAt) sites.markSaved(result.siteId, result.savedAt);
      const completed = read(path.join(ROOT, 'login-state.json'));
      if (completed?.pid === marker.pid && completed.status === 'session-saved' && completed.savedAt) sites.markSaved(completed.siteId, completed.savedAt);
      syncSavedSession(sites, loginState());
      // Acknowledge the handoff in the UI after the manager has had time to resume.
      for (let attempt = 0; attempt < 60; attempt++) {
        const browser = read(path.join(ROOT, 'service-state.json'));
        if (browser?.status === 'running' && browser.ready === true && !fs.existsSync(path.join(ROOT, 'login.pause'))) break;
        await sleep(150);
      }
    },
    addSite: async input => { sites.add(input); },
    removeSite: async id => {
      if (loginState().active && loginState().siteId === id) throw new Error('Finish the open sign-in window before removing its shortcut.');
      sites.remove(id);
      try { fs.unlinkSync(path.join(ROOT, 'setup', 'account-observations', createHash('sha256').update(id).digest('hex') + '.json')); } catch {}
    }
  }));
  server.requestTimeout = 15000; server.headersTimeout = 10000;
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(8936, '127.0.0.1', resolve); }); }
  catch (error) { if (error.code === 'EADDRINUSE') return; throw error; }
  writeJson(lockFile, { pid: process.pid, token: instance });
  const unlock = () => { if (read(lockFile)?.token === instance) { try { fs.unlinkSync(lockFile); } catch {} } };
  process.on('exit', unlock); process.on('SIGINT', () => { stopping = true; }); process.on('SIGTERM', () => { stopping = true; });
  const stopChildren = async () => { await kill(tunnel); tunnel = null; await kill(gateway); gateway = null; };
  try {
    setStatus('ChatGPT connection awaits your free ngrok settings.');
    while (!stopping) {
      if (fs.existsSync(stopFile)) { fs.unlinkSync(stopFile); stopping = true; break; }
      let config; try { config = settings(saved() || {}); } catch {}
      const next = config ? createHash('sha256').update(JSON.stringify(config)).digest('hex') : '';
      if (next !== fingerprint || gateway?.closed || gateway?.error || tunnel?.closed || tunnel?.error || (config && !gateway && Date.now() >= retryAt)) {
        try {
          await stopChildren(); fingerprint = next;
          if (!config) { setStatus('ChatGPT connection awaits your free ngrok settings.'); continue; }
          if (Date.now() < retryAt) { await sleep(1000); continue; }
          writeJson(path.join(ROOT, 'gateway', 'config.json'), { publicBaseUrl: config.publicBaseUrl, allowedRedirectUris: [...new Set([STABLE, config.callback].filter(Boolean))] });
          setStatus('Starting the authenticated gateway.'); gateway = child(process.execPath, [path.join(ROOT, 'gateway', 'server.mjs')]);
          let ready = false;
          for (let attempt = 0; attempt < 40; attempt++) {
            if (gateway.closed || gateway.error || stopping || fs.existsSync(stopFile)) break;
            try { if (await gatewayReady(config.publicBaseUrl)) { ready = true; break; } } catch {}
            await sleep(250);
          }
          if (!ready) throw new Error('Gateway did not become ready.');
          const env = { ...process.env, NGROK_AUTHTOKEN: config.authtoken };
          tunnel = child(path.join(ROOT, 'ngrok', 'ngrok.exe'), ['http', 'http://127.0.0.1:8934', '--url', config.publicBaseUrl, '--config', path.join(__dirname, 'ngrok.yml'), '--inspect=false', '--log=false'], env);
          await sleep(500); if (tunnel.closed || tunnel.error) throw new Error('Tunnel process stopped.');
          failures = 0; setStatus('Gateway ready; tunnel process running. Complete ChatGPT OAuth connection to verify public access.', { publicBaseUrl: config.publicBaseUrl, publicAccessVerified: false });
        } catch {
          try { await stopChildren(); } catch {} failures++; retryAt = Date.now() + Math.min(300000, 2000 * 2 ** Math.min(failures, 8));
          setStatus('Connection could not start. Check your free ngrok domain and authtoken, then save again. Retrying in the background.');
        }
      }
      await sleep(1000);
    }
  } finally {
    try { await stopChildren(); setStatus('Setup and ChatGPT transport stopped.'); }
    catch { setStatus('Setup stopped; an owned transport did not confirm exit.'); }
    unlock(); await new Promise(resolve => server.close(resolve));
  }
}
module.exports = { domain, callback, settings, same, makeHandler, gatewayReady, accountStates, syncSavedSession, loginView, ORIGIN, STABLE };
if (require.main === module) main().catch(() => { process.exitCode = 1; });
