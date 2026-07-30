'use strict';

const hostFields = document.getElementById('host-fields');
const connectFields = document.getElementById('connect-fields');

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
 *  everyone in unified mode. */
function updateFieldVisibility() {
  hostFields.style.display = isHost ? 'block' : 'none';
  connectFields.style.display = isHost ? 'none' : 'block';
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
function renderTailscaleState(state) {
  tsActions.textContent = '';
  tsUrlRow.style.display = 'none';
  if (!state) return;

  if (!state.installed) {
    tsDot.className = 'ts-dot bad';
    tsStatusText.textContent =
      'Tailscale is not installed on this machine. Install it, then come back — this panel detects it automatically.';
    tsActions.append(tsButton('Open download page…', 'open-download'));
    return;
  }
  if (!state.loggedIn) {
    tsDot.className = 'ts-dot warn';
    tsStatusText.textContent = `Tailscale is installed but not logged in (state: ${state.backendState || 'unknown'}).`;
    tsActions.append(tsButton('Log in to Tailscale…', 'login'));
    return;
  }
  if (state.funnelOn) {
    tsDot.className = 'ts-dot ok';
    tsStatusText.textContent = 'Shared publicly — squad members outside your network use this relay URL:';
    tsUrl.textContent = state.wssUrl || '';
    tsUrlRow.style.display = 'flex';
    return;
  }
  if (state.enableUrl) {
    tsDot.className = 'ts-dot warn';
    tsStatusText.textContent =
      'Funnel needs enabling for your tailnet — a one-time approval in the Tailscale admin console, then it retries automatically.';
    tsActions.append(tsButton('Enable Funnel in admin console…', 'open-enable-url'), tsButton('Retry now', 'refresh'));
    return;
  }
  if (state.error) {
    tsDot.className = 'ts-dot warn';
    tsStatusText.textContent = `Tailscale problem: ${state.error}`;
    tsActions.append(tsButton('Retry', 'refresh'));
    return;
  }
  tsDot.className = 'ts-dot';
  tsStatusText.textContent = `Logged in as ${state.dnsName || '(unknown)'} — not shared publicly. Tick the box below and Save to share.`;
}

window.settingsAPI.onTailscaleState(renderTailscaleState);
document.getElementById('ts-copy-invite').addEventListener('click', () => window.settingsAPI.tailscaleAction('copy-invite'));

window.settingsAPI.onInit(({ isHost: host, config, connectedClients }) => {
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
  window.settingsAPI.save({
    relayHostEnabled: isHost,
    callsign: callsignInput.value.trim(),
    photosFolder: photosFolderInput.value.trim() || null,
    token: tokenInput.value.trim(),
    relayUrl: relayUrlInput.value.trim(),
    gm: { relayPort: Number(relayPortInput.value) || 8787, funnelEnabled: funnelToggle.checked },
    hotkeys: nonEmptyHotkeys(hotkeyValues),
  });
});
