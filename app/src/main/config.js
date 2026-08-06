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

/**
 * App names this product has shipped under, newest legacy first.
 *
 * Electron derives userData from the product name, so renaming the app moves
 * the entire config directory. Without this, a pilot who updates launches a
 * stranger's app: the default token — which means their squad code changes
 * and nobody can reach them — hosting switched back off, callsign, keybinds
 * and photos folder all gone. Nothing warns them; it just looks freshly
 * installed.
 *
 * The old directory is copied, never moved, so downgrading still works.
 */
const LEGACY_APP_NAMES = ['Intel Broadcast'];

/**
 * Copies a config left behind under a previous app name into place, once.
 *
 * Takes its directories as arguments rather than reading Electron so a plain
 * node test can drive it. Does nothing if the target already exists — the
 * pilot's current settings always win over an older file.
 */
function adoptLegacyConfig(appDataDir, targetPath, legacyNames = LEGACY_APP_NAMES) {
  if (fs.existsSync(targetPath)) return null;
  for (const name of legacyNames) {
    const legacy = path.join(appDataDir, name, 'config.local.json');
    if (!fs.existsSync(legacy)) continue;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.copyFileSync(legacy, targetPath);
    return name;
  }
  return null;
}

/** The packaged wrapper. Unpackaged runs keep the repo-relative path and are
 *  unaffected, so this is a no-op in dev and in every test but its own. */
function adoptLegacyConfigOnce(targetPath) {
  const app = getElectronApp();
  if (!app || !app.isPackaged) return;
  try {
    const from = adoptLegacyConfig(app.getPath('appData'), targetPath);
    // Names the source only. The file's contents include the token, which is
    // the squad password and never goes near a log line.
    if (from) console.log(`[config] adopted settings from the previous app name "${from}"`);
  } catch (err) {
    console.log(`[config] could not adopt previous settings: ${err.message}`);
  }
}

const LOCAL_CONFIG_PATH = resolveLocalConfigPath();
adoptLegacyConfigOnce(LOCAL_CONFIG_PATH);

/**
 * Reads the user's settings file, or null when it cannot be used.
 *
 * A settings file is something people edit by hand, and two very ordinary ways
 * of doing that produce something `JSON.parse` rejects: Notepad and PowerShell
 * 5.1's `Set-Content -Encoding UTF8` both prepend a UTF-8 BOM. Parsing that
 * threw during module load, which in Electron is an unrecoverable
 * "A JavaScript error occurred in the main process" dialog — the app simply
 * would not start, and nothing said why.
 *
 * So: strip the BOM, and treat anything still unparseable as "no settings"
 * rather than as fatal. The broken file is moved aside instead of deleted,
 * because it is the only copy of whatever the user had configured.
 */
function readLocalConfig() {
  let text;
  try {
    text = fs.readFileSync(LOCAL_CONFIG_PATH, 'utf8');
  } catch (err) {
    console.error(`[config] cannot read ${LOCAL_CONFIG_PATH}: ${err.message} — using defaults`);
    return null;
  }

  // U+FEFF at the start is a byte-order mark, not content.
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);

  try {
    const parsed = JSON.parse(text);
    // A JSON file can be valid and still not be an object (`null`, `[]`, `"x"`).
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('settings must be a JSON object');
    }
    return parsed;
  } catch (err) {
    const spoiled = `${LOCAL_CONFIG_PATH}.broken-${Date.now()}`;
    try {
      fs.renameSync(LOCAL_CONFIG_PATH, spoiled);
      console.error(`[config] ${LOCAL_CONFIG_PATH} is not valid JSON (${err.message})`);
      console.error(`[config] moved it to ${spoiled} and started with defaults`);
    } catch {
      console.error(`[config] ${LOCAL_CONFIG_PATH} is not valid JSON (${err.message}) — using defaults`);
    }
    return null;
  }
}

/**
 * Loads resources/config.default.json (committed, baked in per squad build)
 * and shallow-merges the user's config.local.json over it if present.
 */
function loadConfig() {
  const defaults = JSON.parse(fs.readFileSync(DEFAULT_CONFIG_PATH, 'utf8'));

  if (!fs.existsSync(LOCAL_CONFIG_PATH)) return defaults;

  const local = readLocalConfig();
  if (!local) return defaults;
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

module.exports = { loadConfig, LOCAL_CONFIG_PATH, adoptLegacyConfig, LEGACY_APP_NAMES };
