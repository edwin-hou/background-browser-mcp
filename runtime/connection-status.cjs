'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes } = require('node:crypto');

const CHANNELS = ['chatgpt', 'codex'];
const CODES = ['BACKEND_UNAVAILABLE', 'COMPLETION_UNKNOWN', 'CLIENT_DISCONNECTED', 'REQUEST_FAILED'];
const COMPLETIONS = [null, 'not-dispatched', 'read-only', 'unknown'];
const MAX_RECORDS = 128, MAX_CHANNEL_RECORDS = 64, MAX_ENTRIES = 512, MAX_BYTES = 2048;
const NAME = /^(chatgpt|codex)-[a-f0-9]{32}-[0-9]{1,16}\.json$/;
const empty = state => ({ state, lastContactAt: null, lastSuccessAt: null, lastFailureAt: null, failureCode: null, completion: null });
function directory(root) {
  if (typeof root !== 'string' || !path.isAbsolute(root)) throw new Error('An absolute local state root is required.');
  return path.join(root, 'setup', 'connection-observations');
}
async function entries(dir) {
  const files = [], handle = await fs.opendir(dir);
  let count = 0;
  try {
    for await (const item of handle) {
      if (++count > MAX_ENTRIES) throw new Error('Connection observation limit exceeded.');
      const match = NAME.exec(item.name);
      if (match) files.push({ name: item.name, channel: match[1], regular: item.isFile() && !item.isSymbolicLink() });
    }
  } finally { await handle.close().catch(() => {}); }
  return files;
}
function time(value, now) {
  if (typeof value !== 'string') return null;
  const stamp = Date.parse(value);
  return Number.isFinite(stamp) && stamp >= 0 && stamp <= now + 60000 && new Date(stamp).toISOString() === value ? stamp : null;
}
function validRecord(value, channel, now) {
  const keys = ['version', 'channel', 'state', 'lastContactAt', 'lastSuccessAt', 'lastFailureAt', 'failureCode', 'completion'];
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== keys.length || keys.some(key => !Object.hasOwn(value, key)) || value.version !== 1 || value.channel !== channel || !['succeeded', 'failed'].includes(value.state)) return false;
  const contact = time(value.lastContactAt, now), success = value.lastSuccessAt === null ? null : time(value.lastSuccessAt, now), failure = value.lastFailureAt === null ? null : time(value.lastFailureAt, now);
  if (contact === null || (value.lastSuccessAt !== null && success === null) || (value.lastFailureAt !== null && failure === null) || success > contact || failure > contact) return false;
  if (failure === null ? value.failureCode !== null || value.completion !== null : !CODES.includes(value.failureCode) || !COMPLETIONS.includes(value.completion)) return false;
  return value.state === 'succeeded' ? success === contact : failure === contact;
}
function newest(records, key) {
  return records.filter(record => record[key] !== null).sort((a, b) => Date.parse(b[key]) - Date.parse(a[key]) ||
    (key === 'lastContactAt' ? Number(b.state === 'failed') - Number(a.state === 'failed') : 0) ||
    Number(b.completion === 'unknown') - Number(a.completion === 'unknown') || Number(b.state === 'failed') - Number(a.state === 'failed'))[0];
}
async function readBounded(filename) {
  const handle = await fs.open(filename, 'r');
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > MAX_BYTES) throw new Error('Invalid observation size.');
    const buffer = Buffer.alloc(MAX_BYTES + 1), { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_BYTES) throw new Error('Invalid observation size.');
    return JSON.parse(buffer.toString('utf8', 0, bytesRead));
  } finally { await handle.close(); }
}
async function readConnectionStatus(root, { now = Date.now } = {}) {
  const dir = directory(root), result = { chatgpt: empty('unseen'), codex: empty('unseen') };
  let files, stamp;
  try { stamp = now(); if (!Number.isFinite(stamp) || !(await fs.stat(root)).isDirectory()) throw new Error('Invalid local state root or clock.'); files = await entries(dir); }
  catch (error) { return error.code === 'ENOENT' ? result : { chatgpt: empty('unavailable'), codex: empty('unavailable') }; }
  const records = { chatgpt: [], codex: [] }, bad = new Set();
  if (files.length > MAX_RECORDS) return { chatgpt: empty('unavailable'), codex: empty('unavailable') };
  await Promise.all(files.map(async file => {
    try {
      if (!file.regular) throw new Error('Not a regular observation.');
      const target = path.join(dir, file.name), info = await fs.lstat(target);
      if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_BYTES) throw new Error('Invalid observation size.');
      const value = await readBounded(target);
      if (!validRecord(value, file.channel, stamp)) throw new Error('Invalid observation.');
      records[file.channel].push(value);
    } catch (error) { if (error.code !== 'ENOENT') bad.add(file.channel); }
  }));
  for (const channel of CHANNELS) {
    const latest = newest(records[channel], 'lastContactAt'), success = newest(records[channel], 'lastSuccessAt'), failure = newest(records[channel], 'lastFailureAt');
    result[channel] = {
      state: bad.has(channel) ? 'unavailable' : latest?.state || 'unseen',
      lastContactAt: latest?.lastContactAt || null,
      lastSuccessAt: success?.lastSuccessAt || null,
      lastFailureAt: failure?.lastFailureAt || null,
      failureCode: failure?.failureCode || null,
      // These two fields describe the last failure, even after recovery.
      completion: failure?.completion || null,
    };
  }
  return result;
}
function createConnectionReporter({ root, channel, now = Date.now } = {}) {
  const dir = directory(root);
  if (!CHANNELS.includes(channel) || typeof now !== 'function') throw new Error('Invalid connection observation channel.');
  const instance = randomBytes(16).toString('hex');
  let sequence = 0, queue = Promise.resolve(), record = empty('unseen');
  const publish = (state, code = null, completion = null) => {
    const task = queue.then(async () => {
      try {
        const at = now(); if (!Number.isFinite(at) || at < 0) return;
        const previous = record.lastContactAt ? Date.parse(record.lastContactAt) : -Infinity;
        const observedAt = new Date(Math.max(at, previous + 1)).toISOString();
        record = { ...record, state, lastContactAt: observedAt, ...(state === 'succeeded' ? { lastSuccessAt: observedAt } : { lastFailureAt: observedAt, failureCode: CODES.includes(code) ? code : 'REQUEST_FAILED', completion: COMPLETIONS.includes(completion) ? completion : 'unknown' }) };
        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        const name = channel + '-' + instance + '-' + (++sequence) + '.json', final = path.join(dir, name), temporary = final + '.tmp';
        try {
          await fs.writeFile(temporary, JSON.stringify({ version: 1, channel, ...record }) + '\n', { flag: 'wx', mode: 0o600 });
          await fs.rename(temporary, final);
        } finally { await fs.unlink(temporary).catch(() => {}); }
        // Immutable event names make concurrent pruning safe: an older pathname
        // can never be overwritten with a newer failure between stat and unlink.
        const files = (await entries(dir)).filter(file => file.channel === channel);
        if (files.length > MAX_CHANNEL_RECORDS) {
          const dated = await Promise.all(files.filter(file => file.regular).map(async file => {
            try {
              const filename = path.join(dir, file.name), info = await fs.stat(filename);
              let value = null;
              if (info.size <= MAX_BYTES) { try { const parsed = await readBounded(filename); if (validRecord(parsed, channel, now())) value = parsed; } catch {} }
              return { name: file.name, modified: info.mtimeMs, value };
            } catch { return null; }
          }));
          // Keep the latest explicit success and failure across reporter process
          // restarts, even if one new process has never seen the earlier result.
          const protectedNames = new Set([name]);
          for (const state of ['succeeded', 'failed']) {
            const latest = dated.filter(item => item?.value?.state === state).sort((a, b) => Date.parse(b.value.lastContactAt) - Date.parse(a.value.lastContactAt) || Number(b.value.completion === 'unknown') - Number(a.value.completion === 'unknown'))[0];
            if (latest) protectedNames.add(latest.name);
          }
          dated.sort((a, b) => !a ? 1 : !b ? -1 : a.modified - b.modified || a.name.localeCompare(b.name));
          await Promise.all(dated.filter(item => item && !protectedNames.has(item.name)).slice(0, files.length - MAX_CHANNEL_RECORDS).map(file => fs.unlink(path.join(dir, file.name)).catch(() => {})));
        }
      } catch { /* Diagnostics never change, fail, or replay the browser request. */ }
    });
    queue = task.catch(() => {});
    return task;
  };
  return { success: () => publish('succeeded'), failure: (code, completion = null) => publish('failed', code, completion) };
}
module.exports = { createConnectionReporter, readConnectionStatus };
