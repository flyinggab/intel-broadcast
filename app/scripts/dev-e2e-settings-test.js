'use strict';

// End-to-end against the NEW settings window, driven through its real DOM.
// Replaces the old settings / hotkey-record / live-apply / clients-list tests,
// which all drove markup this UI removed.
//
// Covers the BRIEF §6 checks that live in this window:
//   §6.3 NET can never show a host toggle and a relay field at once
//   §6.4 a truncated squad code disables CONNECT instead of throwing
//   §6.9 the squad code appears in no log line
//   plus: the host's code renders and decodes back to this relay, hotkey
//   recording writes through to config, and saves still apply live.
//
// Usage: node scripts/dev-e2e-settings-test.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');
const { decodeSquadCode } = require('../src/main/squadCode');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const CONFIG_PATH = path.join(APP_DIR, 'settings-e2e-config.local.json');
const EVAL_PATH = path.join(APP_DIR, 'settings-e2e-eval.js');
const CODE_MARKER_PATH = path.join(APP_DIR, 'settings-e2e-code.txt');

const RELAY_PORT = require('./dev-ports').settingsE2E;
const TOKEN = 'settings-e2e-token-long-enough';

fs.rmSync(EVAL_PATH, { force: true });
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({
    relayHostEnabled: true,
    token: TOKEN,
    callsign: 'GHOSTRIDER 1-1',
    missionName: 'roman-sead-joker1',
    gm: { relayPort: RELAY_PORT, funnelEnabled: false },
  }),
);

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
  detached: true,
  env: {
    ...process.env,
    INTEL_BROADCAST_LOCAL_CONFIG_PATH: CONFIG_PATH,
    INTEL_BROADCAST_OPEN_SETTINGS: '1',
    INTEL_BROADCAST_SETTINGS_PROBE: '1',
    INTEL_BROADCAST_SETTINGS_EVAL_PATH: EVAL_PATH,
    INTEL_BROADCAST_SQUAD_CODE_MARKER_PATH: CODE_MARKER_PATH,
  },
});

let probe = null;
let output = '';
child.stdout.on('data', (d) => {
  const text = d.toString();
  output += text;
  process.stdout.write(`[app] ${text}`);
  for (const line of text.split('\n')) {
    const at = line.indexOf('SETTINGS_PROBE ');
    if (at === -1) continue;
    try {
      probe = JSON.parse(line.slice(at + 'SETTINGS_PROBE '.length));
    } catch {
      // chunk boundary
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

function cleanup(code) {
  fs.rmSync(CONFIG_PATH, { force: true });
  fs.rmSync(EVAL_PATH, { force: true });
  fs.rmSync(CODE_MARKER_PATH, { force: true });
  killApp(child);
  setTimeout(() => process.exit(code), 300);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe && predicate()) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${desc}\n  probe: ${JSON.stringify(probe)}`);
}

async function runInSettings(js) {
  // Wrapped in its own scope: every eval shares one global, so a repeated
  // `const` declaration would throw on the second call.
  fs.writeFileSync(EVAL_PATH, `(() => { ${js} })()`);
  const deadline = Date.now() + 10000;
  while (fs.existsSync(EVAL_PATH)) {
    if (Date.now() > deadline) throw new Error(`renderer never picked up: ${js.slice(0, 50)}`);
    await sleep(100);
  }
  await sleep(600);
}
const click = (sel) => runInSettings(`document.querySelector(${JSON.stringify(sel)}).click()`);

function readConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
}

async function main() {
  await waitFor('the settings window to render', () => probe !== null);

  // --- §6.3 host and join are mutually exclusive, in every state ------------
  await click('.subtab[data-tab="net"]');
  await waitFor('NET page', () => probe.page === 'net');
  if (probe.mode !== 'host') throw new Error(`should start in host mode, got ${probe.mode}`);
  if (probe.hostVisible && probe.joinVisible) throw new Error('host and join blocks must never both show');
  if (!probe.hostVisible) throw new Error('host block should be visible in host mode');

  await click('[data-set-mode="join"]');
  await waitFor('join mode', () => probe.mode === 'join');
  if (probe.hostVisible && probe.joinVisible) throw new Error('host and join blocks must never both show');
  if (!probe.joinVisible) throw new Error('join block should be visible in join mode');
  console.log('[e2e] §6.3 NET is exclusive — no contradictory state reachable');

  // --- §6.4 a truncated code disables CONNECT, and does not throw ----------
  await runInSettings(
    `const i = document.getElementById('in-code');
     i.value = 'IB1-Z2FiLXBjLnRhaWw5';
     i.dispatchEvent(new Event('input'));`,
  );
  await waitFor('CONNECT disabled for a bad code', () => probe.connectDisabled === true);
  if (probe.joinHost !== '—') throw new Error(`a bad code must populate nothing, got "${probe.joinHost}"`);
  if (/Uncaught|TypeError/.test(output)) throw new Error('a bad code must not throw into the console');
  console.log('[e2e] §6.4 truncated code: nothing populated, CONNECT disabled, nothing thrown');

  // --- a valid code enables CONNECT and resolves --------------------------
  const validCode = `IB1-${Buffer.from('gab-pc.tail9f2b.ts.net:8140:kd93').toString('base64url').replace(/=+$/, '')}`;
  await runInSettings(
    `const i = document.getElementById('in-code');
     i.value = ${JSON.stringify(validCode)};
     i.dispatchEvent(new Event('input'));`,
  );
  await waitFor('CONNECT enabled for a good code', () => probe.connectDisabled === false);
  if (!probe.joinHost.includes('GAB-PC')) throw new Error(`resolved host cell: "${probe.joinHost}"`);
  console.log('[e2e] a valid code resolves and enables CONNECT');

  // --- the host's own code round-trips back to this relay ------------------
  await click('[data-set-mode="host"]');
  await waitFor('back in host mode', () => probe.mode === 'host');
  if (probe.squadCodePrefix !== 'IB1-') throw new Error(`host code prefix: "${probe.squadCodePrefix}"`);
  if (probe.squadCodeLength < 20) throw new Error('host code looks truncated');
  // The code reaches this test through a file, never through stdout.
  const hostCode = fs.readFileSync(CODE_MARKER_PATH, 'utf8').trim();
  const decoded = decodeSquadCode(hostCode);
  if (decoded.port !== RELAY_PORT) throw new Error(`code points at port ${decoded.port}, expected ${RELAY_PORT}`);
  if (decoded.token !== TOKEN) throw new Error('code must carry this relay’s token');
  console.log(`[e2e] the host's code decodes back to ${decoded.host}:${decoded.port}`);

  // --- §6.9 the code (a password) reaches no log line ----------------------
  const logPath = path.join(require('os').homedir(), '.config', 'intel-broadcast', 'intel-broadcast.log');
  // The log file persists across runs, so only THIS session's slice is ours to
  // judge — everything after the last "session started" marker.
  const wholeLog = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8') : '';
  const sessionAt = wholeLog.lastIndexOf('session started');
  const logText = sessionAt === -1 ? wholeLog : wholeLog.slice(sessionAt);
  for (const [name, haystack] of [['stdout', output], ['log file', logText]]) {
    if (haystack.includes(hostCode)) throw new Error(`the squad code leaked into ${name}`);
    if (haystack.includes(TOKEN)) throw new Error(`the raw token leaked into ${name}`);
  }
  // The masked form is what may be displayed.
  if (!/•|\*/.test(probe.tokenMasked) && probe.tokenMasked.includes(TOKEN)) {
    throw new Error('the token must be masked in the UI');
  }
  console.log('[e2e] §6.9 neither the squad code nor the token appears in stdout or the log file');

  // --- hotkey recording writes through to config ---------------------------
  await click('.subtab[data-tab="keys"]');
  await waitFor('KEYS page', () => probe.page === 'keys');
  await click('[data-record="hide"]');
  await waitFor('recording state shown', () => probe.recording === true);
  await runInSettings(
    `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'j', ctrlKey: true, altKey: true, bubbles: true }))`,
  );
  await sleep(1200);
  const saved = readConfig();
  if (saved.hotkeys.hide !== 'Ctrl+Alt+J') {
    throw new Error(`recorded hotkey not persisted, config has "${saved.hotkeys.hide}"`);
  }
  if (!/register hide "Ctrl\+Alt\+J"/.test(output)) {
    throw new Error('a recorded hotkey must re-register live, without a restart');
  }
  console.log('[e2e] recording HIDE CHROME persisted and re-registered live');

  // --- the window stays open after all that (live apply, no relaunch) ------
  if (child.exitCode !== null) throw new Error('the app must not restart to apply settings');
  await sleep(600);
  if (!probe) throw new Error('the settings window should still be rendering');
  console.log('[e2e] settings applied live; window stayed open, app never restarted');

  console.log('[dev-e2e-settings-test] PASS');
  cleanup(0);
}

main().catch((err) => {
  console.error(`[e2e] FAIL: ${err.message}`);
  cleanup(1);
});

setTimeout(() => {
  console.error('[e2e] FAIL: overall timeout');
  cleanup(1);
}, 120000);
