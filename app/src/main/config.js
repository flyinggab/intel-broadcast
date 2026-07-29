'use strict';

const fs = require('fs');
const path = require('path');

const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'resources', 'config.default.json');
const LOCAL_CONFIG_PATH = path.join(__dirname, '..', '..', 'resources', 'config.local.json');

/**
 * Loads resources/config.default.json (committed, baked in per squad build)
 * and shallow-merges resources/config.local.json over it if present
 * (gitignored — per-dev override, e.g. pointing at a different relay while
 * testing).
 */
function loadConfig() {
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));

  if (!fs.existsSync(LOCAL_CONFIG_PATH)) return defaults;

  const local = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
  return {
    ...defaults,
    ...local,
    hotkeys: { ...defaults.hotkeys, ...(local.hotkeys || {}) },
    gm: { ...defaults.gm, ...(local.gm || {}) },
  };
}

module.exports = { loadConfig, LOCAL_CONFIG_PATH };
