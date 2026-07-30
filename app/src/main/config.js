'use strict';

const fs = require('fs');
const path = require('path');

// Defaults ship inside the app bundle (read-only, fine — we only read them).
const DEFAULT_CONFIG_PATH = path.join(__dirname, '..', '..', 'resources', 'config.default.json');

/**
 * Electron's `app`, or null when this module is loaded by a plain-node test.
 * (Outside Electron, `require('electron')` resolves to a path string rather
 * than the API object.)
 */
function getElectronApp() {
  try {
    const electron = require('electron');
    return electron && typeof electron === 'object' ? electron.app : null;
  } catch {
    return null;
  }
}

/**
 * Where user settings are saved.
 *
 * In a PACKAGED build this must be userData: `__dirname` is inside
 * `app.asar`, which is read-only, so writing config.local.json there fails
 * and every save silently does nothing — the app looks like it ignores the
 * settings window entirely (this shipped in v0.2.0 and made the Tailscale
 * toggle, the photos folder, and everything else appear dead).
 *
 * Unpackaged (dev checkout, test scripts) keeps the old repo-relative path so
 * the dev scripts and two-instance workflow are unchanged. The env override
 * still wins everywhere — that's how two instances share one machine.
 */
function resolveLocalConfigPath() {
  if (process.env.INTEL_BROADCAST_LOCAL_CONFIG_PATH) return process.env.INTEL_BROADCAST_LOCAL_CONFIG_PATH;
  const app = getElectronApp();
  if (app && app.isPackaged) return path.join(app.getPath('userData'), 'config.local.json');
  return path.join(__dirname, '..', '..', 'resources', 'config.local.json');
}

const LOCAL_CONFIG_PATH = resolveLocalConfigPath();

/**
 * Loads resources/config.default.json (committed, baked in per squad build)
 * and shallow-merges the user's config.local.json over it if present.
 */
function loadConfig() {
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));

  if (!fs.existsSync(LOCAL_CONFIG_PATH)) return defaults;

  const local = JSON.parse(fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8'));
  const merged = {
    ...defaults,
    ...local,
    hotkeys: { ...defaults.hotkeys, ...(local.hotkeys || {}) },
    gm: { ...defaults.gm, ...(local.gm || {}) },
  };
  // Legacy: pre-unification configs used `gmModeEnabled` for what is now
  // `relayHostEnabled` (every instance shares AND receives; the old "GM"
  // distinction reduced to "hosts the relay"). Honor the old key when a
  // local file predates the rename.
  if (local.relayHostEnabled === undefined && typeof local.gmModeEnabled === 'boolean') {
    merged.relayHostEnabled = local.gmModeEnabled;
  }
  return merged;
}

module.exports = { loadConfig, LOCAL_CONFIG_PATH };
