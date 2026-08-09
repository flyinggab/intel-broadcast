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

// Each card names its OWN template, and is resolved against that one. This
// used to hardcode strike-package, which meant a second shipped template could
// never be measured — and a template nobody has rendered at a real size is
// exactly how the bullseye came to be silently truncated.
function buildModel(cardFile, layoutFile) {
  const layout = JSON.parse(fs.readFileSync(layoutFile, 'utf8'));
  const card = JSON.parse(fs.readFileSync(cardFile, 'utf8'));
  const { ok, errors, card: resolved } = resolveCard({ layout, card });
  if (!ok) throw new Error(`card refused: ${errors.join('; ')}`);
  return resolved;
}

// Both the example card from the design folder and the deliberately-full one.
// The full card is the interesting case: a card that fits only because its
// strings happen to be short is not a card that fits.
const LAYOUTS = path.join(APP_DIR, 'resources', 'layouts');
const SAMPLES = path.join(APP_DIR, '..', 'design', 'kneeboard', 'samples');
const CARDS = [
  ['design', path.join(APP_DIR, '..', 'design', 'kneeboard', 'foxhunt2-roman1.card.json'), path.join(LAYOUTS, 'strike-package.layout.json')],
  ['full', path.join(APP_DIR, 'scripts', 'fixtures', 'card-full.card.json'), path.join(LAYOUTS, 'strike-package.layout.json')],
  // The second SHIPPED template. A template that ships is one a pilot will
  // fly, so it earns the same string-width check as the first.
  ['cas', path.join(SAMPLES, 'uzi11-cas.card.json'), path.join(LAYOUTS, 'cas-9line.layout.json')],
  // And the sample template meant to be IMPORTED — measured here so the file
  // handed out as "this is what a template looks like" is one that renders.
  ['ferry', path.join(SAMPLES, 'colt21-ferry.card.json'), path.join(SAMPLES, 'ferry-flight.layout.json')],
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
  for (const [name, file, layoutFile] of CARDS) {
    const model = buildModel(file, layoutFile);
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
        // TRUE content width, via a Range over the cell's text. scrollWidth is
        // circular here: on a cell that FITS it returns the width the cell was
        // given, not the width its text wants — so shortening a value did not
        // change the "need" at all, and fractions derived from it were really
        // derived from the previous allocation.
        const textWidth = (cell) => {
          if (!cell.firstChild) return 0;
          const range = document.createRange();
          range.selectNodeContents(cell);
          const w = range.getBoundingClientRect().width;
          range.detach();
          const cs = getComputedStyle(cell);
          return Math.ceil(w + parseFloat(cs.paddingLeft || 0) + parseFloat(cs.paddingRight || 0));
        };
        const comms = [...document.querySelectorAll('.card__comms .card__section')].map((sec) => {
          const rows = [...sec.querySelectorAll('.card__row')];
          const need = Math.max(0, ...rows.map((r) =>
            [...r.children].reduce((sum, c) => sum + textWidth(c), 0) + (r.children.length - 1) * 5));
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
        // A column must mean the same thing all the way down: every cell at
        // the same index in a table starts at the same x. Laid out as
        // independent flex rows they did not, so a tanker with no altitude put
        // its heading where the row above put its altitude.
        const misaligned = [];
        for (const table of sheet.querySelectorAll('.card__rows')) {
          const rows = [...table.querySelectorAll('.card__row')];
          const title = (table.closest('.card__section').querySelector('.card__head-title') || {}).textContent || '?';
          const cols = Math.max(0, ...rows.map((r) => r.children.length));
          for (let i = 0; i < cols; i += 1) {
            const xs = rows
              .map((r) => r.children[i])
              .filter(Boolean)
              .map((c) => Math.round(c.getBoundingClientRect().left));
            if (new Set(xs).size > 1) misaligned.push({ title, col: i, xs: [...new Set(xs)] });
          }
        }
        // CONTENT THAT ESCAPES ITS OWN BLOCK. A different failure from the
        // clipping check above, and invisible to it: nothing is truncated, the
        // text simply hangs outside the border it belongs to. That is what a
        // comms grid with the wrong number of tracks does — a template with two
        // comms blocks put its second in a track sized for the shipped card's
        // narrow middle column, and every row in it sat 215px past the box
        // while the clipping check reported nothing, because no cell was cut.
        //
        // NOTE FOR THE NEXT EDIT: this whole block is injected as a template
        // literal, so a backtick anywhere in it — even inside a comment —
        // closes the literal and the harness stops parsing. Use plain words.
        const escaped = [];
        for (const sec of sheet.querySelectorAll('.card__section, .card__stations, .card__band')) {
          const box = sec.getBoundingClientRect();
          for (const inner of sec.querySelectorAll('.card__row, .card__step, .card__cell, .card__field')) {
            const r = inner.getBoundingClientRect();
            if (r.right > box.right + 1) {
              escaped.push({
                block: (sec.querySelector('.card__head-title') || {}).textContent || String(sec.className).split(' ')[0],
                text: inner.textContent.trim().slice(0, 40),
                over: Math.round(r.right - box.right),
              });
            }
          }
        }
        return {
          escaped,
          misaligned,
          tables: sheet.querySelectorAll('.card__rows').length,
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
