import express from 'express';
import { randomBytes, randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { ListToolsRequestSchema, CallToolRequestSchema, JSONRPCRequestSchema, SUPPORTED_PROTOCOL_VERSIONS } from '@modelcontextprotocol/sdk/types.js';
import { createBackendForwarder, BackendUnavailableError } from './backend.mjs';
import { mcpAuthRouter, createOAuthMetadata, getOAuthProtectedResourceMetadataUrl } from '@modelcontextprotocol/sdk/server/auth/router.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import { InvalidClientMetadataError, InvalidGrantError, InvalidRequestError, InvalidScopeError, InvalidTargetError, InvalidTokenError } from '@modelcontextprotocol/sdk/server/auth/errors.js';

export const DEFAULT_DIR = dirname(fileURLToPath(import.meta.url));
export const SCOPE = 'browser:control';
const MAX_REGISTERED_CLIENTS = 100;
const UNUSED_CLIENT_LIFETIME = 24 * 3600;
// Remote browser permission must not grant Node.js execution or access to arbitrary local files.
const BLOCKED_TOOLS = new Set(['browser_run_code_unsafe', 'browser_file_upload', 'browser_drop']);
const remoteTool = tool => !BLOCKED_TOOLS.has(tool.name) && !tool.inputSchema?.required?.includes('filename');
function remoteSchema(schema) {
  if (!schema?.properties || !Object.hasOwn(schema.properties, 'filename')) return schema;
  const properties = { ...schema.properties };
  delete properties.filename;
  return { ...schema, properties, ...(schema.required ? { required: schema.required.filter(key => key !== 'filename') } : {}) };
}
const now = () => Math.floor(Date.now() / 1000);
const random = () => randomBytes(32).toString('base64url');
const hash = value => createHash('sha256').update(value).digest('hex');
const same = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const escapeHtml = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function ensureOwnerSecret(dataDir = DEFAULT_DIR) {
  mkdirSync(dataDir, { recursive: true });
  const filename = join(dataDir, 'owner-secret.txt');
  if (!existsSync(filename)) writeFileSync(filename, random() + '\n', { flag: 'wx', mode: 0o600 });
  const secret = readFileSync(filename, 'utf8').trim();
  if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) throw new Error('owner-secret.txt must contain a 32-byte base64url secret.');
  return secret;
}

function canonicalConfig(config, testing) {
  const base = new URL(config.publicBaseUrl);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('publicBaseUrl must be an HTTPS origin.');
  const redirects = config.allowedRedirectUris;
  if (!Array.isArray(redirects) || !redirects.length || redirects.length > 10) throw new Error('Set exact allowedRedirectUris in config.json.');
  for (const uri of redirects) {
    const u = new URL(uri);
    // Exact strings only: no callback wildcards, user-provided hosts, queries, or fragments.
    if (u.origin !== 'https://chatgpt.com' || u.search || u.hash || u.href !== uri || !(/^\/connector\/oauth\/[A-Za-z0-9_-]{1,200}$/.test(u.pathname) || u.pathname === '/connector_platform_oauth_redirect')) throw new Error('Unsupported ChatGPT callback URI. Copy the exact URI shown in ChatGPT.');
  }
  return { base, redirects: new Set(redirects), resource: new URL('/mcp', base), testing };
}

class OwnerProvider {
  constructor(config, dataDir) {
    this.config = config;
    this.stateFile = join(dataDir, 'oauth-state.json');
    this.secretHash = hash(ensureOwnerSecret(dataDir));
    this.transactions = new Map();
    this.codes = new Map();
    this.state = existsSync(this.stateFile) ? JSON.parse(readFileSync(this.stateFile, 'utf8')) : { version: 1, resource: config.resource.href, clients: {}, tokens: {} };
    if (this.state.version !== 1 || this.state.resource !== config.resource.href) throw new Error('OAuth state belongs to a different public URL. Archive it before reconfiguring the URL.');
    this.state.approvedClients ||= {};
    // Existing token records establish prior owner approval, even when expired.
    // Preserve that history before clean() removes expired token hashes.
    for (const token of Object.values(this.state.tokens)) if (Object.hasOwn(this.state.clients, token.clientId)) this.state.approvedClients[token.clientId] ||= now();
    this.clientsStore = {
      getClient: id => Object.hasOwn(this.state.clients, id) ? this.state.clients[id] : undefined,
      registerClient: async client => {
        if (client.token_endpoint_auth_method !== 'none' || client.client_secret) throw new InvalidClientMetadataError('Only public clients using PKCE and token_endpoint_auth_method none are accepted.');
        if (!client.redirect_uris?.length || client.redirect_uris.some(uri => !config.redirects.has(uri))) throw new InvalidClientMetadataError('Redirect URI is not in the exact ChatGPT callback allowlist.');
        if (client.grant_types?.some(type => !['authorization_code', 'refresh_token'].includes(type)) || client.response_types?.some(type => type !== 'code')) throw new InvalidClientMetadataError('Only authorization-code PKCE with optional refresh is supported.');
        if (client.scope && client.scope !== SCOPE) throw new InvalidClientMetadataError('Unsupported scope.');
        this.clean();
        this.pruneUnusedClients(1);
        if (Object.keys(this.state.clients).length >= MAX_REGISTERED_CLIENTS) throw new InvalidClientMetadataError('Active client limit reached. Retry after pending authorizations expire.');
        // DCR callers must never choose an ID that overwrites an approved client.
        const result = { ...client, client_id: randomUUID(), client_id_issued_at: now(), token_endpoint_auth_method: 'none', scope: SCOPE };
        this.state.clients[result.client_id] = result;
        this.save();
        return result;
      }
    };
  }
  save() {
    const temp = this.stateFile + '.tmp';
    writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    renameSync(temp, this.stateFile);
  }
  pruneUnusedClients(reservedSlots = 0) {
    const current = now();
    const pending = new Set([...this.transactions.values(), ...this.codes.values()].filter(item => item.expires > current).map(item => item.clientId));
    const unused = Object.entries(this.state.clients)
      .filter(([id]) => !Object.hasOwn(this.state.approvedClients, id) && !pending.has(id))
      .sort((a, b) => (Number(a[1].client_id_issued_at) || 0) - (Number(b[1].client_id_issued_at) || 0));
    let changed = false;
    for (const [id, client] of unused) {
      if ((Number(client.client_id_issued_at) || 0) <= current - UNUSED_CLIENT_LIFETIME) { delete this.state.clients[id]; changed = true; }
    }
    for (const [id] of unused) {
      if (Object.keys(this.state.clients).length <= MAX_REGISTERED_CLIENTS - reservedSlots) break;
      if (Object.hasOwn(this.state.clients, id)) { delete this.state.clients[id]; changed = true; }
    }
    if (changed) this.save();
  }
  clean() {
    for (const [id, tx] of this.transactions) if (tx.expires <= now()) this.transactions.delete(id);
    for (const [id, code] of this.codes) if (code.expires <= now()) this.codes.delete(id);
    // Keep used refresh hashes through their lifetime to detect reuse and revoke their family.
    for (const [id, token] of Object.entries(this.state.tokens)) if (token.expires <= now()) delete this.state.tokens[id];
  }
  checkResource(resource) {
    if (!resource || resource.href !== this.config.resource.href) throw new InvalidTargetError('The exact MCP resource is required.');
  }
  checkScopes(scopes) {
    if (scopes?.some(s => s !== SCOPE)) throw new InvalidScopeError('Unsupported scope.');
  }
  async authorize(client, params, res) {
    this.clean();
    this.checkResource(params.resource);
    this.checkScopes(params.scopes);
    if (!/^[A-Za-z0-9_-]{43}$/.test(params.codeChallenge) || !params.state || params.state.length > 1024) throw new InvalidRequestError('S256 challenge and bounded nonempty state are required.');
    if (!this.config.redirects.has(params.redirectUri)) throw new InvalidRequestError('Callback is not allowlisted.');
    if (this.transactions.size >= 100) throw new InvalidRequestError('Too many pending authorizations.');
    const cookieName = this.config.testing ? 'pwmcp-consent-test' : '__Host-pwmcp-consent';
    const cookieMatch = res.req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(cookieName + '='));
    let binding = cookieMatch?.slice(cookieName.length + 1);
    if (!/^[A-Za-z0-9_-]{43}$/.test(binding || '')) binding = random();
    res.cookie(cookieName, binding, { httpOnly: true, secure: !this.config.testing, sameSite: 'lax', path: '/', maxAge: 600000 });
    const id = random(), csrf = random();
    this.transactions.set(hash(id), { clientId: client.client_id, ...params, resource: params.resource.href, binding: hash(binding), csrf: hash(csrf), expires: now() + 600, attempts: 0 });
    const clientName = escapeHtml((client.client_name || 'ChatGPT').slice(0, 120));
    res.type('html').send(`<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Connect private browser</title><style>body{font:18px system-ui;max-width:640px;margin:8vh auto;padding:24px;line-height:1.5}input{font:inherit;width:100%;box-sizing:border-box;padding:12px;margin:10px 0}button{font:inherit;padding:12px 20px}</style><h1>Connect your private browser</h1><p><strong>${clientName}</strong> requests control of the dedicated Playwright browser, including accounts signed into that profile.</p><p>Enter the connection passphrase from the local setup page. This is not your website password. Continue only for a connection you started.</p><form method="post" action="/consent"><input type="hidden" name="transaction" value="${id}"><input type="hidden" name="csrf" value="${csrf}"><label>Connection passphrase<input type="password" name="passphrase" required autocomplete="off" maxlength="100"></label><button type="submit" name="decision" value="approve">Allow browser access</button> <button type="submit" name="decision" value="deny" formnovalidate>Cancel</button></form></html>`);
  }
  consent(req, res) {
    this.clean();
    if (req.headers.origin !== this.config.base.origin) return res.status(403).send('Invalid consent origin.');
    const { transaction, csrf, passphrase, decision } = req.body || {};
    const tx = typeof transaction === 'string' && this.transactions.get(hash(transaction));
    const cookieName = this.config.testing ? 'pwmcp-consent-test' : '__Host-pwmcp-consent';
    const binding = req.headers.cookie?.split(';').map(c => c.trim()).find(c => c.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    if (!tx || typeof csrf !== 'string' || !binding || !same(hash(binding), tx.binding) || !same(hash(csrf), tx.csrf)) return res.status(403).send('Consent expired or did not match this browser. Start the connection again.');
    if (!['approve', 'deny'].includes(decision)) return res.status(400).send('Invalid consent decision.');
    if (decision !== 'deny' && (typeof passphrase !== 'string' || !same(hash(passphrase), this.secretHash))) {
      if (++tx.attempts >= 5) this.transactions.delete(hash(transaction));
      return res.status(403).send('Invalid passphrase. Restart the connection to retry.');
    }
    this.transactions.delete(hash(transaction));
    const redirect = new URL(tx.redirectUri);
    redirect.searchParams.set('state', tx.state);
    if (decision === 'deny') redirect.searchParams.set('error', 'access_denied');
    else {
      // Approval remains durable even if the client has not exchanged its code.
      this.state.approvedClients[tx.clientId] ||= now();
      this.save();
      const code = random();
      this.codes.set(hash(code), { ...tx, expires: now() + 120 });
      redirect.searchParams.set('code', code);
    }
    res.redirect(303, redirect.href);
  }
  getCode(client, code) {
    const record = typeof code === 'string' && this.codes.get(hash(code));
    if (!record || record.expires <= now() || record.clientId !== client.client_id) throw new InvalidGrantError('Invalid or expired authorization code.');
    return record;
  }
  async challengeForAuthorizationCode(client, code) { return this.getCode(client, code).codeChallenge; }
  async exchangeAuthorizationCode(client, code, _verifier, redirectUri, resource) {
    this.checkResource(resource);
    const record = this.getCode(client, code);
    if (redirectUri !== record.redirectUri || resource.href !== record.resource) throw new InvalidGrantError('Authorization binding does not match.');
    // The SDK validates PKCE before calling this method. The synchronous delete makes code use atomic.
    this.codes.delete(hash(code));
    return this.issue(client.client_id, [SCOPE], randomUUID());
  }
  issue(clientId, scopes, family) {
    this.clean();
    this.state.approvedClients[clientId] ||= now();
    const access = random(), refresh = random();
    const common = { clientId, scopes, family, resource: this.config.resource.href, revoked: false };
    this.state.tokens[hash(access)] = { ...common, kind: 'access', expires: now() + 3600 };
    this.state.tokens[hash(refresh)] = { ...common, kind: 'refresh', used: false, expires: now() + 30 * 86400 };
    this.save();
    return { access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh, scope: scopes.join(' ') };
  }
  revokeFamily(family) {
    for (const token of Object.values(this.state.tokens)) if (token.family === family) token.revoked = true;
    this.save();
  }
  async exchangeRefreshToken(client, refreshToken, scopes, resource) {
    this.checkResource(resource);
    this.checkScopes(scopes);
    const record = this.state.tokens[hash(refreshToken)];
    if (!record || record.kind !== 'refresh' || record.clientId !== client.client_id || record.resource !== resource.href || record.expires <= now() || record.revoked) throw new InvalidGrantError('Invalid refresh token.');
    if (record.used) { this.revokeFamily(record.family); throw new InvalidGrantError('Refresh token reuse detected. Reconnect.'); }
    if (scopes && scopes.some(s => !record.scopes.includes(s))) throw new InvalidScopeError('Scope escalation is forbidden.');
    record.used = true;
    return this.issue(record.clientId, scopes?.length ? scopes : record.scopes, record.family);
  }
  async verifyAccessToken(token) {
    const record = this.state.tokens[hash(token)];
    if (!record || record.kind !== 'access' || record.revoked || record.expires <= now() || record.resource !== this.config.resource.href || !record.scopes.includes(SCOPE)) throw new InvalidTokenError('Invalid or expired access token.');
    return { token, clientId: record.clientId, scopes: record.scopes, expiresAt: record.expires, resource: new URL(record.resource) };
  }
  async revokeToken(client, request) {
    const record = this.state.tokens[hash(request.token)];
    if (record && record.clientId === client.client_id) this.revokeFamily(record.family);
  }
}

export function createGateway({ config, dataDir = DEFAULT_DIR, backendUrl = 'http://127.0.0.1:8933/mcp', testing = false } = {}) {
  const checked = canonicalConfig(config, testing);
  const provider = new OwnerProvider(checked, dataDir);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', false); // Never trust arbitrary tunnel forwarding headers for authentication/rate limits.
  const allowedHosts = new Set([checked.base.host, '127.0.0.1:8934']);
  // Chrome also applies form-action to the OAuth POST's redirect destination.
  // Callback values have already passed the exact HTTPS ChatGPT URI validator above.
  const formActionSources = "'self' " + [...checked.redirects].join(' ');
  let requestWindow = 0, requests = 0, consentWindow = 0, consents = 0;
  app.use((req, res, next) => {
    // no-referrer makes native form POSTs send Origin:null (Fetch's append-Origin algorithm).
    // strict-origin preserves exact-origin CSRF validation without exposing URL paths/queries in Referer.
    res.set({ 'Cache-Control': 'no-store', 'Referrer-Policy': 'strict-origin', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': `default-src 'none'; style-src 'unsafe-inline'; form-action ${formActionSources}; frame-ancestors 'none'; base-uri 'none'` });
    if (!testing && !allowedHosts.has(req.headers.host)) return res.status(421).send('Invalid host.');
    if (req.originalUrl.length > 8192) return res.status(414).end();
    if (Date.now() - requestWindow > 60000) { requestWindow = Date.now(); requests = 0; }
    if (++requests > 600) return res.status(429).send('Request limit reached.');
    next();
  });
  app.use(express.json({ limit: '64kb' }));
  app.use(express.urlencoded({ extended: false, limit: '8kb', parameterLimit: 30 }));
  // The SDK owns OAuth request validation but does not add RFC9207 issuer identifiers.
  // Decorate only Express's public redirect API on these two authorization routes, including SDK error redirects.
  app.use(['/authorize', '/consent'], (_req, res, next) => {
    const redirect = res.redirect;
    res.redirect = function (statusOrUrl, destination) {
      const status = typeof statusOrUrl === 'number' ? statusOrUrl : 302;
      const location = typeof statusOrUrl === 'number' ? destination : statusOrUrl;
      let url;
      try {
        url = new URL(location);
        const callback = new URL(url);
        callback.search = '';
        callback.hash = '';
        if (!checked.redirects.has(callback.href)) throw new Error('Unregistered callback.');
      } catch { return this.status(500).json({ error: 'server_error' }); }
      url.searchParams.set('iss', checked.base.href);
      return redirect.call(this, status, url.href);
    };
    next();
  });
  app.post('/consent', (req, res) => {
    if (Date.now() - consentWindow > 900000) { consentWindow = Date.now(); consents = 0; }
    if (++consents > 20) return res.status(429).send('Consent limit reached. Wait 15 minutes.');
    provider.consent(req, res);
  });
  app.use('/token', (req, res, next) => {
    if (req.body?.grant_type === 'authorization_code' && !/^[A-Za-z0-9._~-]{43,128}$/.test(req.body.code_verifier || '')) return res.status(400).json({ error: 'invalid_request', error_description: 'Invalid PKCE verifier format.' });
    next();
  });
  // ngrok supplies forwarding headers, but all limits intentionally aggregate at the loopback peer.
  const rateLimitValidation = { validate: { xForwardedForHeader: false } };
  // The SDK router advertises secret-based methods by default. This provider accepts only public PKCE clients.
  const metadata = { ...createOAuthMetadata({ provider, issuerUrl: checked.base, scopesSupported: [SCOPE] }), token_endpoint_auth_methods_supported: ['none'], revocation_endpoint_auth_methods_supported: ['none'], authorization_response_iss_parameter_supported: true };
  app.get('/.well-known/oauth-authorization-server', (_req, res) => res.json(metadata));
  app.use(mcpAuthRouter({ provider, issuerUrl: checked.base, resourceServerUrl: checked.resource, resourceName: 'Private Playwright browser', scopesSupported: [SCOPE], authorizationOptions: { rateLimit: rateLimitValidation }, tokenOptions: { rateLimit: rateLimitValidation }, clientRegistrationOptions: { rateLimit: rateLimitValidation }, revocationOptions: { rateLimit: rateLimitValidation } }));
  // Also expose the origin-level discovery URL used by some MCP clients.
  app.get('/.well-known/oauth-protected-resource', (_req, res) => res.json({ resource: checked.resource.href, authorization_servers: [checked.base.href], scopes_supported: [SCOPE], resource_name: 'Private Playwright browser' }));
  const backend = createBackendForwarder({ backendUrl });
  app.all('/mcp', requireBearerAuth({ verifier: provider, requiredScopes: [SCOPE], expectedResource: checked.resource, resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(checked.resource) }), async (req, res) => {
    if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').end();
    // These public transport requirements must be checked before forwarding a
    // side effect, rather than rejected by the SDK after that effect occurred.
    if (!req.headers.accept?.includes('application/json') || !req.headers.accept.includes('text/event-stream')) return res.status(406).json({ error: 'MCP Accept must include application/json and text/event-stream.' });
    if (!req.headers['content-type']?.includes('application/json')) return res.status(415).json({ error: 'MCP requests require application/json.' });
    if (req.headers['mcp-protocol-version'] && !SUPPORTED_PROTOCOL_VERSIONS.includes(req.headers['mcp-protocol-version'])) return res.status(400).json({ error: 'Unsupported MCP protocol version.' });
    let forwarded, forwardedError;
    // Validate with public SDK schemas before dispatching. Performing this stage
    // before creating the HTTP transport allows a real 503/Retry-After response;
    // an SDK request-handler exception alone would produce HTTP 200 JSON-RPC.
    if (JSONRPCRequestSchema.safeParse(req.body).success) {
      const list = ListToolsRequestSchema.safeParse(req.body);
      const call = CallToolRequestSchema.safeParse(req.body);
      try {
        if (list.success) {
          const result = await backend.listTools(list.data.params);
          forwarded = { ...result, tools: result.tools.filter(remoteTool).map(tool => ({ ...tool, inputSchema: remoteSchema(tool.inputSchema), securitySchemes: [{ type: 'oauth2', scopes: [SCOPE] }], _meta: { ...tool._meta, securitySchemes: [{ type: 'oauth2', scopes: [SCOPE] }] } })) };
        } else if (call.success) {
          if (BLOCKED_TOOLS.has(call.data.params.name) || (call.data.params.arguments && Object.hasOwn(call.data.params.arguments, 'filename'))) forwarded = { isError: true, content: [{ type: 'text', text: 'This remote browser connection does not permit server execution, local file upload, or caller-selected artifact filenames.' }] };
          else forwarded = await backend.callTool(call.data.params);
        }
      } catch (error) {
        if (error instanceof BackendUnavailableError) {
          if (res.destroyed) return;
          if (error.retryable) res.status(503).set('Retry-After', String(error.retryAfterSeconds));
          return res.json({ jsonrpc: '2.0', id: req.body.id, error: { code: -32002, message: error.message, data: { backendUnavailable: true, completion: error.completion, retryable: error.retryable, waitForOwner: error.waitForOwner, ...(error.retryable ? { retryAfterSeconds: error.retryAfterSeconds } : {}) } } });
        }
        forwardedError = error;
      }
    }
    // MCP does not equate an HTTP disconnect with cancellation of a dispatched
    // action. Finish it once, while avoiding a response write to a gone peer.
    if (res.destroyed) return;
    const server = new Server({ name: 'private-playwright', version: '1.0.0' }, { capabilities: { tools: {} }, instructions: 'After browser navigation or interaction, call browser_snapshot to read the page inline. If Background Browser is unavailable, pause the task and wait for its owner to reconnect it through the private setup dashboard; do not keep retrying. An interrupted write may have completed: verify its outcome before repeating it. Local artifact links are not accessible remotely. Use the dedicated profile; sign-in and MFA belong to the owner.' });
    const result = async () => { if (forwardedError) throw forwardedError; return forwarded; };
    server.setRequestHandler(ListToolsRequestSchema, result);
    server.setRequestHandler(CallToolRequestSchema, result);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close().catch(() => {}); server.close().catch(() => {}); });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    catch { if (!res.headersSent) res.status(503).json({ error: 'Browser backend unavailable.' }); }
  });
  app.get('/health', (_req, res) => res.json({ ok: true, authenticatedBrowserGateway: true }));
  app.use((err, _req, res, _next) => res.status(err.status === 413 ? 413 : 400).json({ error: 'Invalid request.' }));
  return { app, provider, close: () => backend.close() };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = JSON.parse(readFileSync(join(DEFAULT_DIR, 'config.json'), 'utf8'));
  const gateway = createGateway({ config });
  const listener = gateway.app.listen(8934, '127.0.0.1', () => console.log('Authenticated browser gateway listening on 127.0.0.1:8934.'));
  listener.on('error', () => { console.error('Cannot start browser gateway listener.'); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { listener.close(); gateway.close().finally(() => process.exit()); });
}
