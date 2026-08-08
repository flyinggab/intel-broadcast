'use strict';

// Ticking route steps on a real card, in a real window.
//
// Usage: node scripts/dev-e2e-card-test.js
//
// dev-card-test checks the resolver and dev-card-geometry-test checks the
// render. Neither could catch the bug this exists for, because it needed the
// card DATA, MAIN and the RENDERER to disagree with each other:
//
//   A card says a leg is flown in one of two ways — a `complete` flag, or a
//   state of "done". The renderer treated either as done. The pilot's tick
//   wrote `done`. So for any step whose card said `state: "done"`, unticking
//   was impossible: the tick set done=false, `state` still said "done", the OR
//   kept the row flown, and the first three legs of the example card simply
//   would not respond. Nothing errored; the click was received and handled.
//
// Whether a step is flown now lives in exactly one field. This test flies the
// whole loop — initial, tick, untick — because each piece is individually
// correct and only the round trip shows the disagreement.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const CONFIG_PATH = path.join(APP_DIR, 'card-e2e-config.local.json');
const EVAL_PATH = path.join(APP_DIR, 'card-e2e-eval.js');
const CARD = path.join(APP_DIR, '..', 'design', 'kneeboard', 'foxhunt2-roman1.card.json');

fs.rmSync(EVAL_PATH, { force: true });
fs.writeFileSync(
  CONFIG_PATH,
  JSON.stringify({ relayHostEnabled: false, token: 'card-e2e-token-long-enough', callsign: 'GHOSTRIDER 1-1' }),
);

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox'], {
  cwd: APP_DIR,
  detached: true,
  env: {
    ...process.env,
    INTEL_BROADCAST_LOCAL_CONFIG_PATH: CONFIG_PATH,
    INTEL_BROADCAST_VIEWER_PANEL_PROBE: '1',
    INTEL_BROADCAST_VIEWER_EVAL_PATH: EVAL_PATH,
    INTEL_BROADCAST_CARD_PATH: CARD,
  },
});

let output = '';
child.stdout.on('data', (d) => (output += d.toString()));
child.stderr.on('data', () => {});

function cleanup(code) {
  fs.rmSync(CONFIG_PATH, { force: true });
  fs.rmSync(EVAL_PATH, { force: true });
  killApp(child);
  // Wait for the process to actually die: an Electron instance outliving its
  // test holds the single-instance lock and the next test's app then exits 0
  // with no output at all (CLAUDE.md's trap, self-inflicted by the suite).
  const started = Date.now();
  const poll = setInterval(() => {
    let alive = true;
    try {
      process.kill(child.pid, 0);
    } catch {
      alive = false;
    }
    if (!alive || Date.now() - started > 5000) {
      clearInterval(poll);
      // The shim dying is not the real binary dying: killApp signals the whole
      // process group, but Electron's own children take a moment to go, and
      // whichever still holds userData holds the single-instance lock. 200ms
      // was not enough — the next two Electron tests in the suite came back
      // with completely empty output.
      setTimeout(() => process.exit(code), 1500);
    }
  }, 100);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function run(js) {
  fs.writeFileSync(EVAL_PATH, `(() => { ${js} })()`);
  const deadline = Date.now() + 10000;
  while (fs.existsSync(EVAL_PATH)) {
    if (Date.now() > deadline) throw new Error(`renderer never picked up: ${js.slice(0, 50)}`);
    await sleep(100);
  }
  await sleep(500);
}

/** The first N route rows, as the pilot sees them. */
async function steps(tag, n = 4) {
  const marker = `STEPS_${tag}_${Date.now()}`;
  await run(`
    const rows = [...document.querySelectorAll('.card__step')].slice(0, ${n});
    console.log(${JSON.stringify(marker)} + ' ' + JSON.stringify(rows.map((r) => ({
      name: r.querySelector('.card__step-name').textContent,
      done: r.classList.contains('card__step--done'),
      current: r.classList.contains('card__step--current'),
    }))));
  `);
  const line = output.split('\n').reverse().find((l) => l.includes(marker));
  if (!line) throw new Error(`no step readout for ${tag}`);
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length + 1));
}

async function main() {
  // Wait for the window, then go to CARD.
  const deadline = Date.now() + 30000;
  while (!output.includes('[card] loaded') && Date.now() < deadline) await sleep(300);
  if (!output.includes('[card] loaded')) throw new Error('the card never loaded');
  await sleep(1500);
  await run(`window.viewerAPI.send('set-page', 'card')`);
  await sleep(600);

  const before = await steps('initial');
  if (before.length < 4) throw new Error(`expected route rows, got ${before.length}`);
  const flown = before.filter((s) => s.done).length;
  if (flown === 0) {
    throw new Error('the example card marks its opening legs flown; none rendered as done, so this proves nothing');
  }
  if (!before.some((s) => s.current)) throw new Error('one step must render as current');
  console.log(`[e2e] card loads with ${flown} leg(s) already flown and one current`);

  // THE ONE THAT MATTERS: a leg the CARD called flown must untick.
  await run(`document.querySelectorAll('.card__tick')[0].click()`);
  const afterUntick = await steps('untick');
  if (afterUntick[0].done) {
    throw new Error(
      `"${before[0].name}" was marked flown by the card and would not untick. Whether a step is ` +
        'flown must live in ONE field: if the renderer also accepts state === "done", the tick ' +
        'writes done=false, state still says done, and the row can never be cleared.',
    );
  }
  console.log(`[e2e] a leg the card called flown unticks (${before[0].name})`);

  // And back, because a toggle that only goes one way is not a toggle — it is
  // what makes a plain click safe enough to replace the design's hold.
  await run(`document.querySelectorAll('.card__tick')[0].click()`);
  const afterRetick = await steps('retick');
  if (!afterRetick[0].done) throw new Error(`"${before[0].name}" would not tick again`);
  console.log('[e2e] and ticks again — the toggle round-trips');

  // Ticking one step must not disturb its neighbours.
  for (let i = 1; i < before.length; i += 1) {
    if (afterRetick[i].done !== before[i].done) {
      throw new Error(`ticking ${before[0].name} changed ${before[i].name}`);
    }
  }
  console.log('[e2e] neighbouring legs are untouched');

  console.log('[dev-e2e-card-test] PASS');
  cleanup(0);
}

main().catch((err) => {
  console.error(`[dev-e2e-card-test] FAIL: ${err.message}`);
  console.error('--- last 25 lines ---');
  console.error(output.split('\n').slice(-25).join('\n'));
  cleanup(1);
});

setTimeout(() => {
  console.error('[dev-e2e-card-test] FAIL: timeout');
  cleanup(1);
}, 120000);
