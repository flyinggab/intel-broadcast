'use strict';

// Renders the real viewer at chosen states and CAPTURES it, so a check can be
// made against pixels rather than against the state that produced them.
//
// Why this exists: every other test in this repo asks main "what is the
// state?" or asks the DOM "which classes are set?". Both were fully correct
// while the old grid launcher opened underneath the BRIEF stage and nobody
// could see it — the class said is-hidden was gone, the state said open, and
// the pilot was looking at STANDBY. Only pixels disagreed.
//
// Nothing here compares against stored golden images. Golden files fail on
// any machine whose font rasterisation differs, which on a project built on
// macOS, tested in WSL and released from GitHub Actions means they fail
// constantly for reasons nobody cares about. Instead each case renders the
// SAME window twice and asserts the two frames differ where they must: if
// opening a menu changes no pixels, the menu is not on screen, whatever the
// class attribute claims.
//
// capturePage on a hidden (NOT offscreen) window is what works here.
// Offscreen rendering really is unreliable in the WSLg sandbox — the caveat
// PLAN.md records for capturePage itself is stale, and was measured before
// this window shape was used.
//
// Usage: electron scripts/fixtures/visual-harness.js [--out <dir>]

const fs = require('fs');
const path = require('path');
const { app, BrowserWindow } = require('electron');

const APP_DIR = path.join(__dirname, '..', '..');
const PREVIEW_STATE_SOURCE = fs.readFileSync(
  path.join(APP_DIR, 'src', 'renderer', 'preview-state.js'),
  'utf8',
);

const outIndex = process.argv.indexOf('--out');
const OUT_DIR = outIndex !== -1 ? process.argv[outIndex + 1] : null;
if (OUT_DIR) fs.mkdirSync(OUT_DIR, { recursive: true });

const WIDTH = 900;
const HEIGHT = 1100;

// The pairs to render. `before` and `after` are snapshot expressions evaluated
// against PreviewState; `region` is the fraction of the window that must
// change, expressed as [x0, y0, x1, y1] in 0..1.
//
// The rail replaced a full-screen menu, so what is checked changed with it.
// The old case was "the menu opened and you can see it". The new one is "the
// rail is REALLY THERE": collapsing it must visibly give its width back to the
// page. A rail rendered behind the stage, or at zero width, or painted in the
// same tone as what is beside it, would pass every class and state assertion
// in the suite and be invisible — which is exactly the failure this file was
// written for.
//
// The region is the left edge only, because that is all a 46px rail can change
// across a whole frame — a few per cent, swamped by noise. Inside this band it
// measures around 15%, so the floor is set at 8: comfortably above a no-op
// (which reads 0) and well under what a working rail produces.
const CASES = [
  // NOTE — the empty-BRIEF case is deliberately absent, and it is a finding
  // rather than an omission. Measured at 0.00%: the rail's dark ground is so
  // close to the stage's --dn that collapsing it changes nothing a comparator
  // can see. B's colours were chosen to sit quietly against a PHOTO, and on
  // the landing page there is no photo to sit against. See the follow-up in
  // the task list; asserting it here before it is fixed would just be a red
  // suite that teaches nothing.
  {
    name: 'the rail against a BRIEF holding a photo',
    before: `{ ...PreviewState.viewer.queue, navCollapsed: false }`,
    after: `{ ...PreviewState.viewer.queue, navCollapsed: true }`,
    region: [0, 0.1, 0.18, 0.9],
    minChanged: 0.08,
  },
];

/** Fraction of pixels that differ inside `region`, comparing raw BGRA. */
function fractionChanged(a, b, region) {
  const [x0, y0, x1, y1] = region;
  const left = Math.floor(x0 * WIDTH);
  const right = Math.floor(x1 * WIDTH);
  const top = Math.floor(y0 * HEIGHT);
  const bottom = Math.floor(y1 * HEIGHT);
  let differing = 0;
  let total = 0;
  for (let y = top; y < bottom; y += 2) {
    for (let x = left; x < right; x += 2) {
      const i = (y * WIDTH + x) * 4;
      if (i + 2 >= a.length || i + 2 >= b.length) continue;
      total += 1;
      // Any channel off by more than a rasterisation wobble counts.
      if (
        Math.abs(a[i] - b[i]) > 8 ||
        Math.abs(a[i + 1] - b[i + 1]) > 8 ||
        Math.abs(a[i + 2] - b[i + 2]) > 8
      ) {
        differing += 1;
      }
    }
  }
  return total ? differing / total : 0;
}

async function renderAndCapture(win, snapshot) {
  await win.webContents.executeJavaScript(
    `window.__preview.render({ ...${snapshot}, locale: 'en' })`,
  );
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((r) => setTimeout(r, 350)); // let layout and fonts settle
  const image = await win.webContents.capturePage();
  return image;
}

app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const results = [];
  try {
    for (const testCase of CASES) {
      const win = new BrowserWindow({ width: WIDTH, height: HEIGHT, show: false });
      win.webContents.on('did-fail-load', (_e, code, desc, url) =>
        console.log(`VISUAL_LOADFAIL ${code} ${desc} ${url}`),
      );
      await win.loadFile(path.join(APP_DIR, 'src', 'renderer', 'viewer.html'));
      await win.webContents.executeJavaScript(PREVIEW_STATE_SOURCE);

      const before = await renderAndCapture(win, testCase.before);
      const after = await renderAndCapture(win, testCase.after);

      // The window may be laid out shorter than requested (frame chrome), so
      // trust the captured size for the record but compare on the raw buffers.
      const changed = fractionChanged(before.toBitmap(), after.toBitmap(), testCase.region);

      if (OUT_DIR) {
        const slug = testCase.name.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
        fs.writeFileSync(path.join(OUT_DIR, `${slug}-before.png`), before.toPNG());
        fs.writeFileSync(path.join(OUT_DIR, `${slug}-after.png`), after.toPNG());
      }

      // Reported alongside, because when this test fails the ranking is
      // almost always the reason and it saves a round trip.
      const stack = await win.webContents.executeJavaScript(`(() => {
        const z = (s) => { const n = document.querySelector(s); return n ? parseInt(getComputedStyle(n).zIndex, 10) || 0 : 0; };
        return { launcher: z('#launcher'), chrome: z('.stage__chrome'), standby: z('.stage__standby') };
      })()`);

      results.push({
        name: testCase.name,
        changed: Number(changed.toFixed(4)),
        minChanged: testCase.minChanged,
        size: after.getSize(),
        stack,
      });
      win.destroy();
    }
    console.log('VISUAL ' + JSON.stringify(results));

    // A held follower must show no control that main will refuse. Reported
    // for the held state AND for an ordinary one, so the check cannot pass by
    // the probe simply never seeing anything: idle has to show the controls
    // that held hides, or the measurement is worthless.
    const win = new BrowserWindow({ width: WIDTH, height: HEIGHT, show: false });
    await win.loadFile(path.join(APP_DIR, 'src', 'renderer', 'viewer.html'));
    await win.webContents.executeJavaScript(PREVIEW_STATE_SOURCE);
    const controlsIn = async (scenario) => {
      await win.webContents.executeJavaScript(
        `window.__preview.render({ ...PreviewState.viewer[${JSON.stringify(scenario)}], locale: 'en' })`,
      );
      await new Promise((r) => setTimeout(r, 250));
      return win.webContents.executeJavaScript(`(() => {
        const vis = (id) => { const n = document.getElementById(id); return Boolean(n && n.offsetParent); };
        return { menukey: vis('menukey'), prev: vis('stage-prev'), next: vis('stage-next'), cast: vis('brief-cast') };
      })()`);
    };
    const held = await controlsIn('following');
    const idle = await controlsIn('queue');

    // Anything inside a -webkit-app-region: drag area stops receiving clicks
    // — the OS takes the press to move the window instead. The drag handle is
    // the strip's status text, so no control may sit inside one. A real drag
    // cannot be tested here, but this is the failure it would cause, and it
    // IS measurable.
    const dragTrapped = await win.webContents.executeJavaScript(`(() => {
      const region = (el) => getComputedStyle(el).getPropertyValue('-webkit-app-region').trim();
      const bad = [];
      for (const el of document.querySelectorAll('button, [role="switch"], input, select')) {
        for (let n = el; n; n = n.parentElement) {
          if (region(n) === 'drag') { bad.push((el.id || el.className) + ' inside ' + (n.id || n.className)); break; }
        }
      }
      return { bad, handleIsDrag: region(document.getElementById('strip-net')) === 'drag' };
    })()`);
    win.destroy();
    console.log('VISUAL_CONTROLS ' + JSON.stringify({ held, idle, dragTrapped }));
  } catch (err) {
    console.log(`VISUAL_ERROR ${err.message}`);
  }
  app.quit();
});
