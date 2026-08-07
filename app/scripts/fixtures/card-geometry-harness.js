'use strict';

// Renders the real card, with the real B612 metrics, in an offscreen Electron
// window, and reports every string that does not fit the box it landed in.
//
// This is the check design/kneeboard/HANDOFF.md §5 asks for — "string widths
// against the column they will land in ... fail with 'route.steps[6].note
// needs 340px, column is 280px'" — and §7 admits nobody had looked at the card
// rendered. When first run it found 16 clipped strings on the example card,
// including the BULLSEYE and the S-A threat list.
//
// Why clipping is a defect rather than a cosmetic issue: the cells all carry
// `text-overflow: ellipsis`, so a value too long for its column is replaced by
// a shorter, plausible-looking value. `N29 09'58.8 E53 07'38.6` becomes
// `N29 09'58.8 E53 07…`. Nothing errors, nothing looks broken, and the pilot
// reads a bullseye that is missing its eastings — which is the reference every
// bearing and range call in the flight is made from. Silent truncation on a
// mission card is worse than a card that refuses to load.

const path = require('path');
const { app, BrowserWindow } = require('electron');
const { resolveCard } = require('../../src/main/card');
const fs = require('fs');

const RENDERER = path.join(__dirname, '..', '..', 'src', 'renderer');
const APP_DIR = path.join(__dirname, '..', '..');

function buildModel(cardFile) {
  const layout = JSON.parse(
    fs.readFileSync(path.join(APP_DIR, 'resources', 'layouts', 'strike-package.layout.json'), 'utf8'),
  );
  const card = JSON.parse(fs.readFileSync(cardFile, 'utf8'));
  const { ok, errors, card: resolved } = resolveCard({ layout, card });
  if (!ok) throw new Error(`card refused: ${errors.join('; ')}`);
  return resolved;
}

// Both the example card from the design folder and the deliberately-full one.
// The full card is the interesting case: a card that fits only because its
// strings happen to be short is not a card that fits.
const CARDS = [
  ['design', path.join(APP_DIR, '..', 'design', 'kneeboard', 'foxhunt2-roman1.card.json')],
  ['full', path.join(APP_DIR, 'scripts', 'fixtures', 'card-full.card.json')],
];

app.whenReady().then(async () => {
  // ONE window, loaded once, both cards rendered into it. The first shape of
  // this harness made a window per card and the renderer died before the
  // first measurement ("Object has been destroyed"); geometry-harness.js has
  // loaded this same page reliably for months, so it is copied rather than
  // re-derived.
  const win = new BrowserWindow({ width: 1100, height: 1500, show: false });
  win.webContents.on('did-fail-load', (_e, code, desc, url) =>
    console.log(`CARD_LOADFAIL ${code} ${desc} ${url}`),
  );
  win.webContents.on('render-process-gone', (_e, d) => console.log(`CARD_RENDERGONE ${JSON.stringify(d)}`));

  await win.loadFile(path.join(RENDERER, 'viewer.html'));
  await win.webContents.executeJavaScript('document.fonts.ready.then(() => true)');

  const results = [];
  for (const [name, file] of CARDS) {
    const model = buildModel(file);
    const report = await win.webContents.executeJavaScript(`
      (() => {
        const model = ${JSON.stringify(model)};
        render({
          locale: 'en', page: 'card', launcherOpen: false, chromeHidden: false, focused: true,
          callsign: 'GHOSTRIDER 1-1', isHost: true, connected: true, peers: [],
          relayLabel: '', lastContactAt: null, reconnect: null, banner: null,
          brief: { presenting: false, presenter: null, focusHash: null, following: true,
                   tool: 'pen', cursor: null, inkRevs: {}, live: false, focusMissing: false },
          queue: { total: 0, pos: -1, current: null }, batches: [],
          folder: '', photos: [], selectedCount: 0, photoCount: 0, stagedBytes: 0,
          profile: 'kneeboard', funnel: {}, counters: {}, logPath: '', version: '0',
          autoShow: true, card: model,
        });

        const sheet = document.getElementById('card-sheet');
        const clipped = [];
        for (const n of sheet.querySelectorAll('*')) {
          if (n.children.length || !n.textContent.trim()) continue;
          // 1px of slack: sub-pixel layout rounds, and a value overrunning by a
          // fraction is not losing a character.
          if (n.scrollWidth > n.clientWidth + 1) {
            clipped.push({
              cls: String(n.className || n.tagName),
              text: n.textContent.trim(),
              need: n.scrollWidth,
              have: n.clientWidth,
            });
          }
        }
        const comms = [...document.querySelectorAll('.card__comms .card__section')].map((sec) => {
          const rows = [...sec.querySelectorAll('.card__row')];
          const need = Math.max(0, ...rows.map((r) =>
            [...r.children].reduce((sum, c) => sum + c.scrollWidth, 0) + (r.children.length - 1) * 6));
          return { title: (sec.querySelector('.card__head-title') || {}).textContent || '?',
                   col: Math.round(sec.getBoundingClientRect().width),
                   rowBox: rows[0] ? Math.round(rows[0].clientWidth) : 0, need };
        });
        const page = sheet.querySelector('.card__page') || sheet;
        const blocks = [...page.children].map((b) => ({
          cls: String(b.className).split(' ')[0],
          title: (b.querySelector('.card__head-title') || {}).textContent || '',
          h: Math.round(b.getBoundingClientRect().height / (sheet.getBoundingClientRect().width / sheet.clientWidth)),
          rows: b.querySelectorAll('.card__step').length || b.querySelectorAll('.card__row').length || 0,
        }));
        return {
          blocks,
          bodyH: sheet.clientHeight - 36,
          comms,
          clipped,
          scrollH: sheet.scrollHeight,
          clientH: sheet.clientHeight,
          fontLoaded: document.fonts.check('700 13px "B612"'),
        };
      })()
    `);
    results.push({ card: name, ...report });
  }

  console.log(`CARD_GEOMETRY ${JSON.stringify(results)}`);
  app.exit(0);
});
