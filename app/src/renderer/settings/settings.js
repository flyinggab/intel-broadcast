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
  pilots: el('net-pilots'),
  count: el('net-count'),
};

const savebar = { state: el('save-state'), save: el('btn-save') };

const log = {
  version: el('log-version'),
  build: el('log-build'),
  sent: el('log-sent'),
  recv: el('log-recv'),
  drops: el('log-drops'),
  path: el('log-path'),
  tail: el('log-tail'),
};

// Zulu times for the pilots list; loaded by the <script> tag above this one.
const { zulu } = self.Format;

// Local, pre-save form state only.
let mode = 'host';
let modeDirty = false; // the user picked a mode that isn't saved yet
let profile = 'kneeboard';
let hotkeys = {};
let recordingKey = null;
let lastSnapshot = null;

const send = (intent, payload) => window.settingsAPI && window.settingsAPI.send(intent, payload);
const setText = (node, text) => {
  if (node) node.textContent = text;
};

// --- dirty tracking ---------------------------------------------------------
// Most controls apply the moment you touch them (toggles, quality, hotkeys,
// CONNECT). Exactly two things are deferred form state: the callsign text and
// the HOST/JOIN mode. The save bar reflects those two, and only those two —
// "ALL CHANGES APPLIED" is then always literally true.
function isDirty() {
  if (modeDirty) return true;
  if (!lastSnapshot) return false;
  return pilot.callsign.value.trim() !== (lastSnapshot.callsign || '');
}

function renderSavebar() {
  const dirty = isDirty();
  savebar.save.disabled = !dirty;
  setText(savebar.state, dirty ? 'UNSAVED CHANGES' : 'ALL CHANGES APPLIED');
}

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

  // Pilots on net — moved here from the viewer's BRIEF page. Callsigns are
  // remote-supplied strings: textContent only, never innerHTML.
  setText(net.count, String(s.peers.length));
  net.pilots.textContent = '';
  if (s.peers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pilot';
    const name = document.createElement('span');
    name.className = 'pilot__name';
    name.textContent = s.connected ? 'NOBODY ELSE ON NET' : 'NOT CONNECTED';
    empty.appendChild(name);
    net.pilots.appendChild(empty);
  }
  for (const peer of s.peers) {
    const row = document.createElement('div');
    row.className = 'pilot';
    const dot = document.createElement('i');
    dot.className = 'pilot__dot';
    const name = document.createElement('span');
    name.className = 'pilot__name';
    name.textContent = (peer.callsign || 'UNNAMED').toUpperCase();
    const meta = document.createElement('span');
    meta.className = 'pilot__meta';
    meta.textContent = peer.self ? 'YOU' : peer.host ? 'HOST' : zulu(peer.connectedAt);
    row.append(dot, name, meta);
    net.pilots.appendChild(row);
  }

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

  renderSavebar();
}

function setToggle(node, on) {
  node.classList.toggle('is-on', Boolean(on));
  node.setAttribute('aria-checked', on ? 'true' : 'false');
}

// --- JOIN decode ------------------------------------------------------------
// Decode as the user types. A bad code populates nothing and disables CONNECT
// — it must not throw into the console and leave the UI looking fine.
async function refreshJoinPreview() {
  if (!window.settingsAPI) return; // dev harness: no main to decode against
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
    renderSavebar();
  });
}

pilot.callsign.addEventListener('input', renderSavebar);

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
  modeDirty = false; // CONNECT applies the mode immediately
  send('connect', net.codeInput.value);
  renderSavebar();
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

el('btn-save').addEventListener('click', () => {
  modeDirty = false; // saving adopts the chosen mode; pushes may drive it again
  send('save', {
    callsign: pilot.callsign.value.trim(),
    relayHostEnabled: mode === 'host',
    profile,
    hotkeys,
  });
  // Optimistic: the confirming push arrives in a beat, but the bar must not
  // flash "unsaved" in between.
  if (lastSnapshot) lastSnapshot = { ...lastSnapshot, callsign: pilot.callsign.value.trim() };
  renderSavebar();
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

if (window.settingsAPI) {
  window.settingsAPI.onState(render);
  send('ready');
  refreshJoinPreview();
} else {
  // Dev harnesses (preview.html, geometry): drive the real render directly.
  window.__preview = { render };
}
