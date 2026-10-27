'use strict';
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { websiteUrl, createSiteStore } = require('./sites.cjs');
const { renderDashboard } = require('./dashboard.cjs');
let checks = 0;
function check(fn) { fn(); checks++; }
check(() => assert.equal(websiteUrl('example.com'), 'https://example.com/'));
check(() => assert.equal(websiteUrl('https://example.com/home?code=DO_NOT_SAVE#secret'), 'https://example.com/home'));
for (const bad of ['javascript:alert(1)', 'file:///C:/Users', 'http://example.com', 'https://user:pass@example.com', 'https://example.com:8443', 'https://example.com/\nsecret']) check(() => assert.throws(() => websiteUrl(bad)));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'private-browser-sites-'));
try {
  const filename = path.join(dir, 'sites.json'), cookieSentinel = path.join(dir, 'cookies.json');
  fs.writeFileSync(cookieSentinel, 'PRESERVE_EXISTING_BROWSER_DATA');
  const store = createSiteStore(filename);
  check(() => assert.equal(store.list()[0].id, 'vanderbilt-brightspace'));
  const added = store.add({ name: '<img src=x onerror=alert(1)>', url: 'https://example.com/?code=secret' });
  check(() => assert.equal(store.list().length, 2));
  check(() => assert.equal(store.get(added.id).url, 'https://example.com/'));
  check(() => assert.throws(() => store.add({ name: 'Duplicate', url: 'https://example.com/' })));
  check(() => assert.throws(() => store.get('../service.cjs')));
  check(() => assert.throws(() => store.add({ name: 'x'.repeat(81), url: 'https://other.example/' })));
  store.markSaved(added.id, '2026-10-14T23:00:00.000Z');
  store.markSaved(added.id, '2026-10-13T23:00:00.000Z');
  check(() => assert.equal(createSiteStore(filename).get(added.id).lastSavedAt, '2026-10-14T23:00:00.000Z'));
  const html = renderDashboard({ token: 'FIXTURE_TOKEN', sites: () => store.list(), saved: () => ({ authtoken: 'NEVER_RENDER_THIS_TOKEN', publicBaseUrl: 'https://fixture.ngrok-free.app' }), status: () => ({}), owner: () => 'FIXTURE_OWNER', browser: () => ({ ready: true, status: 'running', headless: true }), login: () => ({ active: false }) });
  check(() => assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;')));
  check(() => assert.ok(!html.includes('<img src=x')));
  check(() => assert.ok(!html.includes('NEVER_RENDER_THIS_TOKEN')));
  check(() => assert.ok(!html.includes('code=secret')));
  check(() => assert.deepEqual(html.match(/<script\b[^>]*>[\s\S]*?<\/script>/gi), ['<script src="/dashboard-client.js?token=FIXTURE_TOKEN" defer></script>']));
  store.remove(added.id);
  check(() => assert.equal(createSiteStore(filename).list().length, 1));
  check(() => assert.equal(fs.readFileSync(cookieSentinel, 'utf8'), 'PRESERVE_EXISTING_BROWSER_DATA'));
  check(() => assert.ok(!fs.readdirSync(dir).some(name => name.endsWith('.tmp'))));
  console.log(JSON.stringify({ ok: true, checks, savedListReloaded: true, removingShortcutPreservesBrowserData: true, queryCredentialsNotStored: true, escapedHtml: true }));
} finally { fs.rmSync(dir, { recursive: true, force: true }); }
