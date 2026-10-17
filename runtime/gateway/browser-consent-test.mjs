import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { chromium } from 'playwright';
import { createGateway, ensureOwnerSecret, DEFAULT_DIR, SCOPE } from './server.mjs';

// A real, headless Chrome exercises the rendered HTML form using an empty temporary browser profile.
// All browser traffic is intercepted: fixture HTTPS requests go to ephemeral loopback; the OAuth
// callback is fulfilled locally. No tunnel, user browser/profile, real account, or browser backend is used.
const expectBroken = process.argv.includes('--expect-broken');
const dataDir = mkdtempSync(join(DEFAULT_DIR, 'consent-browser-test-'));
const publicBaseUrl = 'https://consent-browser-test.ngrok-free.app';
const callback = 'https://chatgpt.com/connector_platform_oauth_redirect';
const gateway = createGateway({ config: { publicBaseUrl, allowedRedirectUris: [callback] }, dataDir, testing: true });
let listener, browser;
const evidence = [];
try {
  const local = await new Promise(resolve => { listener = gateway.app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${listener.address().port}`)); });
  const registration = await fetch(local + '/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ client_name: 'Headless form regression check', redirect_uris: [callback], token_endpoint_auth_method: 'none', grant_types: ['authorization_code', 'refresh_token'], response_types: ['code'], scope: SCOPE }) });
  assert.equal(registration.status, 201);
  const clientId = (await registration.json()).client_id;
  browser = await chromium.launch({ executablePath: 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--disable-component-update', '--proxy-server=http://127.0.0.1:9', '--proxy-bypass-list=<-loopback>', '--host-resolver-rules=MAP * 127.0.0.1'] });
  for (const mode of expectBroken ? ['current-broken'] : ['simulate-no-referrer', 'current-fixed']) {
    const context = await browser.newContext({ serviceWorkers: 'block' });
    let consentOrigin, consentStatus, authorizationPolicy, callbackUrl, externalRequests = 0, formActionBlocked = false, callbackInterceptedBeforeNetwork = false;
    await context.route('**/*', async route => {
      const request = route.request();
      const url = new URL(request.url());
      if (url.origin === publicBaseUrl) {
        if (url.pathname === '/consent') consentOrigin = (await request.allHeaders()).origin;
        const response = await route.fetch({ url: local + url.pathname + url.search, maxRedirects: 0 });
        if (url.pathname === '/consent') consentStatus = response.status();
        const headers = response.headers();
        if (mode === 'simulate-no-referrer' && url.pathname === '/authorize') headers['referrer-policy'] = 'no-referrer';
        if (url.pathname === '/authorize') authorizationPolicy = headers['referrer-policy'];
        await route.fulfill({ response, headers });
      } else if (url.origin + url.pathname === callback) {
        callbackUrl = url;
        await route.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><title>Intercepted test callback</title><p>Callback intercepted locally.</p>' });
      } else {
        externalRequests++;
        await route.abort();
      }
    });
    const page = await context.newPage();
    page.on('console', message => { if (message.text().includes('form-action')) formActionBlocked = true; });
    // Playwright routing runs once per redirect chain. Intercept the callback at CDP Fetch's
    // request stage instead; an invalid loopback proxy and loopback DNS mapping are an independent
    // process-level egress guard in case interception regresses. APIRequestContext proxies fixtures locally.
    const cdp = await context.newCDPSession(page);
    await cdp.send('Network.enable');
    const observedPaths = [];
    let resolveCallback;
    const cdpCallback = new Promise(resolve => { resolveCallback = resolve; });
    cdp.on('Network.requestWillBeSent', event => {
      const url = new URL(event.request.url);
      observedPaths.push(url.origin + url.pathname);
    });
    cdp.on('Fetch.requestPaused', async event => {
      const url = new URL(event.request.url);
      if (url.origin + url.pathname === callback) {
        callbackUrl = url;
        callbackInterceptedBeforeNetwork = true;
        await cdp.send('Fetch.fulfillRequest', { requestId: event.requestId, responseCode: 200, responseHeaders: [{ name: 'Content-Type', value: 'text/html' }], body: Buffer.from('<!doctype html><title>Local callback intercept</title><p>OAuth callback intercepted before network.</p>').toString('base64') });
        resolveCallback();
      } else await cdp.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
    });
    await cdp.send('Fetch.enable', { patterns: [{ urlPattern: 'https://chatgpt.com/*', requestStage: 'Request' }] });
    const verifier = randomBytes(32).toString('base64url');
    const state = randomBytes(16).toString('hex');
    const params = { client_id: clientId, response_type: 'code', redirect_uri: callback, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256', state, resource: publicBaseUrl + '/mcp', scope: SCOPE };
    await page.goto(publicBaseUrl + '/authorize?' + new URLSearchParams(params));
    await page.getByLabel('Connection passphrase').fill(ensureOwnerSecret(dataDir));
    await page.getByRole('button', { name: 'Allow browser access' }).click();
    if (mode === 'current-fixed') {
      let timer;
      try { await Promise.race([cdpCallback, new Promise(resolve => { timer = setTimeout(resolve, 10000); })]); }
      finally { clearTimeout(timer); }
      assert.equal(authorizationPolicy, 'strict-origin');
      assert.equal(consentOrigin, publicBaseUrl);
      assert.equal(consentStatus, 303);
      assert.ok(callbackUrl?.searchParams.get('code'), `Callback was not reached: ${JSON.stringify({ consentOrigin, consentStatus, formActionBlocked, observedPaths })}`);
      assert.equal(callbackUrl.searchParams.get('iss'), publicBaseUrl + '/');
      assert.equal(callbackUrl.searchParams.get('state'), state);
      assert.equal(formActionBlocked, false);
      assert.equal(callbackInterceptedBeforeNetwork, true);
    } else {
      assert.equal(authorizationPolicy, 'no-referrer');
      assert.equal(consentOrigin, 'null');
      assert.equal(consentStatus, 403);
      assert.ok((await page.textContent('body')).includes('Invalid consent origin.'));
      assert.equal(callbackUrl, undefined);
    }
    assert.equal(externalRequests, 0);
    evidence.push({ mode, authorizationPolicy, actualConsentOrigin: consentOrigin, consentStatus, callbackIntercepted: Boolean(callbackUrl), callbackInterceptedBeforeNetwork, loopbackOnlyProxyEgressGuard: true, callbackHasCode: Boolean(callbackUrl?.searchParams.get('code')), callbackHasExactIssuer: callbackUrl?.searchParams.get('iss') === publicBaseUrl + '/', externalRequests });
    await context.close();
  }
  console.log(JSON.stringify({ ok: true, realChromeHeadless: true, emptyTemporaryProfile: true, noUserProfileOrBackendUsed: true, evidence }));
} finally {
  if (browser) await browser.close();
  await gateway.close();
  if (listener) { listener.closeAllConnections(); await new Promise(resolve => listener.close(resolve)); }
  const target = resolve(dataDir), boundary = resolve(DEFAULT_DIR) + '\\';
  if (!target.startsWith(boundary)) throw new Error('Unsafe fixture cleanup target.');
  rmSync(target, { recursive: true, force: true });
}
