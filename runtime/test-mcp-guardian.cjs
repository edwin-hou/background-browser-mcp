'use strict';
const assert = require('node:assert/strict');
const { createMcpGuardian } = require('./mcp-guardian.cjs');

async function main() {
  let checks = 0, backendClients = 0, contextClosed = false, created = [];
  const check = (value, message) => { assert.ok(value, message); checks++; };
  let terminated = 0;
  class Transport { constructor(url) { this.url = url; } async terminateSession() { terminated++; } }
  class Client {
    constructor(info) { this.info = info; this.connected = false; this.backend = false; created.push(this); }
    async connect(transport) { this.connected = true; this.transport = transport; }
    async listTools() { return { tools: [{ name: 'browser_navigate' }] }; }
    async callTool(params) {
      check(params.name === 'browser_tabs' && params.arguments.action === 'list', 'Guardian initializes backend without navigation or closing any tab.');
      if (!this.backend) { this.backend = true; backendClients++; }
      return { content: [] };
    }
    async close() {
      if (this.backend) { this.backend = false; backendClients--; if (!backendClients) contextClosed = true; }
      this.connected = false; this.onclose?.();
    }
  }
  const guardian = createMcpGuardian({ Client, Transport, url: 'http://127.0.0.1:8933/mcp' });
  check(!guardian.isAlive(), 'Uninitialized guardian is not advertised as ready.');
  await guardian.start();
  check(guardian.isAlive() && backendClients === 1 && !contextClosed, 'Guardian retains an actual initialized MCP backend.');
  await guardian.start();
  check(created.length === 1, 'Repeated readiness does not accumulate MCP sessions.');
  const collector = new Client({ name: 'collector' }); await collector.connect(new Transport('http://127.0.0.1:8933/mcp'));
  await collector.callTool({ name: 'browser_tabs', arguments: { action: 'list' } });
  await collector.close();
  check(!contextClosed && guardian.isAlive() && backendClients === 1, 'A routine collector disconnect cannot close the service-owned browser.');
  // The service saves/closes its own browser first, then releases this client.
  contextClosed = true; await guardian.stop();
  check(!guardian.isAlive() && backendClients === 0 && terminated === 1, 'Intentional service shutdown explicitly terminates and releases the guardian once.');
  await guardian.stop();
  check(backendClients === 0, 'Repeated shutdown is harmless.');

  class BrokenClient extends Client { async callTool() { throw new Error('simulated backend error with private details'); } }
  const broken = createMcpGuardian({ Client: BrokenClient, Transport, url: 'http://127.0.0.1:8933/mcp' });
  await assert.rejects(broken.start(), error => error.message === 'Private browser lifecycle guardian could not initialize.'); checks++;
  check(!broken.isAlive() && broken.hasFailed() && created.at(-1).connected, 'Backend initialization failure defers disconnect until the service can checkpoint its browser.');
  await broken.stop();
  check(!created.at(-1).connected && !broken.hasFailed(), 'Service recovery explicitly releases a failed backend after intentional shutdown.');

  contextClosed = false;
  const disconnected = createMcpGuardian({ Client, Transport, url: 'http://127.0.0.1:8933/mcp' });
  await disconnected.start(); created.at(-1).onclose();
  check(!disconnected.isAlive(), 'Unexpected guardian transport loss is detected for service recovery.');
  await disconnected.stop();

  let stalledDeleteCalls = 0;
  class StalledTransport extends Transport {
    terminateSession() { stalledDeleteCalls++; return new Promise(() => {}); }
  }
  const stalled = createMcpGuardian({ Client, Transport: StalledTransport, url: 'http://127.0.0.1:8933/mcp', stopTimeout: 15 });
  await stalled.start();
  const stalledClient = created.at(-1);
  // As in service.stopOwned(), the service has saved/closed its own browser first.
  contextClosed = true;
  let guard;
  try {
    await assert.rejects(Promise.race([
      stalled.stop(), new Promise((resolve, reject) => { guard = setTimeout(() => reject(new Error('Unbounded guardian stop.')), 1000); })
    ]), error => error.code === 'GUARDIAN_CLEANUP_TIMEOUT'); checks++;
  } finally { clearTimeout(guard); }
  check(stalledDeleteCalls === 1 && !stalledClient.connected && backendClients === 0, 'A stalled DELETE is bounded and the exact guardian client is still closed.');
  check(!stalled.isAlive() && !stalled.hasFailed(), 'Timed-out cleanup does not leave stale guardian readiness.');
  await stalled.stop();
  check(stalledDeleteCalls === 1, 'Repeated stop does not repeat a stalled session DELETE.');

  class RejectingTransport extends Transport { async terminateSession() { throw new Error('Synthetic DELETE failure.'); } }
  const rejected = createMcpGuardian({ Client, Transport: RejectingTransport, url: 'http://127.0.0.1:8933/mcp' });
  await rejected.start(); const rejectedClient = created.at(-1); contextClosed = true;
  await assert.rejects(rejected.stop(), /Synthetic DELETE failure/); checks++;
  check(!rejectedClient.connected && backendClients === 0, 'A failed DELETE also closes its guardian client before returning the error.');
  console.log(`${checks} guardian lifecycle checks passed.`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
