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

let isGmMode = false;
const hotkeyValues = { reveal: '', prev: '', next: '', settings: '' };

function renderHotkeyValue(key) {
  document.getElementById(`value-${key}`).textContent = hotkeyValues[key] || '—';
}

window.settingsAPI.onInit(({ isGmMode: gm, config }) => {
  isGmMode = gm;
  heading.textContent = gm ? 'GM Settings' : 'Pilot Settings';
  gmFields.style.display = gm ? 'block' : 'none';
  pilotFields.style.display = gm ? 'none' : 'block';
  rowReveal.style.display = gm ? 'flex' : 'none';

  tokenInput.value = config.token || '';

  for (const key of Object.keys(hotkeyValues)) {
    hotkeyValues[key] = config.hotkeys?.[key] || '';
    renderHotkeyValue(key);
  }

  if (gm) {
    photosFolderInput.value = config.photosFolder || '';
    relayPortInput.value = config.gm?.relayPort || '';
    tailscaleHint.style.display = 'block';
    tailscaleHint.innerHTML =
      `Local relay: <code>ws://localhost:${config.gm?.relayPort || ''}</code>. ` +
      `To let pilots outside your network reach it, install Tailscale on this machine and run ` +
      `<code>tailscale funnel ${config.gm?.relayPort || ''}</code>, then share the printed ` +
      `<code>https://...</code> URL and this token with your pilots.`;
  } else {
    relayUrlInput.value = config.relayUrl || '';
    callsignInput.value = config.callsign || '';
  }
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
        photosFolder: photosFolderInput.value.trim() || null,
        token: tokenInput.value.trim(),
        gm: { relayPort: Number(relayPortInput.value) || 8787 },
        hotkeys,
      }
    : {
        relayUrl: relayUrlInput.value.trim(),
        token: tokenInput.value.trim(),
        callsign: callsignInput.value.trim(),
        hotkeys,
      };

  window.settingsAPI.save(values);
});
