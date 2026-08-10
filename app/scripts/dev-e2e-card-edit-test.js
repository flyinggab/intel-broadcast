'use strict';

// Editing a card on the sheet, in a real window: the mode, the typing, the
// keyboard, rows, persistence, and the two things that must refuse.
//
// Usage: node scripts/dev-e2e-card-edit-test.js
//
// A fresh userData per run. Edits persist THERE — that is the feature — so a
// test reusing a directory would be testing the previous run's leftovers.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const CARD = path.join(APP_DIR, '..', 'design', 'kneeboard', 'foxhunt2-roman1.card.json');

const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'taclink-edit-e2e-'));
const CONFIG = path.join(UD, 'config.json');
const EVAL = path.join(UD, 'eval.js');
fs.writeFileSync(
  CONFIG,
  // HOSTING, on purpose. With no relay to reach, the client retries forever
  // and every failed attempt fires 'disconnected', which releases the
  // presenter lock by design — so a brief could never stay started long
  // enough to assert anything about it.
  JSON.stringify({
    relayHostEnabled: true,
    token: 'edit-e2e-token-long-enough',
    callsign: 'GHOSTRIDER 1-1',
    okb: { enabled: false },
    gm: { relayPort: 8941, funnelEnabled: false },
  }),
);

let child = null;
let output = '';

function boot() {
  output = '';
  child = spawn(ELECTRON_BIN, ['.', '--no-sandbox', `--user-data-dir=${UD}`], {
    cwd: APP_DIR,
    detached: true,
    env: {
      ...process.env,
      INTEL_BROADCAST_LOCAL_CONFIG_PATH: CONFIG,
      INTEL_BROADCAST_VIEWER_PANEL_PROBE: '1',
      INTEL_BROADCAST_VIEWER_EVAL_PATH: EVAL,
      INTEL_BROADCAST_TEST_PICK_PATH: '1',
    },
  });
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', () => {});
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup(code) {
  if (child) killApp(child);
  setTimeout(() => {
    fs.rmSync(UD, { recursive: true, force: true });
    process.exit(code);
  }, 1600);
}

async function run(js) {
  fs.writeFileSync(EVAL, `(() => { ${js} })()`);
  const deadline = Date.now() + 15000;
  while (fs.existsSync(EVAL)) {
    if (Date.now() > deadline) throw new Error('renderer never picked up');
    await sleep(100);
  }
  await sleep(350);
}

async function probe(tag, js) {
  const marker = `ED_${tag}_${Date.now()}`;
  await run(`console.log(${JSON.stringify(marker)} + ' ' + JSON.stringify((() => { ${js} })()))`);
  const line = output.split('\n').reverse().find((l) => l.includes(marker));
  if (!line) throw new Error(`no readout for ${tag}`);
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length + 1));
}

/** Types into the value at `path` and leaves by `key`. */
const typeInto = (path, text, key) => `
  const box = [...document.querySelectorAll('.card__ed')].find((e) => e.dataset.path === ${JSON.stringify(path)});
  if (!box) throw new Error('no editable at ${path}');
  box.click();
  box.textContent = ${JSON.stringify(text)};
  box.dispatchEvent(new KeyboardEvent('keydown', { key: ${JSON.stringify(key)}, bubbles: true }));
`;

const valueAt = (path) => `
  const box = [...document.querySelectorAll('.card__ed')].find((e) => e.dataset.path === ${JSON.stringify(path)});
  return box ? box.textContent : null;
`;

async function waitForCard() {
  const by = Date.now() + 25000;
  while (!output.includes('[card] loaded') && Date.now() < by) await sleep(200);
  if (!output.includes('[card] loaded')) throw new Error(`the card never loaded:\n${output.split('\n').slice(-12).join('\n')}`);
}

async function main() {
  boot();
  const started = Date.now() + 40000;
  while (!output.includes('PANEL_PROBE') && Date.now() < started) await sleep(300);
  if (!output.includes('PANEL_PROBE')) throw new Error('the app never started');
  await sleep(1200);

  await run(`window.viewerAPI.send('card-import', ${JSON.stringify(CARD)})`);
  await waitForCard();
  await run(`window.viewerAPI.send('set-page', 'card')`);
  await sleep(600);

  // EDIT IS OFF. Nothing on the sheet is editable until it is asked for.
  const off = await probe('off', `return {
    editables: document.querySelectorAll('.card__ed').length,
    rowbars: document.querySelectorAll('.card__rowbar').length,
    ticksLive: getComputedStyle(document.querySelector('.card__tick')).pointerEvents !== 'none',
  }`);
  if (off.editables || off.rowbars) throw new Error('the sheet is editable before EDIT was turned on');
  if (!off.ticksLive) throw new Error('the ticks are inert with EDIT off');
  console.log('[e2e] with EDIT off nothing is editable and the ticks still work');

  await run(`window.viewerAPI.send('card-edit-mode', true)`);
  await sleep(700);
  const on = await probe('on', `
    const eds = [...document.querySelectorAll('.card__ed')];
    return {
      editables: eds.length,
      paths: eds.slice(0, 3).map((e) => e.dataset.path),
      ticksLive: getComputedStyle(document.querySelector('.card__tick')).pointerEvents !== 'none',
      rowbars: document.querySelectorAll('.card__rowbar').length,
      kills: document.querySelectorAll('.card__rowkill').length,
    };
  `);
  if (on.editables < 40) throw new Error(`only ${on.editables} editable values — the sheet has far more than that`);
  if (on.ticksLive) throw new Error('the ticks still take clicks while editing — one thing a click can mean at a time');
  if (!on.rowbars || !on.kills) throw new Error('no row keys in edit mode');
  console.log(`[e2e] EDIT on: ${on.editables} values editable, ticks inert, ${on.kills} row keys`);

  // THE COMPOSITE CASE. "{alt} / {speed}" must be two values, not one, and the
  // slash between them must not be editable — it is the template's, not the
  // mission's.
  const gate = await probe('gate', `
    const cell = document.querySelector('.card__step-gate');
    const eds = [...cell.querySelectorAll('.card__ed')];
    return { pieces: eds.length, paths: eds.map((e) => e.dataset.path), text: cell.textContent,
             between: cell.childNodes.length > 1 ? [...cell.childNodes].filter((n) => n.nodeType === 3).map((n) => n.textContent).join('') : '' };
  `);
  if (gate.pieces !== 2) throw new Error(`the route gate renders ${gate.pieces} editable pieces, expected 2`);
  if (!gate.between.includes('/')) throw new Error("the template's slash is missing or editable");
  console.log(`[e2e] a joined cell is two values around fixed text: ${gate.paths.join(' + ')}`);

  // TYPING, and Tab landing on the next value. The sheet is rebuilt by the
  // commit, so this also proves focus survives that.
  await run(typeInto('flight.callsign', 'TEST 9-9', 'Tab'));
  await sleep(900);
  const tabbed = await probe('tabbed', `
    const open = document.querySelector('.card__ed--open');
    const box = [...document.querySelectorAll('.card__ed')].find((e) => e.dataset.path === 'flight.callsign');
    return { value: box ? box.textContent : null, open: open ? open.dataset.path : null };
  `);
  if (tabbed.value !== 'TEST 9-9') throw new Error(`the value reads "${tabbed.value}" after typing`);
  if (!tabbed.open) throw new Error('Tab committed but landed nowhere — the sheet is rebuilt by the commit and focus has to survive it');
  console.log(`[e2e] typing commits and Tab lands on the next value (${tabbed.open})`);

  // ESC PUTS IT BACK. Nothing is sent, so nothing changed.
  await run(`
    const box = [...document.querySelectorAll('.card__ed')].find((e) => e.dataset.path === 'flight.callsign');
    box.click(); box.textContent = 'RUBBISH';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  `);
  await sleep(700);
  const escaped = await probe('esc', valueAt('flight.callsign'));
  if (escaped !== 'TEST 9-9') throw new Error(`Esc left "${escaped}" instead of putting the old value back`);
  console.log('[e2e] Esc puts the old value back');

  // ARROWS MOVE BY GRID. Down from an altitude must land on the NEXT LEG's
  // altitude, not on its note — that is the whole reason arrows exist here
  // alongside Tab.
  await run(`
    const box = [...document.querySelectorAll('.card__ed')].find((e) => e.dataset.path === 'route.steps[0].alt');
    box.click();
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
  `);
  await sleep(700);
  const down = await probe('down', `
    const open = document.querySelector('.card__ed--open');
    return open ? open.dataset.path : null;
  `);
  if (down !== 'route.steps[1].alt') {
    throw new Error(`down from route.steps[0].alt landed on ${down}, not the next leg's altitude`);
  }
  console.log('[e2e] down from an altitude lands on the next leg\'s altitude');

  // THE PROSE LIST — GAME PLAN. Its rows are STRINGS, not rows of fields, and
  // the + ROW key pushed an object into one: the resolver refused the card,
  // the sheet silently reverted, and — worse — the bad row stayed in the data,
  // so every later edit was refused too. One press poisoned the card.
  const prose = await probe('prose', `
    const sec = [...document.querySelectorAll('.card__section')].find((x) => /GAME PLAN/.test(x.textContent));
    return {
      items: sec.querySelectorAll('.card__prose-list li').length,
      kills: sec.querySelectorAll('.card__rowkill').length,
      addKey: Boolean(sec.querySelector('[data-row-add]')),
    };
  `);
  if (!prose.addKey) throw new Error('the prose block has no way to add a line');
  if (!prose.kills) throw new Error('the prose block has no way to remove a line');

  const beforeProse = output.length;
  await run(`
    const sec = [...document.querySelectorAll('.card__section')].find((x) => /GAME PLAN/.test(x.textContent));
    sec.querySelector('[data-row-add]').click();
  `);
  await sleep(900);
  const proseAdded = await probe('proseAdded', `
    const sec = [...document.querySelectorAll('.card__section')].find((x) => /GAME PLAN/.test(x.textContent));
    return { items: sec.querySelectorAll('.card__prose-list li').length };
  `);
  if (proseAdded.items !== prose.items + 1) {
    throw new Error(`+ ROW on the prose list gave ${proseAdded.items} lines, expected ${prose.items + 1}`);
  }
  if (/cannot render|must be strings/.test(output.slice(beforeProse))) {
    throw new Error('adding a prose line produced a card the template refuses');
  }
  console.log(`[e2e] a line is added to the game plan (${prose.items} -> ${proseAdded.items})`);

  // ENTER IN A LIST IS A NEW LINE. There was previously no way to add one at
  // all, and Enter committed-and-moved like a spreadsheet cell.
  await run(`
    const sec = [...document.querySelectorAll('.card__section')].find((x) => /GAME PLAN/.test(x.textContent));
    const box = sec.querySelector('.card__ed');
    box.click();
    box.textContent = 'REWRITTEN LINE';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  `);
  await sleep(1000);
  const broke = await probe('broke', `
    const sec = [...document.querySelectorAll('.card__section')].find((x) => /GAME PLAN/.test(x.textContent));
    const open = document.querySelector('.card__ed--open');
    return {
      first: sec.querySelector('.card__ed').textContent,
      items: sec.querySelectorAll('.card__prose-list li').length,
      open: open ? open.dataset.path : null,
    };
  `);
  if (broke.first !== 'REWRITTEN LINE') {
    throw new Error(`Enter lost the edit — the line reads "${broke.first}"`);
  }
  if (broke.items !== proseAdded.items + 1) {
    throw new Error(`Enter gave ${broke.items} lines, expected ${proseAdded.items + 1} — it must open a new one`);
  }
  if (!broke.open) throw new Error('Enter added a line and landed nowhere');
  console.log(`[e2e] Enter keeps the edit and opens a new line (${broke.open})`);

  // A ROW ADDED, AND THE TICKS THAT MUST MOVE WITH IT.
  const before = await probe('rowsBefore', `return {
    legs: document.querySelectorAll('.card__step').length,
    done: [...document.querySelectorAll('.card__step')].map((r) => r.classList.contains('card__step--done')),
    count: (document.querySelector('.card__rowcount') || {}).textContent,
  }`);
  await run(`document.querySelector('[data-row-add="route.steps"]').click()`);
  await sleep(900);
  const added = await probe('rowsAfter', `return {
    legs: document.querySelectorAll('.card__step').length,
    done: [...document.querySelectorAll('.card__step')].map((r) => r.classList.contains('card__step--done')),
  }`);
  if (added.legs !== before.legs + 1) throw new Error(`adding a row gave ${added.legs} legs, expected ${before.legs + 1}`);
  console.log(`[e2e] a row is added (${before.legs} -> ${added.legs}, cap "${before.count}")`);

  // Remove the FIRST leg, which is flown. Every tick below it must slide up
  // with its own step — a tick left on the wrong leg is the app confidently
  // lying about where the flight is.
  await run(`document.querySelector('[data-row-remove="route.steps"][data-row-index="0"]').click()`);
  await sleep(900);
  const removed = await probe('removed', `return {
    legs: document.querySelectorAll('.card__step').length,
    done: [...document.querySelectorAll('.card__step')].map((r) => r.classList.contains('card__step--done')),
    first: (document.querySelector('.card__step-name') || {}).textContent,
  }`);
  if (removed.legs !== added.legs - 1) throw new Error('removing a row did not remove a row');
  const expected = added.done.slice(1);
  if (JSON.stringify(removed.done) !== JSON.stringify(expected)) {
    throw new Error(
      `removing leg 1 left the flown marks at ${JSON.stringify(removed.done)}, expected ${JSON.stringify(expected)} — ` +
        'ticks are keyed by row index and must move with their step',
    );
  }
  console.log('[e2e] removing a leg carries every tick below it up with its own step');

  // CASTING IS REFUSED WHILE EDITING, in MAIN — not merely by hiding a key,
  // because the hotkey reaches the same intent without passing through the UI.
  // On CARD the cast key SENDS THE CARD; it is not a presenting toggle, which
  // is why this watches the log rather than the key's lit state.
  const beforeCast = output.length;
  await run(`window.viewerAPI.send('brief-present', true)`);
  await sleep(800);
  const castTail = output.slice(beforeCast);
  if (/\[card\] sent to/.test(castTail)) throw new Error('the card was cast while the pilot was mid-edit');
  if (!/not while you are editing/.test(castTail)) throw new Error('casting mid-edit was refused silently');
  console.log('[e2e] casting is refused while editing, and says so');

  // And the other way: EDIT is refused while presenting.
  await run(`window.viewerAPI.send('card-edit-mode', false)`);
  await sleep(400);
  await run(`window.viewerAPI.send('set-page', 'brief')`);
  await sleep(400);
  await run(`window.viewerAPI.send('brief-present', true)`);
  await sleep(700);
  // Nothing below proves anything unless a brief actually started.
  const live = await probe('startedCasting', `
    const c = document.getElementById('brief-cast');
    return {
      live: c.classList.contains('is-live'),
      page: document.body.dataset.page,
      title: c.title,
      hidden: c.classList.contains('is-hidden'),
      toolsHidden: document.getElementById('brief-tools').classList.contains('is-hidden'),
      inkLive: document.getElementById('stage-ink').classList.contains('is-live'),
    };`);
  if (!live.live) {
    throw new Error(`on ${live.page}, pressing cast did not start a brief`);
  }

  const beforeEdit = output.length;
  await run(`window.viewerAPI.send('set-page', 'card')`);
  await sleep(500);
  await run(`window.viewerAPI.send('card-edit-mode', true)`);
  await sleep(600);
  const whilePresenting = await probe('whilePresenting', `return {
    editables: document.querySelectorAll('.card__ed').length,
    editKeyShown: !document.getElementById('card-edit').classList.contains('is-hidden'),
  }`);
  if (whilePresenting.editables) throw new Error('editing started while the pilot was casting');
  if (whilePresenting.editKeyShown) throw new Error('EDIT is offered while casting');
  if (!/not while you are casting/.test(output.slice(beforeEdit))) {
    throw new Error('editing while casting was refused silently');
  }
  console.log('[e2e] and editing is refused while casting, both ways enforced in main');

  // THE PRESENTER BAR IS GONE. The cast key toggles, so a bar with its own
  // STOP key was a second control for one action. The follower COUNT moved
  // onto the key rather than vanishing with the bar.
  const presenting = await probe('presenting', `
    const bar = document.getElementById('briefbar');
    return {
      casting: document.getElementById('brief-cast').classList.contains('is-live'),
      barShown: Boolean(bar && !bar.classList.contains('is-hidden')),
      castSays: document.getElementById('brief-cast').title,
    };
  `);
  if (!presenting.casting) throw new Error('the pilot is not casting, so this proves nothing about the bar');
  if (presenting.barShown) throw new Error('the presenter still gets a bar — the cast key already says it and stops it');
  if (!/\d/.test(presenting.castSays)) {
    throw new Error(`the cast key says "${presenting.castSays}" — the follower count must not vanish with the bar`);
  }
  console.log(`[e2e] no presenter bar; the cast key carries it: "${presenting.castSays}"`);

  // PERSISTENCE. Edits survive a restart, and the file the pilot imported is
  // never written to.
  await run(`window.viewerAPI.send('brief-present', false)`);
  await sleep(400);
  const onDisk = JSON.parse(fs.readFileSync(CARD, 'utf8'));
  if (onDisk.flight.callsign === 'TEST 9-9') {
    throw new Error('the card file the pilot imported was rewritten — it is theirs, not ours');
  }
  console.log('[e2e] the imported file is untouched');

  killApp(child);
  await sleep(2500);
  boot();
  const again = Date.now() + 40000;
  while (!output.includes('PANEL_PROBE') && Date.now() < again) await sleep(300);
  await waitForCard();
  await run(`window.viewerAPI.send('set-page', 'card')`);
  await sleep(600);
  const kept = await probe('kept', `
    const band = document.querySelector('.card__band');
    return { text: band ? band.textContent : null, legs: document.querySelectorAll('.card__step').length };
  `);
  if (!kept.text || !kept.text.includes('TEST 9-9')) {
    throw new Error(`after a restart the card reads "${kept.text}" — the edit did not survive`);
  }
  if (kept.legs !== removed.legs) throw new Error(`after a restart there are ${kept.legs} legs, expected ${removed.legs}`);
  console.log(`[e2e] and after a restart the edits are still there (${kept.legs} legs)`);

  console.log('[dev-e2e-card-edit-test] PASS');
  cleanup(0);
}

main().catch((err) => {
  console.error(`[dev-e2e-card-edit-test] FAIL: ${err.message}`);
  console.error('--- last 20 lines ---');
  console.error(output.split('\n').filter((l) => !l.includes('PANEL_PROBE')).slice(-20).join('\n'));
  cleanup(1);
});

setTimeout(() => {
  console.error('[dev-e2e-card-edit-test] FAIL: timeout');
  cleanup(1);
}, 240000);
