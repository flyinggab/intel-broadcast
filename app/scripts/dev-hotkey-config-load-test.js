'use strict';

// Isolates "does a saved config.local.json's custom hotkeys actually get
// registered at startup" from the live-apply path — writes config.local.json
// directly (bypassing the settings UI entirely) with hotkey values
// deliberately different from the defaults, starts a fresh host instance, and
// checks the registration log lines show the CUSTOM values being registered,
// not the defaults.
//
// Usage: node scripts/dev-hotkey-config-load-test.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');
const { LOCAL_CONFIG_PATH } = require('../src/main/config');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');

const CUSTOM_HOTKEYS = {
  reveal: 'Ctrl+Shift+U', // deliberately different from the default Ctrl+Shift+I
  next: 'Ctrl+Shift+K',
  prev: 'Ctrl+Shift+J',
};

fs.rmSync(LOCAL_CONFIG_PATH, { force: true });
fs.writeFileSync(
  LOCAL_CONFIG_PATH,
  JSON.stringify({ relayHostEnabled: true, hotkeys: CUSTOM_HOTKEYS, gm: { relayPort: require('./dev-ports').hotkeyConfigLoad } }, null, 2),
);

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
  detached: true, // process GROUP, so killApp reaches the real binary
});

let output = '';
child.stdout.on('data', (d) => {
  output += d.toString();
  process.stdout.write(`[electron] ${d}`);
});
child.stderr.on('data', (d) => process.stderr.write(`[electron] ${d}`));

function finish(exitCode) {
  fs.rmSync(LOCAL_CONFIG_PATH, { force: true });
  killApp(child);
  setTimeout(() => process.exit(exitCode), 200);
}

setTimeout(() => {
  const checks = [
    [`register reveal "${CUSTOM_HOTKEYS.reveal}": OK`, 'reveal'],
    [`register next "${CUSTOM_HOTKEYS.next}": OK`, 'next'],
    [`register prev "${CUSTOM_HOTKEYS.prev}": OK`, 'prev'],
  ];
  const usedDefaultInstead = /register (reveal|next|prev) "Ctrl\+Shift\+[ILR][a-z]*"/i.test(output) &&
    !output.includes('Ctrl+Shift+U') && !output.includes('Ctrl+Shift+K');

  let allOk = true;
  for (const [needle, name] of checks) {
    const found = output.includes(needle);
    console.log(`[test] ${name}: ${found ? 'PASS' : 'FAIL — not found in output'}`);
    if (!found) allOk = false;
  }

  if (allOk) {
    console.log('[e2e] PASS: fresh process correctly registered the custom hotkeys from config.local.json');
    finish(0);
  } else {
    console.error('[e2e] FAIL: fresh process did not register the expected custom hotkey values');
    console.error('--- full output ---');
    console.error(output);
    finish(1);
  }
}, 3000);
