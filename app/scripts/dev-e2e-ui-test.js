'use strict';

// End-to-end against the NEW viewer UI, driven through its real DOM.
// Replaces dev-e2e-panel-test.js (the side panel this UI removed).
//
// Covers the parts of BRIEF §6 that can be checked without eyes on a screen:
//   - photos reach the renderer as intel:// URLs, never base64 data URLs (§9.1)
//   - the auto-switch rule and its mandatory banner
//   - HIDE CHROME leaves the photo and nothing else (§6.1)
//   - tabs switch pages, and SETUP does NOT (§6.2)
//   - share tiles drive what actually goes on the wire
//   - the received list reflects arrivals and re-opening an older batch
//
// Usage: node scripts/dev-e2e-ui-test.js

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');
const { RelayClient } = require('../src/main/relayClient');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const CONFIG_PATH = path.join(APP_DIR, 'ui-e2e-config.local.json');
const EVAL_PATH = path.join(APP_DIR, 'ui-e2e-eval.js');

const RELAY_PORT = require('./dev-ports').uiE2E;
const TOKEN = 'ui-e2e-secret';

fs.rmSync(EVAL_PATH, { force: true });
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({
    relayHostEnabled: true,
    token: TOKEN,
    callsign: 'GHOSTRIDER 1-1',
    missionName: 'roman-sead-joker1',
    autoShow: true,
    gm: { relayPort: RELAY_PORT, funnelEnabled: false },
  }),
);

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
  detached: true,
  env: {
    ...process.env,
    INTEL_BROADCAST_LOCAL_CONFIG_PATH: CONFIG_PATH,
    INTEL_BROADCAST_VIEWER_PANEL_PROBE: '1',
    INTEL_BROADCAST_VIEWER_EVAL_PATH: EVAL_PATH,
  },
});

let probe = null;
let output = '';
child.stdout.on('data', (d) => {
  const text = d.toString();
  output += text;
  process.stdout.write(`[app] ${text}`);
  for (const line of text.split('\n')) {
    const at = line.indexOf('PANEL_PROBE ');
    if (at === -1) continue;
    try {
      probe = JSON.parse(line.slice(at + 'PANEL_PROBE '.length));
    } catch {
      // chunk boundary; next tick covers it
    }
  }
});
child.stderr.on('data', (d) => process.stderr.write(`[app] ${d}`));

const clients = [];
function cleanup(code) {
  fs.rmSync(CONFIG_PATH, { force: true });
  fs.rmSync(EVAL_PATH, { force: true });
  for (const c of clients) c.close();
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

async function runInViewer(js) {
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

const click = (selector) => runInViewer(`document.querySelector(${JSON.stringify(selector)}).click()`);

function connectClient(callsign) {
  const client = new RelayClient({ url: `ws://localhost:${RELAY_PORT}`, token: TOKEN, role: 'viewer', callsign });
  clients.push(client);
  return new Promise((resolve) => {
    client.once('connected', () => resolve(client));
    client.connect();
  });
}

const photo = (name, fill) => ({ filename: name, mimeType: 'image/jpeg', buffer: Buffer.alloc(2048, fill) });

async function main() {
  await waitFor('the viewer to render', () => probe !== null);

  // --- the share gallery is populated from the bundled fixture folder -------
  await waitFor('the gallery to list the fixture folder', () => probe.tiles.length === 2);
  if (!probe.tiles.every((t) => t.selected)) throw new Error('photos should start selected');
  // §9.1: the renderer must hold URLs, never base64. The probe reports whether
  // each thumbnail src is an intel:// URL.
  if (!probe.tiles.every((t) => t.hasThumb)) {
    throw new Error(`thumbnails must be intel:// URLs, got ${JSON.stringify(probe.tiles)}`);
  }
  console.log('[e2e] gallery lists the folder, thumbnails served over intel://');

  // --- arrival switches the page AND says so --------------------------------
  const alpha = await connectClient('JOKER 2-1');
  await sleep(400);
  alpha.sendRevealBatch([photo('a.jpg', 1), photo('b.jpg', 2), photo('c.jpg', 3)]);

  await waitFor('the arrival to take the stage', () => probe.page === 'frame');
  if (!probe.banner || !probe.banner.includes('JOKER 2-1')) {
    throw new Error(`a page that moves on its own must say why, got banner: ${probe.banner}`);
  }
  if (!probe.stageSrc.startsWith('intel://blob/')) {
    throw new Error(`the photo must be an intel:// blob URL, got "${probe.stageSrc}"`);
  }
  console.log('[e2e] arrival switched to FRAME, banner announced it, photo is an intel:// blob');

  // --- HIDE CHROME leaves the photo and nothing else ------------------------
  await click('#key-hide');
  await waitFor('chrome hidden', () => probe.chromeHidden === true);
  const chromeVisible = await new Promise((resolve) => {
    fs.writeFileSync(
      EVAL_PATH,
      `console.log('CHROME_PROBE ' + JSON.stringify({
         topbar: !!document.querySelector('.topbar').offsetParent,
         tabbar: !!document.querySelector('.tabbar').offsetParent,
         stageChrome: !!document.querySelector('.stage__chrome').offsetParent,
         img: !!document.getElementById('stage-img').offsetParent,
       }))`,
    );
    const watch = setInterval(() => {
      const m = /CHROME_PROBE (\{.*\})/.exec(output);
      if (m) {
        clearInterval(watch);
        resolve(JSON.parse(m[1]));
      }
    }, 200);
    setTimeout(() => {
      clearInterval(watch);
      resolve(null);
    }, 8000);
  });
  if (!chromeVisible) throw new Error('chrome probe never reported');
  if (chromeVisible.topbar || chromeVisible.tabbar || chromeVisible.stageChrome) {
    throw new Error(`HIDE CHROME must blank all chrome, got ${JSON.stringify(chromeVisible)}`);
  }
  if (!chromeVisible.img) throw new Error('the photo must remain visible with chrome hidden');
  console.log('[e2e] HIDE CHROME shows the photo and nothing else');
  await click('#key-hide');
  await waitFor('chrome back', () => probe.chromeHidden === false);

  // --- tabs switch pages; SETUP does not ------------------------------------
  await click('.tab[data-tab="received"]');
  await waitFor('RECEIVED page', () => probe.page === 'received');
  if (probe.rows.length !== 1) throw new Error(`expected 1 received row, got ${probe.rows.length}`);
  if (!probe.rows[0].who.includes('JOKER 2-1')) throw new Error(`row shows "${probe.rows[0].who}"`);
  if (!/3 PHOTOS · \d{4}Z/.test(probe.rows[0].meta)) throw new Error(`row meta: "${probe.rows[0].meta}"`);
  console.log('[e2e] RECEIVED lists the batch with callsign, count and Zulu time');

  const pageBeforeSetup = probe.page;
  await click('#tab-setup');
  await sleep(800);
  if (probe.page !== pageBeforeSetup) {
    throw new Error(`opening SETUP must not change what the viewer displays (went to ${probe.page})`);
  }
  if (!/\[settingsWindow\] window/.test(output)) throw new Error('SETUP should have opened the settings window');
  console.log('[e2e] SETUP opens the settings window without changing the viewer page');

  // --- a second arrival while reading is badged, not switched (rule C) ------
  const bravo = await connectClient('UZI 1-1');
  await sleep(300);
  await click('.tab[data-tab="share"]'); // deliberate interaction, starts the grace window
  await waitFor('SHARE page', () => probe.page === 'share');
  bravo.sendRevealBatch([photo('d.jpg', 4)]);
  await waitFor('the badge to count the suppressed arrival', () => probe.badge === 1, 10000);
  if (probe.page !== 'share') throw new Error('a recent interaction must stop the page moving');
  console.log('[e2e] rule C: arrival during interaction is badged, page held still');

  // --- re-opening an older batch --------------------------------------------
  await click('.tab[data-tab="received"]');
  await waitFor('two rows', () => probe.rows.length === 2);
  await click('.row[data-batch-id]:last-child'); // the older one
  await waitFor('the older batch on the stage', () => probe.page === 'frame');
  if (probe.badge !== 1) throw new Error('opening the OLD batch must not clear the NEW one’s badge');
  console.log('[e2e] re-opening an older batch works and leaves the new one badged');

  // --- share selection decides what goes on the wire ------------------------
  await click('.tab[data-tab="share"]');
  await waitFor('share page', () => probe.page === 'share');
  await click('#share-none');
  await waitFor('nothing selected', () => probe.tiles.every((t) => !t.selected));
  if (!/NOTHING SELECTED/.test(probe.revealBtn)) throw new Error(`button label: "${probe.revealBtn}"`);
  await click('.tile[data-filename]:last-child');
  await waitFor('one selected', () => probe.tiles.filter((t) => t.selected).length === 1);
  const picked = probe.tiles.find((t) => t.selected).filename;

  const received = new Promise((resolve) => alpha.once('reveal-batch', resolve));
  await click('#share-reveal');
  const batch = await received;
  const names = batch.items.map((i) => i.filename);
  if (names.length !== 1) throw new Error(`expected only the selected photo, got ${JSON.stringify(names)}`);
  if (batch.sharedBy !== 'GHOSTRIDER 1-1') throw new Error(`attribution: "${batch.sharedBy}"`);
  // imagePrep runs on the sender: the shipped bytes should be smaller than the
  // ~300-460KB originals in the fixture folder.
  const bytes = batch.items[0].buffer.length;
  if (bytes >= 300 * 1024) throw new Error(`sender-side compression did not run: ${bytes} bytes`);
  console.log(`[e2e] shared only "${picked}", compressed to ${(bytes / 1024).toFixed(0)}KB on the way out`);

  console.log('[dev-e2e-ui-test] PASS');
  cleanup(0);
}

main().catch((err) => {
  console.error(`[e2e] FAIL: ${err.message}`);
  cleanup(1);
});

setTimeout(() => {
  console.error('[e2e] FAIL: overall timeout');
  cleanup(1);
}, 150000);
