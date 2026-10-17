import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createGateway, ensureOwnerSecret, DEFAULT_DIR, SCOPE } from './server.mjs';

// Real-browser integration, but no public listener/tunnel or permanent OAuth state.
// Opt in only with a dedicated disposable browser backend, never a saved account profile.
const testUpstream = process.env.BACKGROUND_BROWSER_TEST_UPSTREAM;
if (!testUpstream) throw new Error('Set BACKGROUND_BROWSER_TEST_UPSTREAM to a disposable local MCP backend.');
const testUpstreamUrl = new URL(testUpstream);
if (!['http:','https:'].includes(testUpstreamUrl.protocol) || !['127.0.0.1','localhost'].includes(testUpstreamUrl.hostname)) throw new Error('Test backend must be loopback.');
const dataDir = mkdtempSync(join(DEFAULT_DIR, 'integration-'));
const publicBaseUrl = 'https://gateway-integration.ngrok-free.app';
const callback = 'https://chatgpt.com/connector/oauth/local_integration';
const resource = publicBaseUrl + '/mcp';
const tabMarker = 'pwmcp-integration-' + randomBytes(12).toString('hex');
const gateway = createGateway({ config: { publicBaseUrl, allowedRedirectUris: [callback] }, dataDir, backendUrl: testUpstream, testing: true });
let listener, client, local, tokens, clientId, testTabCreated = false, testTabIndex;
const form = (path, values, headers = {}) => fetch(local + path, { method: 'POST', headers, body: new URLSearchParams(values), redirect: 'manual' });
const textContent = result => result.content?.filter(item => item.type === 'text').map(item => item.text).join('\n') || '';
const tool = async (name, args) => {
  const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  if (result.isError) throw new Error(`Browser tool failed: ${name}`);
  return result;
};
try {
  local = await new Promise(resolve => { listener = gateway.app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${listener.address().port}`)); });
  const registered = await fetch(local + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Local integration check', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE }) });
  assert.equal(registered.status, 201);
  clientId = (await registered.json()).client_id;
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const state = randomBytes(16).toString('hex');
  const auth = await fetch(local + '/authorize?' + new URLSearchParams({ client_id: clientId, response_type: 'code', redirect_uri: callback, code_challenge: challenge, code_challenge_method: 'S256', state, resource, scope: SCOPE }));
  const cookie = auth.headers.get('set-cookie').split(';')[0];
  const html = await auth.text();
  const approved = await form('/consent', { transaction: /name="transaction" value="([^"]+)"/.exec(html)[1], csrf: /name="csrf" value="([^"]+)"/.exec(html)[1], passphrase: ensureOwnerSecret(dataDir), decision: 'approve' }, { Cookie: cookie, Origin: publicBaseUrl });
  assert.equal(approved.status, 303);
  const redirect = new URL(approved.headers.get('location'));
  assert.equal(redirect.searchParams.get('state'), state);
  assert.equal(redirect.searchParams.get('iss'), publicBaseUrl + '/');
  const exchange = await form('/token', { grant_type: 'authorization_code', client_id: clientId, code: redirect.searchParams.get('code'), code_verifier: verifier, redirect_uri: callback, resource });
  assert.equal(exchange.status, 200);
  tokens = await exchange.json();
  client = new Client({ name: 'real-browser-integration-check', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(local + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + tokens.access_token } } }));
  const tools = await client.listTools();
  for (const name of ['browser_tabs', 'browser_navigate', 'browser_snapshot']) assert.ok(tools.tools.some(tool => tool.name === name), `Missing tool ${name}`);
  assert.ok(!tools.tools.some(tool => ['browser_run_code_unsafe', 'browser_file_upload', 'browser_drop'].includes(tool.name)), 'Remote discovery exposed an unsafe server/file tool.');
  assert.ok(tools.tools.every(tool => !Object.hasOwn(tool.inputSchema?.properties || {}, 'filename')), 'Remote schema exposed an artifact filename override.');
  await tool('browser_tabs', { action: 'new' });
  testTabCreated = true;
  const tabs = textContent(await tool('browser_tabs', { action: 'list' }));
  const current = /^-\s*(\d+):\s*\(current\)/m.exec(tabs) || /^-\s*(\d+):.*\(current\)/m.exec(tabs);
  if (current) testTabIndex = Number(current[1]);
  await tool('browser_navigate', { url: 'https://example.com/#' + tabMarker });
  const snapshot = textContent(await tool('browser_snapshot', {}));
  assert.ok(snapshot.includes('Example Domain'), 'Real headless browser snapshot did not contain the expected page.');
  const screenshot = await tool('browser_take_screenshot', {});
  assert.ok(screenshot.content.some(item => item.type === 'image' && item.data && item.mimeType.startsWith('image/')), 'Real screenshot did not return an inline image block.');
  console.log(JSON.stringify({ ok: true, oauthPkceConsent: true, protectedMcp: true, realBackend: testUpstreamUrl.origin, toolCount: tools.tools.length, visited: 'https://example.com', inlineSnapshotVerified: true, inlineScreenshotVerified: true, unsafeServerAndFileToolsBlocked: true, publicTunnelOpened: false }));
} finally {
  if (client && testTabCreated) {
    // Close only the tab this check created. Do not touch unrelated tabs.
    try {
      const tabs = textContent(await tool('browser_tabs', { action: 'list' }));
      const ownLine = tabs.split('\n').find(line => line.includes(tabMarker));
      const ownIndex = ownLine && /^-\s*(\d+):/.exec(ownLine);
      if (!ownIndex) throw new Error('Owned test tab could not be identified.');
      await tool('browser_tabs', { action: 'close', index: Number(ownIndex[1]) });
    } catch { console.error('Integration test tab cleanup could not be confirmed; unrelated tabs were preserved.'); }
  }
  if (tokens && local) await form('/revoke', { client_id: clientId, token: tokens.refresh_token }).catch(() => {});
  if (client) await client.close().catch(() => {});
  await gateway.close().catch(() => {});
  if (listener) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
  const target = resolve(dataDir), boundary = resolve(DEFAULT_DIR) + '\\';
  if (!target.startsWith(boundary)) throw new Error('Unsafe integration cleanup target.');
  rmSync(target, { recursive: true, force: true });
}
