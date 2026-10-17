'use strict';
const net = require('node:net');
const { timingSafeEqual } = require('node:crypto');
const LOGIN_PIPE = '\\\\.\\pipe\\BackgroundBrowserMCP-login-v1';
const DEFAULT_SITE = { url: 'https://brightspace.vanderbilt.edu/', siteId: 'vanderbilt-brightspace', siteName: 'Vanderbilt Brightspace' };
function parseLoginOptions(args) {
  const options = { ...DEFAULT_SITE }, seen = new Set();
  const keys = { '--url': 'url', '--site-id': 'siteId', '--site-name': 'siteName' };
  for (let i = 0; i < args.length; i += 2) {
    const flag = args[i], value = args[i + 1];
    if (!Object.hasOwn(keys, flag) || seen.has(flag) || !value || value.startsWith('--')) throw new Error('Invalid sign-in helper options.');
    seen.add(flag); options[keys[flag]] = value;
  }
  let url;
  try { url = new URL(options.url); } catch { throw new Error('The sign-in URL must be a valid HTTPS address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || options.url.length > 4096) throw new Error('The sign-in URL must use HTTPS without embedded credentials.');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(options.siteId)) throw new Error('Site ID must contain lowercase letters, numbers, or hyphens.');
  if (!options.siteName.trim() || options.siteName.length > 100 || /[\x00-\x1f\x7f]/.test(options.siteName)) throw new Error('Invalid site display name.');
  return { ...options, url: url.href, siteName: options.siteName.trim(), displayUrl: url.origin + url.pathname };
}
const tokensMatch = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
function createLoginCommandServer({ token, getMetadata, onFinish }) {
  const sockets = new Set(), activeCommands = new Set();
  let finishing = false;
  const server = net.createServer(socket => {
    sockets.add(socket); socket.once('close', () => { sockets.delete(socket); activeCommands.delete(socket); }); socket.on('error', () => {});
    socket.setEncoding('utf8'); socket.setTimeout(3000, () => socket.destroy());
    // Service health checks read this greeting then disconnect; greeting alone must never finish login.
    socket.write(JSON.stringify({ protocol: 2, ...getMetadata(), token }) + '\n');
    let input = '', handled = false;
    socket.on('data', data => {
      if (handled) return;
      input += data;
      if (Buffer.byteLength(input, 'utf8') > 4096) { handled = true; socket.end(JSON.stringify({ ok: false, error: 'Invalid login command.' }) + '\n'); return; }
      if (!input.includes('\n')) return;
      handled = true;
      let command;
      try { command = JSON.parse(input.slice(0, input.indexOf('\n'))); } catch { socket.end(JSON.stringify({ ok: false, error: 'Invalid login command.' }) + '\n'); return; }
      if (!command || typeof command !== 'object' || command.action !== 'finish' || !tokensMatch(command.token, token)) { socket.end(JSON.stringify({ ok: false, error: 'Invalid login command.' }) + '\n'); return; }
      if (finishing) { socket.end(JSON.stringify({ ok: false, error: 'Session saving is already in progress.' }) + '\n'); return; }
      finishing = true; activeCommands.add(socket); socket.setTimeout(30000, () => socket.destroy());
      Promise.resolve().then(onFinish).then(() => socket.end(JSON.stringify({ ok: true, status: 'session-saved' }) + '\n'), () => socket.end(JSON.stringify({ ok: false, error: 'The sign-in session could not be saved. Keep the window open and retry.' }) + '\n')).finally(() => { finishing = false; activeCommands.delete(socket); });
    });
  });
  return { server, close: async () => {
    // Do not close a finishing socket before its durable-save acknowledgement is written.
    for (const socket of sockets) if (!activeCommands.has(socket)) socket.end();
    if (server.listening) await new Promise(resolve => server.close(resolve));
  } };
}
function finishLogin({ token, timeoutMs = 30000, pipeName = LOGIN_PIPE }) {
  if (typeof token !== 'string' || token.length > 128) return Promise.reject(new Error('Invalid login command token.'));
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipeName);
    let input = '', greeted = false, complete = false;
    const finish = (error, result) => { if (complete) return; complete = true; socket.destroy(); error ? reject(error) : resolve(result); };
    socket.setEncoding('utf8'); socket.setTimeout(Math.min(Math.max(timeoutMs, 100), 30000), () => finish(new Error('The sign-in helper did not finish in time.')));
    socket.on('error', () => finish(new Error('The sign-in helper is not available.')));
    socket.on('end', () => finish(new Error('The sign-in helper closed before confirming a saved session.')));
    socket.on('data', data => {
      input += data;
      if (Buffer.byteLength(input, 'utf8') > 8192) return finish(new Error('Invalid sign-in helper response.'));
      while (input.includes('\n') && !complete) {
        const end = input.indexOf('\n'), line = input.slice(0, end); input = input.slice(end + 1);
        let message;
        try { message = JSON.parse(line); } catch { return finish(new Error('Invalid sign-in helper response.')); }
        if (!message || typeof message !== 'object') return finish(new Error('Invalid sign-in helper response.'));
        if (!greeted) {
          greeted = true;
          if (message.protocol !== 2 || !tokensMatch(message.token, token)) return finish(new Error('The sign-in helper ownership changed.'));
          socket.write(JSON.stringify({ action: 'finish', token }) + '\n');
        } else if (message.ok === true && message.status === 'session-saved') finish(null, { ok: true, status: 'session-saved' });
        else finish(new Error(typeof message.error === 'string' ? message.error : 'The sign-in session could not be saved.'));
      }
    });
  });
}
module.exports = { LOGIN_PIPE, parseLoginOptions, createLoginCommandServer, finishLogin };
