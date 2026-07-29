'use strict';

const heading = document.getElementById('heading');
const gmFields = document.getElementById('gm-fields');
const pilotFields = document.getElementById('pilot-fields');
const tailscaleHint = document.getElementById('tailscale-hint');

const photosFolderInput = document.getElementById('photosFolder');
const relayPortInput = document.getElementById('relayPort');
const hotkeyRevealInput = document.getElementById('hotkeyReveal');
const relayUrlInput = document.getElementById('relayUrl');
const callsignInput = document.getElementById('callsign');
const tokenInput = document.getElementById('token');
const hotkeyPrevInput = document.getElementById('hotkeyPrev');
const hotkeyNextInput = document.getElementById('hotkeyNext');

let isGmMode = false;

window.settingsAPI.onInit(({ isGmMode: gm, config }) => {
  isGmMode = gm;
  heading.textContent = gm ? 'GM Settings' : 'Pilot Settings';
  gmFields.style.display = gm ? 'block' : 'none';
  pilotFields.style.display = gm ? 'none' : 'block';

  tokenInput.value = config.token || '';
  hotkeyPrevInput.value = config.hotkeys?.prev || '';
  hotkeyNextInput.value = config.hotkeys?.next || '';

  if (gm) {
    photosFolderInput.value = config.photosFolder || '';
    relayPortInput.value = config.gm?.relayPort || '';
    hotkeyRevealInput.value = config.hotkeys?.reveal || '';
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

// Blank values would otherwise overwrite good defaults with '' (which
// globalShortcut.register() rejects) via config.js's merge — only include a
// hotkey field if the user actually put something in it.
function nonEmptyHotkeys(fields) {
  const out = {};
  for (const [key, value] of Object.entries(fields)) {
    const trimmed = value.trim();
    if (trimmed) out[key] = trimmed;
  }
  return out;
}

document.getElementById('save').addEventListener('click', () => {
  const hotkeys = isGmMode
    ? nonEmptyHotkeys({ prev: hotkeyPrevInput.value, next: hotkeyNextInput.value, reveal: hotkeyRevealInput.value })
    : nonEmptyHotkeys({ prev: hotkeyPrevInput.value, next: hotkeyNextInput.value });

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
