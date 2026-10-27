import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createLocalBridge } from './local-bridge.mjs';

let checks = 0;
const check = (condition, message) => { assert.ok(condition, message); checks++; };
const sessions = new Map(), allTransports = new Set(), backendServers = new Set();
let initializations = 0, reads = 0, writes = 0, failWrite = false, failRead = false;
const descriptors = ['browser_snapshot', 'browser_click'].map(name => ({ name, inputSchema: { type: 'object', additionalProperties: false }, description: 'Local synthetic fixture.' }));
const backend = http.createServer(async (req, res) => {
  if (req.url !== '/mcp') { res.writeHead(404); return res.end(); }
  if (req.method !== 'POST') { res.writeHead(405); return res.end(); }
  let body = '';
  for await (const chunk of req) body += chunk;
  const message = JSON.parse(body);
  if (message.method === 'tools/call' && message.params.name === 'browser_click' && failWrite) {
    failWrite = false; writes++; res.destroy(); return;
  }
  if (message.method === 'tools/call' && message.params.name === 'browser_snapshot' && failRead) {
    failRead = false; reads++; res.destroy(); return;
  }
  const id = req.headers['mcp-session-id'];
  let transport = id && sessions.get(id);
  if (!transport && isInitializeRequest(message)) {
    const server = new Server({ name: 'synthetic-browser', version: '1.0.0' }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, () => ({ tools: descriptors }));
    server.setRequestHandler(CallToolRequestSchema, request => {
      if (request.params.name === 'browser_snapshot') reads++;
      else if (request.params.name === 'browser_click') writes++;
      return { content: [{ type: 'text', text: 'Synthetic result.' }] };
    });
    transport = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), enableJsonResponse: true, onsessioninitialized: sessionId => sessions.set(sessionId, transport) });
    backendServers.add(server); allTransports.add(transport); initializations++;
    await server.connect(transport);
  }
  if (!transport) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ jsonrpc: '2.0', id: message.id ?? null, error: { code: -32001, message: 'Session not found' } }));
  }
  await transport.handleRequest(req, res, message);
});

let client, transport;
try {
  for (const url of ['https://127.0.0.1:8933/mcp', 'http://example.com/mcp', 'http://127.0.0.1:8933/mcp?credential=fixture']) {
    assert.throws(() => createLocalBridge({ backendUrl: url })); checks++;
  }
  await new Promise(resolve => backend.listen(0, '127.0.0.1', resolve));
  const url = 'http://127.0.0.1:' + backend.address().port + '/mcp';
  transport = new StdioClientTransport({ command: process.execPath, args: [fileURLToPath(new URL('./local-bridge.mjs', import.meta.url)), '--backend-url', url], stderr: 'pipe' });
  let stderr = '';
  transport.stderr.on('data', bytes => { stderr += bytes.toString(); });
  client = new Client({ name: 'local-bridge-test', version: '1.0.0' });
  await client.connect(transport);
  const pid = transport.pid;
  check(Number.isInteger(pid) && pid > 0, 'actual isolated stdio bridge started');
  check((await client.listTools()).tools.length === 2, 'native client discovers backend tools');
  await client.callTool({ name: 'browser_snapshot', arguments: {} });
  check(reads === 1, 'read is forwarded once on healthy connection');
  const firstCount = initializations;
  sessions.clear(); // Simulate an upstream restart without notifying the cached client.
  check((await client.listTools()).tools.length === 2, 'stale upstream session is recovered through the same stdio client');
  check(initializations > firstCount && transport.pid === pid, 'upstream reinitialized without restarting the native connection');
  sessions.clear();
  await client.callTool({ name: 'browser_click', arguments: {} });
  check(writes === 1, 'stale-session preflight recovers before a write is dispatched');
  failWrite = true;
  const beforeWrite = writes;
  await assert.rejects(client.callTool({ name: 'browser_click', arguments: {} }), error => /unknown|uncertain|verify/i.test(error.message)); checks++;
  check(writes === beforeWrite + 1, 'an uncertain write is never automatically repeated');
  check((await client.listTools()).tools.length === 2, 'connection remains usable after an uncertain write');
  failRead = true;
  const beforeRead = reads;
  await client.callTool({ name: 'browser_snapshot', arguments: {} });
  check(reads === beforeRead + 2, 'an explicit read-only request recovers once after a dropped response');
  check(transport.pid === pid, 'native connection survived all simulated backend failures');
  await client.close(); client = null;
  check(!stderr.trim(), 'bridge emits no unexpected diagnostics or private data');
  console.log(JSON.stringify({ ok: true, checks, syntheticBackendOnly: true, browserLaunched: false, realProfileAccessed: false, sameNativeClientSurvivedRestart: true, uncertainWritesNotReplayed: true }));
} finally {
  await client?.close().catch(() => {});
  await Promise.allSettled([...allTransports].map(value => value.close()));
  await Promise.allSettled([...backendServers].map(value => value.close()));
  if (backend.listening) { backend.closeAllConnections(); await new Promise(resolve => backend.close(resolve)); }
}
