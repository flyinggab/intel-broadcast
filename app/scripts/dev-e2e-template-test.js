'use strict';

// The template library in a real window: what ships, importing one, naming it,
// choosing it, refusing a file that is not a template, and removing it again.
//
// Usage: node scripts/dev-e2e-template-test.js
//
// The file dialog cannot be driven from here, so the import is triggered
// through the same intent the key sends with the path supplied — everything
// AFTER the dialog is the real path, which is where all the behaviour is.
//
// A fresh userData directory per run, deliberately: the library is partly
// on disk, and a test that passes only because a previous run left a
// template behind is a test that proves nothing about a new install.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const SAMPLES = path.join(APP_DIR, '..', 'design', 'kneeboard', 'samples');
const FERRY_LAYOUT = path.join(SAMPLES, 'ferry-flight.layout.json');
const FERRY_CARD = path.join(SAMPLES, 'colt21-ferry.card.json');
const STRIKE_CARD = path.join(APP_DIR, '..', 'design', 'kneeboard', 'foxhunt2-roman1.card.json');

const UD = fs.mkdtempSync(path.join(os.tmpdir(), 'taclink-tpl-e2e-'));
const CONFIG = path.join(UD, 'config.json');
const EVAL = path.join(UD, 'eval.js');
// Not a template: valid JSON, wrong shape. The everyday mistake.
const NOT_A_TEMPLATE = path.join(UD, 'mission-notes.json');
fs.writeFileSync(NOT_A_TEMPLATE, JSON.stringify({ notes: ['push at 0940'] }));

fs.writeFileSync(
  CONFIG,
  JSON.stringify({ relayHostEnabled: false, token: 'tpl-e2e-token-long-enough', callsign: 'GHOSTRIDER 1-1' }),
);

const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox', `--user-data-dir=${UD}`], {
  cwd: APP_DIR,
  detached: true,
  env: {
    ...process.env,
    INTEL_BROADCAST_LOCAL_CONFIG_PATH: CONFIG,
    INTEL_BROADCAST_VIEWER_PANEL_PROBE: '1',
    INTEL_BROADCAST_VIEWER_EVAL_PATH: EVAL,
    // NO INTEL_BROADCAST_CARD_PATH. That override beats config.cardPath by
    // design, so with it set every card-import in this test would silently
    // reload the same card — which is exactly how the first version of this
    // test "passed" while loading the strike card in place of the ferry one.
    // Every card here goes in the way a pilot puts one in.
    // Lets the import intent take a path instead of opening a file dialog.
    INTEL_BROADCAST_TEST_PICK_PATH: '1',
  },
});

let output = '';
child.stdout.on('data', (d) => (output += d.toString()));
child.stderr.on('data', () => {});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cleanup(code) {
  killApp(child);
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
  await sleep(400);
}

async function probe(tag, js) {
  const marker = `TPL_${tag}_${Date.now()}`;
  await run(`console.log(${JSON.stringify(marker)} + ' ' + JSON.stringify((() => { ${js} })()))`);
  const line = output.split('\n').reverse().find((l) => l.includes(marker));
  if (!line) throw new Error(`no readout for ${tag}`);
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length + 1));
}

/** The library as the pilot sees it. `offsetParent` rather than a class: a
 *  page hidden by a CSS rule that never listed it is exactly the bug this
 *  found on the way in — the markup was perfect and the window was blank. */
const LIB = `
  const tiles = [...document.querySelectorAll('.tpl')];
  const naming = document.querySelector('.tplask');
  const bad = document.querySelector('.tplbad');
  return {
    visiblePage: [...document.querySelectorAll('.page[data-page]')].filter((p) => p.offsetParent !== null).map((p) => p.dataset.page)[0] || null,
    libVisible: (() => { const l = document.getElementById('lib'); return Boolean(l && l.offsetParent !== null && l.getBoundingClientRect().width > 0); })(),
    groups: [...document.querySelectorAll('.lib__group')].map((n) => n.textContent),
    tiles: tiles.map((t) => ({
      id: t.querySelector('[data-template]') ? t.querySelector('[data-template]').dataset.template : null,
      name: (t.querySelector('.tpl__name') || {}).textContent,
      inUse: t.classList.contains('tpl--on'),
      removable: Boolean(t.querySelector('[data-remove-template]')),
    })),
    naming: naming ? { name: (document.getElementById('tpl-name') || {}).value, text: naming.textContent } : null,
    refused: bad ? bad.textContent : null,
    bar: [...document.querySelectorAll('#abar .akey')].filter((k) => k.offsetParent !== null).map((k) => k.id || k.dataset.view),
  };
`;

async function main() {
  const deadline = Date.now() + 40000;
  while (!output.includes('PANEL_PROBE') && Date.now() < deadline) await sleep(300);
  if (!output.includes('PANEL_PROBE')) throw new Error(`the app never started:\n${output.split('\n').slice(-15).join('\n')}`);
  await sleep(1500);

  // A card, put in the way a pilot puts one in.
  await run(`window.viewerAPI.send('card-import', ${JSON.stringify(STRIKE_CARD)})`);
  const cardBy = Date.now() + 20000;
  while (!output.includes('[card] loaded') && Date.now() < cardBy) await sleep(200);
  if (!output.includes('[card] loaded')) throw new Error('the strike card never loaded');
  await sleep(600);

  await run(`window.viewerAPI.send('set-page', 'templates')`);
  await sleep(700);

  // WHAT SHIPS. A library that renders nothing on a new install is the whole
  // feature failing quietly.
  const fresh = await probe('fresh', LIB);
  if (fresh.visiblePage !== 'templates' || !fresh.libVisible) {
    throw new Error(`TEMPLATES is not on screen (visible page ${fresh.visiblePage}, library ${fresh.libVisible})`);
  }
  if (fresh.tiles.length < 2) throw new Error(`only ${fresh.tiles.length} template(s) ship — the library needs more than one to be a choice`);
  if (fresh.tiles.some((t) => t.removable)) throw new Error('a shipped template offers a remove key — those are not a pilot\'s to delete');
  if (!fresh.tiles.some((t) => t.inUse)) throw new Error('nothing is marked IN USE, though a card is loaded');
  console.log(`[e2e] a new install ships ${fresh.tiles.length} templates: ${fresh.tiles.map((t) => t.id).join(', ')}`);

  // A FILE THAT IS NOT A TEMPLATE. Refused whole, reasons named, library
  // untouched.
  await run(`window.viewerAPI.send('template-import', ${JSON.stringify(NOT_A_TEMPLATE)})`);
  await sleep(800);
  const refused = await probe('refused', LIB);
  if (!refused.refused) throw new Error('a file that is not a template was accepted, or refused silently');
  if (!/mission-notes\.json/.test(refused.refused)) throw new Error('the refusal does not name the file');
  if (!/id|pages/i.test(refused.refused)) throw new Error(`the refusal gives no reason: "${refused.refused}"`);
  if (refused.tiles.length) throw new Error('the library is still on screen behind a refusal — two answers to one question');
  console.log('[e2e] a file that is not a template is refused, by name and with reasons');

  await run(`window.viewerAPI.send('template-cancel')`);
  await sleep(500);
  const after = await probe('afterCancel', LIB);
  if (after.tiles.length !== fresh.tiles.length) throw new Error('a refused import changed the library');
  console.log('[e2e] and the library is exactly as it was');

  // THE REAL IMPORT. Inspected, not saved — the naming step sits between.
  await run(`window.viewerAPI.send('template-import', ${JSON.stringify(FERRY_LAYOUT)})`);
  await sleep(800);
  const naming = await probe('naming', LIB);
  if (!naming.naming) throw new Error('a valid template was not offered for naming');
  if (naming.naming.name !== 'Ferry flight') {
    throw new Error(`the name field reads "${naming.naming.name}", not the name inside the file`);
  }
  if (!/ferry-flight/.test(naming.naming.text)) throw new Error('the naming panel does not show the id it will take');
  if (!/flight|route|comms/.test(naming.naming.text)) throw new Error('the naming panel does not say what data the template needs');
  if (naming.tiles.length) throw new Error('the library is showing behind the naming panel');
  console.log(`[e2e] a valid template is offered for naming, prefilled "${naming.naming.name}"`);

  // Nothing saved yet: cancelling must leave no trace.
  await run(`window.viewerAPI.send('template-cancel')`);
  await sleep(500);
  const cancelled = await probe('cancelled', LIB);
  if (cancelled.tiles.length !== fresh.tiles.length) {
    throw new Error('cancelling the naming step still saved the template — it is saved on SAVE, not on pick');
  }
  console.log('[e2e] cancelling saves nothing');

  // And again, this time named and saved.
  await run(`window.viewerAPI.send('template-import', ${JSON.stringify(FERRY_LAYOUT)})`);
  await sleep(700);
  await run(`document.getElementById('tpl-name').value = 'Squadron ferry'`);
  await run(`document.getElementById('tpl-save').click()`);
  await sleep(900);

  await run(`window.viewerAPI.send('set-page', 'templates')`);
  await sleep(600);
  const saved = await probe('saved', LIB);
  const mine = saved.tiles.find((t) => t.id === 'ferry-flight');
  if (!mine) throw new Error('the imported template is not in the library');
  if (mine.name !== 'Squadron ferry') throw new Error(`it is called "${mine.name}", not the name the pilot typed`);
  if (!mine.removable) throw new Error('a template the pilot imported offers no way to remove it');
  if (saved.groups.length < 2) throw new Error(`yours and shipped are not separated: ${JSON.stringify(saved.groups)}`);
  console.log(`[e2e] imported and named "${mine.name}", filed under ${JSON.stringify(saved.groups)}`);

  // IMPORTING IS CHOOSING. You import a template because you want to use it.
  if (!mine.inUse) throw new Error('the template just imported is not the one on the sheet');
  const blank = await probe('blank', `
    const b = document.querySelector('.card__blank');
    return {
      page: [...document.querySelectorAll('.page[data-page]')].filter((p) => p.offsetParent !== null).map((p) => p.dataset.page)[0],
      blank: Boolean(b), text: b ? b.textContent : null,
      heads: [...document.querySelectorAll('.card__head-title')].map((n) => n.textContent),
      castShown: document.getElementById('brief-cast').offsetParent !== null,
    };
  `);
  if (!blank.blank) throw new Error('a template with no data does not say so — its dashes read as real values');
  if (!blank.heads.length) throw new Error('the empty template renders no blocks at all, so it shows nothing about itself');
  if (blank.castShown) throw new Error('CAST is offered on a template with no data — it would send the PREVIOUS card');
  console.log(`[e2e] and shows empty, saying so, with its real blocks: ${blank.heads.join(' · ')}`);

  // DATA FOR IT. The card names the template, so loading data is all it takes.
  await run(`window.viewerAPI.send('card-import', ${JSON.stringify(FERRY_CARD)})`);
  await sleep(1200);
  const loaded = await probe('loaded', `
    return {
      blank: Boolean(document.querySelector('.card__blank')),
      steps: document.querySelectorAll('.card__step').length,
      first: (document.querySelector('.card__step-name') || {}).textContent,
      castShown: document.getElementById('brief-cast').offsetParent !== null,
    };
  `);
  if (loaded.blank) throw new Error('data was loaded and the sheet still says it is empty');
  // Named exactly, not "at least five": the first version of this assertion
  // said `>= 5` and passed happily on the STRIKE card's eleven legs while the
  // ferry card never loaded at all.
  if (loaded.first !== 'TAXI' || loaded.steps !== 8) {
    throw new Error(
      `expected the ferry card's 8 legs starting TAXI, got ${loaded.steps} starting "${loaded.first}" — ` +
        'this is a DIFFERENT card, so the import did not do what it claims',
    );
  }
  if (!loaded.castShown) throw new Error('a card with data cannot be cast');
  console.log(`[e2e] its data loads into it: ${loaded.steps} legs, first "${loaded.first}", castable`);

  // REMOVING IT. Shipped templates have no remove key at all, tested above;
  // this is the pilot's own.
  await run(`window.viewerAPI.send('set-page', 'templates')`);
  await sleep(500);
  await run(`document.querySelector('[data-remove-template="ferry-flight"]').click()`);
  await sleep(900);
  const gone = await probe('gone', LIB);
  if (gone.tiles.some((t) => t.id === 'ferry-flight')) throw new Error('the template is still in the library after removal');
  if (gone.tiles.length !== fresh.tiles.length) throw new Error('removing one template disturbed the others');
  console.log('[e2e] removing it leaves the shipped ones untouched');

  console.log('[dev-e2e-template-test] PASS');
  cleanup(0);
}

main().catch((err) => {
  console.error(`[dev-e2e-template-test] FAIL: ${err.message}`);
  console.error('--- last 20 lines ---');
  console.error(output.split('\n').filter((l) => !l.includes('PANEL_PROBE')).slice(-20).join('\n'));
  cleanup(1);
});

setTimeout(() => {
  console.error('[dev-e2e-template-test] FAIL: timeout');
  cleanup(1);
}, 180000);
