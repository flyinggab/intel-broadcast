'use strict';

// Unit test for tailscale.js — parsing/composition logic against canned CLI
// output, plus a full getState()/startFunnel()/stopFunnel() cycle driven
// against the stub binary (scripts/fixtures/fake-tailscale). Pure Node.
//
// Usage: node scripts/dev-tailscale-parse-test.js

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const STUB_BIN = path.join(__dirname, 'fixtures', 'fake-tailscale');
const STATE_PATH = path.join(os.tmpdir(), `fake-tailscale-state-${process.pid}.json`);
process.env.INTEL_BROADCAST_TAILSCALE_BIN = STUB_BIN;
process.env.FAKE_TAILSCALE_STATE_PATH = STATE_PATH;

const ts = require('../src/main/tailscale');

async function main() {
  // --- parseStatus ----------------------------------------------------------
  const st = ts.parseStatus(JSON.stringify({ BackendState: 'Running', Self: { DNSName: 'gm-pc.tail1234.ts.net.' } }));
  assert.deepStrictEqual(st, { backendState: 'Running', dnsName: 'gm-pc.tail1234.ts.net' }, 'trailing dot stripped');
  assert.strictEqual(ts.parseStatus('{"BackendState":"NeedsLogin"}').dnsName, null);
  console.log('[test] parseStatus OK');

  // --- parseFunnelStatus ----------------------------------------------------
  const on = ts.parseFunnelStatus(
    JSON.stringify({
      AllowFunnel: { 'gm-pc.tail1234.ts.net:443': true },
      Web: { 'gm-pc.tail1234.ts.net:443': { Handlers: { '/': { Proxy: 'http://127.0.0.1:8787' } } } },
    }),
  );
  assert.deepStrictEqual(on, { funnelOn: true, funnelTarget: 'http://127.0.0.1:8787' });
  assert.strictEqual(ts.parseFunnelStatus('{}').funnelOn, false);
  assert.strictEqual(ts.parseFunnelStatus('No serve config').funnelOn, false, 'non-JSON output tolerated');
  console.log('[test] parseFunnelStatus OK');

  // --- extractUrl / deriveWssUrl -------------------------------------------
  assert.strictEqual(
    ts.extractUrl('Funnel not available. To enable, visit:\n\thttps://login.tailscale.com/f/funnel?node=abc\n'),
    'https://login.tailscale.com/f/funnel?node=abc',
  );
  assert.strictEqual(ts.extractUrl('no url here'), null);
  assert.strictEqual(ts.deriveWssUrl('gm-pc.tail1234.ts.net'), 'wss://gm-pc.tail1234.ts.net');
  console.log('[test] URL helpers OK');

  // --- findBinary env override ---------------------------------------------
  assert.strictEqual(ts.findBinary(), STUB_BIN, 'env override honored');
  console.log('[test] findBinary override OK');

  // --- full cycle against the stub -----------------------------------------
  fs.writeFileSync(
    STATE_PATH,
    JSON.stringify({ backendState: 'Running', dnsName: 'fake-host.tail1234.ts.net.', funnelOn: false, funnelAllowed: false }),
  );
  let state = await ts.getState();
  assert.strictEqual(state.installed, true);
  assert.strictEqual(state.loggedIn, true);
  assert.strictEqual(state.wssUrl, 'wss://fake-host.tail1234.ts.net');
  assert.strictEqual(state.funnelOn, false);

  // Funnel blocked -> enableUrl captured from the CLI error.
  const blocked = await ts.startFunnel(8787);
  assert.strictEqual(blocked.ok, false);
  assert.strictEqual(blocked.enableUrl, 'https://login.tailscale.com/f/funnel?node=fake-node-id');

  // Admin "enables" funnel -> start succeeds -> state reflects it.
  const stubState = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
  stubState.funnelAllowed = true;
  fs.writeFileSync(STATE_PATH, JSON.stringify(stubState));
  const started = await ts.startFunnel(8787);
  assert.strictEqual(started.ok, true);
  state = await ts.getState();
  assert.strictEqual(state.funnelOn, true);
  assert.strictEqual(state.funnelTarget, 'http://127.0.0.1:8787');

  // Stop -> off again.
  await ts.stopFunnel();
  state = await ts.getState();
  assert.strictEqual(state.funnelOn, false);
  console.log('[test] stub full cycle OK');

  // login() reports the auth URL.
  let authUrl = null;
  await ts.login({ onAuthUrl: (u) => (authUrl = u) });
  assert.strictEqual(authUrl, 'https://login.tailscale.com/a/fake-auth-123');
  console.log('[test] login auth-url capture OK');

  console.log('[dev-tailscale-parse-test] PASS');
}

main()
  .catch((err) => {
    console.error(`FAIL: ${err.message}`);
    process.exitCode = 1;
  })
  .finally(() => fs.rmSync(STATE_PATH, { force: true }));
