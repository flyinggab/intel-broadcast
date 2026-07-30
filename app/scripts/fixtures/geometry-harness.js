'use strict';

// Electron harness for dev-ui-geometry-test.js. Loads the real renderer HTML
// offscreen at several --ui-scale values and measures it, then prints one
// GEOMETRY line the test parses. Kept as a real file rather than a string
// inside the test: nested template escaping was unreadable and broke silently.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');

const APP_DIR = path.join(__dirname, '..', '..');
const TOUCH_MIN = 44;
const SCALES = [0.8, 1, 1.4];

// The shipped HTML boots empty — demo state lives in preview-state.js and is
// pushed through the same window.__preview hook preview.html uses. Measuring
// the empty markup would be measuring nothing.
const PREVIEW_STATE_SOURCE = fs.readFileSync(
  path.join(APP_DIR, 'src', 'renderer', 'preview-state.js'),
  'utf8',
);

// Runs inside the page. Returns everything the test needs to judge §6.5/§6.6/§6.8.
function measureInPage(touchMin) {
  const report = { small: [], overflow: [], font: null };

  // §6.8 — B612 must come from the vendored woff2, with no network. Ask the
  // font API directly rather than comparing rendered widths: a width heuristic
  // depends on which glyphs the page happens to have already requested, which
  // made this report differently per file for no real reason.
  const faces = [...document.fonts].map((f) => ({ family: f.family, weight: f.weight, status: f.status }));
  report.font = {
    faces,
    loaded:
      document.fonts.check('700 16px "B612"') &&
      document.fonts.check('400 16px "B612 Mono"') &&
      faces.some((f) => f.family === 'B612' && f.status === 'loaded'),
  };

  const pages = [...document.querySelectorAll('.page')].map((p) => p.dataset.page);
  const originalPage = document.body.dataset.page;

  for (const name of pages) {
    // Measure every page, including ones currently hidden: a target that only
    // clips on SHARE is still a clipped target.
    document.body.dataset.page = name;

    for (const target of document.querySelectorAll('button, input, .toggle, .row, .tile, .step')) {
      const rect = target.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue; // not on this page
      if (rect.height < touchMin - 0.5) {
        report.small.push({
          page: name,
          cls: String(target.className || target.tagName).slice(0, 44),
          h: Math.round(rect.height * 10) / 10,
        });
      }
    }

    const doc = document.documentElement;
    if (doc.scrollWidth > doc.clientWidth + 1) {
      report.overflow.push({ page: name, what: 'document', by: doc.scrollWidth - doc.clientWidth });
    }
    for (const node of document.querySelectorAll('.shell, .strip, .tabbar, .rail, .netstate, .choice, .savebar, .keyrow, .bind2__row, .step__row, .cellrow')) {
      if (node.scrollWidth > node.clientWidth + 1 && getComputedStyle(node).overflowX === 'visible') {
        report.overflow.push({
          page: name,
          what: String(node.className).slice(0, 30),
          by: node.scrollWidth - node.clientWidth,
        });
      }
    }
  }

  document.body.dataset.page = originalPage;
  return report;
}

async function measure(file, scale) {
  // NOT offscreen: offscreen rendering is unreliable in this WSLg sandbox
  // (same GPU-compositor trouble PLAN.md records for capturePage). A normal
  // hidden window still lays out and runs script, which is all we measure.
  const win = new BrowserWindow({
    width: 850,
    height: 1200,
    show: false,
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.log(`GEOMETRY_LOADFAIL ${code} ${desc} ${url}`),
  );
  win.webContents.on('render-process-gone', (_e, details) =>
    console.log(`GEOMETRY_RENDERGONE ${JSON.stringify(details)}`),
  );
  await win.loadFile(path.join(APP_DIR, 'src', 'renderer', file));
  // Populate the empty shipped markup with the shared demo snapshots — the
  // banner shown too, so its close target is measured.
  await win.webContents.executeJavaScript(PREVIEW_STATE_SOURCE);
  await win.webContents.executeJavaScript(
    file === 'viewer.html'
      ? `window.__preview.render(PreviewState.viewer['banner switched'])`
      : `window.__preview.render(PreviewState.settings)`,
  );
  await win.webContents.executeJavaScript(
    `document.documentElement.style.setProperty('--ui-scale', ${JSON.stringify(String(scale))})`,
  );
  // Wait for the webfonts properly rather than guessing: measuring before
  // B612 lands makes it look like the vendored file failed to load.
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');
  await new Promise((resolve) => setTimeout(resolve, 300)); // let layout settle

  const report = await win.webContents.executeJavaScript(`(${measureInPage.toString()})(${TOUCH_MIN})`);
  win.destroy();
  return { file, scale, ...report };
}

// Each measurement destroys its window, which would otherwise leave zero
// windows open and trigger Electron's default quit — aborting every
// subsequent load with a bare ERR_FAILED and no did-fail-load event.
app.on('window-all-closed', () => {});

app.whenReady().then(async () => {
  const results = [];
  try {
    for (const file of ['viewer.html', 'settings.html']) {
      for (const scale of SCALES) results.push(await measure(file, scale));
    }
    console.log('GEOMETRY ' + JSON.stringify(results));
  } catch (err) {
    console.log('GEOMETRY_ERROR ' + err.message);
  }
  app.quit();
});
