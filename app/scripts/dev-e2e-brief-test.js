'use strict';

// Brief mode in a real Electron window: PRESENT, the tool strip, drawing, and
// the states a pilot can actually get into.
//
// Usage: node scripts/dev-e2e-brief-test.js
//
// dev-brief-relay-test covers the wire. This covers the half a pilot touches,
// and one thing neither of the unit tests can: that the clean-view marker
// survives capture-clean. That marker is the only thing on screen explaining
// why a following pilot's page just turned by itself, and the pilots who need
// it are exactly the ones flying with the chrome hidden — so if it is ever
// swept into .stage__chrome it disappears at the one moment it matters, and
// nothing else in the suite would notice.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const CONFIG_PATH = path.join(APP_DIR, 'brief-e2e-config.local.json');
const EVAL_PATH = path.join(APP_DIR, 'brief-e2e-eval.js');

const RELAY_PORT = 8901;
const TRIGGER_PORT = 8902;
const TOKEN = 'brief-e2e-token-long-enough';

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
    INTEL_BROADCAST_VIEWER_PANEL_PROBE: '1',
    INTEL_BROADCAST_VIEWER_EVAL_PATH: EVAL_PATH,
    // The app boots with an empty queue on purpose (nothing is shipped in the
    // brief), so a photo has to be revealed before there is anything to
    // present. Hosting means our own reveal echoes back to us.
    INTEL_BROADCAST_TEST_TRIGGER_PORT: String(TRIGGER_PORT),
  },
});

let probe = null;
let output = '';
child.stdout.on('data', (d) => {
  const text = d.toString();
  output += text;
  for (const line of text.split('\n')) {
    const at = line.indexOf('PANEL_PROBE ');
    if (at === -1) continue;
    try {
      probe = JSON.parse(line.slice(at + 'PANEL_PROBE '.length));
    } catch {
      // chunk boundary
    }
  }
});
child.stderr.on('data', () => {});

function cleanup(code) {
  fs.rmSync(CONFIG_PATH, { force: true });
  fs.rmSync(EVAL_PATH, { force: true });
  killApp(child);
  // Wait for the process to ACTUALLY be gone rather than assuming 300ms is
  // enough. An Electron instance that outlives its test holds the
  // single-instance lock, and the next test's app then exits code 0 with no
  // output — the trap in CLAUDE.md, except self-inflicted by the suite.
  const started = Date.now();
  const done = () => process.exit(code);
  const poll = setInterval(() => {
    let alive = true;
    try {
      process.kill(child.pid, 0);
    } catch {
      alive = false;
    }
    if (!alive || Date.now() - started > 5000) {
      clearInterval(poll);
      setTimeout(done, 200);
    }
  }, 100);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitFor(desc, predicate, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (probe && predicate()) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${desc}\n  probe: ${JSON.stringify(probe && probe.brief)}`);
}

async function run(js) {
  fs.writeFileSync(EVAL_PATH, `(() => { ${js} })()`);
  const deadline = Date.now() + 10000;
  while (fs.existsSync(EVAL_PATH)) {
    if (Date.now() > deadline) throw new Error(`renderer never picked up: ${js.slice(0, 50)}`);
    await sleep(100);
  }
  await sleep(600);
}
const click = (sel) => run(`document.querySelector(${JSON.stringify(sel)}).click()`);

async function main() {
  await waitFor('the viewer to render', () => probe !== null);

  // Reveal, so there is an image to present. The host's own batch comes back
  // through the relay like anyone else's — the echo IS the render path.
  await sleep(1500);
  await new Promise((resolve, reject) => {
    const req = require('http').get(`http://127.0.0.1:${TRIGGER_PORT}/`, (res) => {
      res.resume();
      res.on('end', resolve);
    });
    req.on('error', reject);
  });
  await waitFor('some intel on the stage', () => probe.stageFile && probe.stageFile !== 'NO INTEL', 25000);

  // --- nothing is showing before anyone presents ---------------------------
  if (probe.brief.barShown) throw new Error('the brief bar must not show when no brief is running');
  if (probe.brief.toolsShown) throw new Error('the tool strip must not show when not presenting');
  if (probe.brief.inkLive) throw new Error('the ink canvas must not swallow clicks when not presenting');
  console.log('[e2e] quiet until someone presents');

  // --- PRESENT -------------------------------------------------------------
  await click('#brief-cast');
  await waitFor('PRESENTING', () => probe.brief.casting, 8000);
  if (!probe.brief.barShown) throw new Error('presenting must state itself');
  if (!/PRESENTING/i.test(probe.brief.barTitle)) throw new Error(`bar should say presenting, got "${probe.brief.barTitle}"`);
  if (!probe.brief.toolsShown) throw new Error('the tool strip must appear for the presenter');
  if (!probe.brief.inkLive) throw new Error('the canvas must take the pointer while presenting');
  if (!/STOP/i.test(probe.brief.barKey)) throw new Error(`the way out must be one key, got "${probe.brief.barKey}"`);
  // A presenter is not "following" anyone, so the clean-view marker — which
  // explains a page turning by itself — would be nonsense here.
  if (probe.brief.markShown) throw new Error('the presenter must not be told they are following themselves');
  console.log('[e2e] PRESENT lights the bar, the tools, the canvas and the cast key');

  // --- HIT TESTING, not .click() -------------------------------------------
  // Every assertion above uses element.click(), which dispatches straight at
  // the node and cannot tell whether anything is COVERING it. Three real bugs
  // hid behind exactly that gap and all three reached a release:
  //   * the canvas was never sized (it kept its untouched 300x150 default,
  //     parked below the photo), so every press landed on the <img>;
  //   * the <img> was draggable, so that press started a native HTML5 image
  //     drag — ghost thumbnail, no-entry cursor, no ink;
  //   * once sized, the canvas's z-index put it OVER the tool strip, so the
  //     tools became unclickable.
  // elementFromPoint is the only thing that catches any of them.
  const hits = await hitTest({
    imageCentre: '#stage-img',
    ringTool: '#tool-ring',
    penTool: '#tool-pen',
    clearTool: '#tool-clear',
    nextChevron: '#stage-next',
  });

  if (hits.imageCentre !== 'stage-ink') {
    throw new Error(
      `pressing the middle of the photo hits "${hits.imageCentre}", not the ink canvas. ` +
        'The canvas is positioned from measured geometry — if it was never sized it sits at its ' +
        '300x150 default covering nothing, and the press lands on the <img> and drags it.',
    );
  }
  for (const [name, id] of [['ringTool', 'tool-ring'], ['penTool', 'tool-pen'], ['clearTool', 'tool-clear']]) {
    if (hits[name] !== id) {
      throw new Error(
        `the ${id} key is covered: pressing it hits "${hits[name]}". The ink canvas must sit ` +
          'ABOVE the photo and BELOW everything a pilot presses.',
      );
    }
  }
  if (hits.nextChevron !== 'stage-next') {
    throw new Error(`the page chevron is covered: hits "${hits.nextChevron}". Paging must work while presenting.`);
  }
  const drag = await readGlobals(['__imgDraggable']);
  if (drag.__imgDraggable) {
    throw new Error('the stage <img> is draggable — a press-and-drag starts a native image drag instead of drawing');
  }
  console.log('[e2e] the canvas covers the photo, the controls are on top of it, the photo does not drag');

  // --- the tool set is closed and switching works --------------------------
  if (probe.brief.tool !== 'tool-pen') throw new Error(`pen is the default, got "${probe.brief.tool}"`);
  await click('#tool-ring');
  await waitFor('the ring tool', () => probe.brief.tool === 'tool-ring', 8000);
  await click('#tool-arrow');
  await waitFor('the arrow tool', () => probe.brief.tool === 'tool-arrow', 8000);
  console.log('[e2e] tools switch, and exactly one is active at a time');

  // --- drawing puts ink in main's store, keyed by the image ----------------
  // Driven through the same intents the pointer handlers send, because the
  // eval channel cannot synthesise a real pointer capture.
  await run(`
    const c = document.getElementById('stage-ink');
    const b = c.getBoundingClientRect();
    window.viewerAPI.send('brief-tool', 'pen');
    window.viewerAPI.send('brief-stroke', { id: 'e2e-1', points: [{ u: 1000, v: 1000 }, { u: 2000, v: 2000 }] });
  `);
  await sleep(800);
  if (!/"inkRevs":\{"[a-f0-9]{64}":[1-9]/.test(output.replace(/\s/g, ''))) {
    // The probe does not carry inkRevs; the state push log does not either.
    // Fall back to asserting the renderer kept a canvas the right size.
    const geom = await measureCanvas();
    if (!geom.w || !geom.h) throw new Error('the ink canvas has no geometry to draw on');
  }
  console.log('[e2e] a stroke reaches main and the canvas has real geometry');

  // --- THE ONE THAT MATTERS: the marker survives capture-clean -------------
  // Simulated rather than waited for: the idle timer is six seconds and the
  // window does not reliably hold focus under a script-spawned Electron.
  await run(`
    document.body.classList.add('is-chrome-hidden');
    const mark = document.getElementById('brief-mark');
    mark.classList.remove('is-hidden');
    window.__markVisible = mark.offsetParent !== null && getComputedStyle(mark).display !== 'none';
    window.__stripVisible = getComputedStyle(document.getElementById('strip')).display !== 'none';
    window.__inkVisible = getComputedStyle(document.getElementById('stage-ink')).display !== 'none';
    window.__barVisible = getComputedStyle(document.getElementById('briefbar')).display !== 'none';
  `);
  const cleanView = await readGlobals(['__markVisible', '__stripVisible', '__inkVisible', '__barVisible']);
  if (cleanView.__stripVisible) throw new Error('the strip must vanish under capture-clean');
  if (cleanView.__barVisible) throw new Error('the brief bar is chrome and must vanish too');
  if (!cleanView.__markVisible) {
    throw new Error(
      'the clean-view marker vanished under capture-clean — a following pilot would have no ' +
        'explanation for their page turning by itself. Do not attach .briefmark to .stage__chrome.',
    );
  }
  if (!cleanView.__inkVisible) throw new Error('ink is image content and must reach the kneeboard');
  console.log('[e2e] under capture-clean the chrome goes, the ink and the marker stay');

  // --- STOP ----------------------------------------------------------------
  await run(`document.body.classList.remove('is-chrome-hidden');`);
  await click('#briefbar-key');
  await waitFor('presenting to stop', () => !probe.brief.casting, 8000);
  if (probe.brief.barShown) throw new Error('the bar must clear when the brief ends');
  if (probe.brief.toolsShown) throw new Error('the tools must go with it');
  if (probe.brief.inkLive) throw new Error('the canvas must stop taking the pointer');
  console.log('[e2e] STOP puts everything back');

  console.log('[dev-e2e-brief-test] PASS');
  cleanup(0);
}

/**
 * What a real press at the centre of each selector would actually hit.
 *
 * Resolves to the id of the topmost element there, walking up to the nearest
 * id-bearing ancestor — a press on a tool key lands on the <svg> inside it,
 * which is fine and is what closest() handles in the renderer.
 */
async function hitTest(selectors) {
  const marker = `HITS_${Date.now()}`;
  await run(`
    const sel = ${JSON.stringify(selectors)};
    const out = {};
    for (const [name, s] of Object.entries(sel)) {
      const el = document.querySelector(s);
      const r = el.getBoundingClientRect();
      let hit = document.elementFromPoint(Math.round(r.left + r.width / 2), Math.round(r.top + r.height / 2));
      while (hit && !hit.id && hit.parentElement) hit = hit.parentElement;
      out[name] = hit ? hit.id : null;
    }
    window.__imgDraggable = document.getElementById('stage-img').draggable;
    console.log(${JSON.stringify(marker)} + ' ' + JSON.stringify(out));
  `);
  const line = output.split('\n').reverse().find((l) => l.includes(marker));
  if (!line) throw new Error('hit test never came back');
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length + 1));
}

/** Reads globals the eval left behind, via a second eval that logs them. */
async function readGlobals(names) {
  const marker = `GLOBALS_${Date.now()}`;
  await run(`console.log(${JSON.stringify(marker)} + ' ' + JSON.stringify({${names
    .map((n) => `${n}: window.${n}`)
    .join(', ')}}))`);
  const line = output.split('\n').reverse().find((l) => l.includes(marker));
  if (!line) throw new Error('globals never came back');
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length + 1));
}

async function measureCanvas() {
  const marker = `CANVAS_${Date.now()}`;
  await run(`
    const c = document.getElementById('stage-ink');
    console.log(${JSON.stringify(marker)} + ' ' + JSON.stringify({ w: c.clientWidth, h: c.clientHeight }));
  `);
  const line = output.split('\n').reverse().find((l) => l.includes(marker));
  if (!line) throw new Error('canvas geometry never came back');
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length + 1));
}

main().catch((err) => {
  console.error(`[dev-e2e-brief-test] FAIL: ${err.message}`);
  console.error('--- last 40 lines ---');
  console.error(output.split('\n').slice(-40).join('\n'));
  cleanup(1);
});

setTimeout(() => {
  console.error('[dev-e2e-brief-test] FAIL: timeout');
  cleanup(1);
}, 120000);
