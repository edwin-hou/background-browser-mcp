'use strict';
const assert = require('node:assert/strict'), { Readable } = require('node:stream');
const { domain, callback, settings, same, makeHandler, ORIGIN, STABLE } = require('./portal.cjs');
let checks = 0;
function check(fn) { fn(); checks++; }
check(() => assert.equal(domain('assigned-name.ngrok-free.app'), 'https://assigned-name.ngrok-free.app'));
check(() => assert.equal(domain('https://assigned-name.ngrok-free.dev/'), 'https://assigned-name.ngrok-free.dev'));
for (const bad of ['http://assigned.ngrok-free.app', 'https://assigned.ngrok-free.app.evil.test', 'https://evil.ngrok-free.app/path', 'https://user:pass@assigned.ngrok-free.app', 'https://assigned.ngrok-free.app:444', 'https://assigned.ngrok-free.app/#fragment', 'https://a.b.ngrok-free.app']) check(() => assert.throws(() => domain(bad)));
check(() => assert.equal(callback(''), ''));
check(() => assert.equal(callback(STABLE), STABLE));
check(() => assert.equal(callback('https://chatgpt.com/connector/oauth/abc_DEF-123'), 'https://chatgpt.com/connector/oauth/abc_DEF-123'));
for (const bad of ['http://chatgpt.com/connector/oauth/abc', 'https://chatgpt.com.evil.test/connector/oauth/abc', 'https://evil.chatgpt.com/connector/oauth/abc', 'https://chatgpt.com/connector/oauth/abc?x=1', 'https://chatgpt.com/connector/oauth/abc/extra', 'https://chatgpt.com/connector/oauth/abc#x']) check(() => assert.throws(() => callback(bad)));
check(() => assert.throws(() => settings({ domain: 'a.ngrok-free.app', authtoken: 'bad token\nvalue' })));
check(() => assert.equal(settings({ domain: 'a.ngrok-free.app' }, { authtoken: 'FAKE_SAVED_AUTHTOKEN_123' }).authtoken, 'FAKE_SAVED_AUTHTOKEN_123'));
check(() => assert.equal(same('secret', 'wrong'), false));
let saved = null, saves = 0, logins = 0;
const token = 'TEST_LOCAL_SETUP_TOKEN_1234567890123456789012';
const handler = makeHandler({ token, saved: () => saved, status: () => ({ message: 'Test status' }), owner: () => 'TEST_OWNER_SECRET', sites: () => [{id:'vanderbilt-brightspace',name:'Vanderbilt Brightspace',url:'https://brightspace.vanderbilt.edu/'}], browser: () => ({ready:true,headless:true,status:'running'}), login: () => ({active:false}), startLogin: async () => { logins++; }, finishLogin: async () => {}, addSite: async () => {}, removeSite: async () => {}, save: async value => { saved = value; saves++; } });
async function hit(method, route, options = {}) {
  const req = Readable.from([Buffer.from(options.body || '')]); req.method = method; req.url = route;
  req.headers = { host: '127.0.0.1:8936', origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded', ...options.headers };
  req.socket = { remoteAddress: options.remote || '127.0.0.1' };
  const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
  await handler(req, res); return res;
}
(async () => {
  const auth = '?token=' + token, form = 'csrf=' + token;
  for (const [method, route, options, expected] of [
    ['GET', '/', {}, 403], ['GET', '/?token=wrong', {}, 403], ['GET', '/' + auth, { headers: { host: 'evil.test' } }, 403],
    ['GET', '/' + auth, { remote: '10.0.0.1' }, 403], ['POST', '/login' + auth, { body: form, headers: { origin: 'https://evil.test' } }, 403],
    ['POST', '/login' + auth, { body: form, headers: { origin: undefined } }, 403], ['POST', '/login' + auth, { body: form, headers: { origin: 'null' } }, 403], ['POST', '/login' + auth, { body: '' }, 403],
    ['POST', '/login' + auth, { body: 'csrf=wrong' }, 403], ['POST', '/login' + auth, { body: form + '&csrf=' + token }, 403],
    ['POST', '/login' + auth, { body: form, headers: { 'content-type': 'text/plain' } }, 403], ['POST', '/login', { body: form }, 403],
    ['POST', '/unknown' + auth, { body: form }, 404], ...['/login/finish','/sites/add','/sites/remove'].map(route=>['POST',route+auth,{body:form,headers:{origin:'https://evil.test'}},403]), ['OPTIONS', '/' + auth, {}, 405], ['GET', '/login' + auth, {}, 405],
    ['POST', '/transport' + auth, { body: form + '&domain=bad.example&authtoken=FAKE_NGROK_TOKEN_12345' }, 400],
    ['POST', '/transport' + auth, { body: form + '&domain=a.ngrok-free.app&authtoken=FAKE_NGROK_TOKEN_12345&callback=https%3A%2F%2Fevil.test%2Fconnector%2Foauth%2Fabc' }, 400],
    ['POST', '/login' + auth, { body: form + '&padding=' + 'x'.repeat(9000) }, 413]
  ]) { const res = await hit(method, route, options); check(() => assert.equal(res.status, expected)); }
  check(() => assert.equal(logins, 0)); check(() => assert.equal(saves, 0));
  const page = await hit('GET', '/' + auth);
  check(() => assert.equal(page.status, 200)); check(() => assert.equal(page.headers['Cache-Control'], 'no-store, max-age=0'));
  check(() => assert.equal(page.headers['Referrer-Policy'], 'strict-origin')); check(() => assert.equal(page.headers['X-Frame-Options'], 'DENY'));
  check(() => assert.match(page.headers['Content-Security-Policy'], /frame-ancestors 'none'/)); check(() => assert.equal(page.headers['Access-Control-Allow-Origin'], undefined));
  check(() => assert.ok(page.body.includes('TEST_OWNER_SECRET')));
  check(() => assert.equal((page.body.match(/<script\b/g) || []).length, 2));
  check(() => assert.match(page.body, /<script src="\/dashboard-client\.js\?token=[^"]+" defer><\/script>/));
  check(() => assert.match(page.headers['Content-Security-Policy'], /script-src 'self'; connect-src 'self'/));
  check(() => assert.ok(!/script-src[^;]*'unsafe-inline'/.test(page.headers['Content-Security-Policy'])));
  check(() => assert.match(page.body, /<script src="\/session-view\.js\?token=[^"]+" defer><\/script>/));
  for (const route of ['/status', '/dashboard-client.js', '/session-view.js']) {
    const unauthorized = await hit('GET', route);
    const wrongHost = await hit('GET', route + auth, { headers: { host: 'evil.test' } });
    const wrongPeer = await hit('GET', route + auth, { remote: '10.0.0.1' });
    check(() => assert.equal(unauthorized.status, 403));
    check(() => assert.equal(wrongHost.status, 403));
    check(() => assert.equal(wrongPeer.status, 403));
  }
  const script = await hit('GET', '/dashboard-client.js' + auth);
  check(() => assert.equal(script.status, 200));
  check(() => assert.match(script.headers['Content-Type'], /^application\/javascript/));
  check(() => assert.ok(!script.body.includes(token) && !script.body.includes('TEST_OWNER_SECRET')));
  const sessionScript = await hit('GET', '/session-view.js' + auth);
  check(() => assert.equal(sessionScript.status, 200));
  check(() => assert.match(sessionScript.headers['Content-Type'], /^application\/javascript/));
  check(() => assert.ok(!sessionScript.body.includes(token) && !sessionScript.body.includes('TEST_OWNER_SECRET')));
  const status = await hit('GET', '/status' + auth);
  check(() => assert.equal(status.status, 200));
  check(() => assert.match(status.headers['Content-Type'], /^application\/json/));
  check(() => assert.equal(JSON.parse(status.body).version, 1));
  check(() => assert.ok(!status.body.includes(token) && !status.body.includes('TEST_OWNER_SECRET')));
  const login = await hit('POST', '/login' + auth, { body: form }); check(() => assert.equal(login.status, 303)); check(() => assert.equal(logins, 1));
  const save = await hit('POST', '/transport' + auth, { body: form + '&domain=assigned.ngrok-free.dev&authtoken=FAKE_NGROK_TOKEN_12345' });
  check(() => assert.equal(save.status, 303)); check(() => assert.equal(saves, 1)); check(() => assert.ok(!save.body.includes('FAKE_NGROK_TOKEN_12345')));
  console.log(checks + ' portal validation and CSRF checks passed; no server or browser launched.');
})().catch(error => { console.error(error); process.exitCode = 1; });
