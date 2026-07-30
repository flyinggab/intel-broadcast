'use strict';

const hostFields = document.getElementById('host-fields');
const connectFields = document.getElementById('connect-fields');
const relayUrlNote = document.getElementById('relayUrl-note');
const saveStatusEl = document.getElementById('save-status');

const connectedClientsEl = document.getElementById('connected-clients');
const photosFolderInput = document.getElementById('photosFolder');
const relayPortInput = document.getElementById('relayPort');
const relayUrlInput = document.getElementById('relayUrl');
const callsignInput = document.getElementById('callsign');
const tokenInput = document.getElementById('token');
const hostToggle = document.getElementById('hostToggle');
const funnelToggle = document.getElementById('funnelToggle');

const tsDot = document.getElementById('ts-dot');
const tsStatusText = document.getElementById('ts-status-text');
const tsUrlRow = document.getElementById('ts-url-row');
const tsUrl = document.getElementById('ts-url');
const tsActions = document.getElementById('ts-actions');

let isHost = false;
const hotkeyValues = { reveal: '', prev: '', next: '', settings: '' };

function renderHotkeyValue(key) {
  document.getElementById(`value-${key}`).textContent = hotkeyValues[key] || '—';
}

/** Applies the current isHost to field visibility — called on init AND
 *  whenever the checkbox changes, since hosting is a live, in-session choice.
 *  Everything else (callsign, photos folder, reveal hotkey) belongs to
 *  everyone in unified mode.
 *
 *  The relay URL stays VISIBLE even while hosting (it used to be hidden,
 *  which made the app look like it had nowhere to paste a host's link) — it's
 *  just annotated as unused, since a host connects to its own relay. */
function updateFieldVisibility() {
  hostFields.style.display = isHost ? 'block' : 'none';
  relayUrlInput.disabled = isHost;
  relayUrlNote.textContent = isHost
    ? "Not used while you're hosting — your app connects to its own relay. Others paste YOUR link (below, once sharing is on) into this field on their machine."
    : 'Ask whoever is hosting for their wss:// link, or use their "Copy invite".';
}

hostToggle.addEventListener('change', () => {
  isHost = hostToggle.checked;
  updateFieldVisibility();
});

/** Renders the host's live "Connected clients" list. Built with textContent
 *  (never innerHTML) — callsigns are remote-supplied strings. */
function renderConnectedClients(clients) {
  connectedClientsEl.textContent = '';
  if (!clients || clients.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'clients-empty';
    empty.textContent = 'No one connected yet.';
    connectedClientsEl.appendChild(empty);
    return;
  }
  for (const client of clients) {
    const row = document.createElement('div');
    row.className = 'client-row';
    const name = document.createElement('span');
    name.className = 'client-callsign' + (client.callsign ? '' : ' unnamed');
    name.textContent = client.callsign || 'unnamed pilot';
    const role = document.createElement('span');
    role.className = 'client-role';
    role.textContent = client.role;
    row.append(name, role);
    connectedClientsEl.appendChild(row);
  }
}

window.settingsAPI.onConnectedClients(renderConnectedClients);

function tsButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = label;
  button.addEventListener('click', () => window.settingsAPI.tailscaleAction(action));
  return button;
}

/** Renders the Tailscale panel from a main-process state snapshot — one
 *  status line, the public URL when shared, and only the action buttons that
 *  make sense in the current state. All text via textContent (CLI output and
 *  URLs are not our strings). */
/** Monospace detail block under the status line — raw CLI output and paths.
 *  Only rendered when there's something diagnostic to say. */
function tsDetail(text) {
  const box = document.createElement('div');
  box.className = 'ts-detail';
  box.textContent = text;
  return box;
}

function renderTailscaleState(state) {
  tsActions.textContent = '';
  tsUrlRow.style.display = 'none';
  if (!state) return;

  if (!state.installed) {
    tsDot.className = 'ts-dot bad';
    tsStatusText.textContent =
      'No tailscale command found on this machine. If you just installed it, click Re-check — and if you installed it while this app was already running, restart the app so it picks up the new PATH.';
    tsActions.append(tsButton('Open download page…', 'open-download'), tsButton('Re-check', 'refresh'));
    if (state.triedPaths && state.triedPaths.length) {
      tsActions.append(tsDetail(`Looked in:\n${state.triedPaths.join('\n')}`));
    }
    return;
  }
  if (state.error) {
    tsDot.className = 'ts-dot bad';
    tsStatusText.textContent = 'Tailscale is installed but the command failed:';
    tsActions.append(tsDetail(state.error), tsButton('Re-check', 'refresh'));
    return;
  }
  if (!state.loggedIn) {
    tsDot.className = 'ts-dot warn';
    tsStatusText.textContent = `Tailscale is installed but not logged in (state: ${state.backendState || 'unknown'}). Log in here, or from the Tailscale icon in your system tray — either way this panel notices.`;
    tsActions.append(tsButton('Log in to Tailscale…', 'login'), tsButton('Re-check', 'refresh'));
    if (state.binaryPath) tsActions.append(tsDetail(`Using: ${state.binaryPath}`));
    return;
  }
  if (state.funnelOn) {
    tsDot.className = 'ts-dot ok';
    tsStatusText.textContent = 'Shared publicly — squad members outside your network paste this into their Relay URL:';
    tsUrl.textContent = state.wssUrl || '';
    tsUrlRow.style.display = 'flex';
    tsActions.append(tsButton('Re-check', 'refresh'));
    return;
  }
  if (state.enableUrl) {
    tsDot.className = 'ts-dot warn';
    tsStatusText.textContent =
      'Funnel needs enabling for your tailnet — a one-time approval in the Tailscale admin console, then it retries automatically.';
    tsActions.append(tsButton('Enable Funnel in admin console…', 'open-enable-url'), tsButton('Retry now', 'refresh'));
    if (state.funnelError) tsActions.append(tsDetail(state.funnelError));
    return;
  }
  if (state.funnelError) {
    tsDot.className = 'ts-dot warn';
    tsStatusText.textContent = 'Turning on public sharing failed. Raw output from the tailscale command:';
    tsActions.append(tsDetail(state.funnelError), tsButton('Retry now', 'refresh'));
    return;
  }
  tsDot.className = 'ts-dot';
  tsStatusText.textContent = `Logged in as ${state.dnsName || '(unknown)'} — not shared publicly yet. Tick the box below, then Save & Apply.`;
  tsActions.append(tsButton('Re-check', 'refresh'));
}

window.settingsAPI.onTailscaleState(renderTailscaleState);
document.getElementById('ts-copy-invite').addEventListener('click', () => window.settingsAPI.tailscaleAction('copy-invite'));

window.settingsAPI.onInit(({ isHost: host, config, connectedClients, logPath }) => {
  const logPathEl = document.getElementById('log-path');
  logPathEl.textContent = logPath || '';
  logPathEl.title = logPath || '';
  isHost = host;
  hostToggle.checked = host;
  updateFieldVisibility();
  renderConnectedClients(connectedClients);

  callsignInput.value = config.callsign || '';
  photosFolderInput.value = config.photosFolder || '';
  tokenInput.value = config.token || '';

  for (const key of Object.keys(hotkeyValues)) {
    hotkeyValues[key] = config.hotkeys?.[key] || '';
    renderHotkeyValue(key);
  }

  // Both host and connect fields are populated regardless of current mode, so
  // switching the toggle mid-session shows correct values immediately
  // instead of blank fields.
  relayPortInput.value = config.gm?.relayPort || '';
  funnelToggle.checked = config.gm?.funnelEnabled === true;
  relayUrlInput.value = config.relayUrl || '';
});

document.getElementById('browse').addEventListener('click', async () => {
  const folder = await window.settingsAPI.browseFolder();
  if (folder) photosFolderInput.value = folder;
});

// Browser KeyboardEvent.key names that don't match Electron's accelerator
// vocabulary 1:1 — everything else (letters, digits, F1-F24) already matches.
const KEY_NAME_MAP = {
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ' ': 'Space',
  Escape: 'Esc',
  Enter: 'Return',
  Delete: 'Delete',
  Backspace: 'Backspace',
  Tab: 'Tab',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};

/** Converts a KeyboardEvent into an Electron accelerator string, or null if
 *  only modifier keys have been pressed so far (nothing to record yet). */
function keyEventToAccelerator(event) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null;

  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');

  const mainKey = KEY_NAME_MAP[event.key] || (event.key.length === 1 ? event.key.toUpperCase() : event.key);
  parts.push(mainKey);
  return parts.join('+');
}

let recordingKey = null;
let recordingButton = null;

function stopRecording() {
  if (recordingButton) {
    recordingButton.textContent = 'Record';
    recordingButton.classList.remove('recording');
  }
  recordingKey = null;
  recordingButton = null;
}

document.addEventListener('keydown', (event) => {
  if (!recordingKey) return;
  event.preventDefault();

  if (event.key === 'Escape') {
    stopRecording(); // Escape cancels without changing the bound value
    return;
  }

  const accelerator = keyEventToAccelerator(event);
  if (!accelerator) return; // only modifiers pressed so far, keep listening

  hotkeyValues[recordingKey] = accelerator;
  renderHotkeyValue(recordingKey);
  stopRecording();
});

for (const button of document.querySelectorAll('.record-btn')) {
  button.addEventListener('click', () => {
    stopRecording();
    recordingKey = button.dataset.key;
    recordingButton = button;
    button.textContent = 'Press keys… (Esc to cancel)';
    button.classList.add('recording');
  });
}

// Blank values would otherwise overwrite good defaults with '' (which
// globalShortcut.register() rejects) via config.js's merge — only include a
// hotkey field if it actually has a value.
function nonEmptyHotkeys(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    if (value) out[key] = value;
  }
  return out;
}

document.getElementById('save').addEventListener('click', () => {
  // One unified payload: every field applies to every instance now; the host
  // checkbox only decides whether this machine also runs the relay. Values
  // for the hidden section are sent too (deep merge keeps them consistent
  // with what the form showed).
  saveStatusEl.textContent = 'Saved — applying…';
  window.settingsAPI.save({
    relayHostEnabled: isHost,
    callsign: callsignInput.value.trim(),
    photosFolder: photosFolderInput.value.trim() || null,
    token: tokenInput.value.trim(),
    relayUrl: relayUrlInput.value.trim(),
    gm: { relayPort: Number(relayPortInput.value) || 8787, funnelEnabled: funnelToggle.checked },
    hotkeys: nonEmptyHotkeys(hotkeyValues),
  }).then((result) => {
    if (result && result.ok === false) {
      saveStatusEl.style.color = '#e08a7a';
      saveStatusEl.textContent = result.error || 'Save failed.';
      return;
    }
    // The window stays open on purpose — for a host turning on public
    // sharing, the result (URL or error) lands in the panel above a moment
    // from now, and closing would hide exactly what the save produced.
    saveStatusEl.style.color = '';
    saveStatusEl.textContent = isHost && funnelToggle.checked
      ? 'Saved. Setting up public sharing — watch the Internet sharing panel above.'
      : 'Saved and applied.';
    setTimeout(() => {
      if (saveStatusEl.textContent.startsWith('Saved and applied')) saveStatusEl.textContent = '';
    }, 4000);
  });
});

document.getElementById('open-log').addEventListener('click', () => window.settingsAPI.openLog());
