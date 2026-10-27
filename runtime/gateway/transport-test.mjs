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
import { ListToolsRequestSchema, CallToolRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createGateway, SCOPE } from './server.mjs';
import { createBackendForwarder, BackendUnavailableError, isReadOnlyBrowserCall } from './backend.mjs';
import connectionStatus from '../connection-status.cjs';
const { createConnectionReporter, readConnectionStatus } = connectionStatus;

// Stateful loopback fixtures deliberately retain a client's dead session ID
// across a simulated backend restart. No real browser, account, or tunnel runs.
const dir = await mkdtemp(join(tmpdir(), 'background-browser-transport-'));
const listeners = [], servers = new Set(), transports = new Set(), sessions = new Map();
let gateway, deliveryGateway, client, direct, observationFailure, checks = 0, initialized = 0, missingSessions = 0, backendDown = false, readFailures = 0, failWrite = false;
let releaseHeldWrite, heldWriteStarted, holdWrite = false;
const calls = [];
const ok = (condition, label) => { assert.ok(condition, label); checks++; };
const listen = app => new Promise(resolve => {
  const server = app.listen(0, '127.0.0.1', () => { listeners.push(server); resolve('http://127.0.0.1:' + server.address().port); });
});
const expireSessions = () => sessions.clear();
const outcome = async () => { await gateway.flushConnectionStatus(); return (await readConnectionStatus(dir)).chatgpt; };
const waitOutcome = async predicate => {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) { const value = await outcome(); if (predicate(value)) return value; await new Promise(resolve => setTimeout(resolve, 20)); }
  throw new Error('Fixture outcome receipt was not observed.');
};
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
      server.setRequestHandler(CallToolRequestSchema, async request => {
        if (request.params.arguments?.ordinaryRpcError) throw new McpError(ErrorCode.InvalidParams, 'Synthetic selector error.');
        if (request.params.arguments?.ordinaryToolError) return { isError: true, content: [{ type: 'text', text: 'Synthetic ordinary browser error.' }] };
        return { content: [{ type: 'text', text: 'fixture result' }] };
      });
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
      if (req.body.params.name === 'browser_navigate' && holdWrite) {
        holdWrite = false; heldWriteStarted?.();
        await new Promise(resolve => { releaseHeldWrite = resolve; });
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
  ok((await outcome()).state === 'unseen', 'rejected transport schemas do not poison or clear connection status');
  await fetch(url + '/mcp', { method: 'POST', headers: { ...headers, authorization: 'Bearer arbitrary-invalid-fixture' }, body: malformedBody });
  ok((await outcome()).state === 'unseen', 'unauthenticated public scans are not attributed to ChatGPT');
  const externalTransport = new StreamableHTTPClientTransport(new URL(url + '/mcp'), { requestInit: { headers: { Authorization: 'Bearer ' + token } } });
  client = new Client({ name: 'unchanged-frontend-session-fixture', version: '1' });
  await client.connect(externalTransport);
  ok((await outcome()).state === 'unseen', 'successful initialization alone is not browser-request proof');
  ok((await client.listTools()).tools.length === 3, 'Frontend initially discovers fake backend tools.');
  ok((await outcome()).state === 'succeeded', 'normal response completion records hosted browser contact');
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
  ok(failedWrite.status === 200 && failedWrite.body.error?.data.completion === 'unknown' && failedWrite.body.error.data.retryable === false && failedWrite.body.error.data.waitForOwner === true && failedWrite.retryAfter === null, 'Uncertain mutation pauses for owner with explicit MCP error and no automatic-retry instruction.');
  ok(calls.length === beforeWrite + 1, 'Mutation with lost response executes exactly once.');
  ok((await outcome()).state === 'failed' && (await outcome()).failureCode === 'COMPLETION_UNKNOWN', 'uncertain write reaches hosted request-status receipts');
  ok((await client.listTools()).tools.length === 3, 'Next request gets a fresh backend session after failed write.');
  ok((await outcome()).state === 'succeeded' && (await outcome()).completion === 'unknown', 'actual hosted recovery retains earlier uncertain action history');
  const beforeUnavailable = calls.length; backendDown = true;
  const unavailable = await rpc('tools/call', { name: 'browser_navigate', arguments: { url: 'https://example.invalid/not-dispatched' } });
  ok(unavailable.status === 503 && unavailable.retryAfter === '2' && unavailable.body.error?.data.completion === 'not-dispatched', 'Paused/unreachable backend yields HTTP503 with Retry-After before a write is dispatched.');
  ok(calls.length === beforeUnavailable, 'Unavailable preflight dispatches no website action.');
  const failedContact = await outcome();
  ok(failedContact.state === 'failed' && (await (await fetch(url + '/health')).json()).ok === true, 'actual request failure remains visible while gateway health is200');
  backendDown = false;
  await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'isolated-init-check', version: '1' } });
  ok((await outcome()).state === 'failed' && (await outcome()).lastFailureAt === failedContact.lastFailureAt, 'later initialization does not clear a failed browser request');
  await rpc('tools/call', { name: 'browser_file_upload', arguments: {} });
  ok((await outcome()).state === 'failed', 'blocked policy tools cannot clear a connection failure');
  const ordinaryRpc = await rpc('tools/call', { name: 'browser_navigate', arguments: { ordinaryRpcError: true } });
  ok(ordinaryRpc.body.error && (await outcome()).state === 'succeeded', 'ordinary RPC errors demonstrate connectivity without becoming outages');
  const ordinaryTool = await rpc('tools/call', { name: 'browser_navigate', arguments: { ordinaryToolError: true } });
  ok(ordinaryTool.body.result?.isError === true && (await outcome()).state === 'succeeded', 'ordinary browser tool errors are distinct from transport failures');
  ok((await client.listTools()).tools.length === 3, 'The same frontend client works after backend returns.');
  readFailures = 2;
  const beforeExhaustion = calls.length;
  const exhausted = await rpc('tools/call', observation);
  ok(exhausted.status === 503 && exhausted.retryAfter === '2' && exhausted.body.error?.data.completion === 'read-only', 'Repeated read-only transport failure returns explicit temporary-unavailability response.');
  ok(calls.length === beforeExhaustion + 2, 'Read-only retry is capped at two total dispatches.');
  await client.listTools();
  holdWrite = true;
  const reachedBackend = new Promise(resolve => { heldWriteStarted = resolve; });
  const abortController = new AbortController();
  const disconnectedRequest = fetch(url + '/mcp', { method: 'POST', headers, signal: abortController.signal, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'browser_navigate', arguments: { fixture: 'held-write' } } }) });
  const disconnectedRejection = disconnectedRequest.catch(error => error);
  await reachedBackend;
  abortController.abort();
  await disconnectedRejection;
  const lost = await waitOutcome(value => value.state === 'failed' && value.failureCode === 'CLIENT_DISCONNECTED');
  ok(lost.completion === 'unknown', 'premature client disconnect records delivery failure with uncertain action completion');
  releaseHeldWrite(); releaseHeldWrite = null;
  // A subsequent request waits behind the held action; its success establishes
  // the exact recovery boundary, without replaying the held action.
  await client.listTools();
  ok((await outcome()).state === 'succeeded' && (await outcome()).lastFailureAt === lost.lastFailureAt, 'late backend completion does not clear disconnect; the next delivered request recovers');
  ok(calls.filter(call => call.arguments?.fixture === 'held-write').length === 1, 'disconnected write is never repeated');
  ok((await readConnectionStatus(dir)).codex.state === 'unseen', 'hosted receipts do not fabricate native-client activity');
  // A controlled operation promise makes the late-completion check independent
  // of socket timing: await the exact operation after its response peer is gone.
  const deliveryDir = join(dir, 'delivery');
  const deliveredReporter = createConnectionReporter({ root: deliveryDir, channel: 'chatgpt' });
  let throwReceipt = false, releaseDelivery, operationPromise, enteredDelivery;
  const entered = new Promise(resolve => { enteredDelivery = resolve; });
  const gate = new Promise(resolve => { releaseDelivery = resolve; });
  deliveryGateway = createGateway({ config: { publicBaseUrl, allowedRedirectUris: [callback] }, dataDir: deliveryDir, testing: true,
    connectionReporter: {
      success: () => { if (throwReceipt) throw new Error('Synthetic receipt fault.'); return deliveredReporter.success(); },
      failure: (...args) => { if (throwReceipt) throw new Error('Synthetic receipt fault.'); return deliveredReporter.failure(...args); },
    },
    backendForwarder: {
      listTools: async () => ({ tools: [{ name: 'browser_snapshot', inputSchema: { type: 'object' } }] }),
      callTool: () => { operationPromise = (async () => { enteredDelivery(); await gate; return { content: [{ type: 'text', text: 'Synthetic completed action.' }] }; })(); return operationPromise; },
      close: async () => { releaseDelivery(); },
    },
  });
  const deliveryRegistration = await deliveryGateway.provider.clientsStore.registerClient({ redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'] });
  const deliveryToken = deliveryGateway.provider.issue(deliveryRegistration.client_id, [SCOPE], randomUUID()).access_token;
  const deliveryUrl = await listen(deliveryGateway.app);
  const deliveryHeaders = { ...headers, authorization: 'Bearer ' + deliveryToken };
  const deliveryRpc = method => fetch(deliveryUrl + '/mcp', { method: 'POST', headers: deliveryHeaders, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method }) });
  await (await deliveryRpc('tools/list')).json();
  await deliveryGateway.flushConnectionStatus();
  ok((await readConnectionStatus(deliveryDir)).chatgpt.state === 'succeeded', 'controlled delivery fixture starts with a completed successful response');
  const deliveryAbort = new AbortController();
  const abandoned = fetch(deliveryUrl + '/mcp', { method: 'POST', headers: deliveryHeaders, signal: deliveryAbort.signal, body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name: 'browser_navigate', arguments: {} } }) }).catch(error => error);
  await entered; deliveryAbort.abort(); await abandoned;
  const deliveryDeadline = Date.now() + 3000;
  while (Date.now() < deliveryDeadline) { await deliveryGateway.flushConnectionStatus(); if ((await readConnectionStatus(deliveryDir)).chatgpt.failureCode === 'CLIENT_DISCONNECTED') break; await new Promise(resolve => setTimeout(resolve, 20)); }
  const abandonedOutcome = (await readConnectionStatus(deliveryDir)).chatgpt;
  ok(abandonedOutcome.state === 'failed' && abandonedOutcome.completion === 'unknown', 'delivery fixture observes the client disconnect before releasing its action');
  releaseDelivery(); await operationPromise; await new Promise(resolve => setImmediate(resolve));
  await deliveryGateway.flushConnectionStatus();
  const lateOutcome = (await readConnectionStatus(deliveryDir)).chatgpt;
  ok(lateOutcome.state === 'failed' && lateOutcome.lastFailureAt === abandonedOutcome.lastFailureAt, 'completed backend action never clears failure when its client did not receive a response');
  await (await deliveryRpc('tools/list')).json(); await deliveryGateway.flushConnectionStatus();
  ok((await readConnectionStatus(deliveryDir)).chatgpt.state === 'succeeded', 'a later delivered request alone establishes recovery');
  throwReceipt = true;
  const unaffected = await deliveryRpc('tools/list');
  ok(unaffected.status === 200 && (await unaffected.json()).result.tools.length === 1, 'receipt writer failure cannot alter the original browser response');
  await deliveryGateway.flushConnectionStatus();
  direct = createBackendForwarder({ backendUrl: backend + '/mcp', root: dir });
  ok((await direct.listTools()).tools.length === 3, 'OAuth-independent shared helper supports the local bridge.');
  expireSessions();
  ok((await direct.callTool({ name: 'browser_tabs', arguments: { action: 'list' } })).content[0].text === 'fixture result', 'Local helper recovers backend session restart without an external reinitialize.');
  failWrite = true;
  await assert.rejects(direct.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.invalid/direct' } }), error => error instanceof BackendUnavailableError && error.completion === 'unknown' && !error.retryable && error.waitForOwner); checks++;
  const controller = new AbortController(); controller.abort(); const beforeAbort = calls.length;
  await assert.rejects(direct.callTool({ name: 'browser_navigate', arguments: {} }, { signal: controller.signal }));
  ok(calls.length === beforeAbort, 'Canceled queued requests never dispatch.');
  ok(isReadOnlyBrowserCall({ name: 'browser_tabs', arguments: { action: 'list' } }) && !isReadOnlyBrowserCall({ name: 'browser_tabs', arguments: { action: 'new' } }), 'Tab observation is distinguished from tab mutation.');
  ok(!isReadOnlyBrowserCall({ name: 'browser_evaluate', arguments: {} }) && !isReadOnlyBrowserCall({ name: 'unknown_tool', arguments: {} }) && !isReadOnlyBrowserCall({ name: 'browser_snapshot', arguments: { filename: 'fixture.txt' } }), 'Evaluation, unknown tools, and local file outputs are never replayed.');
  observationFailure = createBackendForwarder({ backendUrl: backend + '/mcp', accountObserver: { observeToolResult: async () => { throw new Error('Synthetic observation failure.'); } } });
  const beforeObservationFailure = calls.length;
  const observedWrite = await observationFailure.callTool({ name: 'browser_navigate', arguments: { url: 'https://example.invalid/observation-failure' } });
  ok(observedWrite.content[0].text === 'fixture result' && calls.length === beforeObservationFailure + 1, 'Observation failure cannot fail or repeat a completed browser write.');
  console.log(`PASS: ${checks} backend restart/retry/HTTP transport checks; fake loopback backend only.`);
} finally {
  releaseHeldWrite?.();
  await deliveryGateway?.close().catch(() => {});
  await client?.close().catch(() => {});
  await direct?.close().catch(() => {});
  await observationFailure?.close().catch(() => {});
  await gateway?.close().catch(() => {});
  for (const transport of transports) await transport.close().catch(() => {});
  for (const server of servers) await server.close().catch(() => {});
  for (const listener of listeners) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
  const target = resolve(dir);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('background-browser-transport-')) throw new Error('Unsafe fixture cleanup target.');
  await rm(target, { recursive: true, force: true });
}
