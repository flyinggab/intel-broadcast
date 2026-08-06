'use strict';

// Unit test for config.js — specifically the legacy-key fallback: local
// configs written before the mode unification used `gmModeEnabled` for what
// is now `relayHostEnabled`. Pure Node.
//
// Usage: node scripts/dev-config-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const TMP_CONFIG = path.join(os.tmpdir(), `taclink-config-test-${process.pid}.json`);
process.env.INTEL_BROADCAST_LOCAL_CONFIG_PATH = TMP_CONFIG; // must be set before require
const { loadConfig } = require('../src/main/config');

try {
  // Legacy local config: old key only -> honored as relayHostEnabled.
  fs.writeFileSync(TMP_CONFIG, JSON.stringify({ gmModeEnabled: true }));
  assert.strictEqual(loadConfig().relayHostEnabled, true, 'legacy gmModeEnabled:true maps to relayHostEnabled');

  fs.writeFileSync(TMP_CONFIG, JSON.stringify({ gmModeEnabled: false }));
  assert.strictEqual(loadConfig().relayHostEnabled, false, 'legacy gmModeEnabled:false maps too');
  console.log('[test] legacy fallback OK');

  // New key present -> it wins, stale legacy key ignored.
  fs.writeFileSync(TMP_CONFIG, JSON.stringify({ relayHostEnabled: false, gmModeEnabled: true }));
  assert.strictEqual(loadConfig().relayHostEnabled, false, 'new key wins over stale legacy key');
  console.log('[test] new key precedence OK');

  // No local config -> defaults (not hosting).
  fs.rmSync(TMP_CONFIG, { force: true });
  const cfg = loadConfig();
  assert.strictEqual(cfg.relayHostEnabled, false);
  assert.strictEqual(cfg.gm.funnelEnabled, false, 'funnelEnabled default present');
  assert.strictEqual(cfg.hotkeys.reveal, 'Ctrl+Shift+I');
  console.log('[test] defaults OK');

  // ---------------------------------------------------------------------
  // Renaming the app moves Electron's userData directory, which would strand
  // every existing install on defaults — including the token, so the pilot's
  // squad code silently changes and nobody can reach them. The old file is
  // adopted once. (Packaged-only in real life; here the paths are injected.)
  // ---------------------------------------------------------------------
  const { adoptLegacyConfig, LEGACY_APP_NAMES } = require('../src/main/config');
  const appData = fs.mkdtempSync(path.join(os.tmpdir(), 'taclink-appdata-'));
  try {
    const legacyName = LEGACY_APP_NAMES[0];
    const legacyDir = path.join(appData, legacyName);
    const target = path.join(appData, 'Tac Link', 'config.local.json');
    fs.mkdirSync(legacyDir, { recursive: true });
    fs.writeFileSync(path.join(legacyDir, 'config.local.json'),
      JSON.stringify({ token: 'squad-secret', callsign: 'GHOSTRIDER 1-1', relayHostEnabled: true }));

    assert.strictEqual(adoptLegacyConfig(appData, target), legacyName, 'reports which name it adopted');
    const adopted = JSON.parse(fs.readFileSync(target, 'utf8'));
    assert.strictEqual(adopted.token, 'squad-secret', 'the token survives the rename');
    assert.strictEqual(adopted.relayHostEnabled, true, 'a host stays a host across the rename');
    assert.ok(fs.existsSync(path.join(legacyDir, 'config.local.json')), 'the old file is copied, not moved');
    console.log('[test] legacy app-name adoption OK');

    // Current settings always win: a second run must not overwrite them.
    fs.writeFileSync(target, JSON.stringify({ token: 'newer' }));
    assert.strictEqual(adoptLegacyConfig(appData, target), null, 'no adoption when a config is already there');
    assert.strictEqual(JSON.parse(fs.readFileSync(target, 'utf8')).token, 'newer', 'existing config untouched');

    // Nothing to adopt is not an error.
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'taclink-appdata-'));
    assert.strictEqual(adoptLegacyConfig(empty, path.join(empty, 'x', 'config.local.json')), null);
    fs.rmSync(empty, { recursive: true, force: true });
    console.log('[test] adoption is idempotent and safe when absent');
  } finally {
    fs.rmSync(appData, { recursive: true, force: true });
  }

  // A settings file people edit by hand must never be fatal. A UTF-8 BOM is
  // what Notepad and PowerShell 5.1 write, and parsing one threw during module
  // load — an unrecoverable Electron crash dialog before the app could start.
  fs.writeFileSync(TMP_CONFIG, '\uFEFF' + JSON.stringify({ callsign: 'BOM PILOT', relayHostEnabled: true }), 'utf8');
  let cfg2 = loadConfig();
  assert.strictEqual(cfg2.callsign, 'BOM PILOT', 'a BOM must be stripped, not fatal');
  assert.strictEqual(cfg2.relayHostEnabled, true);
  console.log('[test] UTF-8 BOM tolerated');

  // Anything still unparseable falls back to defaults, and the file is moved
  // aside rather than deleted — it is the only copy of the user's settings.
  const dir = path.dirname(TMP_CONFIG);
  for (const f of fs.readdirSync(dir)) if (f.includes('.broken-')) fs.rmSync(path.join(dir, f), { force: true });
  fs.writeFileSync(TMP_CONFIG, '{ this is not json ');
  cfg2 = loadConfig();
  assert.strictEqual(cfg2.relayHostEnabled, false, 'falls back to defaults rather than throwing');
  assert.ok(!fs.existsSync(TMP_CONFIG), 'the broken file is moved out of the way');
  const salvaged = fs.readdirSync(dir).filter((f) => f.includes('.broken-'));
  assert.strictEqual(salvaged.length, 1, 'the broken file is kept, not deleted');
  for (const f of salvaged) fs.rmSync(path.join(dir, f), { force: true });
  console.log('[test] malformed settings: defaults, and the file is preserved');

  // Valid JSON that is not an object is not settings either.
  for (const junk of ['null', '[]', '"hello"', '42']) {
    fs.writeFileSync(TMP_CONFIG, junk);
    assert.strictEqual(loadConfig().relayHostEnabled, false, `${junk} must not be treated as settings`);
    for (const f of fs.readdirSync(dir)) if (f.includes('.broken-')) fs.rmSync(path.join(dir, f), { force: true });
  }
  console.log('[test] non-object JSON rejected');

  console.log('[dev-config-test] PASS');
} finally {
  fs.rmSync(TMP_CONFIG, { force: true });
}
