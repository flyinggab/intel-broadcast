'use strict';

// Asserts against PIXELS. The rest of the suite asserts against state and
// class attributes, which is how the launcher shipped opening underneath the
// BRIEF stage: `launcherOpen` was true, `is-hidden` was gone, the hit test
// passed, and the pilot was looking at STANDBY with no way off the page.
//
// The rule enforced here is deliberately blunt and needs no golden images:
//
//     opening the menu must visibly change the screen.
//
// A control that claims to show something and changes no pixels is not on
// screen, whatever the state says. That holds on any machine and survives
// font rasterisation differences between macOS, WSL and CI, which is exactly
// what stored reference screenshots do not.
//
//   node scripts/dev-visual-test.js                 assert only
//   node scripts/dev-visual-test.js --out shots/    also write the frames out,
//                                                   for when a human wants to
//                                                   look at what failed
//
// The captures are worth keeping when a case fails: a picture of the wrong
// screen answers "what did it actually look like" in one step.

const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');

const APP_DIR = path.join(__dirname, '..');
const HARNESS = path.join(__dirname, 'fixtures', 'visual-harness.js');

const outIndex = process.argv.indexOf('--out');
const outDir = outIndex !== -1 ? process.argv[outIndex + 1] : null;
if (outIndex !== -1 && !outDir) {
  console.error('usage: node scripts/dev-visual-test.js [--out <dir>]');
  process.exit(1);
}

const args = [HARNESS, '--no-sandbox'];
if (outDir) args.push('--out', path.resolve(outDir));

const child = spawn(path.join(APP_DIR, 'node_modules', '.bin', 'electron'), args, {
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
  const failure = /VISUAL_ERROR (.*)/.exec(output);
  if (failure) {
    console.error(`[visual] FAIL: harness errored — ${failure[1]}`);
    return finish(1);
  }

  const match = /VISUAL (\[.*\])/.exec(output);
  if (!match) {
    console.error('[visual] FAIL: harness captured nothing');
    console.error(output.slice(-800));
    return finish(1);
  }

  const results = JSON.parse(match[1]);
  let failed = false;

  for (const r of results) {
    if (r.changed < r.minChanged) {
      console.error(
        `[visual] FAIL: "${r.name}" — opening the launcher changed ${(r.changed * 100).toFixed(2)}% ` +
          `of the frame, needs at least ${(r.minChanged * 100).toFixed(0)}%. ` +
          `The menu is open and not visible. Stacking: ${JSON.stringify(r.stack)}`,
      );
      console.error('[visual]       re-run with --out <dir> to see the frames.');
      failed = true;
    } else {
      console.log(`[visual] "${r.name}": ${(r.changed * 100).toFixed(1)}% of the frame changed`);
    }
  }

  // While a presenter holds a follower's controls, main refuses to act on
  // them. Anything still on screen would press and do nothing, which is the
  // exact experience this app has already shipped once.
  const controlsMatch = /VISUAL_CONTROLS (\{.*\})/.exec(output);
  if (!controlsMatch) {
    console.error('[visual] FAIL: the held-controls probe never reported');
    failed = true;
  } else {
    const { held, idle, dragTrapped } = JSON.parse(controlsMatch[1]);
    // The window is frameless, so part of the chrome has to be draggable —
    // and a control that lands inside that region silently stops responding.
    if (dragTrapped.bad.length) {
      console.error(
        `[visual] FAIL: controls sit inside a window-drag region and will not take clicks: ` +
          dragTrapped.bad.join('; '),
      );
      failed = true;
    }
    if (!dragTrapped.handleIsDrag) {
      console.error(
        '[visual] FAIL: nothing in the strip is draggable — a frameless window that cannot be moved',
      );
      failed = true;
    }
    const stillShowing = Object.keys(held).filter((k) => held[k]);
    if (stillShowing.length) {
      console.error(
        `[visual] FAIL: a follower whose controls are held can still see ${stillShowing.join(', ')} — ` +
          'they press and nothing happens',
      );
      failed = true;
    }
    // The positive half: if the probe reported "hidden" for everything
    // regardless, the check above would pass while measuring nothing.
    const missingWhenIdle = ['menukey', 'prev', 'next'].filter((k) => !idle[k]);
    if (missingWhenIdle.length) {
      console.error(
        `[visual] FAIL: ${missingWhenIdle.join(', ')} missing with no brief running — ` +
          'either navigation is broken, or this probe is not measuring what it claims',
      );
      failed = true;
    }
    if (!failed) console.log('[visual] held follower shows no dead controls; idle shows them all');
  }

  if (failed) return finish(1);
  console.log('[dev-visual-test] PASS');
  finish(0);
});
