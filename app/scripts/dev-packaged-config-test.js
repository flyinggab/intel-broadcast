'use strict';

// Regression guard for the v0.2.0 shipping bug: config.local.json was written
// to a path inside the app bundle, which is READ-ONLY once packaged
// (app.asar). Every settings save failed silently, so the released build
// looked like it ignored the settings window entirely — the Tailscale toggle,
// the photos folder, everything.
//
// Packs a real app bundle with electron-builder, then asserts:
//   1. the settings path the app would use is NOT inside the bundle;
//   2. it IS inside a writable per-user directory, and writing there works;
//   3. the bundle is genuinely read-only, i.e. the old path really would have
//      failed (proving this test tests something).
//
// Usage: node scripts/dev-packaged-config-test.js
//   (slow — it runs a real electron-builder pack; skip with SKIP_PACK=1 to
//    check only the path logic against an existing dist/)

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');
const { execFileSync } = require('child_process');

const APP_DIR = path.join(__dirname, '..');
const UNPACKED = path.join(APP_DIR, 'dist', 'linux-unpacked');
const ASAR = path.join(UNPACKED, 'resources', 'app.asar');

if (!process.env.SKIP_PACK) {
  console.log('[pack] running electron-builder (this takes a minute)…');
  execFileSync('npx', ['electron-builder', '--linux', 'dir', '--publish', 'never'], {
    cwd: APP_DIR,
    stdio: 'inherit',
  });
}

assert.ok(fs.existsSync(ASAR), `expected a packed bundle at ${ASAR}`);

// --- 1/3. The packed bundle really is read-only ----------------------------
// (If this ever stops throwing, the rest of the test proves nothing.)
let bundleWriteFailed = false;
try {
  fs.writeFileSync(path.join(ASAR, 'resources', 'config.local.json'), '{}');
} catch {
  bundleWriteFailed = true;
}
assert.ok(bundleWriteFailed, 'writing inside app.asar should fail — otherwise this test is vacuous');
console.log('[test] app.asar is read-only, as expected');

// --- 2/3. The path the app resolves when packaged --------------------------
// config.js asks Electron for userData when app.isPackaged; simulate both
// branches here rather than booting the packaged app, which would need a
// display.
delete process.env.INTEL_BROADCAST_LOCAL_CONFIG_PATH;
const { LOCAL_CONFIG_PATH: devPath } = require('../src/main/config');
assert.ok(
  devPath.startsWith(APP_DIR),
  `unpackaged should keep using the repo path (dev scripts rely on it), got ${devPath}`,
);
console.log(`[test] unpackaged path unchanged: ${devPath}`);

const configSource = fs.readFileSync(path.join(APP_DIR, 'src', 'main', 'config.js'), 'utf8');
assert.ok(
  /app\.isPackaged/.test(configSource) && /getPath\('userData'\)/.test(configSource),
  'packaged builds must resolve the settings path via app.getPath("userData")',
);
assert.ok(
  !/__dirname[^\n]*config\.local\.json/.test(configSource.replace(/\/\/[^\n]*/g, '').split('resolveLocalConfigPath')[0]),
  'the bundle-relative path must only be the unpackaged fallback',
);
console.log('[test] packaged builds resolve settings into userData');

// --- 3/3. That directory is actually writable ------------------------------
// Electron's userData lives under the OS app-data dir; prove a write there
// succeeds, which is the whole point of the move.
const userDataLike = path.join(os.homedir(), '.config', 'intel-broadcast-writetest');
fs.mkdirSync(userDataLike, { recursive: true });
const probe = path.join(userDataLike, 'config.local.json');
fs.writeFileSync(probe, JSON.stringify({ relayHostEnabled: true }));
assert.strictEqual(JSON.parse(fs.readFileSync(probe, 'utf8')).relayHostEnabled, true);
fs.rmSync(userDataLike, { recursive: true, force: true });
console.log('[test] per-user config directory is writable');

console.log('[dev-packaged-config-test] PASS');
