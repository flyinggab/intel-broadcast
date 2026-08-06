'use strict';

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
const { createOkbServer } = require('./okbServer');
// SETUP is a page of the viewer, so there is no settings window module any
// more: what survived is the config writer and the folder dialog.
const { saveSettingsValues, browseFolder } = require('./settingsConfig');

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
  applyBriefMessage(withMe);
  if (relayClient) relayClient.sendBrief(msg);
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

function handleBriefIntent(intent, payload) {
  const hash = currentHash();
  switch (intent) {
    case 'brief-present': {
      const on = Boolean(payload);
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
// ways into the launcher — the breadcrumb and the menu key — live in the
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
 * so this navigates rather than opening a window. Reached from the launcher,
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
    case 'toggle-launcher':
      view.toggleLauncher();
      noteActivity();
      break;
    case 'close-launcher':
      view.setLauncher(false);
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
             markShown: !document.getElementById('brief-mark').classList.contains('is-hidden'),
             toolsShown: !document.getElementById('brief-tools').classList.contains('is-hidden'),
             casting: document.getElementById('brief-cast').classList.contains('is-on'),
             inkLive: document.getElementById('stage-ink').classList.contains('is-live'),
             tool: (document.querySelector('#brief-tools [data-tool].is-on') || {}).id || '',
           },
           launcherOpen: !document.getElementById('launcher').classList.contains('is-hidden'),
           // Not the same question as launcherOpen, and the difference is a
           // shipped bug: the menu was open and taking clicks while the BRIEF
           // stage painted over it, so the class said "open" and the pilot saw
           // nothing. Ask the compositor who is actually on top.
           launcherOnTop: (() => {
             const el = document.getElementById('launcher');
             if (el.classList.contains('is-hidden')) return null;
             const r = el.getBoundingClientRect();
             const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
             return Boolean(hit) && (hit === el || el.contains(hit));
           })(),
           // The same question asked structurally, because the hit test alone
           // is not enough: .stage__chrome is pointer-events: none, so it
           // buries the launcher visually while letting the probe's click
           // straight through. These layers share a stacking context, so the
           // ranking IS the invariant.
           launcherStack: (() => {
             const z = (sel) => {
               const n = document.querySelector(sel);
               return n ? parseInt(getComputedStyle(n).zIndex, 10) || 0 : 0;
             };
             return { launcher: z('#launcher'), chrome: z('.stage__chrome'), standby: z('.stage__standby') };
           })(),
           crumb: document.getElementById('crumb-page').textContent + ' ' + document.getElementById('crumb-pos').textContent,
           dests: [...document.querySelectorAll('.dest[data-dest]')].map((d) => d.dataset.dest),
           groups: [...document.querySelectorAll('.launcher__group')].map((g) => g.textContent),
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
