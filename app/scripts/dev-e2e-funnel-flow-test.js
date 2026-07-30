'use strict';

// Funnel-lifecycle e2e against the stub tailscale binary
// (scripts/fixtures/fake-tailscale via INTEL_BROADCAST_TAILSCALE_BIN):
//
// Scenario 1 — the host's happy-path walk, with the one-time admin hurdle:
//   boot a host with funnelEnabled -> funnel start is BLOCKED (node attribute
//   not set) -> settings DOM shows "needs enabling" -> admin "approves" (test
//   flips the stub state) -> app retries automatically -> DOM shows the
//   public wss:// URL -> app is terminated -> the app must have run
//   `funnel --https=443 off` on the way out (session-only funnel lifetime).
//
// Scenario 2 — startup reconcile: a leftover --bg funnel from a crash is
//   turned OFF at boot when config doesn't want it.
//
// Usage: node scripts/dev-e2e-funnel-flow-test.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const STUB_BIN = path.join(APP_DIR, 'scripts', 'fixtures', 'fake-tailscale');
const CONFIG_PATH = path.join(APP_DIR, 'funnel-e2e-config.local.json');
const STATE_PATH = path.join(APP_DIR, 'funnel-e2e-tailscale-state.json');
const LOG_PATH = path.join(APP_DIR, 'funnel-e2e-tailscale-log.txt');

const RELAY_PORT = require('./dev-ports').funnelFlow;
const WSS_URL = 'wss://fake-host.tail1234.ts.net';

function baseEnv() {
  return {
    ...process.env,
    INTEL_BROADCAST_LOCAL_CONFIG_PATH: CONFIG_PATH,
    INTEL_BROADCAST_TAILSCALE_BIN: STUB_BIN,
    INTEL_BROADCAST_FUNNEL_RETRY_MS: '1500',
    FAKE_TAILSCALE_STATE_PATH: STATE_PATH,
    FAKE_TAILSCALE_LOG_PATH: LOG_PATH,
  };
}

function cleanupFiles() {
  fs.rmSync(CONFIG_PATH, { force: true });
  fs.rmSync(STATE_PATH, { force: true });
  fs.rmSync(LOG_PATH, { force: true });
}

function offInvocations() {
  try {
    return fs
      .readFileSync(LOG_PATH, 'utf8')
      .split('\n')
      .filter((l) => l.trim() === 'funnel --https=443 off').length;
  } catch {
    return 0;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await sleep(300);
  }
  throw new Error(`timed out waiting for: ${desc}`);
}

async function scenario1() {
  cleanupFiles();
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      relayHostEnabled: true,
      token: 'funnel-e2e',
      gm: { relayPort: RELAY_PORT, funnelEnabled: true },
    }),
  );
  // Logged in, funnel not yet permitted by the tailnet admin.
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ backendState: 'Running', dnsName: 'fake-host.tail1234.ts.net.', funnelOn: false, funnelAllowed: false }),
  );

  let output = '';
  const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
    cwd: APP_DIR,
    detached: true, // process GROUP, so killTree reaches the real binary
    env: { ...baseEnv(), INTEL_BROADCAST_OPEN_SETTINGS: '1', INTEL_BROADCAST_SETTINGS_PROBE: '1' },
  });
  child.stdout.on('data', (d) => {
    output += d.toString();
    process.stdout.write(`[app] ${d}`);
  });
  child.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

  try {
    await waitFor(
      'the funnel step to report it needs enabling',
      () => output.includes('SETTINGS_PROBE') && output.includes('NEEDS ENABLING IN ADMIN'),
      15000,
    );
    console.log('[e2e] blocked state surfaced in the DOM — "approving" funnel in the fake admin console');

    const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    state.funnelAllowed = true;
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));

    await waitFor(
      'the automatic retry to bring the funnel up',
      () => /"funnel":\{"state":"done"/.test(output),
      15000,
    );
    console.log('[e2e] funnel live, wss URL rendered — terminating the app');

    const offsBefore = offInvocations();
    // Graceful shutdown must go to the DIRECT child: the electron shim
    // forwards SIGTERM to the real binary, which then runs its normal quit
    // path (will-quit -> stopFunnelSync). Signalling the whole group instead
    // tears the shim down alongside Electron and the cleanup never finishes.
    child.kill('SIGTERM');
    await waitFor('the quit path to run `funnel --https=443 off`', () => offInvocations() > offsBefore, 8000);
    console.log('[e2e] scenario 1 OK (blocked -> enabled -> live -> off on quit)');
  } finally {
    killApp(child);
  }
}

async function scenario2() {
  cleanupFiles();
  // Hosting, but funnel sharing NOT wanted — yet a stale --bg funnel is still
  // up (crash last session). Startup reconcile must turn it off.
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      relayHostEnabled: true,
      token: 'funnel-e2e',
      gm: { relayPort: RELAY_PORT, funnelEnabled: false },
    }),
  );
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({
      backendState: 'Running',
      dnsName: 'fake-host.tail1234.ts.net.',
      funnelOn: true,
      funnelPort: RELAY_PORT,
      funnelAllowed: true,
    }),
  );

  const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
    cwd: APP_DIR,
    detached: true, // process GROUP, so killApp reaches the real binary
    env: baseEnv(),
  });
  child.stdout.on('data', (d) => process.stdout.write(`[app2] ${d}`));
  child.stderr.on('data', (d) => process.stderr.write(`[app2] ${d}`));

  try {
    await waitFor(
      'startup reconcile to stop the leftover funnel',
      () => {
        try {
          return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')).funnelOn === false && offInvocations() > 0;
        } catch {
          return false;
        }
      },
      15000,
    );
    console.log('[e2e] scenario 2 OK (leftover funnel reconciled off at startup)');
  } finally {
    killApp(child);
  }
}

function stubInvocations(pattern) {
  try {
    return fs
      .readFileSync(LOG_PATH, 'utf8')
      .split('\n')
      .filter((l) => l.trim().startsWith(pattern)).length;
  } catch {
    return 0;
  }
}

// Scenario 3 — a broken status READBACK must read as "unknown", never "off":
// with the funnel up and wanted, the status command starts failing. The app
// must not flap (no new `funnel --bg`, no `off`), must say in the panel that
// the state can't be read, and must return to "Shared" once readback
// recovers — still without ever having restarted the funnel. This pins the
// fix for the on/off flapping seen on the first real Windows run.
async function scenario3() {
  cleanupFiles();
  fs.writeFileSync(
    CONFIG_PATH,
    JSON.stringify({
      relayHostEnabled: true,
      token: 'funnel-e2e',
      gm: { relayPort: RELAY_PORT, funnelEnabled: true },
    }),
  );
  // Funnel already up and wanted — steady state.
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({
      backendState: 'Running',
      dnsName: 'fake-host.tail1234.ts.net.',
      funnelOn: true,
      funnelPort: RELAY_PORT,
      funnelAllowed: true,
    }),
  );

  let output = '';
  const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
    cwd: APP_DIR,
    detached: true, // process GROUP, so killApp reaches the real binary
    env: { ...baseEnv(), INTEL_BROADCAST_OPEN_SETTINGS: '1', INTEL_BROADCAST_SETTINGS_PROBE: '1' },
  });
  child.stdout.on('data', (d) => {
    output += d.toString();
    process.stdout.write(`[app3] ${d}`);
  });
  child.stderr.on('data', (d) => process.stderr.write(`[app3] ${d}`));

  try {
    await waitFor('steady state: shared, no start needed', () => /"funnel":\{"state":"done"/.test(output), 15000);
    const startsBefore = stubInvocations('funnel --bg');
    const offsBefore = stubInvocations('funnel --https=443 off');

    let state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    state.funnelStatusFail = true;
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));

    await waitFor(
      "the panel to say the state can't be read",
      () => output.includes('FAILED · SEE LOG'),
      15000,
    );
    await sleep(4000); // several poll ticks worth of opportunity to misbehave
    if (stubInvocations('funnel --bg') !== startsBefore) throw new Error('app re-ran `funnel --bg` on an unreadable status');
    if (stubInvocations('funnel --https=443 off') !== offsBefore) throw new Error('app ran `funnel off` on an unreadable status');
    console.log('[e2e] unreadable status: no flapping, clearly reported');

    state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    state.funnelStatusFail = false;
    fs.writeFileSync(STATE_PATH, JSON.stringify(state));
    await waitFor(
      'the panel to recover to Shared',
      () => {
        const lines = output.split('\n').filter((l) => l.includes('SETTINGS_PROBE'));
        return lines.length > 0 && /"funnel":\{"state":"done"/.test(lines[lines.length - 1]);
      },
      15000,
    );
    if (stubInvocations('funnel --bg') !== startsBefore) throw new Error('recovery should not have restarted the funnel');
    console.log('[e2e] scenario 3 OK (unknown != off; no restarts across a readback outage)');
  } finally {
    killApp(child);
  }
}

(async () => {
  try {
    await scenario1();
    await scenario2();
    await scenario3();
    console.log('[dev-e2e-funnel-flow-test] PASS');
    cleanupFiles();
    setTimeout(() => process.exit(0), 300);
  } catch (err) {
    console.error(`[e2e] FAIL: ${err.message}`);
    cleanupFiles();
    setTimeout(() => process.exit(1), 300);
  }
})();
