'use strict';

const fs = require('node:fs');
const path = require('node:path');

// This generated file contains executable paths only; credentials stay separate.
function chromeExecutable(root = __dirname) {
  const settingsPath = path.join(root, 'runtime-settings.json');
  let configured;
  try {
    if (fs.statSync(settingsPath).size > 16384) throw new Error('Runtime settings are too large.');
    configured = JSON.parse(fs.readFileSync(settingsPath, 'utf8')).chromeExecutable;
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error('Invalid local runtime settings.');
  }
  if (configured !== undefined) {
    if (typeof configured !== 'string' || !path.isAbsolute(configured) || !fs.existsSync(configured)) {
      throw new Error('Configured Chrome executable is unavailable. Run the installer again in a new directory.');
    }
    return configured;
  }
  const candidates = [
    process.env.PROGRAMFILES && path.join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env['PROGRAMFILES(X86)'] && path.join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
  const found = candidates.find(file => fs.existsSync(file));
  if (!found) throw new Error('Chrome is not installed. Install Chrome or supply -ChromePath to the installer.');
  return found;
}

module.exports = { chromeExecutable };
