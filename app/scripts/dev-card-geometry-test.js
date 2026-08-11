'use strict';

// The mission card must fit, and every value on it must be readable in full.
//
// Usage: node scripts/dev-card-geometry-test.js
//
// dev-card-test checks the RESOLVER — that bindings resolve, that a bad card
// is refused. This checks the RENDER, which is the half nobody had looked at:
// design/kneeboard/HANDOFF.md §7 says so in as many words, and when this was
// first run it found 16 clipped strings on the example card.
//
// The failure mode is what makes it worth a test of its own. Card cells carry
// `text-overflow: ellipsis`, so a value too long for its column is silently
// replaced by a shorter one that still looks like a value. The bullseye
// `N29 09'58.8 E53 07'38.6` renders as `N29 09'58.8 E53 07…` — no error, no
// visible damage, and the pilot reads a reference missing its eastings. Every
// bearing and range call in the flight is made from that number.

const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');

const APP_DIR = path.join(__dirname, '..');
const HARNESS = path.join(__dirname, 'fixtures', 'card-geometry-harness.js');

const child = spawn(path.join(APP_DIR, 'node_modules', '.bin', 'electron'), [HARNESS, '--no-sandbox'], {
  cwd: APP_DIR,
  detached: true,
  env: process.env,
});

let output = '';
child.stdout.on('data', (d) => (output += d.toString()));
child.stderr.on('data', () => {});

function finish(code) {
  killApp(child);
  setTimeout(() => process.exit(code), 200);
}

child.on('exit', () => {
  const match = /CARD_GEOMETRY (\[.*\])/.exec(output);
  if (!match) {
    console.error('[card-geometry] FAIL: the harness produced no measurements');
    console.error(output.slice(-1200));
    return finish(1);
  }

  const results = JSON.parse(match[1]);
  let failed = false;

  for (const r of results) {
    if (!r.fontLoaded) {
      console.error(`[card-geometry] FAIL: ${r.card} — B612 did not load, so these widths mean nothing`);
      failed = true;
    }

    if (r.clipped.length) {
      console.error(`[card-geometry] FAIL: ${r.card} — ${r.clipped.length} value(s) do not fit their column:`);
      for (const c of r.clipped) {
        console.error(`  "${c.text}" needs ${c.need}px, has ${c.have}px  (${c.cls})`);
      }
      console.error(
        '  These do not error — they ellipsis. A truncated value still reads as a value, which on a\n' +
          '  mission card means a pilot flies a bullseye or a threat list that is missing its tail.\n' +
          '  Either the column is too narrow or the card says too much for it; both are card bugs.',
      );
      failed = true;
    }

    if (!r.tables) {
      console.error(`[card-geometry] FAIL: ${r.card} — no .card__rows found, so alignment proves nothing`);
      failed = true;
    }
    // Content hanging OUTSIDE the box it belongs to. A different failure from
    // clipping and invisible to that check: nothing is truncated, the text
    // just sits past its own border. A comms grid with the wrong number of
    // tracks does exactly this — the ferry template's second block hung 215px
    // outside itself and `clipped` reported nothing, because no cell was cut.
    if (r.escaped && r.escaped.length) {
      console.error(`[card-geometry] FAIL: ${r.card} — ${r.escaped.length} row(s) hang outside their block:`);
      for (const e of r.escaped.slice(0, 8)) {
        console.error(`  ${e.block}: "${e.text}" sits ${e.over}px past the block's right edge`);
      }
      console.error(
        '  Nothing is clipped here — the text is simply outside the border it belongs to, which is\n' +
          '  what a block laid into a track narrower than its content does. Check that the column\n' +
          '  count in the CSS is not fixed to the number of blocks one particular template happens to have.',
      );
      failed = true;
    }

    if (r.misaligned && r.misaligned.length) {
      console.error(`[card-geometry] FAIL: ${r.card} — ${r.misaligned.length} column(s) do not line up:`);
      for (const m of r.misaligned) {
        console.error(`  ${m.title} column ${m.col} starts at ${m.xs.join(', ')}px on different rows`);
      }
      console.error(
        '  A column has to mean the same thing all the way down. A row missing a value must leave a\n' +
          '  gap in ITS column, not slide everything after it left — otherwise a pilot reads a heading\n' +
          '  where the row above has an altitude.',
      );
      failed = true;
    }

    // The sheet is a fixed 893 x 1263 and the whole design is built around
    // fitting inside it. Overflow means a block is off the bottom of the
    // kneeboard, where a pilot cannot scroll to it in flight.
    //
    // The `full` fixture is DELIBERATELY over-long — it exists to prove the
    // check bites. It should become an import-time refusal (card.js has the
    // measured height model, not yet wired up because it comes out 132px
    // light); until then this is where a too-long card is caught.
    // The over-long fixture, in either mode. Edit mode adds a row bar per
    // block, so it overflows by more — still on purpose.
    if (r.card.startsWith('full')) {
      if (r.scrollH <= r.clientH + 1) {
        console.error('[card-geometry] FAIL: the over-long fixture now fits — the overflow check proves nothing');
        failed = true;
      } else {
        console.log(
          `[card-geometry] note: ${r.card} overflows by ${r.scrollH - r.clientH}px, as intended — ` +
            'this fixture exists to keep the check honest',
        );
      }
    } else if (r.scrollH > r.clientH + 1) {
      console.error(
        `[card-geometry] FAIL: ${r.card} — the sheet overflows by ${r.scrollH - r.clientH}px ` +
          `(${r.scrollH} of ${r.clientH}). Anything past the bottom edge is unreachable in flight.`,
      );
      failed = true;
    }

    console.log(
      `[card-geometry] ${r.card}: ${r.clipped.length} clipped, ` +
        `${Math.max(0, r.scrollH - r.clientH)}px overflow, B612 ${r.fontLoaded ? 'loaded' : 'MISSING'}`,
    );
  }

  console.log(failed ? '[dev-card-geometry-test] FAIL' : '[dev-card-geometry-test] PASS');
  finish(failed ? 1 : 0);
});

setTimeout(() => {
  console.error('[card-geometry] FAIL: timeout');
  finish(1);
}, 90000);
