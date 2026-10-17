'use strict';
const assert = require('node:assert/strict');
const net = require('node:net');
const { randomUUID } = require('node:crypto');
const { LOGIN_PIPE, parseLoginOptions, createLoginCommandServer, finishLogin } = require('./login-control.cjs');

async function main() {
  let checks = 0, finishCount = 0, saveComplete = false, contextClosed = false, releaseSave;
  const ok = (condition, message) => { assert.ok(condition, message); checks++; };
  const defaults = parseLoginOptions([]);
  ok(defaults.siteId === 'vanderbilt-brightspace' && defaults.url === 'https://brightspace.vanderbilt.edu/', 'Old no-argument launcher retains Brightspace defaults.');
  const generic = parseLoginOptions(['--url', 'https://example.com/login?temporary=private#fragment', '--site-id', 'example-site', '--site-name', 'Example Site']);
  ok(generic.siteId === 'example-site' && generic.siteName === 'Example Site' && generic.displayUrl === 'https://example.com/login' && generic.url.includes('?temporary=private'), 'Actual HTTPS URL is retained while display/status URL omits query and fragment.');
  for (const args of [ ['--url', 'http://example.com'], ['--url', 'https://user:password@example.com'], ['--url', 'file:///C:/secret'], ['--site-id', '../unsafe'], ['--site-id', 'UPPER'], ['--site-name', 'bad\nname'], ['--unknown', 'value'], ['--url'], ['--url', 'https://one.example', '--url', 'https://two.example'], ['toString', 'value'] ]) {
    assert.throws(() => parseLoginOptions(args)); checks++;
  }
  const token = randomUUID(), pipeName = LOGIN_PIPE + '-test-' + randomUUID();
  const controller = createLoginCommandServer({ token, getMetadata: () => ({ pid: process.pid, status: 'login-open', active: true, siteId: generic.siteId, siteName: generic.siteName, url: generic.displayUrl }), onFinish: async () => {
    finishCount++;
    await new Promise(resolve => { releaseSave = resolve; });
    saveComplete = true;
    // Simulated context closes only after the durable snapshot save has completed.
    contextClosed = true;
  } });
  await new Promise((resolve, reject) => { controller.server.once('error', reject); controller.server.listen(pipeName, resolve); });
  const exchange = async command => new Promise((resolve, reject) => {
    const socket = net.connect(pipeName); let text = '', lines = [];
    socket.setEncoding('utf8'); socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('Test pipe timed out.')); });
    socket.on('error', reject);
    socket.on('data', data => {
      text += data;
      while (text.includes('\n')) {
        const end = text.indexOf('\n'); lines.push(JSON.parse(text.slice(0, end))); text = text.slice(end + 1);
        if (lines.length === 1) { if (command === undefined) { socket.destroy(); resolve(lines); } else socket.write(command); }
        else { socket.destroy(); resolve(lines); }
      }
    });
  });
  try {
    const greeting = (await exchange())[0];
    ok(greeting.protocol === 2 && greeting.token === token && greeting.siteId === 'example-site' && greeting.url === 'https://example.com/login', 'Immediate greeting retains manager ownership compatibility and safe site metadata.');
    ok(finishCount === 0, 'Manager-style greeting/read/disconnect never finishes a login.');
    for (const command of [JSON.stringify({ action: 'finish', token: 'wrong' }) + '\n', JSON.stringify({ action: 'finish', token: 'ö'.repeat(token.length) }) + '\n', JSON.stringify({ action: 'unknown', token }) + '\n', 'null\n', 'not-json\n', 'x'.repeat(4097) + '\n']) {
      const response = await exchange(command);
      ok(response[1].ok === false && finishCount === 0, 'Malformed, unauthorized, multibyte, or oversized command cannot close/save context.');
    }
    let receivedAck = false;
    const finishing = finishLogin({ token, pipeName }).then(result => { receivedAck = true; return result; });
    for (let i = 0; i < 50 && !releaseSave; i++) await new Promise(resolve => setTimeout(resolve, 5));
    ok(finishCount === 1 && !saveComplete && !contextClosed && !receivedAck, 'Valid finish begins saving and does not acknowledge or close prematurely.');
    const duplicate = await exchange(JSON.stringify({ action: 'finish', token }) + '\n');
    ok(duplicate[1].ok === false && finishCount === 1, 'A second simultaneous Finish cannot duplicate the save or close.');
    const closing = controller.close();
    releaseSave();
    const result = await finishing;
    ok(result.ok && result.status === 'session-saved' && saveComplete && contextClosed, 'Success acknowledgement arrives only after save and context close.');
    await closing;
    ok(true, 'Helper shutdown preserves the in-flight durable-save acknowledgement.');
  } finally { await controller.close(); }
  const failedPipe = LOGIN_PIPE + '-test-' + randomUUID();
  const failed = createLoginCommandServer({ token, getMetadata: () => ({ pid: process.pid, status: 'login-open', active: true }), onFinish: async () => { throw new Error('Synthetic internal error with sensitive details.'); } });
  try {
    await new Promise(resolve => failed.server.listen(failedPipe, resolve));
    await assert.rejects(() => finishLogin({ token: 'wrong', pipeName: failedPipe }), /ownership changed/); checks++;
    await assert.rejects(() => finishLogin({ token, pipeName: failedPipe }), error => error.message.includes('could not be saved') && !error.message.includes('sensitive')); checks++;
  } finally { await failed.close(); }
  console.log(JSON.stringify({ ok: true, checks, browserLaunched: false, actualUserProfileAccessed: false, managerGreetingPreserved: true, boundedAuthenticatedFinish: true, acknowledgementAfterSaveAndClose: true }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
