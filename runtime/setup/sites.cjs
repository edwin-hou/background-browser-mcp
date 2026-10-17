'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function websiteUrl(value) {
  const text = String(value ?? '').trim();
  if (!text || text.length > 2048 || /[\x00-\x20\x7f]/.test(text)) throw new Error('Enter a valid HTTPS website address.');
  let url;
  try { url = new URL(text.includes('://') ? text : 'https://' + text); }
  catch { throw new Error('Enter a valid HTTPS website address.'); }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname || url.port) throw new Error('Use an HTTPS website address without embedded credentials or a custom port.');
  // Store reusable website addresses, never one-time sign-in codes or URL fragments.
  url.search = ''; url.hash = '';
  return url.href;
}
function siteName(value, url) {
  const name = String(value ?? '').trim() || new URL(url).hostname.replace(/^www\./, '');
  if (name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw new Error('Use a website name of 80 characters or fewer.');
  return name;
}
function validId(value) {
  if (!/^[a-z0-9][a-z0-9-]{0,79}$/.test(String(value ?? ''))) throw new Error('Choose a saved website.');
  return String(value);
}
function createSiteStore(filename) {
  let records;
  try { records = JSON.parse(fs.readFileSync(filename, 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw new Error('The saved website list could not be read.');
    records = [{ id: 'vanderbilt-brightspace', name: 'Vanderbilt Brightspace', url: 'https://brightspace.vanderbilt.edu/d2l/home' }];
  }
  if (!Array.isArray(records) || records.length > 100) throw new Error('The saved website list is invalid.');
  records = records.map(item => ({ id: validId(item.id), name: siteName(item.name, websiteUrl(item.url)), url: websiteUrl(item.url), ...(typeof item.lastSavedAt === 'string' && !isNaN(Date.parse(item.lastSavedAt)) ? { lastSavedAt: item.lastSavedAt } : {}) }));
  if (new Set(records.map(item => item.id)).size !== records.length) throw new Error('The saved website list is invalid.');
  function save(next) {
    fs.mkdirSync(path.dirname(filename), { recursive: true });
    const temporary = filename + '.' + process.pid + '.' + randomUUID() + '.tmp';
    try { fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); fs.renameSync(temporary, filename); }
    finally { try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; } }
    records = next;
  }
  return {
    list: () => records.map(item => ({ ...item })),
    get: id => { const found = records.find(item => item.id === validId(id)); if (!found) throw new Error('Choose a saved website.'); return { ...found }; },
    add(input) {
      const url = websiteUrl(input.url), name = siteName(input.name, url);
      if (records.length >= 100) throw new Error('You can save up to 100 websites.');
      if (records.some(item => item.url === url)) throw new Error('That website is already saved.');
      const site = { id: randomUUID(), name, url }; save([...records, site]); return { ...site };
    },
    remove(id) { validId(id); if (!records.some(item => item.id === id)) throw new Error('Choose a saved website.'); save(records.filter(item => item.id !== id)); },
    markSaved(id, timestamp) {
      if (!records.some(item => item.id === id) || isNaN(Date.parse(timestamp))) return;
      const current = records.find(item => item.id === id);
      if (current.lastSavedAt && Date.parse(current.lastSavedAt) >= Date.parse(timestamp)) return;
      save(records.map(item => item.id === id ? { ...item, lastSavedAt: timestamp } : item));
    }
  };
}
module.exports = { websiteUrl, siteName, validId, createSiteStore };
