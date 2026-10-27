import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

export class BackendUnavailableError extends Error {
  constructor(completion = 'not-dispatched') {
    super(completion === 'unknown'
      ? 'Browser connection failed after dispatch. The operation may have completed; verify its result before retrying.'
      : 'The background browser is temporarily unavailable. It may be restarting or paused for sign-in.');
    this.name = 'BackendUnavailableError';
    this.code = 'BACKEND_UNAVAILABLE';
    this.completion = completion;
    this.retryable = completion !== 'unknown';
    this.retryAfterSeconds = this.retryable ? 2 : undefined;
  }
}

function transportFailure(error) {
  if (error instanceof StreamableHTTPError) return [404, 408, 429].includes(error.code) || error.code >= 500;
  if (error?.code === -32001 || (error?.code === -32000 && /connection closed|transport closed/i.test(error.message || ''))) return true;
  for (let current = error, depth = 0; current && depth < 4; current = current.cause, depth++) {
    if (['ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'UND_ERR_SOCKET', 'UND_ERR_CONNECT_TIMEOUT'].includes(current.code)) return true;
  }
  return error?.name === 'TypeError' && /fetch failed/i.test(error.message || '');
}

// Tool descriptions/annotations are hints, not sufficient proof for replaying a
// website action. Only these specific observation operations can be retried.
export function isReadOnlyBrowserCall(params) {
  const args = params.arguments || {};
  if (Object.hasOwn(args, 'filename')) return false;
  if (params.name === 'browser_tabs') return args.action === 'list' && Object.keys(args).every(key => key === 'action');
  return ['browser_snapshot', 'browser_take_screenshot', 'browser_console_messages', 'browser_network_requests'].includes(params.name);
}

export function createBackendForwarder({ backendUrl = 'http://127.0.0.1:8933/mcp', connectTimeoutMs = 3000, pingTimeoutMs = 2000, toolTimeoutMs = 120000 } = {}) {
  let current, queue = Promise.resolve(), stopped = false;
  const canceled = signal => { if (signal?.aborted) throw signal.reason || new Error('Request canceled.'); };
  const discard = async entry => {
    if (current === entry) current = undefined;
    await entry?.client.close().catch(() => {});
  };
  const connect = async signal => {
    canceled(signal);
    if (stopped) throw new BackendUnavailableError();
    if (!current) {
      const client = new Client({ name: 'background-browser-forwarder', version: '1.1.0' });
      const entry = { client };
      current = entry;
      client.onclose = () => { if (current === entry) current = undefined; };
      entry.promise = (async () => {
        try {
          await client.connect(new StreamableHTTPClientTransport(new URL(backendUrl)), { timeout: connectTimeoutMs, signal });
          return entry;
        } catch (error) { await discard(entry); throw error; }
      })();
    }
    return current.promise;
  };
  const ready = async signal => {
    for (let attempt = 0; attempt < 2; attempt++) {
      let entry;
      try {
        entry = await connect(signal);
        // A live HTTP connection can retain an MCP session that the restarted
        // server no longer knows. Probe without dispatching the user's action.
        await entry.client.ping({ timeout: pingTimeoutMs, signal });
        return entry;
      } catch (error) {
        canceled(signal);
        await discard(entry || current);
        if (!transportFailure(error)) throw error;
        if (attempt === 1) throw new BackendUnavailableError();
      }
    }
  };
  const execute = (operation, readOnly, { signal } = {}) => {
    const result = queue.then(async () => {
      canceled(signal);
      let entry = await ready(signal);
      for (let attempt = 0; attempt < 2; attempt++) {
        canceled(signal);
        try { return await operation(entry.client, signal); }
        catch (error) {
          canceled(signal);
          if (!transportFailure(error)) throw error;
          await discard(entry);
          // Never replay a possibly completed write, navigation, evaluation,
          // input action, or unknown tool. The next request gets a new session.
          if (!readOnly) throw new BackendUnavailableError('unknown');
          if (attempt === 1) throw new BackendUnavailableError('read-only');
          entry = await ready(signal);
        }
      }
    });
    queue = result.catch(() => {});
    return result;
  };
  return {
    listTools: (params = {}, options) => execute((client, signal) => client.listTools(params, { timeout: toolTimeoutMs, signal }), true, options),
    callTool: (params, options) => execute((client, signal) => client.callTool(params, undefined, { timeout: toolTimeoutMs, signal }), isReadOnlyBrowserCall(params), options),
    close: async () => { stopped = true; const entry = current; current = undefined; await discard(entry); },
  };
}
