import { pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js';
import { createBackendForwarder, BackendUnavailableError } from './backend.mjs';

// Codex owns this connection. A browser-manager restart must not close its transport.
export function createLocalBridge({ backendUrl = 'http://127.0.0.1:8933/mcp', startupTimeoutMs = 45000 } = {}) {
  const endpoint = new URL(backendUrl);
  if (endpoint.protocol !== 'http:' || endpoint.hostname !== '127.0.0.1' || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/mcp') throw new Error('Use an explicit loopback MCP backend.');
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 100 || startupTimeoutMs > 60000) throw new Error('Invalid bridge startup timeout.');
  const backend = createBackendForwarder({ backendUrl: endpoint.href });
  let catalogReady = false;
  const server = new Server({ name: 'private-background-browser', version: '1.1.0' }, {
    capabilities: { tools: {} },
    instructions: 'Use the dedicated background browser profile. After navigation or interaction, read browser_snapshot inline. Preserve unrelated tabs and coordinate one browser workflow at a time. Website sign-in and MFA belong in the user-opened setup window. If Background Browser is disconnected or an account needs sign-in, pause the task and wait for the owner to reconnect through the private setup dashboard. Do not switch browsers or guess private information from public search. After reconnection, verify authenticated access before continuing. A connection error does not establish that a submitted action failed; verify its outcome before retrying.',
  });
  const explain = error => {
    if (error instanceof BackendUnavailableError) return new McpError(ErrorCode.InternalError, error.message, {
      completion: error.completion, retryable: error.retryable, retryAfterSeconds: error.retryAfterSeconds,
      waitForOwner: error.waitForOwner === true,
    });
    return new McpError(ErrorCode.InternalError, 'The background browser request failed. Verify the page before retrying an action.');
  };
  server.setRequestHandler(ListToolsRequestSchema, async (request, extra) => {
    const deadline = Date.now() + (catalogReady ? 0 : startupTimeoutMs);
    while (true) {
      try {
        const result = await backend.listTools(request.params || {}, { signal: extra.signal });
        catalogReady = true;
        return result;
      } catch (error) {
        // Only initial, side-effect-free discovery waits for the recovery service.
        if (catalogReady || !(error instanceof BackendUnavailableError) || Date.now() >= deadline || extra.signal.aborted) throw explain(error);
        await new Promise(resolve => setTimeout(resolve, Math.min(500, Math.max(1, deadline - Date.now()))));
      }
    }
  });
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    try { return await backend.callTool(request.params, { signal: extra.signal }); }
    catch (error) { throw explain(error); }
  });
  let closing;
  const close = () => closing ||= (async () => { await backend.close(); await server.close(); })();
  server.onclose = () => { backend.close().catch(() => {}); };
  return { server, close };
}

async function main(args) {
  if (args.length && (args.length !== 2 || args[0] !== '--backend-url')) throw new Error('Invalid local bridge options.');
  const bridge = createLocalBridge({ backendUrl: args[1] });
  const transport = new StdioServerTransport();
  process.once('SIGINT', () => bridge.close().catch(() => {}));
  process.once('SIGTERM', () => bridge.close().catch(() => {}));
  await bridge.server.connect(transport);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(() => {
    process.stderr.write('The local Background Browser bridge could not start. Check the installed runtime and connection settings.\n');
    process.exitCode = 1;
  });
}
