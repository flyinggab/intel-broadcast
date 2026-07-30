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

const TMP_CONFIG = path.join(os.tmpdir(), `intel-broadcast-config-test-${process.pid}.json`);
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

  console.log('[dev-config-test] PASS');
} finally {
  fs.rmSync(TMP_CONFIG, { force: true });
}
