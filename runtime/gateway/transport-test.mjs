import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createGateway, SCOPE } from './server.mjs';
import { createBackendForwarder, BackendUnavailableError, isReadOnlyBrowserCall } from './backend.mjs';

// Stateful loopback fixtures deliberately retain a client's dead session ID
// across a simulated backend restart. No real browser, account, or tunnel runs.
const dir = await mkdtemp(join(tmpdir(), 'background-browser-transport-'));
const listeners = [], servers = new Set(), transports = new Set(), sessions = new Map();
let gateway, client, direct, checks = 0, initialized = 0, missingSessions = 0, backendDown = false, readFailures = 0, failWrite = false;
const calls = [];
const ok = (condition, label) => { assert.ok(condition, label); checks++; };
const listen = app => new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => { listeners.push(server); resolve('http://127.0.0.1:' + server.address().port); });
});
const expireSessions = () => sessions.clear();
try {
  const fake = express(); fake.use(express.json());
  fake.all('/mcp', async (req, res) => {
    if (req.method === 'GET') return res.sendStatus(405); // No SSE close event to hide stale-session behavior.
    if (backendDown) return res.status(503).json({ error: 'Fixture backend paused.' });
    const id = req.headers['mcp-session-id'];
    if (id && !sessions.has(id)) { missingSessions++; return res.status(404).json({ error: 'Session not found' }); }
    let transport = id && sessions.get(id);
    if (!transport) {
      if (req.body?.method !== 'initialize') return res.sendStatus(400);
      const server = new Server({ name: 'stateful-fixture', version: '1.0.0' }, { capabilities: { tools: {} } });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: randomUUID, enableJsonResponse: true, onsessioninitialized: sessionId => sessions.set(sessionId, transport) });
      initialized++; servers.add(server); transports.add(transport);
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [
        { name: 'browser_snapshot', inputSchema: { type: 'object' } },
        { name: 'browser_tabs', inputSchema: { type: 'object' } },
        { name: 'browser_navigate', inputSchema: { type: 'object' } },
      ] }));
      server.setRequestHandler(CallToolRequestSchema, async () => ({ content: [{ type: 'text', text: 'fixture result' }] }));
      await server.connect(transport);
    }
    if (req.body?.method === 'tools/call') {
      calls.push(structuredClone(req.body.params));
      if (req.body.params.name === 'browser_snapshot' && readFailures > 0) {
        readFailures--; expireSessions(); return res.status(404).json({ error: 'Session not found' });
      }
      if (req.body.params.name === 'browser_navigate' && failWrite) {
        // The simulated mutation has been recorded before the response fails.
        failWrite = false; expireSessions(); return res.status(503).json({ error: 'Fixture lost write response.' });
      }
    }
    await transport.handleRequest(req, res, req.body);
  });
  const backend = await listen(fake);
  const publicBaseUrl = 'https://transport-fixture.invalid';
  const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
  gateway = createGateway({ config: { publicBaseUrl, allowedRedirectUris: [callback] }, dataDir: dir, backendUrl: backend + '/mcp', testing: true });
  const registration = await gateway.provider.clientsStore.registerClient({ redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  const token = gateway.provider.issue(registration.client_id, [SCOPE], randomUUID()).access_token;
  const url = await listen(gateway.app);
  const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json', accept: 'application/json, text/event-stream' };
  let rpcId = 100;
  const rpc = async (method, params) => {
    const response = await fetch(url + '/mcp', { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method, params }) });
    return { status: response.status, retryAfter: response.headers.get('retry-after'), body: await response.json() };
  };
  const invalidBefore = calls.length;
  const malformedBody = JSON.stringify({ jsonrpc: '2.0', id: 90, method: 'tools/call', params: { name: 'browser_navigate', arguments: { url: 'https://example.invalid/never-dispatched' } } });
  const badAccept = await fetch(url + '/mcp', { method: 'POST', headers: { ...headers, accept: 'application/json' }, body: malformedBody });
  const badProtocol = await fetch(url + '/mcp', { method: 'POST', headers: { ...headers, 'mcp-protocol-version': 'unsupported-fixture' }, body: malformedBody });
  ok(badAccept.status === 406 && badProtocol.status === 400 && calls.length === invalidBefore, 'Transport-invalid requests never dispatch a website mutation.');
  const externalTransport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } });
  client = new Client({ name: 'unchanged-frontend-session-fixture', version: '1' });
  await client.connect(externalTransport);
  ok((await client.listTools()).tools.length === 3, 'Frontend initially discovers fake backend tools.');
  const firstInitialized = initialized;
  expireSessions();
  ok((await client.listTools()).tools.length === 3 && initialized === firstInitialized + 1 && missingSessions >= 1, 'Stale session404 is replaced before dispatch on the same external client.');
  ok(externalTransport.sessionId === undefined, 'External stateless MCP connection retains no backend session ID.');
  const observation = { name: 'browser_snapshot', arguments: { full: true, fixture: 'unchanged arguments' } };
  const beforeRead = calls.length;
  readFailures = 1;
  ok((await client.callTool(observation)).content[0].text === 'fixture result', 'Read-only operation recovers if backend expires after preflight.');
  ok(calls.length === beforeRead + 2 && JSON.stringify(calls.at(-1)) === JSON.stringify(observation) && JSON.stringify(calls.at(-2)) === JSON.stringify(observation), 'Only the exact read-only request is retried once.');
  const beforeWrite = calls.length; failWrite = true;
  const failedWrite = await rpc('tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.invalid/fixture' } });
  ok(failedWrite.status === 200 && failedWrite.body.error?.data.completion === 'unknown' && failedWrite.body.error.data.retryable === false && failedWrite.retryAfter === null, 'Uncertain mutation has explicit MCP error and no automatic-retry instruction.');
  ok(calls.length === beforeWrite + 1, 'Mutation with lost response executes exactly once.');
  ok((await client.listTools()).tools.length === 3, 'Next request gets a fresh backend session after failed write.');
  const beforeUnavailable = calls.length; backendDown = true;
  const unavailable = await rpc('tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.invalid/not-dispatched' } });
  ok(unavailable.status === 503 && unavailable.retryAfter === '2' && unavailable.body.error?.data.completion === 'not-dispatched', 'Paused/unreachable backend yields HTTP503 with Retry-After before a write is dispatched.');
  ok(calls.length === beforeUnavailable, 'Unavailable preflight dispatches no website action.');
  backendDown = false;
  ok((await client.listTools()).tools.length === 3, 'The same frontend client works after backend returns.');
  readFailures = 2;
  const beforeExhaustion = calls.length;
  const exhausted = await rpc('tools/call', observation);
  ok(exhausted.status === 503 && exhausted.retryAfter === '2' && exhausted.body.error?.data.completion === 'read-only', 'Repeated read-only transport failure returns explicit temporary-unavailability response.');
  ok(calls.length === beforeExhaustion + 2, 'Read-only retry is capped at two total dispatches.');
  direct = createBackendForwarder({ backendUrl: backend + '/mcp' });
  ok((await direct.listTools()).tools.length === 3, 'OAuth-independent shared helper supports the local bridge.');
  expireSessions();
  ok((await direct.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).content[0].text === 'fixture result', 'Local helper recovers backend session restart without an external reinitialize.');
  failWrite = true;
  await assert.rejects(direct.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.invalid/direct' } }), error => error instanceof BackendUnavailableError && error.completion === 'unknown' && !error.retryable); checks++;
  const controller = new AbortController(); controller.abort(); const beforeAbort = calls.length;
  await assert.rejects(direct.callTool({ name: 'browser_navigate', arguments: {} }, { signal: controller.signal }));
  ok(calls.length === beforeAbort, 'Canceled queued requests never dispatch.');
  ok(isReadOnlyBrowserCall({ name: 'browser_tabs', arguments: { action: 'list' } }) && !isReadOnlyBrowserCall({ name: 'browser_tabs', arguments: { action: 'new' } }), 'Tab observation is distinguished from tab mutation.');
  ok(!isReadOnlyBrowserCall({ name: 'browser_evaluate', arguments: {} }) && !isReadOnlyBrowserCall({ name: 'unknown_tool', arguments: {} }) && !isReadOnlyBrowserCall({ name: 'browser_snapshot', arguments: { filename: 'fixture.txt' } }), 'Evaluation, unknown tools, and local file outputs are never replayed.');
  console.log(`PASS: ${checks} backend restart/retry/HTTP transport checks; fake loopback backend only.`);
} finally {
  await client?.close().catch(() => {});
  await direct?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  for (const transport of transports) await transport.close().catch(() => {});
  for (const server of servers) await server.close().catch(() => {});
  for (const listener of listeners) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
  const target = resolve(dir);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('background-browser-transport-')) throw new Error('Unsafe fixture cleanup target.');
  await rm(target, { recursive: true, force: true });
}
