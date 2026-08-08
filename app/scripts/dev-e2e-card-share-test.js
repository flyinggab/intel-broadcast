'use strict';

// Casting a mission card, between TWO real Electron instances.
//
// Usage: node scripts/dev-e2e-card-share-test.js
//
// This test exists because the feature shipped broken with a green suite, and
// the shape of that miss is worth stating plainly:
//
//   dev-brief-relay-test proved the frame crosses the relay, and proved a
//   received card resolves — by calling resolveCard ITSELF, on the far side.
//   So the wire was covered and the resolver was covered, and between them sat
//   the app's own receive handler, which nothing called. It had been written
//   into the wrong switch: `handleBriefIntent`, which takes (intent, payload)
//   and never sees a `msg`. Incoming cards fell through applyBriefMessage's
//   `default: return` and were dropped in silence. The pilot pressed CAST and
//   nothing happened, anywhere, ever.
//
// A test that stops at the socket cannot catch that. This one presses the key
// a pilot presses and looks at the other pilot's screen — so the assertion is
// the feature, not a component of it.
//
// PC-A hosts and has a card. PC-B joins and has none, which is what makes the
// card appearing on PC-B mean something.

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { killApp } = require('./dev-electron');

const APP_DIR = path.join(__dirname, '..');
const ELECTRON_BIN = path.join(APP_DIR, 'node_modules', '.bin', 'electron');
const CARD = path.join(APP_DIR, '..', 'design', 'kneeboard', 'foxhunt2-roman1.card.json');

const RELAY_PORT = 8931;
const TOKEN = 'card-share-e2e-token-long-enough';
const ROOT = path.join(os.tmpdir(), 'taclink-card-share-e2e');

fs.rmSync(ROOT, { recursive: true, force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makePc({ name, callsign, config, card = null }) {
  const dir = path.join(ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  const configPath = path.join(dir, 'config.json');
  const evalPath = path.join(dir, 'eval.js');
  fs.writeFileSync(configPath, JSON.stringify({ callsign, missionName: 'roman-sead-joker1', ...config }));

  const child = spawn(ELECTRON_BIN, ['.', '--no-sandbox', `--user-data-dir=${dir}`], {
    cwd: APP_DIR,
    detached: true,
    env: {
      ...process.env,
      INTEL_BROADCAST_LOCAL_CONFIG_PATH: configPath,
      INTEL_BROADCAST_VIEWER_PANEL_PROBE: '1',
      INTEL_BROADCAST_VIEWER_EVAL_PATH: evalPath,
      ...(card ? { INTEL_BROADCAST_CARD_PATH: card } : {}),
    },
  });

  const pc = { name, callsign, child, evalPath, output: '' };
  child.stdout.on('data', (d) => (pc.output += d.toString()));
  child.stderr.on('data', () => {});
  return pc;
}

/** Runs JS inside a specific instance's window. */
async function run(pc, js) {
  fs.writeFileSync(pc.evalPath, `(() => { ${js} })()`);
  const deadline = Date.now() + 15000;
  while (fs.existsSync(pc.evalPath)) {
    if (Date.now() > deadline) throw new Error(`${pc.name}: renderer never picked up`);
    await sleep(100);
  }
  await sleep(400);
}

/** Reads a value back out of an instance's window. */
async function probe(pc, tag, js) {
  const marker = `PROBE_${pc.name}_${tag}_${Date.now()}`;
  await run(pc, `console.log(${JSON.stringify(marker)} + ' ' + JSON.stringify((() => { ${js} })()))`);
  const line = pc.output.split('\n').reverse().find((l) => l.includes(marker));
  if (!line) throw new Error(`${pc.name}: no readout for ${tag}`);
  return JSON.parse(line.slice(line.indexOf(marker) + marker.length + 1));
}

/** The card as that pilot's screen actually shows it. */
const SHEET = `
  const rows = [...document.querySelectorAll('.card__step')];
  const from = document.querySelector('.card__from');
  const name = (r) => r.querySelector('.card__step-name').textContent;
  const at = rows.findIndex((r) => r.classList.contains('card__step--current'));
  return {
    steps: rows.length,
    names: rows.slice(0, 3).map(name),
    done: rows.filter((r) => r.classList.contains('card__step--done')).length,
    flown: rows.map((r) => r.classList.contains('card__step--done')),
    current: at,
    currentName: at === -1 ? null : name(rows[at]),
    from: from && !from.classList.contains('is-hidden') ? from.textContent.trim() : null,
    empty: Boolean(document.querySelector('.card--empty, .card__empty')),
  };
`;

/**
 * The rail, and which destinations are marked as holding something new.
 *
 * Measures the mark rather than just finding it in the DOM. A dot that exists
 * at zero size, or hanging off the edge of its tile, is not on the pilot's
 * screen whatever the markup says — this app has shipped exactly that once,
 * which is why dev-visual-test asserts against pixels at all.
 */
const RAIL = `
  const tiles = [...document.querySelectorAll('.dest')];
  return Object.fromEntries(tiles.map((t) => {
    const d = t.querySelector('.dest__dot');
    const tr = t.getBoundingClientRect();
    if (!d) return [t.dataset.dest, { dot: false, title: t.title }];
    const dr = d.getBoundingClientRect();
    const cs = getComputedStyle(d);
    return [t.dataset.dest, {
      dot: true,
      title: t.title,
      w: Math.round(dr.width),
      h: Math.round(dr.height),
      inside: dr.left >= tr.left && dr.right <= tr.right && dr.top >= tr.top && dr.bottom <= tr.bottom,
      shown: cs.visibility !== 'hidden' && cs.display !== 'none' && Number(cs.opacity) > 0,
      colour: cs.backgroundColor,
    }];
  }));
`;

const pcA = makePc({
  name: 'PC-A',
  callsign: 'GHOSTRIDER 1-1',
  card: CARD,
  config: { relayHostEnabled: true, token: TOKEN, okb: { enabled: false }, gm: { relayPort: RELAY_PORT, funnelEnabled: false } },
});
const pcB = makePc({
  name: 'PC-B',
  callsign: 'JOKER 2-1',
  config: {
    relayHostEnabled: false,
    okb: { enabled: false },
    relayUrl: `ws://127.0.0.1:${RELAY_PORT}`,
    token: TOKEN,
  },
});

function cleanup(code) {
  killApp(pcA.child);
  killApp(pcB.child);
  // An instance outliving its test holds nothing here (each has its own
  // userData), but the next test in the suite shares APP_DIR's default one.
  setTimeout(() => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    process.exit(code);
  }, 1800);
}

async function waitFor(pc, needle, what, ms = 40000) {
  const deadline = Date.now() + ms;
  while (!pc.output.includes(needle) && Date.now() < deadline) await sleep(300);
  if (!pc.output.includes(needle)) throw new Error(`${pc.name}: ${what}`);
}

async function main() {
  await waitFor(pcA, '[card] loaded', 'the card never loaded on the lead');
  // Asked of the HOST, not the client: the client logs nothing on connect, and
  // "the host can see the wingman" is the fact that actually matters here.
  await waitFor(pcA, 'callsign=JOKER 2-1', 'the wingman never reached the relay');
  await sleep(2000);

  await run(pcA, `window.viewerAPI.send('set-page', 'card')`);
  // The wingman is deliberately left on INTEL. A card arriving on the page
  // you are already reading is its own notification; the case that needs
  // testing is the one where the pilot is looking somewhere else.
  await run(pcB, `window.viewerAPI.send('set-page', 'brief')`);
  await sleep(800);

  // The wingman starts with NOTHING. Without this the test would pass on an
  // app that shipped the same card to everyone at boot.
  const before = await probe(pcB, 'before', SHEET);
  if (before.steps > 0) {
    throw new Error(`the wingman already has a card before anything was sent (${before.steps} steps) — this proves nothing`);
  }
  console.log('[e2e] the wingman starts with no card');

  const lead = await probe(pcA, 'lead', SHEET);
  if (lead.steps < 3) throw new Error(`the lead has no card to send (${lead.steps} steps)`);
  if (lead.from) throw new Error(`the lead's own card is stamped "${lead.from}" — provenance is for cards you were GIVEN`);
  console.log(`[e2e] the lead has a card of ${lead.steps} steps, unstamped`);

  // Mark a step, so the tick state is observable across the send. Casting must
  // not cost the sender their own place in the plan.
  await run(pcA, `document.querySelectorAll('.card__tick')[3].click()`);
  await sleep(400);
  const leadTicked = await probe(pcA, 'ticked', SHEET);

  // THE PRESS. Not an IPC call — the key a pilot actually reaches for.
  await run(pcA, `document.getElementById('brief-cast').click()`);

  // Read FIRST, while the acknowledgement is still up: it clears itself after
  // a few seconds, and every probe below costs the best part of a second.
  //
  // The sender needs telling. Casting a card changes nothing else on their own
  // screen — they are still looking at the card they sent — so with no word
  // here a working key is indistinguishable from a dead one, which is exactly
  // how this feature was first reported broken.
  const ack = await probe(pcA, 'ack', `
    const bar = document.getElementById('briefbar');
    return {
      shown: bar && !bar.classList.contains('is-hidden'),
      title: document.getElementById('briefbar-title').textContent.trim(),
      meta: document.getElementById('briefbar-meta').textContent.trim(),
    };
  `);
  if (!ack.shown || !ack.title) {
    throw new Error('the lead got no acknowledgement that the card went out — the press looks like nothing happened');
  }
  if (!/\b1\b/.test(ack.meta)) {
    throw new Error(`the acknowledgement reads "${ack.meta}" — it must name how many pilots it reached (1 here)`);
  }
  console.log(`[e2e] the lead is told: "${ack.title} — ${ack.meta}"`);

  await sleep(2500);

  // ---------------------------------------------------------------------------
  // THE WINGMAN IS ON ANOTHER PAGE, and a card raises no banner by design. The
  // mark on the rail is the ONLY thing anywhere on their screen saying a card
  // just landed on their kneeboard.
  // ---------------------------------------------------------------------------
  const railAfter = await probe(pcB, 'rail', RAIL);
  if (!railAfter.card || !railAfter.card.dot) {
    throw new Error(
      'a card arrived while the wingman was on INTEL and nothing marked CARD on the rail — ' +
        'with no banner for cards, they have no way to know it happened',
    );
  }
  if (railAfter.brief.dot) {
    throw new Error('INTEL is marked, but nothing arrived there — the mark must name the right destination');
  }
  if (railAfter.setup.dot) throw new Error('SETUP is marked; nothing ever arrives there');
  // On screen, not merely in the markup.
  const dot = railAfter.card;
  if (!dot.shown || dot.w < 4 || dot.h < 4) {
    throw new Error(`the mark is ${dot.w}x${dot.h}, shown=${dot.shown} — it is not on the pilot's screen`);
  }
  if (!dot.inside) {
    throw new Error('the mark hangs outside its tile, where the rail can clip it away');
  }
  console.log(`[e2e] the mark measures ${dot.w}x${dot.h} ${dot.colour}, inside its tile`);
  if (!/NEW|NUOVO/i.test(railAfter.card.title)) {
    throw new Error(
      `the marked tile reads "${railAfter.card.title}" — a coloured dot says nothing to a pilot ` +
        'using a screen reader, and it is the whole message',
    );
  }
  console.log(`[e2e] CARD is marked on the wingman's rail: "${railAfter.card.title}"`);

  // GOING THERE IS HOW IT CLEARS. No second gesture, nothing to remember.
  await run(pcB, `window.viewerAPI.send('set-page', 'card')`);
  await sleep(600);
  const railSeen = await probe(pcB, 'railSeen', RAIL);
  if (railSeen.card.dot) throw new Error('the wingman opened CARD and the mark is still there');
  console.log('[e2e] and walking over to CARD clears it');

  const got = await probe(pcB, 'after', SHEET);
  if (got.steps === 0) {
    throw new Error(
      'the wingman received nothing. The card crossed the relay (dev-brief-relay-test proves that ' +
        'separately), so the break is in main: applyBriefMessage must have a `brief-card` case, or ' +
        'incoming cards fall through its `default: return` and are dropped in silence.',
    );
  }
  if (got.steps !== lead.steps) {
    throw new Error(`the wingman sees ${got.steps} steps, the lead sent ${lead.steps}`);
  }
  if (JSON.stringify(got.names) !== JSON.stringify(lead.names)) {
    throw new Error(`the wingman's steps read ${JSON.stringify(got.names)}, the lead's ${JSON.stringify(lead.names)}`);
  }
  console.log(`[e2e] the wingman's screen shows the lead's ${got.steps} steps, same names`);

  // It is TEXT on the far side, rendered from the layout this build ships —
  // not a picture. If the transport ever regresses to an image this is the
  // assertion that notices: an image has no steps to count.
  const isText = await probe(pcB, 'text', `
    const n = document.querySelectorAll('.card__step-name').length;
    const imgs = document.querySelectorAll('.card img, .card canvas').length;
    return { n, imgs };
  `);
  if (isText.n === 0) throw new Error('the wingman has no step TEXT — the card arrived as a picture');
  console.log(`[e2e] and it is real text (${isText.n} step names), not a picture`);

  if (!got.from || !got.from.includes('GHOSTRIDER 1-1')) {
    throw new Error(`the wingman's card says "${got.from}" — it must name who sent it`);
  }
  console.log(`[e2e] stamped "${got.from}"`);

  // The sender keeps their own card, their own ticks and no self-stamp: the
  // local echo must not come back through the door as a card FROM themselves.
  const leadAfter = await probe(pcA, 'leadAfter', SHEET);
  if (leadAfter.from) {
    throw new Error(`after casting, the lead's own card is stamped "${leadAfter.from}" — they did not receive it, they sent it`);
  }
  if (leadAfter.done !== leadTicked.done) {
    throw new Error(
      `casting reset the lead's ticks (${leadTicked.done} flown before, ${leadAfter.done} after). ` +
        'Their own echo must not re-take the card.',
    );
  }
  console.log(`[e2e] the lead keeps their ${leadAfter.done} ticked step(s) and no self-stamp`);

  // The acknowledgement goes away on its own. A standing "CARD SENT" would
  // read as state — as though the card were still going out.
  const gone = await probe(pcA, 'gone', `
    const bar = document.getElementById('briefbar');
    return { shown: bar && !bar.classList.contains('is-hidden') };
  `);
  if (gone.shown) throw new Error('the acknowledgement never cleared — it reads as a standing state, not an event');
  console.log('[e2e] and it clears itself');

  // THE STEPS ALREADY FLOWN CAME WITH IT. The lead ticked one before casting,
  // so the wingman must be looking at the same state of the mission — not at a
  // card that says nothing has happened yet.
  if (JSON.stringify(got.flown) !== JSON.stringify(leadTicked.flown)) {
    throw new Error(
      `the wingman's flown steps ${JSON.stringify(got.flown)} differ from the lead's ` +
        `${JSON.stringify(leadTicked.flown)} — the ticks must ride with the card`,
    );
  }
  console.log(`[e2e] the wingman has the lead's ${got.done} flown step(s), not a fresh card`);

  // CURRENT IS DERIVED, so it agrees on both screens without being sent.
  if (got.current !== leadTicked.current) {
    throw new Error(`current is step ${got.current} for the wingman and ${leadTicked.current} for the lead`);
  }
  if (got.current === -1 || got.flown[got.current]) {
    throw new Error(`current (step ${got.current}) must be the first step NOT yet flown`);
  }
  console.log(`[e2e] both are on the same current step: ${got.currentName}`);

  // ---------------------------------------------------------------------------
  // A TICK CROSSES ON ITS OWN — the half the owner asked for in the same
  // breath as sharing: "I will be able to cast and mark completed steps that
  // will be reflected there."
  // ---------------------------------------------------------------------------
  const beforeTick = await probe(pcB, 'beforeTick', SHEET);
  await run(pcA, `document.querySelectorAll('.card__tick')[${beforeTick.current}].click()`);
  await sleep(1500);

  const afterTick = await probe(pcB, 'afterTick', SHEET);
  if (!afterTick.flown[beforeTick.current]) {
    throw new Error(
      `the lead flew step ${beforeTick.current} (${beforeTick.currentName}) and the wingman still shows it unflown — ` +
        'ticks must reach every pilot holding the card',
    );
  }
  console.log(`[e2e] the lead marks ${beforeTick.currentName} flown and the wingman sees it`);

  // And the highlight follows it, on the far side, without current ever being
  // sent: it is computed from the ticks, so it cannot disagree with them.
  if (afterTick.current !== beforeTick.current + 1) {
    throw new Error(
      `after the tick the wingman's current is step ${afterTick.current}, expected ${beforeTick.current + 1}`,
    );
  }
  console.log(`[e2e] and the wingman's current moves on to ${afterTick.currentName}`);

  // BOTH WAYS. A wingman is a pilot too, and a checklist only one pilot can
  // mark is a checklist the others cannot correct.
  await run(pcB, `document.querySelectorAll('.card__tick')[${beforeTick.current}].click()`);
  await sleep(1500);
  const leadBack = await probe(pcA, 'leadBack', SHEET);
  if (leadBack.flown[beforeTick.current]) {
    throw new Error(`the wingman unflew step ${beforeTick.current} and the lead still shows it flown`);
  }
  console.log('[e2e] and the wingman can untick it back on the lead');

  console.log('[dev-e2e-card-share-test] PASS');
  cleanup(0);
}

main().catch((err) => {
  console.error(`[dev-e2e-card-share-test] FAIL: ${err.message}`);
  console.error('--- PC-A last 12 ---');
  console.error(pcA.output.split('\n').filter((l) => !l.includes('PANEL_PROBE')).slice(-12).join('\n'));
  console.error('--- PC-B last 12 ---');
  console.error(pcB.output.split('\n').filter((l) => !l.includes('PANEL_PROBE')).slice(-12).join('\n'));
  cleanup(1);
});

setTimeout(() => {
  console.error('[dev-e2e-card-share-test] FAIL: timeout');
  cleanup(1);
}, 180000);
