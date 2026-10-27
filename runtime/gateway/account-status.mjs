import { createHash, randomUUID } from 'node:crypto';
import { readFile, writeFile, rename, unlink, mkdir, rmdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

const MAX_BYTES = 128 * 1024;
const MAX_RECORD_BYTES = 1024;
const MAX_CONTEXT_AGE = 2 * 60 * 1000;
const validId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value);
export const accountObservationFilename = siteId => {
  if (!validId(siteId)) throw new Error('Invalid saved-site identity.');
  return createHash('sha256').update(siteId).digest('hex') + '.json';
};

function url(value) {
  try {
    const result = new URL(value);
    if (result.protocol !== 'https:' || result.username || result.password || result.port) return;
    result.search = ''; result.hash = '';
    return result;
  } catch { return; }
}
function providerFor(origin) {
  if (origin === 'https://brightspace.vanderbilt.edu') return 'brightspace';
  if (origin === 'https://drive.google.com') return 'drive';
  if (origin === 'https://docs.google.com') return 'docs';
}
function protectedPage(provider, page) {
  if (/\/(?:login|signin|sign-in|auth)(?:\/|$)/i.test(page.pathname)) return false;
  if (provider === 'brightspace') return page.origin === 'https://brightspace.vanderbilt.edu' && (page.pathname === '/' || page.pathname.startsWith('/d2l/'));
  if (provider === 'drive') return page.origin === 'https://drive.google.com' && (page.pathname === '/' || page.pathname.startsWith('/drive/'));
  if (provider === 'docs') return page.origin === 'https://docs.google.com' && (page.pathname === '/' || /^\/(?:document|spreadsheets|presentation)\//.test(page.pathname));
  return false;
}
function loginDestination(provider, page) {
  // Exact known identity-provider origins only. No hostname suffix/wildcard,
  // title-only, or generic URL containing the word "login" is sufficient.
  if (provider === 'brightspace') return page.origin === 'https://onevu.vanderbilt.edu';
  return ['drive', 'docs'].includes(provider) && page.origin === 'https://accounts.google.com' &&
    (/^\/(?:v\d+\/)?signin(?:\/|$)/.test(page.pathname) || page.pathname === '/ServiceLogin');
}
function actualPage(result) {
  if (!result || result.isError) return;
  let text = '';
  for (const part of result.content || []) {
    if (part.type !== 'text' || typeof part.text !== 'string') continue;
    text += part.text.slice(0, MAX_BYTES - text.length) + '\n';
    if (text.length >= MAX_BYTES) break;
  }
  // Only the tool's Page metadata is considered, not URLs/words in arbitrary
  // page prose, console output, all-tab listings, or artifact file contents.
  const section = /(?:^|\n)### Page(?: state)?\s*\n([\s\S]*?)(?=\n### |$)/.exec(text)?.[1];
  const address = section && /^\s*-?\s*Page URL:\s*(\S+)/m.exec(section)?.[1];
  const page = address && url(address);
  if (!page || /(?:Page Title:.*(?:403|Forbidden|Access Denied|CAPTCHA)|recaptcha|verify you are human|unusual traffic|ERR_[A-Z_]+)/i.test(text)) return;
  return { page, text };
}
function loginForm(text) {
  const field = /(?:^|\n)\s*-\s*(?:textbox|input)\s+"[^"\n]*(?:password|username|email|VUnetID)[^"\n]*"/i.test(text);
  const submit = /(?:^|\n)\s*-\s*button\s+"(?:Sign in|Log in|Continue|Next|Verify)[^"\n]*"/i.test(text);
  return field && submit;
}
function authenticatedMarker(provider, text) {
  if (provider === 'brightspace') return /(?:^|\n)\s*-\s*button\s+"(?:User Profile[^"\n]*|[^"\n]*\bavatar)"/i.test(text) && /(?:^|\n)\s*-\s*(?:heading|link|region)\s+"(?:My Courses|My Home)"/i.test(text);
  if (provider === 'drive') return /(?:^|\n)\s*-\s*button\s+"Google Account[^"\n]*"/i.test(text) && /(?:^|\n)\s*-\s*button\s+"(?:New|Create new)[^"\n]*"/i.test(text) && /(?:^|\n)\s*-\s*(?:heading|link)\s+"My Drive"/i.test(text);
  if (provider === 'docs') return /(?:^|\n)\s*-\s*button\s+"Google Account[^"\n]*"/i.test(text) && /(?:^|\n)\s*-\s*(?:menuitem|button)\s+"(?:File|Share)[^"\n]*"/i.test(text);
  return false;
}

export function createAccountObserver({ root, now = Date.now } = {}) {
  if (typeof root !== 'string' || !root) throw new Error('An installation root is required.');
  const directory = join(root, 'setup', 'account-observations');
  let expected, queue = Promise.resolve();
  const savedSites = async () => {
    try {
      const filename = join(root, 'setup', 'sites.json');
      if ((await stat(filename)).size > MAX_BYTES) return [];
      const records = JSON.parse(await readFile(filename, 'utf8'));
      if (!Array.isArray(records) || records.length > 100) return [];
      return records.filter(site => validId(site.id) && typeof site.lastSavedAt === 'string' && Number.isFinite(Date.parse(site.lastSavedAt)) && url(site.url));
    } catch { return []; }
  };
  const write = async (site, state, reasonCode, observedAt) => {
    const record = { version: 1, siteId: site.id, state, observedAt, reasonCode };
    const contents = JSON.stringify(record) + '\n';
    if (Buffer.byteLength(contents) > MAX_RECORD_BYTES) return;
    await mkdir(directory, { recursive: true });
    const filename = join(directory, accountObservationFilename(site.id));
    const lock = filename + '.lock';
    let owned = false;
    for (let attempt = 0; attempt < 4; attempt++) {
      try { await mkdir(lock); owned = true; break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        if (attempt < 3) await new Promise(resolve => setTimeout(resolve, (attempt + 1) * 5));
      }
    }
    if (!owned) return; // Never steal another writer's lock; skip a busy observation.
    let temporary;
    try {
      try { await stat(join(root, 'login.pause')); expected = undefined; return; }
      catch (error) { if (error.code !== 'ENOENT') return; }
      const currentSite = (await savedSites()).find(item => item.id === site.id);
      if (!currentSite || currentSite.url !== site.url || currentSite.lastSavedAt !== site.lastSavedAt) return;
      try {
        if ((await stat(filename)).size <= MAX_RECORD_BYTES) {
          const prior = JSON.parse(await readFile(filename, 'utf8'));
          if (prior.siteId === site.id && Date.parse(prior.observedAt) > Date.parse(observedAt)) return;
        }
      } catch { /* A missing/invalid record can be replaced with current evidence. */ }
      temporary = filename + '.' + process.pid + '.' + randomUUID() + '.tmp';
      await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
      await rename(temporary, filename);
      const stillSaved = (await savedSites()).find(item => item.id === site.id);
      if (!stillSaved || stillSaved.url !== site.url || stillSaved.lastSavedAt !== site.lastSavedAt) await unlink(filename).catch(() => {});
    } finally {
      if (temporary) await unlink(temporary).catch(() => {});
      await rmdir(lock).catch(() => {});
    }
    // Bookmark removal owns exact-record deletion. Never prune from a stale
    // per-process website list while another process may have added a card.
  };
  const observe = async (params, result, observedAt) => {
    try { await stat(join(root, 'login.pause')); expected = undefined; return; }
    catch (error) { if (error.code !== 'ENOENT') return; }
    const sites = await savedSites();
    const navigation = params.name === 'browser_navigate' || (params.name === 'browser_tabs' && params.arguments?.action === 'new');
    if (navigation) {
      expected = undefined;
      if (result?.isError) return;
      const target = url(params.arguments?.url);
      if (!target) return;
      const candidates = sites.filter(item => { const saved = url(item.url); const provider = providerFor(saved.origin); return saved.origin === target.origin && provider && protectedPage(provider, target); });
      const exact = candidates.filter(item => url(item.url).href === target.href);
      const site = exact.length === 1 ? exact[0] : exact.length === 0 && candidates.length === 1 ? candidates[0] : undefined;
      if (!site) return;
      expected = { siteId: site.id, provider: providerFor(target.origin), savedAt: site.lastSavedAt, expires: now() + MAX_CONTEXT_AGE };
      expected.accountScope = (target.pathname.match(/^\/(?:drive|document|spreadsheets|presentation)\/u\/\d+\//) || url(site.url).pathname.match(/^\/(?:drive|document|spreadsheets|presentation)\/u\/\d+\//))?.[0];
      const redirected = actualPage(result);
      if (redirected && loginDestination(expected.provider, redirected.page)) expected.loginRedirect = redirected.page.origin + redirected.page.pathname;
    } else if (params.name === 'browser_tabs') {
      if (params.arguments?.action !== 'list') expected = undefined;
      return; // An all-tab listing never establishes account state.
    } else if (params.name !== 'browser_snapshot') {
      // A click, keypress, script, or unknown tool may switch tabs or navigate.
      // Without an explicit correlated page identity, forget the account task
      // rather than attributing the next shared SSO page to an earlier request.
      if (!['browser_take_screenshot', 'browser_console_messages', 'browser_network_requests'].includes(params.name)) expected = undefined;
      return;
    }
    if (!expected || expected.expires < now()) { expected = undefined; return; }
    const site = sites.find(item => item.id === expected.siteId);
    if (!site || site.lastSavedAt !== expected.savedAt) { expected = undefined; return; }
    const page = actualPage(result);
    if (!page) return;
    if (expected.loginRedirect === page.page.origin + page.page.pathname && loginDestination(expected.provider, page.page) && loginForm(page.text)) await write(site, 'sign-in-required', 'known-login-form', observedAt);
    else if ((!expected.accountScope || page.page.pathname.startsWith(expected.accountScope)) && protectedPage(expected.provider, page.page) && authenticatedMarker(expected.provider, page.text)) await write(site, 'verified', 'protected-page-marker', observedAt);
  };
  return {
    observeToolResult(params, result) {
      // Observation is best effort and must never turn a completed browser
      // action into a failure/retry. No additional browser call occurs here.
      let observedAt;
      try { observedAt = new Date(now()).toISOString(); } catch { return Promise.resolve(); }
      const pending = queue.then(() => observe(params, result, observedAt)).catch(() => {});
      queue = pending;
      return pending;
    },
  };
}
