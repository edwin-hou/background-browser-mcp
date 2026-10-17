'use strict';

// Playwright MCP disposes its shared browser context when its last client
// disconnects. The service therefore retains one initialized backend client
// until it intentionally closes the context itself (after saving the profile).
function createMcpGuardian({ Client, Transport, url, timeout = 2000 }) {
  let client = null, transport = null, alive = false, failed = false;
  return {
    isAlive: () => alive,
    hasFailed: () => failed,
    async start() {
      if (alive) return;
      if (failed) throw new Error('Private browser lifecycle guardian requires service recovery.');
      const current = new Client({ name: 'local-browser-lifecycle-guardian', version: '1.0.0' });
      let disconnected = false;
      current.onclose = () => { disconnected = true; if (client === current) alive = false; };
      client = current;
      const currentTransport = new Transport(new URL(url)); transport = currentTransport;
      let connected = false;
      try {
        await current.connect(currentTransport, { timeout }); connected = true;
        const tools = await current.listTools({}, { timeout });
        if (!tools.tools.some(tool => tool.name === 'browser_navigate')) throw new Error('Browser tools missing');
        // Merely listing tools does not instantiate the MCP browser backend.
        // Initialize that backend without navigating, adopting, or closing tabs.
        const result = await current.callTool({ name: 'browser_tabs', arguments: { action: 'list' } }, undefined,
          { timeout: Math.max(timeout, 10000) });
        if (result?.isError) throw new Error('Browser backend initialization failed');
        if (client !== current || disconnected) throw new Error('Browser guardian changed during initialization');
        alive = true;
      } catch {
        alive = false;
        // Once a backend might exist, defer its DELETE until stopOwned has
        // checkpointed/closed the service's own context. A connect refusal has
        // not instantiated a backend and may be retried during server startup.
        failed = connected;
        if (!connected) {
          await current.close().catch(() => {});
          if (client === current) { client = null; transport = null; }
        }
        throw new Error('Private browser lifecycle guardian could not initialize.');
      }
    },
    async stop() {
      const current = client, currentTransport = transport;
      alive = false;
      client = null; transport = null; failed = false;
      try {
        if (currentTransport) await currentTransport.terminateSession();
      } finally { if (current) await current.close(); }
    }
  };
}

module.exports = { createMcpGuardian };
