import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, rmdir, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, dirname, basename } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createAccountObserver, accountObservationFilename } from './account-status.mjs';

// Synthetic tool output and temporary files only. No browser, account, or
// network is accessed. Concurrent writers/readers are real isolated processes.
const root = await mkdtemp(join(tmpdir(), 'background-browser-observation-'));
const setup = join(root, 'setup'), directory = join(setup, 'account-observations');
await mkdir(setup);
let checks = 0, time = Date.parse('2026-10-27T12:00:00Z');
const check = (value, message) => { assert.ok(value, message); checks++; };
const saved = '2026-10-20T12:00:00Z';
const sites = [
  { id: 'brightspace-fixture', url: 'https://brightspace.vanderbilt.edu/d2l/home', lastSavedAt: saved },
  { id: 'drive-fixture', url: 'https://drive.google.com/drive/my-drive', lastSavedAt: saved },
  { id: 'docs-fixture', url: 'https://docs.google.com/document/', lastSavedAt: saved },
  { id: 'unknown-fixture', url: 'https://unknown.example/', lastSavedAt: saved },
];
const saveSites = records => writeFile(join(setup, 'sites.json'), JSON.stringify(records));
const snapshot = (url, body, title = 'Fixture page') => ({ content: [{ type: 'text', text: `### Page\n- Page URL: ${url}\n- Page Title: ${title}\n### Snapshot\n\`\`\`yaml\n${body}\n\`\`\`` }] });
const login = '- textbox "Email or VUnetID": PRIVATE_FORM_VALUE\n- textbox "Password": PRIVATE_PASSWORD_VALUE\n- button "Sign in"';
const authenticated = '- heading "My Courses"\n- button "User Profile: PRIVATE_ACCOUNT_NAME"';
const nav = url => ({ name: 'browser_navigate', arguments: { url } });
const snap = { name: 'browser_snapshot', arguments: {} };
const read = async id => {
  try { return JSON.parse(await readFile(join(directory, accountObservationFilename(id)), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return; throw error; }
};
const empty = async () => {
  if (resolve(directory) !== join(resolve(root), 'setup', 'account-observations')) throw new Error('Unsafe observation fixture target.');
  await rm(directory, { recursive: true, force: true });
};
try {
  await saveSites(sites);
  let observer = createAccountObserver({ root, now: () => time });
  await observer.observeToolResult(snap, snapshot('https://onevu.vanderbilt.edu/login', login));
  check(!(await read(sites[0].id)), 'Untracked login snapshot cannot infer an account issue.');
  await observer.observeToolResult(nav('https://onevu.vanderbilt.edu/login'), snapshot('https://onevu.vanderbilt.edu/login', login));
  check(!(await read(sites[0].id)), 'Ordinary direct public sign-in navigation is ignored.');
  await observer.observeToolResult(nav(sites[0].url), snapshot(sites[0].url, '- heading "Fixture course"'));
  await observer.observeToolResult(snap, snapshot('https://onevu.vanderbilt.edu/login', login));
  check(!(await read(sites[0].id)), 'Unrelated SSO snapshot cannot stand in for a redirect observed by the requested navigation.');
  await observer.observeToolResult(nav(sites[0].url), snapshot('https://onevu.vanderbilt.edu/login', '- link "Continue"'));
  await observer.observeToolResult({ name: 'browser_click', arguments: { ref: 'fixture' } }, snapshot('https://other.example/', '- heading "Unrelated page"'));
  await observer.observeToolResult(snap, snapshot('https://onevu.vanderbilt.edu/login', login));
  check(!(await read(sites[0].id)), 'Intervening action clears account context even when the later SSO URL is shared.');
  await observer.observeToolResult(nav('https://brightspace.vanderbilt.edu/d2l/home'), snapshot('https://onevu.vanderbilt.edu/login?login_hint=PRIVATE_ACCOUNT_NAME&code=PRIVATE_CODE', '- link "Sign in"'));
  check(!(await read(sites[0].id)), 'A sign-in link/redirect without form evidence is not enough.');
  await observer.observeToolResult(snap, snapshot('https://onevu.vanderbilt.edu/login?login_hint=PRIVATE_ACCOUNT_NAME&code=PRIVATE_CODE#PRIVATE_FRAGMENT', login));
  let record = await read(sites[0].id);
  check(record?.state === 'sign-in-required' && record.reasonCode === 'known-login-form', 'Requested saved-site redirect plus real login fields records reconnect requirement.');
  check(Object.keys(record).sort().join(',') === 'observedAt,reasonCode,siteId,state,version' && !JSON.stringify(record).includes('PRIVATE_'), 'Only the fixed sanitized record schema is persisted.');
  check(Object.keys(record).every(key => !/url|title|body|user|cookie|credential|query/i.test(key)), 'No content, identity, URL query, or credential fields are stored.');
  await observer.observeToolResult(snap, snapshot('https://brightspace.vanderbilt.edu/d2l/home', '- heading "My Courses"'));
  check((await read(sites[0].id)).state === 'sign-in-required', 'Arbitrary200 or one account-like heading cannot clear reconnect.');
  time += 1000;
  await observer.observeToolResult(snap, snapshot('https://brightspace.vanderbilt.edu/d2l/home', authenticated));
  check((await read(sites[0].id)).state === 'verified', 'Known protected origin plus account controls clears reconnect.');
  time += 1000;
  await observer.observeToolResult(nav(sites[0].url), snapshot(sites[0].url, '- region "My Courses"\n- button "PRIVATE_ACCOUNT_NAME, avatar"'));
  check((await read(sites[0].id)).state === 'verified' && !JSON.stringify(await read(sites[0].id)).includes('PRIVATE_'), 'Actual Brightspace avatar plus My Courses region is recognized without retaining its name.');
  const verifiedAt = (await read(sites[0].id)).observedAt;
  const late = createAccountObserver({ root, now: () => Date.parse(verifiedAt) - 1000 });
  await late.observeToolResult(nav(sites[0].url), snapshot('https://onevu.vanderbilt.edu/login', login));
  check((await read(sites[0].id)).observedAt === verifiedAt && (await read(sites[0].id)).state === 'verified', 'Late older observation cannot replace newer per-site evidence.');
  const lock = join(directory, accountObservationFilename(sites[0].id) + '.lock');
  await mkdir(lock);
  const busyStarted = Date.now();
  await observer.observeToolResult(nav(sites[0].url), snapshot('https://onevu.vanderbilt.edu/login', login));
  check(Date.now() - busyStarted < 2000 && (await stat(lock)).isDirectory() && (await read(sites[0].id)).observedAt === verifiedAt, 'Busy per-site writer is skipped promptly and its lock is never stolen.');
  await rmdir(lock);
  await observer.observeToolResult(snap, snapshot('https://onevu.vanderbilt.edu/login', login, '403 Forbidden'));
  check((await read(sites[0].id)).observedAt === verifiedAt, '403/blocked pages are not reauthentication evidence.');
  await observer.observeToolResult(snap, snapshot('https://onevu.vanderbilt.edu/login', login + '\n- generic: Verify you are human CAPTCHA'));
  check((await read(sites[0].id)).observedAt === verifiedAt, 'CAPTCHA/human challenges do not infer expired authentication.');
  await observer.observeToolResult({ name: 'browser_tabs', arguments: { action: 'list' } }, snapshot('https://onevu.vanderbilt.edu/login', login));
  check((await read(sites[0].id)).observedAt === verifiedAt, 'All-tab listing never updates site authentication.');
  await observer.observeToolResult({ name: 'browser_tabs', arguments: { action: 'select', index: 2 } }, {});
  await observer.observeToolResult(snap, snapshot('https://onevu.vanderbilt.edu/login', login));
  check((await read(sites[0].id)).observedAt === verifiedAt, 'Switching tabs clears inferred task context.');
  await observer.observeToolResult(nav(sites[0].url), snapshot('https://onevu.vanderbilt.edu/login', '- link "Continue"'));
  await saveSites(sites.map(site => site.id === sites[0].id ? { ...site, lastSavedAt: new Date(time + 1000).toISOString() } : site));
  await observer.observeToolResult(snap, snapshot('https://onevu.vanderbilt.edu/login', login));
  check((await read(sites[0].id)).observedAt === verifiedAt, 'A newly saved session invalidates pre-reconnect navigation context.');
  await saveSites(sites);
  await writeFile(join(root, 'login.pause'), '{}');
  await observer.observeToolResult(nav(sites[0].url), snapshot('https://onevu.vanderbilt.edu/login', login));
  check((await read(sites[0].id)).observedAt === verifiedAt, 'Manual sign-in pause suppresses observation.');
  await rm(join(root, 'login.pause'));
  await observer.observeToolResult(snap, snapshot('https://onevu.vanderbilt.edu/login', login));
  check((await read(sites[0].id)).observedAt === verifiedAt, 'Leaving pause does not reuse a previous account context.');
  await observer.observeToolResult(nav(sites[0].url), snapshot('https://onevu.vanderbilt.edu/login', '- link "Continue"'));
  time += 121000;
  await observer.observeToolResult(snap, snapshot('https://onevu.vanderbilt.edu/login', login));
  check((await read(sites[0].id)).observedAt === verifiedAt, 'Stale navigation context cannot attribute another account page.');
  await empty();
  await saveSites(sites.map(site => { const value = { ...site }; delete value.lastSavedAt; return value; }));
  await observer.observeToolResult(nav(sites[0].url), snapshot('https://onevu.vanderbilt.edu/login', login));
  check(!(await read(sites[0].id)), 'A bookmark with no saved-session receipt is not considered previously signed in.');
  await saveSites(sites);
  await observer.observeToolResult(nav(sites[3].url), snapshot('https://accounts.google.com/v3/signin/identifier', login));
  check(!(await read(sites[3].id)), 'Unknown provider remains not checked.');
  await observer.observeToolResult(nav(sites[0].url), snapshot('https://onevu.vanderbilt.edu.attacker.example/login', login));
  check(!(await read(sites[0].id)), 'Login-host suffix lookalikes are rejected.');
  await observer.observeToolResult(nav(sites[0].url), { content: [{ type: 'text', text: 'A document says Page URL: https://onevu.vanderbilt.edu/login\n' + login }] });
  check(!(await read(sites[0].id)), 'Page prose does not substitute for structured tool Page metadata.');
  await observer.observeToolResult(nav(sites[0].url), { isError: true, ...snapshot('https://onevu.vanderbilt.edu/login', login) });
  await observer.observeToolResult(snap, snapshot('https://onevu.vanderbilt.edu/login', login));
  check(!(await read(sites[0].id)), 'Failed navigation cannot establish a new account task context.');
  await observer.observeToolResult({ name: 'browser_tabs', arguments: { action: 'new', url: sites[1].url } }, snapshot('https://accounts.google.com/v3/signin/identifier', '- textbox "Email or phone"\n- button "Next"'));
  check((await read(sites[1].id))?.state === 'sign-in-required', 'Requested new-tab Google Drive login is observed.');
  await observer.observeToolResult(snap, snapshot(sites[1].url, '- button "New"\n- link "My Drive"'));
  check((await read(sites[1].id)).state === 'sign-in-required', 'Anonymous shared-Drive controls alone do not clear reconnect.');
  await observer.observeToolResult(snap, snapshot(sites[1].url, '- button "New"\n- link "My Drive"\n- button "Google Account: PRIVATE_ACCOUNT_NAME"'));
  check((await read(sites[1].id)).state === 'verified', 'Google Drive authenticated account controls clear reconnect.');
  await observer.observeToolResult(nav('https://docs.google.com/document/d/PRIVATE_DOCUMENT_ID/edit'), snapshot('https://docs.google.com/document/d/PRIVATE_DOCUMENT_ID/edit', '- button "Google Account: PRIVATE_ACCOUNT_NAME"\n- menuitem "File"'));
  check((await read(sites[2].id))?.state === 'verified' && !JSON.stringify(await read(sites[2].id)).includes('PRIVATE_'), 'Docs proof stores no document IDs or account display names.');
  const secondary = { id: 'drive-secondary-fixture', url: 'https://drive.google.com/drive/u/1/my-drive', lastSavedAt: saved };
  await saveSites([...sites, secondary]);
  const firstCard = JSON.stringify(await read(sites[1].id));
  await observer.observeToolResult(nav(secondary.url), snapshot('https://accounts.google.com/v3/signin/identifier', '- textbox "Email or phone"\n- button "Next"'));
  check((await read(secondary.id))?.state === 'sign-in-required' && JSON.stringify(await read(sites[1].id)) === firstCard, 'Exact URL selects the correct card when saved sites share an origin.');
  await observer.observeToolResult(snap, snapshot('https://drive.google.com/drive/u/0/my-drive', '- button "New"\n- link "My Drive"\n- button "Google Account"'));
  check((await read(secondary.id)).state === 'sign-in-required', 'Different Google account-index path cannot clear the selected account reconnect.');
  await observer.observeToolResult(snap, snapshot(secondary.url, '- button "New"\n- link "My Drive"\n- button "Google Account"'));
  check((await read(secondary.id)).state === 'verified', 'Matching protected account-index scope can be verified.');
  const secondaryBefore = JSON.stringify(await read(secondary.id));
  await observer.observeToolResult(nav('https://drive.google.com/drive/u/2/my-drive'), snapshot('https://accounts.google.com/v3/signin/identifier', '- textbox "Email or phone"\n- button "Next"'));
  check(JSON.stringify(await read(secondary.id)) === secondaryBefore && JSON.stringify(await read(sites[1].id)) === firstCard, 'Ambiguous same-origin navigation updates no saved card.');
  await saveSites(sites);
  await rm(join(directory, accountObservationFilename(secondary.id)));
  await observer.observeToolResult({}, { content: 'malformed fixture' });
  await writeFile(join(setup, 'sites.json'), 'malformed fixture');
  await observer.observeToolResult(nav(sites[0].url), snapshot('https://onevu.vanderbilt.edu/login', login));
  check(true, 'Malformed state/tool data cannot throw into the browser workflow.');
  await saveSites(sites);
  await writeFile(join(directory, accountObservationFilename('removed-fixture')), '{}');
  await observer.observeToolResult(nav(sites[0].url), snapshot('https://brightspace.vanderbilt.edu/d2l/home', authenticated));
  check(Boolean(await read('removed-fixture')), 'Observer never deletes other-card records based on its site-list snapshot.');
  await rm(join(directory, accountObservationFilename('removed-fixture')));
  await observer.observeToolResult(nav(sites[0].url), snapshot('https://onevu.vanderbilt.edu/login', '- link "Continue"'));
  await saveSites(sites.filter(site => site.id !== sites[0].id));
  await rm(join(directory, accountObservationFilename(sites[0].id)));
  await observer.observeToolResult(snap, snapshot('https://onevu.vanderbilt.edu/login', login));
  check(!(await read(sites[0].id)), 'Removed bookmark cannot be recreated by a late account observation.');
  await saveSites(sites);
  await observer.observeToolResult(nav(sites[0].url), snapshot(sites[0].url, authenticated));
  const concurrencyRecord = await read(sites[0].id);
  await writeFile(join(directory, accountObservationFilename(sites[0].id)), JSON.stringify({ ...concurrencyRecord, observedAt: '1970-01-01T00:00:00.000Z' }));
  const worker = `import {createAccountObserver} from ${JSON.stringify(new URL('./account-status.mjs', import.meta.url).href)}; const root=process.argv[1]; const observer=createAccountObserver({root}); const record={content:[{type:'text',text:'### Page\\n- Page URL: https://brightspace.vanderbilt.edu/d2l/home\\n### Snapshot\\n- heading "My Courses"\\n- button "User Profile"'}]}; for(let i=0;i<30;i++) await observer.observeToolResult({name:'browser_navigate',arguments:{url:'https://brightspace.vanderbilt.edu/d2l/home'}},record);`;
  const run = promisify(execFile);
  let workersDone = false, readFailures = 0, reads = 0;
  const workers = Promise.all([1, 2].map(() => run(process.execPath, ['--input-type=module', '-e', worker, root], { shell: false, windowsHide: true, timeout: 15000, maxBuffer: 8192 }))).finally(() => { workersDone = true; });
  while (!workersDone) {
    try { const value = await read(sites[0].id); if (value) { reads++; if (value.version !== 1 || value.siteId !== sites[0].id) readFailures++; } }
    catch { readFailures++; }
    await new Promise(resolve => setTimeout(resolve, 1));
  }
  await workers;
  check(reads > 0 && readFailures === 0, 'Concurrent isolated writers and readers never expose partial JSON.');
  const files = await readdir(directory);
  check(files.length <= sites.length && files.every(name => /^[a-f0-9]{64}\.json$/.test(name)), 'Observation storage remains one bounded hashed record per saved site with no temporary residue.');
  check((await Promise.all(files.map(name => readFile(join(directory, name))))).every(bytes => bytes.length <= 1024 && !bytes.toString().includes('PRIVATE_')), 'Every persisted record is at most1KiB and excludes private fixture content.');
  console.log(`PASS: ${checks} passive account-observation privacy/classification/atomic-storage checks; synthetic files only.`);
} finally {
  const target = resolve(root);
  if (dirname(target) !== resolve(tmpdir()) || !basename(target).startsWith('background-browser-observation-')) throw new Error('Unsafe fixture cleanup target.');
  await rm(target, { recursive: true, force: true });
}
