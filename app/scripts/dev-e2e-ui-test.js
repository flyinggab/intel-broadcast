'use strict';

// End-to-end against the v0.4 viewer UI, driven through its real DOM.
//
// Covers what can be checked without eyes on a screen:
//   - photos reach the renderer as intel:// URLs, never base64 data URLs (§9.1)
//   - an idle arrival takes the BRIEF stage at 1/N and the banner says so
//   - HIDE CHROME leaves the photo and nothing else
//   - tabs switch pages, and SETUP does NOT
//   - rule C: an arrival during interaction queues with a QUEUED banner and
//     the page holds still — there is no badge any more
//   - RECEIVED curation: deselecting a tile shrinks the brief's queue without
//     moving the stage; HIDE/RESTORE empties and refills it
//   - share tiles drive what actually goes on the wire
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
    INTEL_BROADCAST_CHROME_IDLE_MS: '1500',
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

// The tab bar is gone: navigation is the launcher. Open it from the strip,
// then pick a destination. Two clicks, exactly as a pilot does it.
async function goTo(dest) {
  if (!probe.launcherOpen) await click('#menukey');
  await waitFor('the launcher to open', () => probe.launcherOpen === true);
  await click(`.dest[data-dest="${dest}"]`);
}

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
  // The shipped markup boots empty: STANDBY until intel arrives.
  if (!probe.standby) throw new Error('an empty queue must show STANDBY');
  console.log('[e2e] gallery lists the folder, thumbnails served over intel://, stage is STANDBY');

  // --- arrival takes the BRIEF stage at 1/N AND says so ---------------------
  const alpha = await connectClient('JOKER 2-1');
  await sleep(400);
  alpha.sendRevealBatch([photo('a.jpg', 1), photo('b.jpg', 2), photo('c.jpg', 3)]);

  await waitFor('the arrival to take the stage', () => probe.stageSrc.startsWith('intel://blob/'));
  if (probe.page !== 'brief') throw new Error(`expected BRIEF to hold the photo, page=${probe.page}`);
  if (probe.standby) throw new Error('STANDBY must clear when intel lands');
  if (probe.pos !== '1 / 3') throw new Error(`arrival should land at 1 / 3, got "${probe.pos}"`);
  if (!probe.banner || !probe.banner.includes('JOKER 2-1')) {
    throw new Error(`a page that moves on its own must say why, got banner: ${probe.banner}`);
  }
  if (!/SWITCHED AUTOMATICALLY/.test(probe.bannerMeta || '')) {
    throw new Error(`switched banner must say so, got "${probe.bannerMeta}"`);
  }
  console.log('[e2e] arrival took the BRIEF stage at 1/3, banner announced the switch');

  // --- HIDE CHROME leaves the photo and nothing else ------------------------
  // Hotkey-only in the UI now; the intent channel stands in for the hotkey.
  // The chrome hides itself once you stop touching the app — no binding to
  // remember, and it is the state the kneeboard capture wants.
  // Arm the idle timer explicitly. Main only schedules the hide in response to
  // activity, and the first activity normally comes from the window gaining
  // focus — which a window spawned by a test script does not reliably get.
  // Relying on that made this assertion pass or fail by luck.
  await runInViewer(`window.dispatchEvent(new MouseEvent('mousemove'))`);
  await waitFor('chrome to auto-hide while idle on BRIEF', () => probe.chromeHidden === true, 15000);
  const chromeVisible = await new Promise((resolve) => {
    fs.writeFileSync(
      EVAL_PATH,
      `console.log('CHROME_PROBE ' + JSON.stringify({
         strip: !!document.querySelector('.strip').offsetParent,
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
  if (chromeVisible.strip || chromeVisible.stageChrome) {
    throw new Error(`HIDE CHROME must blank all chrome, got ${JSON.stringify(chromeVisible)}`);
  }
  if (!chromeVisible.img) throw new Error('the photo must remain visible with chrome hidden');
  console.log('[e2e] HIDE CHROME shows the photo and nothing else');
  // ...and comes back the moment someone is at the machine again.
  await runInViewer(`window.dispatchEvent(new MouseEvent('mousemove'))`);
  await waitFor('chrome back on activity', () => probe.chromeHidden === false, 10000);
  console.log('[e2e] chrome auto-hides when idle and returns on activity');

  // --- tabs switch pages; SETUP does not ------------------------------------
  await goTo('received');
  await waitFor('RECEIVED page', () => probe.page === 'received');
  if (probe.batches.length !== 1) throw new Error(`expected 1 batch, got ${probe.batches.length}`);
  if (!probe.batches[0].who.includes('JOKER 2-1')) throw new Error(`batch shows "${probe.batches[0].who}"`);
  if (!/3 OF 3 IN BRIEF · \d{4}Z/.test(probe.batches[0].meta)) {
    throw new Error(`batch meta: "${probe.batches[0].meta}"`);
  }
  if (probe.batches[0].tiles.length !== 3) throw new Error('every received photo gets a tile');
  console.log('[e2e] RECEIVED lists the batch with callsign, selection count and Zulu time');

  // --- the launcher is the navigation now ---------------------------------
  if (!probe.launcherOpen) await click('#menukey');
  await waitFor('the launcher to open', () => probe.launcherOpen === true);
  if (!probe.dests.includes('brief') || !probe.dests.includes('setup')) {
    throw new Error(`launcher must list every destination, got ${JSON.stringify(probe.dests)}`);
  }
  if (!probe.groups.length) throw new Error('destinations must be grouped — that is what scales');
  // Escape must close it: it covers the whole window.
  await runInViewer(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  await waitFor('Escape to close the launcher', () => probe.launcherOpen === false);
  console.log('[e2e] launcher lists every destination, grouped, and Escape closes it');

  // SETUP is a page of this window now — the EFB carries its own settings.
  await goTo('setup');
  await waitFor('SETUP page', () => probe.page === 'setup');
  if (probe.setup !== 'net') throw new Error(`SETUP should open on NETWORK, got ${probe.setup}`);
  if (!probe.squadCodePrefix) throw new Error('SETUP should be rendering from the same snapshot');
  console.log('[e2e] SETUP is a page of the viewer, rendered from the same snapshot');

  // --- rule C: an arrival during interaction queues, page holds still ------
  const bravo = await connectClient('UZI 1-1');
  await sleep(300);
  await goTo('share'); // deliberate interaction, starts the grace window
  await waitFor('SHARE page', () => probe.page === 'share');
  bravo.sendRevealBatch([photo('d.jpg', 4)]);
  await waitFor('the arrival to join the queue', () => probe.batches.length === 2, 10000);
  if (probe.page !== 'share') throw new Error('a recent interaction must stop the page moving');
  if (!probe.banner || !probe.banner.includes('UZI 1-1')) {
    throw new Error(`with no badge the banner is the only trace — got ${probe.banner}`);
  }
  if (!/QUEUED/.test(probe.bannerMeta || '')) {
    throw new Error(`a held page must announce QUEUED, got "${probe.bannerMeta}"`);
  }
  console.log('[e2e] rule C: arrival during interaction queued with a QUEUED banner, page held still');

  // --- RECEIVED curation drives the brief's queue ---------------------------
  await goTo('brief');
  await waitFor('back on the brief', () => probe.page === 'brief');
  if (probe.pos !== '2 / 4') {
    // 1 (d.jpg, prepended) + 3 (a/b/c) — the stage stayed on a.jpg, renumbered.
    throw new Error(`prepend should renumber the held stage to 2 / 4, got "${probe.pos}"`);
  }
  await goTo('received');
  await waitFor('RECEIVED again', () => probe.page === 'received');

  // Deselect the photo BEHIND the stage (b.jpg): queue shrinks, stage holds.
  await click('.tile[data-filename="b.jpg"]');
  await waitFor('the tile to toggle off', () =>
    probe.batches.some((b) => b.tiles.some((t) => t.filename === 'b.jpg' && !t.selected)));
  if (probe.stageFile !== 'A.JPG') throw new Error(`deselecting b.jpg must not move the stage off ${probe.stageFile}`);
  if (probe.pos !== '2 / 3') throw new Error(`queue must shrink to 3, got "${probe.pos}"`);

  // HIDE the whole JOKER batch (the older one, last in the newest-first
  // list): only d.jpg remains; the stage falls to it.
  await click('.batch[data-batch-id]:last-child .batch__all');
  await waitFor('the batch to hide', () => probe.batches.some((b) => b.all === 'RESTORE'), 10000);
  if (probe.stageFile !== 'D.JPG') throw new Error(`stage must fall to the surviving photo, got ${probe.stageFile}`);
  if (probe.pos !== '1 / 1') throw new Error(`queue must be d.jpg alone, got "${probe.pos}"`);

  // RESTORE brings the batch back.
  await click('.batch__all[data-on="1"]');
  await waitFor('the batch to restore', () => probe.batches.every((b) => b.all === 'HIDE'), 10000);
  if (probe.pos !== '1 / 4') throw new Error(`restore must refill the queue, got "${probe.pos}"`);
  console.log('[e2e] RECEIVED curation: tile off, batch HIDE, RESTORE — queue follows, stage repairs');

  // --- share selection decides what goes on the wire ------------------------
  await goTo('share');
  await waitFor('share page', () => probe.page === 'share');
  // One key now: with photos selected it reads DESELECT ALL and clears them.
  await click('#share-toggle');
  await waitFor('nothing selected', () => probe.tiles.every((t) => !t.selected));
  if (!/SELECT ALL/.test(probe.shareToggle || '')) {
    throw new Error(`with nothing selected the key must offer SELECT ALL, got "${probe.shareToggle}"`);
  }
  if (!/NOTHING SELECTED/.test(probe.revealBtn)) throw new Error(`button label: "${probe.revealBtn}"`);
  await click('#share-grid .tile[data-filename]:last-child');
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
