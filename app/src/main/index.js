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
const { createImagePrep } = require('./imagePrep');
const squad = require('./squadCode');
const { createTray } = require('./tray');
const { startKeyHook } = require('./keyHook');
const i18n = require('../renderer/i18n');
const { initFileLogging, getLogFilePath, recentLines } = require('./logger');
const tailscale = require('./tailscale');
const {
  openSettingsWindow,
  registerSettingsIpc,
  saveSettingsValues,
  pushSettingsState,
  isSettingsOpen,
} = require('./settingsWindow');

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

const blobs = createBlobStore();
const view = createViewState();
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
// State push. Both windows are pure renderers of these snapshots (§5.2).
// ---------------------------------------------------------------------------

function pushState() {
  const snapshot = view.snapshot();
  if (viewer) viewer.pushState(snapshot);
  if (isSettingsOpen()) pushSettingsState(settingsSnapshot(snapshot));
}

/** The viewer snapshot plus the fields only the settings window renders. */
function settingsSnapshot(base) {
  return {
    ...base,
    relayPort: config.gm.relayPort,
    passthroughKeys: config.passthroughKeys === true,
    passthroughActive: Boolean(keyHook && keyHook.ok),
    tokenMasked: squad.maskToken(config.token),
    squadCode: hostSquadCode(),
    hotkeys: config.hotkeys,
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
    pushState();
  });
  relayClient.on('reconnecting', (info) => {
    view.state.reconnect = info;
    pushState();
  });
  relayClient.on('reveal-batch', (batch) => {
    // Bytes go to the blob store keyed by content hash; the renderer only ever
    // sees intel:// URLs (§9.1, §5.1).
    const items = batch.items.map((item) => {
      const hash = blobs.put(item.buffer, item.mimeType);
      return { filename: item.filename, url: blobs.urlFor(hash) };
    });
    view.addBatch({ sharedBy: batch.sharedBy, items });
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

/** Pages the photo queue. */
function pageBoth(delta) {
  view.step(delta);
  pushState();
}

// The pass-through hook, when enabled. Held so a settings change can rebind
// it without restarting, and so quit can stop it.
let keyHook = null;

/** What each binding name does. One table, used by both binding backends. */
function bindingActions() {
  return {
    settings: openSettings,
    next: () => pageBoth(1),
    prev: () => pageBoth(-1),
    reveal: doReveal,
    hide: () => {
      view.toggleChrome();
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

  registerHotkey('settings', config.hotkeys.settings, actions.settings);
  registerHotkey('next', config.hotkeys.next, actions.next);
  registerHotkey('prev', config.hotkeys.prev, actions.prev);
  registerHotkey('reveal', config.hotkeys.reveal, actions.reveal);
  // New in this build: blanks all chrome so the kneeboard capture is just the
  // photo. This is the state that matters most in the air.
  registerHotkey('hide', config.hotkeys.hide, actions.hide);

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

function openSettings() {
  const win = openSettingsWindow({ config, uiScale: config.uiScale });
  pushSettingsState(settingsSnapshot(view.snapshot()));
  if (process.env.INTEL_BROADCAST_SETTINGS_PROBE) attachSettingsProbe(win);
  // Dev/test-only: hands the squad code to a harness through a FILE, never
  // through stdout — writing it to a log is exactly what must not happen.
  if (process.env.INTEL_BROADCAST_SQUAD_CODE_MARKER_PATH) {
    const code = hostSquadCode();
    if (code) fs.writeFileSync(process.env.INTEL_BROADCAST_SQUAD_CODE_MARKER_PATH, code);
  }
  if (!tailscalePollTimer) {
    refreshTailscaleState({ reconcile: true });
    tailscalePollTimer = setInterval(() => refreshTailscaleState({ reconcile: true }), 3000);
    win.on('closed', () => {
      clearInterval(tailscalePollTimer);
      tailscalePollTimer = null;
    });
  }
  return win;
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
      break;
    case 'step':
      view.step(payload);
      break;
    case 'toggle-received':
      view.toggleItem(payload && payload.batchId, payload && payload.filename);
      break;
    case 'set-batch':
      view.setBatchSelected(payload && payload.batchId, Boolean(payload && payload.on));
      break;
    case 'toggle-chrome':
      view.toggleChrome();
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
      return void openSettingsWindow.browseFolder().then((folder) => {
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
    default:
      console.log(`[viewer] unknown intent: ${intent}`);
      return;
  }
  pushState();
}

async function handleSettingsIntent(intent, payload) {
  switch (intent) {
    case 'ready':
      break;
    case 'browse-folder': {
      const folder = await openSettingsWindow.browseFolder();
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
    `[index] Intel Broadcast ${app.getVersion()} on ${process.platform} — packaged=${app.isPackaged} hosting=${isHost()}`,
  );
  console.log(`[index] settings file: ${LOCAL_CONFIG_PATH}`);

  // Serve image bytes by content hash. The renderer never holds pixels.
  protocol.handle('intel', (request) => {
    const hash = blobs.hashFromUrl(request.url);
    const entry = hash && blobs.get(hash);
    if (!entry) return new Response(null, { status: 404 });
    return new Response(entry.buffer, { headers: { 'content-type': entry.mimeType } });
  });

  registerSettingsIpc();
  ipcMain.on('viewer:intent', (_event, intent, payload) => handleViewerIntent(intent, payload));
  ipcMain.on('settings:intent', (_event, intent, payload) => handleSettingsIntent(intent, payload));
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

  if (process.env.INTEL_BROADCAST_OPEN_SETTINGS) openSettings();

  viewer.window.on('closed', () => {
    stopClient();
    stopHost();
  });
});

/** Dev/test-only: same probe/eval channel as the viewer, for the settings window. */
function attachSettingsProbe(win) {
  if (win.__probeAttached) return;
  win.__probeAttached = true;
  win.webContents.on('console-message', (_e, level, message) => {
    console.log(`[settings renderer] ${message}`);
  });
  const probe = setInterval(() => {
    if (win.isDestroyed()) return clearInterval(probe);
    const evalPath = process.env.INTEL_BROADCAST_SETTINGS_EVAL_PATH;
    if (evalPath && fs.existsSync(evalPath)) {
      const source = fs.readFileSync(evalPath, 'utf8');
      fs.rmSync(evalPath, { force: true });
      win.webContents.executeJavaScript(source).catch((err) => console.log(`[settings eval] ${err.message}`));
    }
    win.webContents
      .executeJavaScript(
        `console.log('SETTINGS_PROBE ' + JSON.stringify({
           page: document.body.dataset.page,
           mode: document.body.dataset.mode,
           hostVisible: Boolean(document.querySelector('.page[data-page="net"] [data-mode="host"]').offsetParent),
           joinVisible: Boolean(document.querySelector('.page[data-page="net"] [data-mode="join"]').offsetParent),
           connectDisabled: document.getElementById('btn-connect').disabled,
           joinResolved: document.getElementById('join-resolved').textContent,
           netstate: document.getElementById('netstate-what').textContent,
           dirty: document.getElementById('save-state').textContent,
           saveDisabled: document.getElementById('btn-save').disabled,
           // Shape only — the code is a password, and this probe's output goes
           // to stdout and therefore to the log file.
           squadCodePrefix: document.getElementById('squad-code').textContent.slice(0, 4),
           squadCodeLength: document.getElementById('squad-code').textContent.length,
           tokenMasked: document.getElementById('net-token').textContent,
           recording: Boolean(document.querySelector('.field--recording')),
           // The one control on the Tailscale panel: label plus the action it
           // will fire. A host with no visible way to turn sharing on is the
           // bug this reports against.
           funnelAction: {
             action: document.getElementById('btn-funnel-action').dataset.action || '',
             label: document.getElementById('btn-funnel-action').textContent,
             visible: Boolean(document.getElementById('btn-funnel-action').offsetParent),
           },
           joinSteps: ['join-step1', 'join-step2'].map((id) => {
             const node = document.getElementById(id);
             return node.classList.contains('is-done') ? 'done' : node.classList.contains('is-running') ? 'running' : 'off';
           }),
           // The computed colour of a done mark — the point of the change is
           // that a satisfied step is GREEN, which a class name alone would
           // not prove.
           doneMarkColour: (() => {
             const done = document.querySelector('.step.is-done .step__mark');
             return done ? getComputedStyle(done).backgroundColor : '';
           })(),
           steps: ['install', 'auth', 'funnel'].reduce((acc, name) => {
             const node = document.getElementById('step-' + name);
             acc[name] = {
               state: node.classList.contains('is-done') ? 'done' : node.classList.contains('is-running') ? 'running' : 'off',
               text: node.querySelector('.step__state').textContent,
             };
             return acc;
           }, {}),
         }))`,
      )
      .catch(() => {});
  }, 400);
}

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
           chromeHidden: document.body.classList.contains('is-chrome-hidden'),
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
        label: 'Intel Broadcast',
        submenu: [
          { label: i18n.t('menu.settings'), click: openSettings },
          { type: 'separator' },
          { label: i18n.t('menu.quit'), role: 'quit' },
        ],
      },
    ]),
  );
  if (tray) tray.retranslate(i18n.t);
}

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
  stopKeyHook();
  if (wantFunnel()) tailscale.stopFunnelSync();
});

app.on('window-all-closed', () => app.quit());
