'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { app, globalShortcut, Menu, shell, clipboard, ipcMain, protocol, net: enet } = require('electron');
const { loadConfig, LOCAL_CONFIG_PATH } = require('./config');
const { createViewerWindow } = require('./viewerWindow');
const { RelayClient } = require('./relayClient');
const { createRelayServer } = require('./relayServer');
const { revealPhotosFolder } = require('./reveal');
const { listPhotoFilenames, makeThumbnail } = require('./photoLibrary');
const { createBlobStore } = require('./blobStore');
const { createViewState } = require('./viewState');
const { createInkStore, quantise } = require('./inkStore');
const { createImagePrep } = require('./imagePrep');
const squad = require('./squadCode');
const { createTray } = require('./tray');
const { startKeyHook } = require('./keyHook');
const i18n = require('../renderer/i18n');
const { initFileLogging, getLogFilePath, recentLines } = require('./logger');
const tailscale = require('./tailscale');
const okb = require('./okb');
const { resolveCard, markCurrentStep, blankCardFor } = require('./card');
const { createTemplateStore } = require('./templateStore');
const cardEdit = require('./cardEdit');
const { createUpdater } = require('./updater');
const { createOkbServer } = require('./okbServer');
// SETUP is a page of the viewer, so there is no settings window module any
// more: what survived is the config writer and the folder dialog.
const { saveSettingsValues, browseFolder, browseCard, browseLayout, saveCardAs } = require('./settingsConfig');

const BUNDLED_PHOTOS_DIR = path.join(__dirname, '..', '..', 'photos');

// A harness (or any parent) that exits while we're still logging leaves us
// writing to a closed pipe; Node turns that into an EPIPE exception and
// Electron shows it as a crash dialog. Dropping those writes is correct.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (err) => {
    if (err.code !== 'EPIPE') console.error(`[stdio] ${err.message}`);
  });
}

// intel:// serves image bytes to the renderer instead of base64 data URLs
// (BRIEF §9.1). Must be declared before app.ready.
protocol.registerSchemesAsPrivileged([
  { scheme: 'intel', privileges: { standard: true, secure: true, supportFetchAPI: true, bypassCSP: false } },
]);

let config = loadConfig();
let viewer = null;
let tray = null;
let relayServer = null;
let relayClient = null;
let okbServer = null;

const blobs = createBlobStore();
const view = createViewState();
// Brief-mode ink. Main-process authoritative like everything else, but NOT
// part of the state snapshot: at 30 Hz that would be absurd. Deltas go out on
// their own IPC channel, and the snapshot carries only a revision per image.
const ink = createInkStore();
const prep = createImagePrep({ onLog: (msg) => console.log(`[prep] ${msg}`) });

function isHost() {
  return config.relayHostEnabled === true;
}
/**
 * The user's OS language preferences, most-preferred first.
 *
 * `getPreferredSystemLanguages()` is the right source on all three platforms
 * (Electron 24+; this app is on 32): on Windows it is the preferred UI
 * language list, on macOS the Preferred Languages list, on Linux the LANG /
 * LANGUAGE environment. `getLocale()` is Chromium's OWN UI locale and can
 * disagree — the dev Mac reports "en-GB" from getLocale while the OS list is
 * ["en-IT", "it-IT"] — so it is only the fallback, for the case where the
 * preferred list comes back empty.
 *
 * Both must be called after `ready`, which is why nothing here runs at module
 * load.
 */
let localeLogged = false;

function systemLanguages() {
  // Dev/test override: lets a translation be checked without changing the
  // machine's language, and is the only way to exercise the OS path in CI.
  const forced = process.env.INTEL_BROADCAST_SYSTEM_LANGUAGES;
  if (forced) return forced.split(',').map((s) => s.trim()).filter(Boolean);

  let preferred = [];
  try {
    if (typeof app.getPreferredSystemLanguages === 'function') preferred = app.getPreferredSystemLanguages() || [];
  } catch {
    preferred = [];
  }
  if (preferred.length === 0) {
    try {
      preferred = [app.getLocale()];
    } catch {
      preferred = [];
    }
  }
  return preferred;
}

/** Explicit config wins; otherwise follow the OS, defaulting to English.
 *  The matching rules live in i18n.pickLocale so they are testable. */
function effectiveLocale() {
  return i18n.pickLocale(systemLanguages(), config.locale);
}

/** Applies the locale to view state and to main's own strings (tray, menu). */
function applyLocale() {
  const languages = systemLanguages();
  const locale = i18n.pickLocale(languages, config.locale);
  // Logged because "the app is in the wrong language" is otherwise
  // undiagnosable from a bug report: this one line says what the OS asked
  // for and what we chose.
  const source = config.locale === 'en' || config.locale === 'it' ? 'settings' : 'system';
  // Log the first resolution and every change after it. Keying only on
  // "changed" would stay silent for English, which is the initial value —
  // and "why is it in English?" is precisely the report that needs this line.
  if (!localeLogged || locale !== view.state.locale) {
    localeLogged = true;
    console.log(`[i18n] system languages: ${languages.join(', ') || '(none)'} -> ${locale} (${source})`);
  }
  view.state.locale = locale;
  i18n.setLocale(locale);
  return locale;
}
function effectiveRelayUrl() {
  return isHost() ? `ws://127.0.0.1:${config.gm.relayPort}` : config.relayUrl;
}
function currentPhotosFolder() {
  return config.photosFolder || path.join(BUNDLED_PHOTOS_DIR, config.missionName);
}


// ---------------------------------------------------------------------------
// Updates
// ---------------------------------------------------------------------------

let updater = null;

/**
 * Wires the updater, if this build can use one.
 *
 * `electron-updater` is required lazily and in a try/catch for the same reason
 * `uiohook-napi` is: an unguarded require of a native-ish optional module took
 * the whole app down once already. A dev run (unpackaged) has no update to
 * apply, so it degrades to "unsupported" and the panel says so.
 */
function startUpdater() {
  let autoUpdater = null;
  try {
    if (app.isPackaged) ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    console.log(`[update] electron-updater unavailable: ${err.message}`);
  }
  updater = createUpdater({
    autoUpdater,
    onLog: (msg) => console.log(`[update] ${msg}`),
    // Every state move re-renders SETUP, which is how a download percentage
    // reaches the panel without the renderer polling anything.
    onChange: () => pushState(),
  });
  // One check on launch. Nothing downloads from it — the pilot presses.
  if (updater.snapshot().supported) updater.check();
}

// ---------------------------------------------------------------------------
// Kneeboard cards
// ---------------------------------------------------------------------------

// The resolved card, or null. Resolved ONCE at load, not per push: a card is
// static until a new one is imported, and re-validating untrusted content on
// every state push would be both wasteful and a nice way to make a hostile
// card expensive.
let cardModel = null;

// Which route steps the pilot has ticked, as OVERRIDES on what the card says:
// index -> true/false. An override rather than a set, because a card may ship
// steps already marked done and un-ticking one has to be expressible.
//
// Deliberately not persisted and deliberately local. The handoff is explicit
// that whether a lead ticking a step pushes to the flight is the same question
// as brief mode's FOCUS and gets the same machinery — so this stays in memory
// until that answer exists, rather than inventing a second mechanism or
// writing into a pilot's card file.
let cardTicks = new Map();

// The card exactly as it came off disk. `cardModel` is the RESOLVED form —
// every binding already turned into a string — which is what the renderer
// needs and the wrong thing to send: the receiver has its own copy of the
// layout and must resolve against that, or a card would arrive rendered to
// the sender's template version rather than the receiver's.
let cardSource = null;
const currentCardSource = () => cardSource;

// The library. Built once `app` is ready, because the user directory comes
// from Electron's userData path.
let templates = null;

// WHICH TEMPLATE THE PILOT IS LOOKING AT. Normally the loaded card's own, set
// when a card is loaded or arrives. It differs only when the pilot picked one
// out of the library that they have no data for — then the sheet shows that
// template EMPTY, which is the only way to see what a template wants before
// committing to it.
let chosenTemplateId = null;

// Bumped whenever the card's DATA or ticks change. The renderer will not
// rebuild the sheet while a pilot is typing into it — but it must still
// rebuild when the card ITSELF changed, or a press that adds a line lands in
// main, succeeds, and never appears. This is how the two are told apart.
let cardRev = 0;

// An inspected template waiting to be named. Held HERE rather than in the
// snapshot: it is a file another pilot wrote, and nothing about it needs to
// reach a DOM except the handful of fields the naming panel shows.
let pendingLayout = null;

// EDIT MODE. Off by default and off again the moment the pilot leaves CARD:
// this sheet rides on a knee for a whole flight, and the ticks are already a
// plain click — if every value were live too, one stray tap during a merge
// rewrites a frequency and nothing says so.
let editing = false;

/**
 * The app's OWN copy of the card.
 *
 * Edits are permanent the moment they are made and survive a restart, the way
 * ticks and the chosen template already do — but THE FILE THE PILOT IMPORTED
 * IS NEVER WRITTEN TO. They loaded it; it is theirs; reaching back into their
 * folder to rewrite it is not ours to do silently. So the app keeps this and
 * prefers it, and EXPORT is how an edited card leaves as a file.
 */
function workingCardPath() {
  return path.join(app.getPath('userData'), 'card.working.json');
}

function saveWorkingCard() {
  if (!cardSource) return;
  try {
    fs.writeFileSync(workingCardPath(), JSON.stringify(cardSource, null, 2));
  } catch (err) {
    console.log(`[card] could not save the working copy: ${err.message}`);
  }
}

/**
 * Loads the card named in config and resolves it against its layout.
 *
 * Rejects loudly and completely — `card.js` returns every error it found and
 * none of them are recoverable, because a half-rendered card still looks like
 * the mission. The pilot sees CARD REFUSED and the log says why.
 */
function loadCard({ fresh = false } = {}) {
  cardModel = null;
  cardSource = null;
  cardTicks = new Map();
  const cardPath = process.env.INTEL_BROADCAST_CARD_PATH || config.cardPath;
  // The app's own copy wins, because it is the one carrying the pilot's edits.
  // `fresh` is an import saying "replace it" — the only thing that discards
  // edits, and it is the pilot handing over a different card.
  const working = workingCardPath();
  const from = !fresh && fs.existsSync(working) ? working : cardPath;
  if (!from) return;
  try {
    const card = JSON.parse(fs.readFileSync(from, 'utf8'));
    cardSource = card;
    // Through the LIBRARY, so a card built on a template the pilot imported
    // loads exactly like one built on a template that ships.
    const layout = templates && templates.get(card.layout);
    if (!layout) {
      console.log(`[card] ${from}: no template named "${card.layout}"`);
      cardModel = { error: true, pages: [], missingTemplate: card.layout };
      return;
    }
    const { ok, errors, card: resolved } = resolveCard({ layout, card });
    if (!ok) {
      console.log(`[card] ${from} REFUSED, ${errors.length} problem(s):`);
      for (const err of errors.slice(0, 12)) console.log(`[card]   ${err}`);
      cardModel = { error: true, pages: [] };
      return;
    }
    // Image blocks carry a bare content hash out of the resolver; the URL is
    // main's to build, because only main knows which surface it is bound for
    // (forOkb rewrites intel:// for the dashboard).
    for (const page of resolved.pages) {
      for (const block of page.blocks) {
        if (block.type === 'image') block.url = `intel://blob/${block.blob}`;
      }
    }
    cardModel = resolved;
    chosenTemplateId = card.layout;
    cardRev += 1;
    if (from !== working) saveWorkingCard();
    const pages = resolved.pages.map((p) => p.id).join(', ');
    console.log(`[card] loaded ${from} (${resolved.pages.length} page(s): ${pages})`);
  } catch (err) {
    console.log(`[card] could not read ${from}: ${err.message}`);
    cardModel = { error: true, pages: [] };
  }
}

// ---------------------------------------------------------------------------
// OpenKneeboard web dashboard
// ---------------------------------------------------------------------------

// Last probe of the OpenKneeboard side. Held rather than probed per push:
// settingsSnapshot runs on every state push, and shelling out to `reg` at that
// rate would be absurd. Refreshed when SETUP opens and after a toggle.
let okbState = {
  enabled: false,
  supported: process.platform === 'win32',
  installed: false,
  registered: false,
  connected: false,
  url: null,
};

async function refreshOkbState() {
  const enabled = Boolean(config.okb && config.okb.enabled);
  try {
    const p = await okb.probe({ pluginPath: path.join(okbPluginDir(), 'okb-plugin.json') });
    okbState = {
      enabled,
      supported: p.supported,
      installed: p.installed,
      registered: p.registered,
      // Ground truth for "the pilot added the tab" needs a WebView2 talking
      // back to us, which is the transport that does not exist yet
      // (design/okb-integration §5). Reported as false rather than guessed.
      connected: false,
      url: okbServer ? okbServer.url : null,
    };
  } catch {
    okbState = { ...okbState, enabled };
  }
  pushState();
}

function okbPluginDir() {
  // Our own LocalAppData, which is what OpenKneeboard's docs recommend for a
  // third party, and never anywhere under OpenKneeboard: writing into theirs
  // is unsupported and breaks pilots' setups on update.
  return path.join(app.getPath('userData'), 'okb');
}

/** The card as the renderer should see it: what the card said, with the
 *  pilot's ticks laid over the top. */
/**
 * The template the pilot chose, rendered with nothing in it.
 *
 * Goes through the SAME resolveCard as a real card — `blankCardFor` builds a
 * card that satisfies the layout and says nothing — so a preview cannot drift
 * from the sheet it is previewing. `blank` tells the renderer to say so out
 * loud rather than let dashes read as real values.
 */
function blankTemplateModel(id) {
  const layout = templates && templates.get(id);
  if (!layout) return null;
  const { ok, card: resolved } = resolveCard({ layout, card: blankCardFor(layout) });
  if (!ok) return null;
  return { ...resolved, blank: true, templateName: (templates.list().templates.find((t) => t.id === id) || {}).name || id };
}

function cardForSnapshot() {
  // Picked a template we have no data for: show it empty.
  if (chosenTemplateId && (!cardSource || cardSource.layout !== chosenTemplateId)) {
    const preview = blankTemplateModel(chosenTemplateId);
    if (preview) return preview;
  }
  if (!cardModel || !cardModel.pages) return cardModel;
  const ticked = !cardTicks.size
    ? cardModel
    : {
        ...cardModel,
        pages: cardModel.pages.map((page) => ({
          ...page,
          blocks: page.blocks.map((block) =>
            block.type === 'steps'
              ? {
                  ...block,
                  rows: block.rows.map((row, i) => (cardTicks.has(i) ? { ...row, done: cardTicks.get(i) } : row)),
                }
              : block,
          ),
        })),
      };
  // AFTER the ticks, never before: where the flight has got to is the first
  // step not yet flown, and that moves every time one is marked off.
  return { ...markCurrentStep(ticked), rev: cardRev };
}

/**
 * WHICH card, as a content hash — the same rule the photos use, and for the
 * same reason: nothing else means anything across two instances. A tick names
 * it so a pilot holding a different card, or none, ignores the message rather
 * than ticking whatever sits at that index on theirs.
 */
/** Rebuilds the library into the snapshot. Called after anything that changes
 *  it, so the view is never a stale list a pilot has already acted on. */
function refreshTemplates() {
  if (!templates) return;
  const { templates: all, bad } = templates.list();
  for (const one of bad) {
    console.log(`[template] skipping ${one.file} (${one.source}): ${one.errors[0]}`);
  }
  view.setTemplates(all);
}

/**
 * Re-resolves the card after its DATA changed, and persists it.
 *
 * Through the same resolveCard a fresh load uses, so a pilot editing a value
 * sees exactly what a receiver would — including a refusal, if they have
 * managed to type something the template cannot render.
 */
/**
 * Makes one change to the card DATA, and keeps the data and the sheet in step.
 *
 * ROLLS BACK if the change leaves a card the template cannot render. Without
 * that, a refused change stayed in `cardSource` while `cardModel` kept the old
 * sheet: the screen silently reverted, and — far worse — EVERY LATER EDIT was
 * refused too, because the card was still carrying the bad row. One press
 * poisoned the card for the rest of the session. That is exactly what the
 * + ROW key on GAME PLAN did.
 */
function applyCardChange(mutate) {
  if (!cardSource) return false;
  const layout = templates && templates.get(cardSource.layout);
  if (!layout) return false;

  const before = JSON.stringify(cardSource);
  if (!mutate()) return false; // nothing actually changed

  const { ok, errors, card: resolved } = resolveCard({ layout, card: cardSource });
  if (!ok) {
    cardSource = JSON.parse(before);
    console.log(`[card] change refused — the template cannot render it, ${errors.length} problem(s):`);
    for (const err of errors.slice(0, 6)) console.log(`[card]   ${err}`);
    return false;
  }
  for (const page of resolved.pages) {
    for (const block of page.blocks) if (block.type === 'image') block.url = `intel://blob/${block.blob}`;
  }
  cardModel = { ...resolved, from: cardModel && cardModel.from ? cardModel.from : '' };
  cardRev += 1;
  saveWorkingCard();
  return true;
}

/** The steps block's row array and cap, for add/remove and tick reindexing. */
function stepsBlock() {
  const page = cardModel && cardModel.pages ? cardModel.pages.find((p) => p.id === 'card') : null;
  return page ? page.blocks.find((b) => b.type === 'steps') : null;
}

/** Puts a template on the sheet. With no data for it, that is the empty
 *  preview; with data, the card itself. */
/**
 * The file dialog, or a path handed straight in.
 *
 * A native dialog cannot be driven from a test, which would leave everything
 * after it — validating, naming, saving, choosing — permanently unexercised.
 * The bypass is gated on an env var set only by the dev tests, so a packaged
 * build has exactly one way to pick a file.
 */
function pickFile(browse, payload) {
  if (process.env.INTEL_BROADCAST_TEST_PICK_PATH && typeof payload === 'string' && payload) {
    return Promise.resolve(payload);
  }
  return browse(viewer && viewer.window);
}

function chooseTemplate(id) {
  if (!templates || !templates.has(id)) return;
  chosenTemplateId = id;
}

function cardHash() {
  if (!cardSource) return null;
  return crypto.createHash('sha256').update(JSON.stringify(cardSource)).digest('hex');
}

/**
 * Rewrites `intel://blob/<hash>` to `/blob/<hash>` everywhere in a snapshot.
 *
 * Done HERE, per transport, rather than in the renderer: main is the only
 * place that knows which surface a snapshot is going to, and `viewer.js` must
 * stay a pure function of what it is handed (ROADMAP §5.2). The alternative —
 * snapshots carrying bare hashes, each surface composing its own URL — is
 * tidier in the abstract and touches every render path for one consumer.
 */
function forOkb(value) {
  if (typeof value === 'string') {
    return value.startsWith('intel://blob/') ? value.replace('intel://blob/', '/blob/') : value;
  }
  if (Array.isArray(value)) return value.map(forOkb);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = forOkb(v);
    return out;
  }
  return value;
}

/** Serves the EFB on loopback and registers our plugin so OpenKneeboard
 *  offers "Tac Link" in its own tab list. Both halves are reversible. */
async function startOkb() {
  if (okbServer) return;
  const port = (config.okb && config.okb.port) || 8788;
  okbServer = createOkbServer({
    port,
    onLog: (msg) => console.log(`[okb] ${msg}`),
    blobs,
    // The dashboard's intents go through the SAME door as the window's, or
    // the two surfaces drift.
    onIntent: (intent, payload) => handleViewerIntent(intent, payload),
    getSnapshot: () => forOkb(settingsSnapshot(view.snapshot())),
  });
  // Do not advertise a tab we are not the ones serving. If another instance
  // already holds the port, its dashboard is the live one and registering
  // over the top would just point OpenKneeboard at someone else's app.
  if (!(await okbServer.ready)) {
    okbServer.close();
    okbServer = null;
    return;
  }
  try {
    const { file, ok, removed } = await okb.register({
      dir: okbPluginDir(),
      version: app.getVersion(),
      url: okbServer.url,
    });
    // Worth a line each: a stale registration is invisible until OpenKneeboard
    // silently stops offering the tab, and then nothing on screen explains it.
    for (const gone of removed || []) console.log(`[okb] removed a stale registration: ${gone}`);
    console.log(`[okb] plugin manifest ${file}${ok ? ' registered' : ' written (registry unavailable)'}`);
    // Registration is only discovered when OpenKneeboard starts, so say so
    // rather than letting a pilot conclude the toggle did nothing.
    if (ok) console.log('[okb] restart OpenKneeboard, then Add Tab -> Tac Link');
  } catch (err) {
    console.log(`[okb] could not register the plugin: ${err.message}`);
  }
}

async function stopOkb() {
  if (okbServer) {
    okbServer.close();
    okbServer = null;
  }
  try {
    await okb.unregister({ dir: okbPluginDir() });
  } catch {
    // nothing registered, or no registry — either way there is nothing to undo
  }
  console.log('[okb] dashboard stopped and plugin unregistered');
}

// ---------------------------------------------------------------------------
// Brief mode
// ---------------------------------------------------------------------------

/** Sends one ink delta to the renderer on its own channel. */
function pushInk(delta) {
  if (!delta) return;
  if (viewer && !viewer.window.isDestroyed()) viewer.window.webContents.send('ink', delta);
  // Brief-mode ink reaches the dashboard tab on the same socket as state. It
  // must not ride the snapshot — at 30 Hz that would be absurd — which is the
  // same reason it has its own IPC channel in the window.
  if (okbServer) okbServer.pushInk(delta);
}

/** The image the local pilot is looking at — what they annotate, and what a
 *  FOCUS names when they present. Ink is keyed by content hash, so a photo
 *  with no hash (an old batch) simply cannot be annotated. */
function currentHash() {
  const q = view.snapshot().queue;
  return (q.current && q.current.hash) || null;
}

/** Applies an incoming realtime message from the relay. */
function applyBriefMessage(msg) {
  switch (msg.type) {
    case 'brief-present-start':
      view.setPresenter(msg.presenter);
      break;
    case 'brief-present-stop':
      view.setPresenter(null);
      break;
    case 'brief-focus':
      view.setFocus(msg);
      break;
    case 'brief-cursor':
      view.setCursor({ u: msg.u, v: msg.v, who: msg.presenter });
      break;
    case 'brief-stroke':
      pushInk(ink.apply({ kind: 'append', hash: msg.hash, id: msg.id, by: msg.presenter, points: msg.points, rev: bump(msg.hash) }));
      break;
    case 'brief-shape':
      pushInk(ink.apply({ kind: 'upsert', hash: msg.hash, id: msg.id, tool: msg.tool, by: msg.presenter, a: msg.a, b: msg.b, final: msg.final, rev: bump(msg.hash) }));
      break;
    case 'brief-undo':
      pushInk(ink.apply({ kind: 'undo', hash: msg.hash, id: msg.id, rev: bump(msg.hash) }));
      break;
    case 'brief-clear':
      pushInk(ink.apply({ kind: 'clear', hash: msg.hash, rev: bump(msg.hash) }));
      break;
    case 'brief-card': {
      // Our own echo, coming back through the same door every message uses.
      // The sender already HAS this card: re-taking it would re-resolve it for
      // nothing and wipe the ticks they have already marked. Casting your plan
      // to the flight is not a way to lose your place in it.
      if (msg.local) return;

      // The card DATA arrives, not a picture of it — the layout ships inside
      // the app, so it renders here with OUR copy of the template and looks
      // exactly as it does on the sender.
      //
      // Validated again, here, even though the sender validated it at import:
      // a card off the wire is a file from another pilot, and the only thing
      // standing between it and a pilot's kneeboard is this refusing it whole.
      // Through the LIBRARY, so a card built on a template the squad shares
      // out of band resolves exactly like one built on a shipped template.
      const layout = templates && templates.get(msg.card.layout);
      if (!layout) {
        console.log(`[card] ${msg.presenter || 'someone'} sent a card needing template "${msg.card.layout}", which is not in your library`);
        return;
      }
      let resolved;
      try {
        const out = resolveCard({ layout, card: msg.card });
        if (!out.ok) {
          console.log(`[card] REFUSED a card from ${msg.presenter || 'someone'}, ${out.errors.length} problem(s):`);
          for (const err of out.errors.slice(0, 6)) console.log(`[card]   ${err}`);
          return;
        }
        resolved = out.card;
      } catch (err) {
        console.log(`[card] REFUSED a card from ${msg.presenter || 'someone'}: ${err.message}`);
        return;
      }
      for (const page of resolved.pages) {
        for (const block of page.blocks) if (block.type === 'image') block.url = `intel://blob/${block.blob}`;
      }
      // No banner and no prompt, by design: the card the lead sent IS the
      // card. The only mark is the line of provenance the sheet carries.
      cardModel = { ...resolved, from: msg.presenter || '' };
      cardSource = msg.card;
      chosenTemplateId = msg.card.layout;
      // The steps already flown come WITH it. A lead casting mid-mission is
      // the normal case, and a card that arrives claiming nothing has happened
      // yet is worse than no card: it is a confident wrong answer about where
      // the flight is.
      cardTicks = new Map(Object.entries(msg.ticks || {}).map(([k, v]) => [Number(k), v]));
      cardRev += 1;
      // A card raises no banner, by design. Without a mark on the rail it can
      // land on a pilot's kneeboard with nothing on screen saying so.
      view.noteCardArrived();
      console.log(
        `[card] took a card from ${msg.presenter || 'someone'}` +
          (cardTicks.size ? `, ${cardTicks.size} step(s) already marked` : ''),
      );
      break;
    }

    case 'brief-card-tick': {
      // Ours, already applied when the pilot pressed it.
      if (msg.local) return;
      // For a card we do not have. Applying it by index would tick whatever
      // happens to sit at that row of a DIFFERENT mission — the failure that
      // content-hash addressing exists to make impossible.
      const mine = cardHash();
      if (!mine || mine !== msg.hash) return;
      cardTicks.set(msg.index, msg.done);
      cardRev += 1;
      break;
    }
    default:
      return;
  }
  view.setInkRevs(ink.revisions());
  pushState();
}

/** The revision an applied delta should land on. The relay does not carry
 *  revisions — each instance counts its own, and the snapshot's per-image
 *  revision is what lets a renderer notice it fell behind. */
function bump(hash) {
  return (ink.revisions()[hash] || 0) + 1;
}

/**
 * The local pilot draws. Two things happen and the order matters: the ink is
 * applied HERE first so it renders immediately, and only then does it go to
 * the relay. Local echo is not an optimisation — the funnel rides DERP at
 * 30-80ms and a presenter watching their own line lag behind the pen would
 * stop trusting the tool.
 */
function originateBrief(msg) {
  const withMe = { ...msg, presenter: config.callsign || '' };
  // `local` marks the echo as OURS and is a separate object from what goes on
  // the wire, so the flag cannot leak to another pilot. Ink does not care —
  // applying our own stroke is the whole point — but a card does: taking back
  // the card we just sent would reset the ticks we have already marked.
  // Comparing callsigns would not do; two pilots may fly under the same one.
  applyBriefMessage({ ...withMe, local: true });

  // ONE path to the net, not two. Hosting ALSO runs a client against our own
  // relay — that loopback is how a host hears everyone else's brief — so a
  // host that took both paths put every frame on the net twice, and every
  // other pilot applied it twice.
  //
  // The client is preferred where it exists, because the relay then knows the
  // presenter by SOCKET: `broadcastBrief` can only record the host as "no
  // socket", and a presenter with no socket never matches the check that
  // guards presenter-only messages. The server path stays for the seconds
  // before the loopback is up, and for a host with the relay off.
  if (relayClient && relayClient.sendBrief(msg)) return;
  if (relayServer) relayServer.broadcastBrief(withMe);
}

// The last image we told the net we were on. Compared against, so a FOCUS
// goes out once per actual move rather than once per state push.
let lastFocusSent = null;

/**
 * Announces where the presenter is now, if that changed.
 *
 * Called after anything that can move `current` while presenting, because a
 * page turn is the one thing a brief cannot do without: PRESENT used to send
 * exactly one FOCUS — the image the presenter happened to be on when they
 * started — and every photo they moved to afterwards was seen by nobody.
 *
 * The queue moves for reasons other than the chevrons (intel arriving,
 * curation restaging), and all of them are equally "the presenter is now
 * looking at this", so this is driven off the resulting hash rather than off
 * the navigation intents.
 */
function syncFocus() {
  const s = view.snapshot();
  if (!s.brief.presenting) {
    lastFocusSent = null;
    return;
  }
  const current = s.queue.current;
  const hash = current && current.hash;
  if (!hash || hash === lastFocusSent) return;
  lastFocusSent = hash;
  originateBrief({
    type: 'brief-focus',
    hash,
    batchId: String(current.batchId),
    filename: current.filename,
  });
}

// How long the "card sent" acknowledgement stays up. Long enough to read
// while looking away at a HOTAS, short enough that it is gone before it can be
// mistaken for a standing state.
const CARD_SENT_MS = 3000;
let cardSentTimer = null;

/** Says a card went out, then takes it back down. */
function noteCardSent(n) {
  if (cardSentTimer) clearTimeout(cardSentTimer);
  view.noteCardSent(n);
  pushState();
  cardSentTimer = setTimeout(() => {
    cardSentTimer = null;
    view.noteCardSent(null);
    pushState();
  }, CARD_SENT_MS);
}

function handleBriefIntent(intent, payload) {
  const hash = currentHash();
  switch (intent) {
    case 'brief-present': {
      // On CARD the same key means "put this card on every kneeboard" — the
      // same verb as casting a photo, which is why it is the same glyph and
      // the same binding. It sends the DATA; the layout is already on the
      // other end, shipped inside the app.
      if (view.state.page === 'card') {
        // The owner's rule, both directions: you cannot cast mid-edit.
        if (editing) {
          console.log('[card] not while you are editing');
          return true;
        }
        const raw = currentCardSource();
        if (!raw) {
          console.log('[card] nothing to send — no card loaded');
          return true;
        }
        // With the steps already flown. Casting mid-mission is the normal
        // case, and the raw card on its own says nothing has been done yet.
        originateBrief({ type: 'brief-card', card: raw, ticks: Object.fromEntries(cardTicks) });
        const reached = Math.max(0, (view.state.peers || []).length - 1);
        console.log(`[card] sent to ${reached} pilot(s) on net`);
        noteCardSent(reached);
        return true;
      }
      const on = Boolean(payload);
      if (on && editing) {
        console.log('[brief] not while you are editing');
        return true;
      }
      view.setPresenting(on, config.callsign || '');
      if (on) {
        originateBrief({ type: 'brief-present-start' });
        // Announce the opening image through the same path every later page
        // turn uses, so there is one definition of "where the brief is".
        lastFocusSent = null;
        syncFocus();
      } else {
        originateBrief({ type: 'brief-present-stop' });
      }
      return true;
    }
    case 'brief-tool':
      view.setTool(payload);
      return true;
    case 'brief-stroke':
      if (!hash) return true;
      originateBrief({ type: 'brief-stroke', hash, id: payload.id, points: payload.points });
      return true;
    case 'brief-shape':
      if (!hash) return true;
      originateBrief({ type: 'brief-shape', hash, id: payload.id, tool: payload.tool, a: payload.a, b: payload.b, final: payload.final });
      return true;
    case 'brief-cursor':
      if (!hash) return true;
      originateBrief({ type: 'brief-cursor', u: payload.u, v: payload.v });
      return true;
    case 'brief-undo': {
      if (!hash) return true;
      // Scoped to our own marks: a slip must not erase someone else's brief.
      const d = ink.undo(hash, config.callsign || '');
      if (d) originateBrief({ type: 'brief-undo', hash, id: d.id });
      return true;
    }
    case 'brief-clear':
      if (!hash) return true;
      originateBrief({ type: 'brief-clear', hash });
      return true;
    case 'brief-snapshot-req': {
      // Both surfaces ask for this, and both must be answered: a dashboard tab
      // that woke up behind the ink has no other way to catch up.
      const snap = ink.snapshot(payload.hash);
      if (viewer && !viewer.window.isDestroyed()) viewer.window.webContents.send('ink-snapshot', snap);
      if (okbServer) okbServer.pushInkSnapshot(snap);
      return true;
    }
    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// State push. Both windows are pure renderers of these snapshots (§5.2).
// ---------------------------------------------------------------------------

function pushState() {
  // SETUP is a page of the viewer, so there is one snapshot and one window.
  const snapshot = settingsSnapshot(view.snapshot());
  if (viewer) viewer.pushState(snapshot);
  // ...and the OpenKneeboard tab, if one is open. Same snapshot, photo URLs
  // rewritten for a surface that has no intel:// protocol.
  if (okbServer) okbServer.pushState(forOkb(snapshot));
}

/** The base snapshot plus the fields only the SETUP page renders. */
function settingsSnapshot(base) {
  return {
    ...base,
    relayPort: config.gm.relayPort,
    passthroughKeys: config.passthroughKeys === true,
    passthroughActive: Boolean(keyHook && keyHook.ok),
    tokenMasked: squad.maskToken(config.token),
    squadCode: hostSquadCode(),
    hotkeys: config.hotkeys,
    card: cardForSnapshot(),
    editing,
    update: updater ? updater.snapshot() : { supported: false },
    okb: okbState,
    // The squad code is a password and must never appear here.
    logTail: recentLines(12),
  };
}

/** The code this host hands out, or null when we aren't hosting/reachable. */
function hostSquadCode() {
  if (!isHost()) return null;
  const funnel = view.state.funnel;
  const host = funnel && funnel.funnelOn && funnel.dnsName ? funnel.dnsName : null;
  // Funnel up: the public name on 443. Otherwise a LAN address is the honest
  // answer — a code that only works locally beats a code that works nowhere.
  const port = host ? 443 : config.gm.relayPort;
  const hostname = host || localHostname();
  try {
    return squad.encodeSquadCode(hostname, port, config.token);
  } catch {
    return null;
  }
}

function localHostname() {
  try {
    const os = require('os');
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list || []) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
  } catch {
    // fall through
  }
  return 'localhost';
}

// ---------------------------------------------------------------------------
// Gallery + staging
// ---------------------------------------------------------------------------

/** Rebuilds the share gallery, preserving which photos were ticked. */
function refreshGallery() {
  const folder = currentPhotosFolder();
  const available = listPhotoFilenames(folder);
  const previous = new Map(view.state.photos.map((p) => [p.filename, p.selected]));
  const photos = available.map((filename) => {
    // Thumbnails go through the blob store too, so the renderer never holds
    // pixel data — only intel:// URLs (BRIEF §9.1).
    const thumb = makeThumbnail(path.join(folder, filename));
    let thumbUrl = null;
    if (thumb) thumbUrl = blobs.urlFor(blobs.put(thumb, 'image/png'));
    return {
      filename,
      // Default to selected so the reveal hotkey behaves as it always has.
      selected: previous.has(filename) ? previous.get(filename) : true,
      thumbUrl,
    };
  });
  // Logged because a rebuild is the one thing that can legitimately change
  // what is ticked, and "my selection came back on its own" is otherwise
  // undiagnosable from a bug report.
  const kept = photos.filter((ph) => ph.selected).length;
  console.log(`[gallery] rebuilt: ${photos.length} photo(s), ${kept} selected`);
  view.setGallery({ folder, photos });
  restage();
}

/**
 * Watches the photos folder and rescans on change — always on. This used to
 * be a settings toggle (`watchFolder`), but the toggle only ever wrote config:
 * nothing consumed it, so it silently did nothing. Now the behaviour exists
 * and is unconditional; the config key is ignored. fs.watch fires in bursts
 * while DCS writes a screenshot, hence the debounce.
 */
let folderWatcher = null;
let folderWatchTimer = null;
function watchPhotosFolder() {
  if (folderWatcher) {
    folderWatcher.close();
    folderWatcher = null;
  }
  const folder = currentPhotosFolder();
  try {
    folderWatcher = fs.watch(folder, { persistent: false }, () => {
      clearTimeout(folderWatchTimer);
      folderWatchTimer = setTimeout(() => {
        console.log('[gallery] folder changed — rescanning');
        refreshGallery();
      }, 600);
    });
  } catch (err) {
    console.log(`[gallery] cannot watch ${folder}: ${err.message}`);
  }
}

/**
 * Recomputes what a reveal would actually put on the wire, and warms the
 * compression cache. Warming happens HERE, on selection change — not on the
 * hotkey, which is the one moment we cannot afford to block the main process.
 */
function restage() {
  const folder = view.state.folder;
  const selected = view.selectedFilenames().map((f) => path.join(folder, f));
  prep.warm(selected, config.sendProfile);
  view.state.stagedBytes = prep.stagedBytes(selected, config.sendProfile);
  pushState();
}

// ---------------------------------------------------------------------------
// Roles
// ---------------------------------------------------------------------------

function peerList() {
  const peers = relayServer
    ? relayServer.getConnectedClients().map((c) => ({
        callsign: c.callsign,
        connectedAt: c.connectedAt,
        self: c.callsign === config.callsign,
        host: false,
      }))
    : [];
  return peers;
}

function startHost() {
  relayServer = createRelayServer({
    port: config.gm.relayPort,
    token: config.token,
    onLog: (msg) => console.log(`[relay] ${msg}`),
    onClientsChanged: () => {
      view.state.peers = peerList();
      pushState();
    },
  });
}

function stopHost(done = () => {}) {
  if (!relayServer) return void done();
  const server = relayServer;
  relayServer = null;
  server.close(done);
}

function startClient() {
  relayClient = new RelayClient({
    url: effectiveRelayUrl(),
    token: config.token,
    role: 'viewer',
    callsign: config.callsign,
  });

  relayClient.on('connected', () => {
    view.setConnection({ connected: true, relayLabel: labelFor(effectiveRelayUrl()) });
    pushState();
  });
  relayClient.on('disconnected', () => {
    view.setConnection({ connected: false, relayLabel: labelFor(effectiveRelayUrl()) });
    // Losing the link releases the lock. A follower cannot page away by hand,
    // so a presenter we can no longer hear from would otherwise hold this
    // pilot's controls indefinitely — including the way to SETUP, i.e. the
    // way to fix the connection. Re-locking is safe and automatic: the relay
    // re-announces a live brief to every client that authenticates.
    view.setPresenter(null);
    pushState();
  });
  relayClient.on('reconnecting', (info) => {
    view.state.reconnect = info;
    pushState();
  });
  relayClient.on('brief', (msg) => applyBriefMessage(msg));

  relayClient.on('reveal-batch', (batch) => {
    // Bytes go to the blob store keyed by content hash; the renderer only ever
    // sees intel:// URLs (§9.1, §5.1).
    const items = batch.items.map((item) => {
      const hash = blobs.put(item.buffer, item.mimeType);
      // The hash travels with the item: brief-mode ink is keyed by it, and
      // re-hashing later would mean holding the bytes again for no reason.
      return { filename: item.filename, url: blobs.urlFor(hash), hash };
    });
    view.addBatch({ sharedBy: batch.sharedBy, items });
    // Intel landing can move the presenter onto it; the net has to be told,
    // or everyone else stays on the old photo watching them annotate a
    // picture the followers cannot see.
    syncFocus();
    pushState();

    if (process.env.INTEL_BROADCAST_RECEIVED_MARKER_PATH) {
      fs.writeFileSync(
        process.env.INTEL_BROADCAST_RECEIVED_MARKER_PATH,
        JSON.stringify({
          batchId: batch.batchId,
          sharedBy: batch.sharedBy || '',
          filenames: batch.items.map((i) => i.filename),
        }),
      );
    }
  });

  view.setConnection({ connected: false, relayLabel: labelFor(effectiveRelayUrl()) });
  relayClient.connect();
}

function labelFor(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function stopClient() {
  if (!relayClient) return;
  relayClient.removeAllListeners();
  relayClient.close();
  relayClient = null;
}

// ---------------------------------------------------------------------------
// Reveal
// ---------------------------------------------------------------------------

function doReveal() {
  const result = revealPhotosFolder({
    photosFolder: view.state.folder || currentPhotosFolder(),
    relayClient,
    selection: view.selectedFilenames(),
    prep,
    profileName: config.sendProfile,
    onLog: (msg) => console.log(`[reveal] ${msg}`),
  });
  if (result.ok) view.state.counters.sent += 1;
  pushState();
  return result;
}

// ---------------------------------------------------------------------------
// Hotkeys
// ---------------------------------------------------------------------------

function registerHotkey(name, accelerator, handler) {
  if (!accelerator) return;
  const ok = globalShortcut.register(accelerator, handler);
  console.log(`[hotkeys] register ${name} "${accelerator}": ${ok ? 'OK' : 'FAILED (already taken by another app?)'}`);
}

/** Pages the photo queue. A no-op while following someone else's brief. */
function pageBoth(delta) {
  view.step(delta);
  syncFocus();
  pushState();
}

// The pass-through hook, when enabled. Held so a settings change can rebind
// it without restarting, and so quit can stop it.
let keyHook = null;

/** What each binding name does. One table, used by both binding backends. */
function bindingActions() {
  return {
    next: () => pageBoth(1),
    prev: () => pageBoth(-1),
    reveal: doReveal,
    // Brief mode is bindable end to end, and that is not a convenience: many
    // pilots see the EFB only through OpenKneeboard and cannot click
    // anything. A control that exists only as a button does not exist for
    // them.
    present: () => {
      handleBriefIntent('brief-present', !view.state.brief.presenting);
      pushState();
    },
    // No FOLLOW binding: following is no longer something a pilot leaves or
    // rejoins. While someone else presents you are in their brief, and it
    // ends when they end it. See viewState.isFollower().
    clearInk: () => {
      handleBriefIntent('brief-clear');
      pushState();
    },
  };
}

/** Dev/test-only: reports what got bound, for either backend. */
function writeHotkeyMarker() {
  if (process.env.INTEL_BROADCAST_HOTKEY_REGISTER_MARKER_PATH) {
    fs.writeFileSync(
      process.env.INTEL_BROADCAST_HOTKEY_REGISTER_MARKER_PATH,
      JSON.stringify({
        reveal: config.hotkeys.reveal,
        revealRegistered: globalShortcut.isRegistered(config.hotkeys.reveal),
      }),
    );
  }
}

// The chrome does NOT auto-hide.
//
// It used to, after a few idle seconds on BRIEF. That hid `.strip`, and both
// the rail and the hamburger that collapses it live in the
// strip. So sitting still on BRIEF removed the only way off the page: you
// click where the key was and nothing is there to receive it.
//
// The first attempt at a fix kept the chrome while the window had focus, which
// is wrong for a subtler reason: `document.hasFocus()` is false in perfectly
// ordinary situations (the window is visible but was never clicked), so the
// chrome still vanished. Gating the only exit from a page on a signal that can
// be wrong is a bad trade for a slightly cleaner capture. If a
// photo-and-nothing-else mode comes back, it needs a control that cannot
// disappear with the thing it controls.
function noteActivity() {
  // Kept as the single place interaction is recorded, so callers read the same.
  view.noteInteraction();
}

function stopKeyHook() {
  if (!keyHook) return;
  keyHook.stop();
  keyHook = null;
}

function registerHotkeys() {
  globalShortcut.unregisterAll();
  stopKeyHook();

  const actions = bindingActions();

  // Pass-through mode: a low-level hook OBSERVES the keys and lets them
  // continue to every other app, so a bare letter is a usable binding and
  // OpenKneeboard/DCS still see the same press. globalShortcut cannot do
  // this — RegisterHotKey both owns a combination exclusively and swallows it.
  if (config.passthroughKeys === true) {
    keyHook = startKeyHook({
      bindings: config.hotkeys,
      onFire: (name) => {
        const action = actions[name];
        if (action) action();
      },
      onLog: (msg) => console.log(`[keys] ${msg}`),
    });
    if (keyHook.ok) {
      for (const [name, accelerator] of Object.entries(config.hotkeys)) {
        if (accelerator) console.log(`[keys] pass-through ${name} "${accelerator}"`);
      }
      writeHotkeyMarker();
      return;
    }
    // Falling back is better than no keybinds at all; the log says why.
    console.log('[keys] falling back to exclusive keybinds');
  }

  registerHotkey('next', config.hotkeys.next, actions.next);
  registerHotkey('prev', config.hotkeys.prev, actions.prev);
  registerHotkey('reveal', config.hotkeys.reveal, actions.reveal);
  registerHotkey('present', config.hotkeys.present, actions.present);
  registerHotkey('clearInk', config.hotkeys.clearInk, actions.clearInk);
  // New in this build: blanks all chrome so the kneeboard capture is just the
  // photo. This is the state that matters most in the air.

  writeHotkeyMarker();
}

// ---------------------------------------------------------------------------
// Tailscale (unchanged behaviour; see PLAN.md for why reconcile only turns ON)
// ---------------------------------------------------------------------------

let lastFunnelAttempt = 0;
let tailscalePollTimer = null;
let lastLoggedFunnelRaw;
const FUNNEL_RETRY_MS = Number(process.env.INTEL_BROADCAST_FUNNEL_RETRY_MS) || 10000;

function wantFunnel() {
  return isHost() && config.gm.funnelEnabled === true;
}

async function refreshTailscaleState({ reconcile = false } = {}) {
  let state;
  try {
    state = await tailscale.getState();
    if (state.funnelRaw !== undefined && state.funnelRaw !== lastLoggedFunnelRaw) {
      lastLoggedFunnelRaw = state.funnelRaw;
      console.log(`[tailscale] funnel status raw: ${state.funnelRaw || '(empty)'}`);
    }
    const startable =
      reconcile && wantFunnel() && state.installed && state.loggedIn && !state.funnelOn && !state.funnelStatusError;
    if (startable && Date.now() - lastFunnelAttempt >= FUNNEL_RETRY_MS) {
      lastFunnelAttempt = Date.now();
      const res = await tailscale.startFunnel(config.gm.relayPort);
      if (res.ok) {
        console.log(`[tailscale] funnel started: public :443 -> 127.0.0.1:${config.gm.relayPort}`);
        state = await tailscale.getState();
        state.since = Date.now();
      } else {
        state.enableUrl = res.enableUrl || null;
        state.funnelError = res.message;
        console.log(`[tailscale] funnel start failed: ${res.message}`);
      }
    } else if (startable && view.state.funnel) {
      state.enableUrl = view.state.funnel.enableUrl || null;
      state.funnelError = view.state.funnel.funnelError || null;
    }
    if (state.funnelOn && view.state.funnel && view.state.funnel.since) state.since = view.state.funnel.since;
    else if (state.funnelOn && !state.since) state.since = Date.now();
  } catch (err) {
    state = { installed: true, error: err.message };
  }
  view.state.funnel = state;
  pushState();
  return state;
}

async function cleanupLeftoverFunnel() {
  try {
    const state = await tailscale.getState();
    if (!wantFunnel() && state.funnelOn && tailscale.funnelTargetPort(state) === config.gm.relayPort) {
      console.log('[tailscale] stopping leftover funnel from a previous session (it targets our relay port)');
      await tailscale.stopFunnel();
    }
  } catch (err) {
    console.log(`[tailscale] leftover-funnel check failed: ${err.message}`);
  }
}

async function handleTailscaleAction(action) {
  if (action === 'open-download') return void shell.openExternal(tailscale.DOWNLOAD_URL);
  if (action === 'open-enable-url') {
    const url = view.state.funnel && view.state.funnel.enableUrl;
    if (url) shell.openExternal(url);
    return;
  }
  if (action === 'login') {
    tailscale
      .login({ onAuthUrl: (url) => shell.openExternal(url) })
      .catch(() => {})
      .finally(() => refreshTailscaleState({ reconcile: true }));
    return;
  }
  if (action === 'toggle-funnel') {
    const next = !(config.gm.funnelEnabled === true);
    applyNewConfig(saveSettingsValues({ gm: { ...config.gm, funnelEnabled: next } }));
    return;
  }
  if (action === 'refresh') {
    lastFunnelAttempt = 0;
    await refreshTailscaleState({ reconcile: true });
  }
}

// ---------------------------------------------------------------------------
// Config apply
// ---------------------------------------------------------------------------

function applyNewConfig(newConfig) {
  const old = config;
  const oldLocale = view.state.locale;
  config = newConfig;

  view.state.callsign = config.callsign;
  view.state.isHost = isHost();
  view.state.autoShow = config.autoShow !== false;
  view.state.profile = config.sendProfile || 'kneeboard';
  // The menu and tray are built by main, so they need rebuilding by hand;
  // the renderers pick the locale up from the next snapshot.
  if (applyLocale() !== oldLocale) buildAppMenu();

  registerHotkeys();

  if (old.photosFolder !== config.photosFolder || old.missionName !== config.missionName) {
    refreshGallery();
    watchPhotosFolder();
  } else if (old.sendProfile !== config.sendProfile) {
    restage();
  }

  const wasHost = old.relayHostEnabled === true;
  const oldUrl = wasHost ? `ws://127.0.0.1:${old.gm.relayPort}` : old.relayUrl;
  if (isHost() && !wasHost) {
    startHost();
    console.log('[index] hosting enabled — embedded relay started');
  } else if (!isHost() && wasHost) {
    stopHost();
    console.log('[index] hosting disabled — embedded relay stopped');
  } else if (isHost() && (old.gm.relayPort !== config.gm.relayPort || old.token !== config.token)) {
    stopHost(() => {
      startHost();
      console.log('[index] relay settings changed — embedded relay restarted');
    });
  }

  if (oldUrl !== effectiveRelayUrl() || old.token !== config.token || old.callsign !== config.callsign) {
    stopClient();
    startClient();
    console.log('[index] relay connection changed — reconnecting');
  }

  const okbBefore = Boolean(old.okb && old.okb.enabled);
  const okbNow = Boolean(config.okb && config.okb.enabled);
  if (okbNow && !okbBefore) startOkb().then(refreshOkbState);
  else if (!okbNow && okbBefore) stopOkb().then(refreshOkbState);
  else refreshOkbState();

  const wantedBefore = old.relayHostEnabled === true && old.gm.funnelEnabled === true;
  lastFunnelAttempt = 0;
  if (wantedBefore && !wantFunnel()) {
    tailscale
      .stopFunnel()
      .then(() => console.log('[tailscale] funnel stopped (sharing disabled in settings)'))
      .catch(() => {})
      .finally(() => refreshTailscaleState());
  } else {
    refreshTailscaleState({ reconcile: true });
  }
  pushState();
}

/**
 * Shows SETUP. It is a page of the viewer — the EFB carries its own settings —
 * so this navigates rather than opening a window. Reached from the rail,
 * the tray and the app menu.
 *
 * The Tailscale panel polls only while SETUP is the page: it shells out to the
 * CLI every few seconds, which is not something to run behind a photo.
 */
function openSettings() {
  view.setPage('setup');
  noteActivity();
  pushState();
  // Cheap registry reads, and only when the panel that shows them is on
  // screen — same rule as the Tailscale polling below.
  refreshOkbState();
  // Dev/test-only: hands the squad code to a harness through a FILE, never
  // through stdout — writing it to a log is exactly what must not happen.
  if (process.env.INTEL_BROADCAST_SQUAD_CODE_MARKER_PATH) {
    const code = hostSquadCode();
    if (code) fs.writeFileSync(process.env.INTEL_BROADCAST_SQUAD_CODE_MARKER_PATH, code);
  }
  startTailscalePolling();
}

function startTailscalePolling() {
  if (tailscalePollTimer) return;
  refreshTailscaleState({ reconcile: true });
  tailscalePollTimer = setInterval(() => refreshTailscaleState({ reconcile: true }), 3000);
}

function stopTailscalePolling() {
  clearInterval(tailscalePollTimer);
  tailscalePollTimer = null;
}

// ---------------------------------------------------------------------------
// Intents from the renderers
// ---------------------------------------------------------------------------

function handleViewerIntent(intent, payload) {
  switch (intent) {
    case 'ready':
      break;
    case 'set-page':
      // EDIT belongs to the CARD page. Walking away is the ordinary way to
      // stop, and a mode still running on a page you cannot see is a mode
      // that will surprise you when you come back.
      if (!['card', 'templates'].includes(payload)) editing = false;
      view.setPage(payload);
      if (payload === 'setup') startTailscalePolling();
      else stopTailscalePolling();
      noteActivity();
      break;
    case 'window-control':
      // The frame is gone so OpenKneeboard never captures a Windows title
      // bar, which makes these the only way to move, size or close the
      // window. No view state is involved: the window is the OS's, not ours.
      if (viewer && !viewer.window.isDestroyed()) {
        if (payload === 'minimize') viewer.window.minimize();
        else if (payload === 'maximize') {
          if (viewer.window.isMaximized()) viewer.window.unmaximize();
          else viewer.window.maximize();
        } else if (payload === 'close') viewer.window.close();
      }
      break;
    case 'card-edit': {
      // One value, named by the absolute path the resolver handed the renderer.
      if (!editing || !cardSource) break;
      const { path: at, value } = payload || {};
      if (typeof at !== 'string' || typeof value !== 'string') break;
      applyCardChange(() => cardEdit.setAt(cardSource, at, value));
      noteActivity();
      break;
    }
    case 'card-line-break': {
      // ENTER IN A PROSE LIST: commit this line and open a new one after it.
      // ONE intent, not an edit followed by an add, and that is not tidiness.
      // As two, main pushed twice: the first render re-opened the editor the
      // pilot was moving to, and the second — the one carrying the new line —
      // was then skipped, because the sheet is deliberately not rebuilt while
      // an editor is open. The new line never appeared. As one change it is
      // also one rollback if the template refuses it.
      if (!editing || !cardSource) break;
      const { path: at, value, repeat, at: index } = payload || {};
      if (typeof at !== 'string' || typeof value !== 'string' || typeof repeat !== 'string') break;
      const block = (cardModel.pages || []).flatMap((p) => p.blocks).find((b) => b.repeat === repeat);
      if (!block) break;
      applyCardChange(() => {
        cardEdit.setAt(cardSource, at, value);
        const made = cardEdit.addRow(cardSource, repeat, {
          max: block.max,
          fields: block.rowFields,
          kind: block.rowKind,
          at: Number.isInteger(index) ? index : null,
        });
        if (!made.ok) console.log(`[card] no line added: ${made.reason}`);
        return true; // the value changed even if the list was at its cap
      });
      noteActivity();
      break;
    }
    case 'card-row-add': {
      if (!editing || !cardSource) break;
      // A bare string is "append to this block"; {repeat, at} inserts, which
      // is what Enter in a prose list means.
      const repeat = typeof payload === 'string' ? payload : (payload || {}).repeat;
      const at = typeof payload === 'object' && payload ? payload.at : null;
      const block = (cardModel.pages || []).flatMap((p) => p.blocks).find((b) => b.repeat === repeat);
      if (!block) break;
      let added = { ok: false };
      applyCardChange(() => {
        added = cardEdit.addRow(cardSource, block.repeat, {
          max: block.max,
          fields: block.rowFields,
          kind: block.rowKind,
          at: Number.isInteger(at) ? at : null,
        });
        if (!added.ok) console.log(`[card] no row added: ${added.reason}`);
        return added.ok;
      });
      // Ticks are keyed by row index: a row inserted above a ticked step
      // pushes that step down, and its tick has to go with it.
      if (added.ok && block.type === 'steps') cardTicks = cardEdit.reindexTicks(cardTicks, added.index, 1);
      if (added.ok) cardRev += 1;
      noteActivity();
      break;
    }
    case 'card-row-remove': {
      if (!editing || !cardSource) break;
      const { repeat, index } = payload || {};
      const block = (cardModel.pages || []).flatMap((p) => p.blocks).find((b) => b.repeat === repeat);
      if (!block) break;
      let gone = { ok: false };
      applyCardChange(() => {
        gone = cardEdit.removeRow(cardSource, repeat, Number(index));
        if (!gone.ok) console.log(`[card] no row removed: ${gone.reason}`);
        return gone.ok;
      });
      // A tick is keyed by row index, so removing a row above a ticked step
      // slides that tick onto a different leg unless the ticks move with it.
      if (gone.ok && block.type === 'steps') cardTicks = cardEdit.reindexTicks(cardTicks, Number(index), -1);
      if (gone.ok) cardRev += 1;
      noteActivity();
      break;
    }
    case 'card-edit-mode': {
      // Refused while this pilot is casting, and casting is refused while
      // this is on — enforced HERE and not only by hiding a key, because the
      // hotkey reaches the same intent.
      const on = Boolean(payload);
      if (on && view.state.brief.presenting) {
        console.log('[card] not while you are casting');
        break;
      }
      editing = on;
      noteActivity();
      break;
    }
    case 'card-tick': {
      // Not while editing: one thing a click can mean at a time.
      if (editing) break;
      // Not on a template being previewed empty. Its rows are placeholders,
      // and a tick there would go out to the net stamped with the hash of
      // whatever card is still loaded — marking a step on somebody else's
      // sheet that this pilot is not even looking at.
      if (chosenTemplateId && (!cardSource || cardSource.layout !== chosenTemplateId)) break;
      const step = Number(payload);
      if (Number.isInteger(step) && step >= 0) {
        // A toggle: clicking a ticked step unticks it, which is what makes a
        // plain click safe enough to replace the hold the design asked for.
        const page = cardModel && cardModel.pages ? cardModel.pages.find((p) => p.id === 'card') : null;
        const steps = page ? page.blocks.find((b) => b.type === 'steps') : null;
        const said = steps && steps.rows[step] ? Boolean(steps.rows[step].done) : false;
        const now = cardTicks.has(step) ? cardTicks.get(step) : said;
        cardTicks.set(step, !now);
        cardRev += 1;
        // And everyone else flying this card sees it. A route card is a
        // shared checklist, not a performance — so unlike ink there is no
        // presenter lock on it, and any pilot may mark a leg flown. Last
        // write wins, which for a four-ship agreeing on whether the tanker
        // is behind them is the right answer and needs no arbitration.
        const hash = cardHash();
        if (hash) originateBrief({ type: 'brief-card-tick', hash, index: step, done: !now });
      }
      noteActivity();
      break;
    }
    case 'toggle-nav':
      view.toggleNav();
      noteActivity();
      break;
    case 'step':
      view.step(payload);
      syncFocus();
      break;
    case 'toggle-received':
      view.toggleItem(payload && payload.batchId, payload && payload.filename);
      syncFocus();
      break;
    case 'set-batch':
      view.setBatchSelected(payload && payload.batchId, Boolean(payload && payload.on));
      syncFocus();
      break;
    case 'focus':
      view.setFocused(Boolean(payload));
      break;
    case 'banner-dismiss':
      view.clearBanner();
      break;
    case 'toggle-photo':
      view.togglePhoto(payload);
      return restage();
    case 'select-all':
      view.setAllSelected(true);
      return restage();
    case 'select-none':
      view.setAllSelected(false);
      return restage();
    case 'browse-folder':
      // The picker lives on SHARE now, next to the gallery it feeds.
      return void browseFolder(viewer && viewer.window).then((folder) => {
        if (folder) applyNewConfig(saveSettingsValues({ photosFolder: folder }));
      });
    case 'card-export':
      // The only way a card leaves as a file. Casting already shares the
      // values, so this is for handing one to someone out of band.
      if (!cardSource) break;
      return void saveCardAs(viewer && viewer.window, payload).then((file) => {
        if (!file) return;
        try {
          fs.writeFileSync(file, JSON.stringify(cardSource, null, 2));
          console.log(`[card] exported to ${file}`);
        } catch (err) {
          console.log(`[card] could not export: ${err.message}`);
        }
      });
    case 'template-import':
      // Inspected, NOT saved. The naming step sits between the two: a template
      // saved before it is named appears in the library under whatever the
      // file happened to call it if the pilot changes their mind.
      return void pickFile(browseLayout, payload).then((file) => {
        if (!file) return;
        const found = templates.inspect(file);
        if (!found.ok) {
          console.log(`[template] REFUSED ${path.basename(file)}: ${found.errors.join('; ')}`);
          view.setTemplateError({ file: path.basename(file), errors: found.errors.slice(0, 6) });
          return pushState();
        }
        // The LAYOUT stays in main. Only what the naming panel shows crosses
        // to the renderer — a template is a file another pilot wrote, and
        // there is no reason for it to be in a DOM.
        pendingLayout = found.layout;
        view.setTemplatePending({ ...found.describe, file: path.basename(file), replaces: found.replaces });
        pushState();
      });
    case 'template-save': {
      const pending = view.state.templatePending;
      if (!pending || !pendingLayout) return;
      const saved = templates.save(pendingLayout, String(payload || pending.name || ''));
      if (!saved.ok) {
        view.setTemplateError({ file: pending.file, errors: saved.errors.slice(0, 6) });
        return void pushState();
      }
      console.log(`[template] saved "${saved.id}"`);
      pendingLayout = null;
      view.setTemplatePending(null);
      refreshTemplates();
      // Straight to it. Importing a template is something you do BECAUSE you
      // want to use it, and leaving the pilot on the library to hunt for the
      // one they just added is a step that exists for no reason.
      chooseTemplate(saved.id);
      return void pushState();
    }
    case 'template-cancel':
      pendingLayout = null;
      view.setTemplatePending(null);
      view.setTemplateError(null);
      return void pushState();
    case 'template-choose':
      chooseTemplate(String(payload || ''));
      view.setPage('card');
      return void pushState();
    case 'template-remove': {
      const gone = templates.remove(String(payload || ''));
      if (!gone.ok) console.log(`[template] not removed: ${gone.errors.join('; ')}`);
      // The card was built on it. Keep the DATA — the pilot may re-import the
      // template — but stop claiming to render a sheet we no longer have.
      if (gone.ok && chosenTemplateId === payload) loadCard();
      refreshTemplates();
      return void pushState();
    }
    case 'card-import':
      // Picked from CARD's own action bar, because that is where a pilot is
      // standing when they want a different card. The path is SAVED, so the
      // card a pilot chose is still there next launch — a mission card they
      // have to re-pick every time is one they will stop using.
      return void pickFile(browseCard, payload).then((file) => {
        if (!file) return;
        applyNewConfig(saveSettingsValues({ cardPath: file }));
        loadCard({ fresh: true });
        view.setPage('card');
        pushState();
      });
    case 'set-auto-show':
      // The toggle lives on the viewer's RECEIVED page now; applies live.
      applyNewConfig(saveSettingsValues({ autoShow: Boolean(payload) }));
      return;
    case 'reveal':
      return void doReveal();
    case 'reconnect':
      stopClient();
      startClient();
      break;
    case 'open-settings':
      openSettings();
      return;
    // SETUP's intents arrive here too — one page, one channel.
    default:
      // Brief intents are VIEWER intents. Putting one in the settings switch
      // compiles, runs, and does nothing.
      if (handleBriefIntent(intent, payload)) break;
      return void handleSettingsIntent(intent, payload);
  }
  pushState();
}

async function handleSettingsIntent(intent, payload) {
  switch (intent) {
    case 'ready':
      break;
    case 'browse-folder': {
      const folder = await browseFolder(viewer && viewer.window);
      if (folder) applyNewConfig(saveSettingsValues({ photosFolder: folder }));
      return;
    }
    case 'copy-code': {
      const code = hostSquadCode();
      if (code) clipboard.writeText(code);
      return;
    }
    case 'new-token': {
      // Rotating invalidates every code ever issued.
      applyNewConfig(saveSettingsValues({ token: squad.generateToken() }));
      return;
    }
    case 'connect': {
      const decoded = squad.tryDecodeSquadCode(payload);
      if (!decoded.ok) return; // CONNECT is disabled in the UI for this case
      applyNewConfig(
        saveSettingsValues({
          relayHostEnabled: false,
          relayUrl: squad.relayUrlFor(decoded),
          token: decoded.token,
        }),
      );
      return;
    }
    case 'update-action':
      if (updater) {
        if (payload === 'download') updater.download();
        else if (payload === 'install') updater.install();
        else updater.check();
      }
      return;
    case 'set-okb-enabled':
      applyNewConfig(saveSettingsValues({ okb: { ...config.okb, enabled: Boolean(payload) } }));
      return;
    case 'set-passthrough-keys':
      applyNewConfig(saveSettingsValues({ passthroughKeys: Boolean(payload) }));
      return;
    case 'set-locale':
      // A display preference, applied immediately — not a form value.
      applyNewConfig(saveSettingsValues({ locale: payload === 'it' ? 'it' : 'en' }));
      return;
    case 'set-hotkey':
      if (payload && payload.key && payload.accelerator) {
        applyNewConfig(saveSettingsValues({ hotkeys: { [payload.key]: payload.accelerator } }));
      }
      return;
    case 'save':
      applyNewConfig(
        saveSettingsValues({
          callsign: String((payload && payload.callsign) || ''),
          relayHostEnabled: Boolean(payload && payload.relayHostEnabled),
          sendProfile: String((payload && payload.profile) || config.sendProfile),
        }),
      );
      return;
    case 'tailscale':
      return void handleTailscaleAction(payload);
    case 'open-log': {
      const logPath = getLogFilePath();
      if (logPath) shell.showItemInFolder(logPath);
      return;
    }
    case 'copy-log-path':
      clipboard.writeText(getLogFilePath() || '');
      return;
    default:
      console.log(`[settings] unknown intent: ${intent}`);
      return;
  }
  pushState();
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------

let isPrimaryInstance = true;
if (!process.env.INTEL_BROADCAST_LOCAL_CONFIG_PATH) {
  isPrimaryInstance = app.requestSingleInstanceLock();
  if (!isPrimaryInstance) app.quit();
  else {
    app.on('second-instance', () => {
      if (viewer && !viewer.window.isDestroyed()) {
        if (viewer.window.isMinimized()) viewer.window.restore();
        viewer.window.show();
        viewer.window.focus();
      }
    });
  }
}

app.whenReady().then(() => {
  if (!isPrimaryInstance) return;

  initFileLogging(app.getPath('userData'));
  console.log(
    `[index] Tac Link ${app.getVersion()} on ${process.platform} — packaged=${app.isPackaged} hosting=${isHost()}`,
  );
  console.log(`[index] settings file: ${LOCAL_CONFIG_PATH}`);

  // Serve image bytes by content hash. The renderer never holds pixels.
  protocol.handle('intel', (request) => {
    const hash = blobs.hashFromUrl(request.url);
    const entry = hash && blobs.get(hash);
    if (!entry) return new Response(null, { status: 404 });
    return new Response(entry.buffer, { headers: { 'content-type': entry.mimeType } });
  });

  ipcMain.on('viewer:intent', (_event, intent, payload) => handleViewerIntent(intent, payload));
  ipcMain.handle('settings:decode-code', (_event, raw) => {
    const decoded = squad.tryDecodeSquadCode(raw);
    // Never return the token to the renderer: it only needs to know it parsed.
    return decoded.ok ? { ok: true, host: decoded.host, port: decoded.port } : { ok: false };
  });
  ipcMain.handle('settings:read-clipboard', () => clipboard.readText());

  buildAppMenu();
  tray = createTray({ onOpenSettings: openSettings, t: i18n.t });

  view.state.callsign = config.callsign;
  view.state.isHost = isHost();
  view.state.autoShow = config.autoShow !== false;
  view.state.profile = config.sendProfile || 'kneeboard';
  view.state.logPath = getLogFilePath() || '';
  view.state.version = app.getVersion();
  applyLocale();

  const initialPosition = isHost() ? { x: 80, y: 80 } : { x: 460, y: 200 };
  viewer = createViewerWindow({
    title: config.windowTitle,
    initialPosition,
    uiScale: config.uiScale,
    onState: pushState,
  });

  attachContextMenu(viewer.window.webContents);

  if (process.env.INTEL_BROADCAST_VIEWER_PANEL_PROBE) attachViewerProbe();

  registerHotkeys();
  refreshGallery();
  watchPhotosFolder();
  // BEFORE loadCard: a card is resolved against a template out of the
  // library, so the library has to exist first.
  templates = createTemplateStore({
    shippedDir: path.join(__dirname, '..', '..', 'resources', 'layouts'),
    userDataDir: app.getPath('userData'),
  });
  refreshTemplates();
  loadCard();
  startUpdater();
  if (isHost()) startHost();
  startClient();
  cleanupLeftoverFunnel().then(() => refreshTailscaleState({ reconcile: true }));

  if (process.env.INTEL_BROADCAST_TEST_TRIGGER_PORT) {
    http
      .createServer((req, res) => {
        doReveal();
        res.end('ok');
      })
      .listen(Number(process.env.INTEL_BROADCAST_TEST_TRIGGER_PORT), '127.0.0.1');
  }

  // OpenKneeboard web-dashboard tab. OFF by default and it stays off unless
  // the pilot asks: window capture is the shipped, working path and nothing
  // about it changes. See design/okb-integration/HANDOFF.md §5.
  if (config.okb && config.okb.enabled === true) startOkb();

  if (process.env.INTEL_BROADCAST_OPEN_SETTINGS) openSettings();

  viewer.window.on('closed', () => {
    stopClient();
    stopHost();
  });
});

/** Dev/test-only: pipes the viewer renderer's console and dumps its DOM. */
function attachViewerProbe() {
  viewer.window.webContents.on('console-message', (_e, level, message) => {
    console.log(`[viewer renderer] ${message}`);
  });
  const probe = setInterval(() => {
    if (viewer.window.isDestroyed()) return clearInterval(probe);
    const evalPath = process.env.INTEL_BROADCAST_VIEWER_EVAL_PATH;
    if (evalPath && fs.existsSync(evalPath)) {
      const source = fs.readFileSync(evalPath, 'utf8');
      fs.rmSync(evalPath, { force: true });
      viewer.window.webContents.executeJavaScript(source).catch((err) => console.log(`[viewer eval] ${err.message}`));
    }
    viewer.window.webContents
      .executeJavaScript(
        `console.log('PANEL_PROBE ' + JSON.stringify({
           page: document.body.dataset.page,
           // SETUP is a page here now, so its probe fields ride along.
           setup: document.body.dataset.setup,
           mode: document.body.dataset.mode,
           hostVisible: Boolean(document.querySelector('.page[data-setup="net"] [data-mode="host"]') && document.querySelector('.page[data-setup="net"] [data-mode="host"]').offsetParent),
           joinVisible: Boolean(document.querySelector('.page[data-setup="net"] [data-mode="join"]') && document.querySelector('.page[data-setup="net"] [data-mode="join"]').offsetParent),
           joinResolved: document.getElementById('join-resolved').textContent,
           dirty: document.getElementById('save-state').textContent,
           saveDisabled: document.getElementById('btn-save').disabled,
           squadCodePrefix: document.getElementById('squad-code').textContent.slice(0, 4),
           squadCodeLength: document.getElementById('squad-code').textContent.length,
           tokenMasked: document.getElementById('net-token').textContent,
           recording: Boolean(document.querySelector('.field--recording')),
           joinSteps: ['join-step1', 'join-step2'].map((id) => {
             const node = document.getElementById(id);
             return node.classList.contains('is-done') ? 'done' : node.classList.contains('is-running') ? 'running' : 'off';
           }),
           doneMarkColour: (() => {
             const done = document.querySelector('.step.is-done .step__mark');
             return done ? getComputedStyle(done).backgroundColor : '';
           })(),
           funnelAction: {
             action: document.getElementById('btn-funnel-action').dataset.action || '',
             label: document.getElementById('btn-funnel-action').textContent,
             visible: Boolean(document.getElementById('btn-funnel-action').offsetParent),
           },
           steps: ['install', 'auth', 'funnel'].reduce((acc, name) => {
             const node = document.getElementById('step-' + name);
             acc[name] = {
               state: node.classList.contains('is-done') ? 'done' : node.classList.contains('is-running') ? 'running' : 'off',
               text: node.querySelector('.step__state').textContent,
             };
             return acc;
           }, {}),
           okbPanel: (() => {
             const tg = document.getElementById('tg-okb');
             if (!tg) return null;
             return {
               on: tg.classList.contains('is-on'),
               hint: document.getElementById('okb-hint').textContent,
               steps: ['found', 'registered', 'tab'].map(
                 (n) => document.getElementById('okb-state-' + n).textContent,
               ),
             };
           })(),
           chromeHidden: document.body.classList.contains('is-chrome-hidden'),
           brief: {
             barShown: !document.getElementById('briefbar').classList.contains('is-hidden'),
             barTitle: document.getElementById('briefbar-title').textContent,
             barKey: document.getElementById('briefbar-key').textContent,
             // The presenter has no bar any more, so what the CAST KEY says is
             // the thing worth probing: it carries the follower count now.
             castSays: document.getElementById('brief-cast').title,
             markShown: !document.getElementById('brief-mark').classList.contains('is-hidden'),
             toolsShown: !document.getElementById('brief-tools').classList.contains('is-hidden'),
             casting: document.getElementById('brief-cast').classList.contains('is-live'),
             inkLive: document.getElementById('stage-ink').classList.contains('is-live'),
             tool: (document.querySelector('#brief-tools [data-tool].is-on') || {}).id || '',
           },
           navCollapsed: document.getElementById('nav').classList.contains('is-collapsed'),
           navDests: [...document.querySelectorAll('#nav .dest[data-dest]')].map((d) => d.dataset.dest),
           navLabels: [...document.querySelectorAll('#nav .dest__label')].map((l) => l.textContent),
           pos: document.getElementById('stage-pos-n').textContent,
           standby: !document.getElementById('stage-standby').classList.contains('is-hidden'),
           batches: [...document.querySelectorAll('.batch[data-batch-id]')].map((b) => ({
             who: b.querySelector('.batch__who').textContent,
             meta: b.querySelector('.batch__meta').textContent,
             all: b.querySelector('.batch__all').textContent,
             tiles: [...b.querySelectorAll('.tile[data-filename]')].map((t) => ({
               filename: t.dataset.filename,
               selected: !t.classList.contains('is-off'),
             })),
           })),
           tiles: [...document.querySelectorAll('#share-grid .tile[data-filename]')].map((t) => ({
             filename: t.dataset.filename,
             selected: !t.classList.contains('is-off'),
             hasThumb: Boolean(t.querySelector('img') && t.querySelector('img').src.startsWith('intel://')),
           })),
           stageSrc: document.getElementById('stage-img').getAttribute('src') || '',
           stageFile: document.getElementById('stage-file').textContent,
           banner: document.getElementById('banner').classList.contains('is-hidden') ? null : document.getElementById('banner-who').textContent,
           bannerMeta: document.getElementById('banner').classList.contains('is-hidden') ? null : document.getElementById('banner-meta').textContent,
           revealBtn: document.getElementById('share-reveal').textContent,
           shareToggle: document.getElementById('share-toggle').textContent,
         }))`,
      )
      .catch(() => {});
  }, 400);
}

/** The app menu, in the current language. Rebuilt when the locale changes. */
function buildAppMenu() {
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Tac Link',
        submenu: [
          { label: i18n.t('menu.settings'), click: openSettings },
          { type: 'separator' },
          { label: i18n.t('menu.quit'), role: 'quit' },
        ],
      },
      {
        // WITHOUT THIS, Ctrl/Cmd+V DOES NOTHING. Electron binds the standard
        // editing shortcuts through menu items carrying these roles; an app
        // that replaces the default menu and omits them leaves every text
        // field unable to paste, which is how the squad code — a string you
        // are explicitly told to paste — could not be pasted.
        label: i18n.t('menu.edit'),
        submenu: [
          { role: 'undo', label: i18n.t('menu.undo') },
          { role: 'redo', label: i18n.t('menu.redo') },
          { type: 'separator' },
          { role: 'cut', label: i18n.t('menu.cut') },
          { role: 'copy', label: i18n.t('menu.copy') },
          { role: 'paste', label: i18n.t('menu.paste') },
          { role: 'selectAll', label: i18n.t('menu.selectAll') },
        ],
      },
    ]),
  );
  if (tray) tray.retranslate(i18n.t);
}

/** Right-click on a text field offers the clipboard. Electron ships no
 *  context menu at all, so without this there is no mouse path to paste. */
function attachContextMenu(webContents) {
  webContents.on('context-menu', (_event, props) => {
    if (!props.isEditable) return;
    Menu.buildFromTemplate([
      { role: 'cut', label: i18n.t('menu.cut'), enabled: props.editFlags.canCut },
      { role: 'copy', label: i18n.t('menu.copy'), enabled: props.editFlags.canCopy },
      { role: 'paste', label: i18n.t('menu.paste'), enabled: props.editFlags.canPaste },
      { type: 'separator' },
      { role: 'selectAll', label: i18n.t('menu.selectAll') },
    ]).popup();
  });
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopKeyHook();
  if (wantFunnel()) tailscale.stopFunnelSync();
});

app.on('window-all-closed', () => app.quit());
