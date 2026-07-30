'use strict';

// SETTINGS — a separate BrowserWindow, deliberately NOT the captured one.
//
// Like the viewer, this owns no state: it renders a pushed snapshot and sends
// intents. The one exception is in-progress form input (what you have typed
// but not saved), which is local by definition until you press save.

const body = document.body;
const el = (id) => document.getElementById(id);

const bar = { section: el('bar-section'), callsign: el('bar-callsign') };

const pilot = {
  callsign: el('in-callsign'),
  folder: el('fld-folder'),
  folderMeta: el('fld-folder-meta'),
  strip: el('folder-strip'),
  watch: el('tg-watch'),
  autoshow: el('tg-autoshow'),
  profileKeys: el('profile-keys'),
  profileNote: el('profile-note'),
};

const net = {
  code: el('squad-code'),
  port: el('net-port'),
  token: el('net-token'),
  stepInstall: el('step-install'),
  stepAuth: el('step-auth'),
  stepFunnel: el('step-funnel'),
  codeInput: el('in-code'),
  joinHost: el('join-host'),
  joinToken: el('join-token'),
  connect: el('btn-connect'),
  probe: document.querySelector('[data-mode="join"] .pilot .pilot__name'),
};

const log = {
  version: el('log-version'),
  build: el('log-build'),
  sent: el('log-sent'),
  recv: el('log-recv'),
  drops: el('log-drops'),
  path: el('log-path'),
  tail: el('log-tail'),
};

const PLACEHOLDER = 'img/frame-placeholder.svg';

// Local, pre-save form state only.
let mode = 'host';
let modeDirty = false; // the user picked a mode that isn't saved yet
let profile = 'kneeboard';
let hotkeys = {};
let recordingKey = null;
let lastSnapshot = null;

const send = (intent, payload) => window.settingsAPI.send(intent, payload);
const setText = (node, text) => {
  if (node) node.textContent = text;
};

function setStep(node, state, text) {
  node.classList.toggle('is-done', state === 'done');
  node.classList.toggle('is-running', state === 'running');
  setText(node.querySelector('.step__state'), text);
}

// --- render -----------------------------------------------------------------

function render(s) {
  lastSnapshot = s;
  setText(bar.callsign, (s.callsign || 'UNNAMED').toUpperCase());

  // PILOT --------------------------------------------------------------
  if (document.activeElement !== pilot.callsign) pilot.callsign.value = s.callsign || '';
  setText(pilot.folder, (s.folder ? s.folder.split(/[\\/]/).pop() : 'NOT SET').toUpperCase());
  setText(
    pilot.folderMeta,
    s.photoCount ? `${s.photoCount} IMAGES · ${(s.stagedBytes / (1024 * 1024)).toFixed(1)} MB STAGED` : 'NO IMAGES',
  );

  pilot.strip.textContent = '';
  for (const photo of s.photos.slice(0, 5)) {
    const img = document.createElement('img');
    img.className = 'tile__img';
    img.src = photo.thumbUrl || PLACEHOLDER;
    img.alt = '';
    pilot.strip.appendChild(img);
  }

  setToggle(pilot.autoshow, s.autoShow);
  setToggle(pilot.watch, s.watchFolder);

  profile = s.profile || 'kneeboard';
  for (const key of pilot.profileKeys.querySelectorAll('[data-profile]')) {
    key.classList.toggle('key--primary', key.dataset.profile === profile);
  }
  setText(pilot.profileNote, s.profileNote || '');

  // NET ----------------------------------------------------------------
  // Mode is an unsaved form choice until you press save, so a state push must
  // not overwrite it — otherwise picking JOIN gets silently reverted to HOST
  // by the next push, exactly like a text field being retyped under you.
  if (!modeDirty) mode = s.isHost ? 'host' : 'join';
  body.dataset.mode = mode;
  for (const key of document.querySelectorAll('[data-set-mode]')) {
    key.classList.toggle('key--primary', key.dataset.setMode === mode);
  }
  setText(net.code, s.squadCode || 'NOT AVAILABLE');
  setText(net.port, String(s.relayPort || ''));
  setText(net.token, s.tokenMasked || '••••');

  const f = s.funnel || {};
  if (!f.installed) setStep(net.stepInstall, 'running', 'NOT FOUND · CLICK TO INSTALL');
  else setStep(net.stepInstall, 'done', 'INSTALLED');
  if (!f.installed) setStep(net.stepAuth, '', 'WAITING');
  else if (!f.loggedIn) setStep(net.stepAuth, 'running', 'SIGN IN REQUIRED');
  else setStep(net.stepAuth, 'done', (f.dnsName || 'SIGNED IN').toUpperCase());
  if (f.funnelOn) setStep(net.stepFunnel, 'done', `UP · ${s.squadCode ? 'CODE READY' : 'UP'}`);
  else if (f.enableUrl) setStep(net.stepFunnel, 'running', 'NEEDS ENABLING IN ADMIN');
  else if (f.funnelError || f.funnelStatusError) setStep(net.stepFunnel, 'running', 'FAILED · SEE LOG');
  else setStep(net.stepFunnel, '', 'OFF');

  // KEYS ---------------------------------------------------------------
  hotkeys = { ...s.hotkeys };
  for (const bind of document.querySelectorAll('[data-record]')) {
    const key = bind.dataset.record;
    const field = bind.parentElement.querySelector('.field');
    if (key === recordingKey) {
      field.classList.add('field--recording');
      setText(field, 'PRESS KEYS…');
      bind.textContent = 'STOP';
      bind.classList.add('key--primary');
    } else {
      field.classList.remove('field--recording');
      setText(field, (hotkeys[key] || '—').toUpperCase());
      bind.textContent = 'RECORD';
      bind.classList.remove('key--primary');
    }
  }

  // LOG ----------------------------------------------------------------
  setText(log.version, s.version || '');
  setText(log.build, s.isHost ? 'HOST' : 'JOIN');
  setText(log.sent, String(s.counters.sent));
  setText(log.recv, String(s.counters.received));
  setText(log.drops, String(s.counters.drops));
  setText(log.path, (s.logPath || '').toUpperCase());
  // The squad code is a password: it must never reach the log tail.
  setText(log.tail, (s.logTail || []).join('\n'));
}

function setToggle(node, on) {
  node.classList.toggle('is-on', Boolean(on));
  node.setAttribute('aria-checked', on ? 'true' : 'false');
}

// --- JOIN decode ------------------------------------------------------------
// Decode as the user types. A bad code populates nothing and disables CONNECT
// — it must not throw into the console and leave the UI looking fine.
async function refreshJoinPreview() {
  const decoded = await window.settingsAPI.decodeCode(net.codeInput.value);
  if (decoded.ok) {
    setText(net.joinHost, decoded.host.toUpperCase());
    setText(net.joinToken, 'VALID');
    net.connect.disabled = false;
    setText(net.probe, `RESOLVES TO PORT ${decoded.port}`);
  } else {
    setText(net.joinHost, '—');
    setText(net.joinToken, net.codeInput.value.trim() ? 'INVALID' : '—');
    net.connect.disabled = true;
    setText(net.probe, net.codeInput.value.trim() ? 'CODE NOT RECOGNISED' : 'PASTE A CODE TO CONNECT');
  }
}

// --- intents ----------------------------------------------------------------

for (const tab of document.querySelectorAll('.subtab')) {
  tab.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.subtab')) {
      other.classList.toggle('is-active', other === tab);
    }
    body.dataset.page = tab.dataset.tab;
    setText(bar.section, tab.dataset.tab.toUpperCase());
  });
}

// Mode is exclusive by construction: body[data-mode] hides the other block, so
// there is no state where a host toggle and a relay field are both live.
for (const key of document.querySelectorAll('[data-set-mode]')) {
  key.addEventListener('click', () => {
    mode = key.dataset.setMode;
    modeDirty = true;
    body.dataset.mode = mode;
    for (const other of document.querySelectorAll('[data-set-mode]')) {
      other.classList.toggle('key--primary', other.dataset.setMode === mode);
    }
  });
}

el('btn-folder').addEventListener('click', () => send('browse-folder'));
el('btn-copy-code').addEventListener('click', () => send('copy-code'));
el('btn-new-token').addEventListener('click', () => {
  // Rotating invalidates every code ever issued — say so at the point of the
  // button, not in a doc nobody reads.
  send('new-token');
});
el('btn-paste').addEventListener('click', async () => {
  net.codeInput.value = await window.settingsAPI.readClipboard();
  refreshJoinPreview();
});
net.codeInput.addEventListener('input', refreshJoinPreview);
net.connect.addEventListener('click', () => {
  modeDirty = false;
  send('connect', net.codeInput.value);
});

pilot.autoshow.addEventListener('click', () => {
  const on = !pilot.autoshow.classList.contains('is-on');
  setToggle(pilot.autoshow, on);
  send('set-auto-show', on);
});
pilot.watch.addEventListener('click', () => {
  const on = !pilot.watch.classList.contains('is-on');
  setToggle(pilot.watch, on);
  send('set-watch-folder', on);
});

for (const key of pilot.profileKeys.querySelectorAll('[data-profile]')) {
  key.addEventListener('click', () => send('set-profile', key.dataset.profile));
}

el('btn-save-pilot').addEventListener('click', () => {
  modeDirty = false; // saving adopts the chosen mode; pushes may drive it again
  send('save', {
    callsign: pilot.callsign.value.trim(),
    relayHostEnabled: mode === 'host',
    profile,
    hotkeys,
  });
});

el('btn-open-log').addEventListener('click', () => send('open-log'));
el('btn-copy-path').addEventListener('click', () => send('copy-log-path'));

// Steps double as the action for their stage.
net.stepInstall.addEventListener('click', () => send('tailscale', 'open-download'));
net.stepAuth.addEventListener('click', () => send('tailscale', 'login'));
net.stepFunnel.addEventListener('click', () => send('tailscale', 'toggle-funnel'));

// --- hotkey capture ---------------------------------------------------------
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

function keyEventToAccelerator(event) {
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(event.key)) return null;
  const parts = [];
  if (event.ctrlKey) parts.push('Ctrl');
  if (event.altKey) parts.push('Alt');
  if (event.shiftKey) parts.push('Shift');
  if (event.metaKey) parts.push('Super');
  parts.push(KEY_NAME_MAP[event.key] || (event.key.length === 1 ? event.key.toUpperCase() : event.key));
  return parts.join('+');
}

for (const button of document.querySelectorAll('[data-record]')) {
  button.addEventListener('click', () => {
    recordingKey = recordingKey === button.dataset.record ? null : button.dataset.record;
    if (lastSnapshot) render(lastSnapshot);
  });
}

document.addEventListener('keydown', (event) => {
  if (!recordingKey) return;
  event.preventDefault();
  if (event.key === 'Escape') {
    recordingKey = null;
    if (lastSnapshot) render(lastSnapshot);
    return;
  }
  const accelerator = keyEventToAccelerator(event);
  if (!accelerator) return;
  const key = recordingKey;
  recordingKey = null;
  send('set-hotkey', { key, accelerator });
});

window.settingsAPI.onState(render);
send('ready');
refreshJoinPreview();
