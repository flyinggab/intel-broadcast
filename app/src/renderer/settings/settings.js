'use strict';

const heading = document.getElementById('heading');
const gmFields = document.getElementById('gm-fields');
const pilotFields = document.getElementById('pilot-fields');
const tailscaleHint = document.getElementById('tailscale-hint');

const photosFolderInput = document.getElementById('photosFolder');
const relayPortInput = document.getElementById('relayPort');
const relayUrlInput = document.getElementById('relayUrl');
const callsignInput = document.getElementById('callsign');
const tokenInput = document.getElementById('token');
const rowReveal = document.getElementById('row-reveal');
const gmModeToggle = document.getElementById('gmModeToggle');

let isGmMode = false;
const hotkeyValues = { reveal: '', prev: '', next: '', settings: '' };

function renderHotkeyValue(key) {
  document.getElementById(`value-${key}`).textContent = hotkeyValues[key] || '—';
}

/** Applies the current isGmMode to field visibility — called on init AND
 *  whenever the checkbox changes, since toggling GM mode is now a live,
 *  in-session choice rather than something fixed at launch. */
function updateFieldVisibility() {
  heading.textContent = isGmMode ? 'GM Settings' : 'Pilot Settings';
  gmFields.style.display = isGmMode ? 'block' : 'none';
  pilotFields.style.display = isGmMode ? 'none' : 'block';
  rowReveal.style.display = isGmMode ? 'flex' : 'none';
}

gmModeToggle.addEventListener('change', () => {
  isGmMode = gmModeToggle.checked;
  updateFieldVisibility();
});

window.settingsAPI.onInit(({ isGmMode: gm, config }) => {
  isGmMode = gm;
  gmModeToggle.checked = gm;
  updateFieldVisibility();

  tokenInput.value = config.token || '';

  for (const key of Object.keys(hotkeyValues)) {
    hotkeyValues[key] = config.hotkeys?.[key] || '';
    renderHotkeyValue(key);
  }

  // Both sets of fields are populated regardless of current mode, so
  // switching the toggle mid-session shows correct values immediately
  // instead of blank fields.
  photosFolderInput.value = config.photosFolder || '';
  relayPortInput.value = config.gm?.relayPort || '';
  tailscaleHint.style.display = 'block';
  tailscaleHint.innerHTML =
    `Local relay: <code>ws://localhost:${config.gm?.relayPort || ''}</code>. ` +
    `To let pilots outside your network reach it, install Tailscale on this machine and run ` +
    `<code>tailscale funnel ${config.gm?.relayPort || ''}</code>, then share the printed ` +
    `<code>https://...</code> URL and this token with your pilots.`;
  relayUrlInput.value = config.relayUrl || '';
  callsignInput.value = config.callsign || '';
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
  const hotkeys = isGmMode ? nonEmptyHotkeys(hotkeyValues) : nonEmptyHotkeys({ ...hotkeyValues, reveal: undefined });

  const values = isGmMode
    ? {
        gmModeEnabled: true,
        photosFolder: photosFolderInput.value.trim() || null,
        token: tokenInput.value.trim(),
        gm: { relayPort: Number(relayPortInput.value) || 8787 },
        hotkeys,
      }
    : {
        gmModeEnabled: false,
        relayUrl: relayUrlInput.value.trim(),
        token: tokenInput.value.trim(),
        callsign: callsignInput.value.trim(),
        hotkeys,
      };

  window.settingsAPI.save(values);
});
