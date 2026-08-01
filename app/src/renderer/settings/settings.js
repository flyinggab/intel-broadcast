'use strict';

// SETTINGS — a separate BrowserWindow, deliberately NOT the captured one.
//
// Like the viewer, this owns no state: it renders a pushed snapshot and sends
// intents. The one exception is in-progress form input (what you have typed
// but not saved), which is local by definition until you press save. Exactly
// two things are deferred form state: the callsign text and the relay mode —
// everything else applies the moment you touch it.

const body = document.body;
const el = (id) => document.getElementById(id);

const pilot = { callsign: el('in-callsign') };

const net = {
  code: el('squad-code'),
  port: el('net-port'),
  token: el('net-token'),
  stepInstall: el('step-install'),
  stepAuth: el('step-auth'),
  stepFunnel: el('step-funnel'),
  funnelAction: el('btn-funnel-action'),
  funnelHint: el('funnel-hint'),
  codeInput: el('in-code'),
  connect: el('btn-connect'),
  joinStep1: el('join-step1'),
  joinStep2: el('join-step2'),
  joinResolved: el('join-resolved'),
  pilots: el('net-pilots'),
  count: el('net-count'),
  stateDot: el('netstate-dot'),
  stateWhat: el('netstate-what'),
  stateMeta: el('netstate-meta'),
};

const log = {
  version: el('log-version'),
  sent: el('log-sent'),
  recv: el('log-recv'),
  drops: el('log-drops'),
  path: el('log-path'),
  tail: el('log-tail'),
};

const passthrough = { toggle: el('tg-passthrough'), hint: el('passthrough-hint') };
const savebar = { state: el('save-state'), save: el('btn-save') };
const railVersion = el('rail-version');
const langKeys = el('lang-keys');

// Zulu times for the status line and pilots list; loaded by the <script>
// tag above this one.
const { zulu } = self.Format;
// i18n.js is loaded by the <script> tag above format.js.
const { t, setLocale, applyStatic } = self.I18n;

// Local, pre-save form state only.
let mode = 'host';
let modeDirty = false; // the user picked a mode that isn't saved yet
let hotkeys = {};
let recordingKey = null;
let lastSnapshot = null;
// Whether this machine is currently on someone's relay, from the last
// snapshot. Lives up here because render() reads it and refreshJoinPreview()
// also runs on input events, outside render.
let joinConnected = false;

const send = (intent, payload) => window.settingsAPI && window.settingsAPI.send(intent, payload);
const setText = (node, text) => {
  if (node) node.textContent = text;
};

function setStep(node, state, text) {
  node.classList.toggle('is-done', state === 'done');
  node.classList.toggle('is-running', state === 'running');
  setText(node.querySelector('.step__state'), text);
}

// --- dirty tracking ---------------------------------------------------------
/**
 * The three steps are STATUS. This is the only CONTROL on the panel, and its
 * label and action follow whichever step actually needs doing — so there is
 * always one visible way to move the setup forward.
 *
 * The steps used to carry hidden click handlers and nothing else, which meant
 * a host had no way to discover how to turn sharing on: they read as
 * read-only status, because that is what they look like.
 */
function renderFunnelAction(f) {
  let action;
  let label;
  let hint;

  if (!f.installed) {
    [action, label, hint] = ['open-download', 'ts.actInstall', 'ts.hintInstall'];
  } else if (!f.loggedIn) {
    [action, label, hint] = ['login', 'ts.actSignIn', 'ts.hintSignIn'];
  } else if (f.enableUrl) {
    [action, label, hint] = ['open-enable-url', 'ts.actEnable', 'ts.hintEnable'];
  } else if (f.funnelOn) {
    [action, label, hint] = ['toggle-funnel', 'ts.actStop', 'ts.hintOn'];
  } else {
    [action, label, hint] = ['toggle-funnel', 'ts.actShare', f.funnelError ? 'ts.hintEnable' : 'ts.hintShare'];
  }

  net.funnelAction.dataset.action = action;
  setText(net.funnelAction, t(label));
  setText(net.funnelHint, t(hint));
}

function isDirty() {
  if (modeDirty) return true;
  if (!lastSnapshot) return false;
  return pilot.callsign.value.trim() !== (lastSnapshot.callsign || '');
}

function renderSavebar() {
  const dirty = isDirty();
  savebar.save.disabled = !dirty;
  setText(savebar.state, t(dirty ? 'save.unsaved' : 'save.applied'));
}

// --- render -----------------------------------------------------------------

let renderedLocale = null;

function render(s) {
  lastSnapshot = s;

  // Locale first: every string below reads through t().
  if (s.locale !== renderedLocale) {
    renderedLocale = s.locale;
    setLocale(s.locale);
    document.documentElement.lang = s.locale || 'en';
    applyStatic(document);
  }
  for (const key of langKeys.querySelectorAll('[data-locale]')) {
    key.classList.toggle('key--primary', key.dataset.locale === (s.locale || 'en'));
  }

  setText(railVersion, s.version ? `V${s.version}` : '');

  // NETWORK -------------------------------------------------------------
  if (document.activeElement !== pilot.callsign) pilot.callsign.value = s.callsign || '';

  // Status line: what you ARE, regardless of the unsaved choice below it.
  const f = s.funnel || {};
  if (s.isHost) {
    setText(net.stateWhat, t('net.hosting'));
    const funnelPart = f.funnelOn ? t('net.funnelUp', { t: zulu(f.since) }) : t('net.funnelDown');
    setText(net.stateMeta, t('net.hostingMeta', { n: s.peers.length, funnel: funnelPart }));
    net.stateDot.classList.remove('netstate__dot--off');
  } else if (s.connected) {
    setText(net.stateWhat, t('net.joined'));
    setText(net.stateMeta, `${(s.relayLabel || '').toUpperCase()} · ${zulu(s.lastContactAt)}`);
    net.stateDot.classList.remove('netstate__dot--off');
  } else {
    setText(net.stateWhat, t('net.notConnected'));
    setText(net.stateMeta, t(mode === 'join' ? 'net.pasteToJoin' : 'net.offline'));
    net.stateDot.classList.add('netstate__dot--off');
  }

  // Mode is an unsaved form choice until you press save, so a state push must
  // not overwrite it — otherwise picking JOIN gets silently reverted to HOST
  // by the next push, exactly like a text field being retyped under you.
  if (!modeDirty) mode = s.isHost ? 'host' : 'join';
  body.dataset.mode = mode;
  for (const card of document.querySelectorAll('[data-set-mode]')) {
    card.classList.toggle('is-on', card.dataset.setMode === mode);
  }

  // JOIN's step 02 ticks only when a socket is actually up, so keep the flag
  // fresh and re-evaluate — connection state arrives by push, not by typing.
  const wasConnected = joinConnected;
  joinConnected = Boolean(s.connected) && !s.isHost;
  if (wasConnected !== joinConnected) refreshJoinPreview();

  setText(net.code, s.squadCode || t('net.codeUnavailable'));
  setText(net.port, String(s.relayPort || ''));
  setText(net.token, s.tokenMasked || '••••');

  if (!f.installed) setStep(net.stepInstall, 'running', t('ts.notFound'));
  else setStep(net.stepInstall, 'done', t('ts.installed'));
  if (!f.installed) setStep(net.stepAuth, '', t('ts.waiting'));
  else if (!f.loggedIn) setStep(net.stepAuth, 'running', t('ts.signInRequired'));
  else setStep(net.stepAuth, 'done', (f.dnsName || t('ts.signedIn')).toUpperCase());
  renderFunnelAction(f);
  if (f.funnelOn) setStep(net.stepFunnel, 'done', t(s.squadCode ? 'ts.upCodeReady' : 'ts.up'));
  else if (f.enableUrl) setStep(net.stepFunnel, 'running', t('ts.needsEnabling'));
  else if (f.funnelError || f.funnelStatusError) setStep(net.stepFunnel, 'running', t('ts.failed'));
  else setStep(net.stepFunnel, '', t('ts.off'));

  // Pilots on net. Callsigns are remote-supplied strings: textContent only.
  setText(net.count, String(s.peers.length));
  net.pilots.textContent = '';
  if (s.peers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pilot';
    const name = document.createElement('span');
    name.className = 'pilot__name';
    name.textContent = t(s.connected ? 'net.nobodyElse' : 'net.notConnected');
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
    name.textContent = (peer.callsign || t('strip.unnamed')).toUpperCase();
    const meta = document.createElement('span');
    meta.className = 'pilot__meta';
    meta.textContent = peer.self ? t('net.you') : peer.host ? t('net.host') : zulu(peer.connectedAt);
    row.append(dot, name, meta);
    net.pilots.appendChild(row);
  }

  // KEYBINDS ------------------------------------------------------------
  hotkeys = { ...s.hotkeys };
  for (const bind of document.querySelectorAll('[data-record]')) {
    const key = bind.dataset.record;
    const field = bind.parentElement.querySelector('.field');
    if (key === recordingKey) {
      field.classList.add('field--recording');
      setText(field, t('bind.pressKeys'));
      bind.textContent = t('bind.stop');
      bind.classList.add('key--primary');
    } else {
      field.classList.remove('field--recording');
      setText(field, (hotkeys[key] || '—').toUpperCase());
      bind.textContent = t('bind.record');
      bind.classList.remove('key--primary');
    }
  }

  // KEYBINDS: the OpenKneeboard relay. Shown regardless, so the toggle is
  // discoverable, but the hint says plainly when there is nothing to relay to.
  const wantPass = s.passthroughKeys === true;
  passthrough.toggle.classList.toggle('is-on', wantPass);
  passthrough.toggle.setAttribute('aria-checked', wantPass ? 'true' : 'false');
  // Say plainly when it was asked for but could not start, rather than
  // showing "on" while keys are quietly still exclusive.
  setText(
    passthrough.hint,
    t(wantPass ? (s.passthroughActive ? 'keys.passthroughOn' : 'keys.passthroughFailed') : 'keys.passthroughOff'),
  );


  // LOG -----------------------------------------------------------------
  setText(log.version, s.version || '');
  setText(log.sent, String(s.counters.sent));
  setText(log.recv, String(s.counters.received));
  setText(log.drops, String(s.counters.drops));
  setText(log.path, (s.logPath || '').toUpperCase());
  // The squad code is a password: it must never reach the log tail.
  setText(log.tail, (s.logTail || []).join('\n'));

  renderSavebar();
}

// --- JOIN decode ------------------------------------------------------------
// Decode as the user types. A bad code populates nothing, keeps CONNECT dead
// and says so in step 02 — it must not throw into the console and leave the
// UI looking fine.
async function refreshJoinPreview() {
  if (!window.settingsAPI) return; // dev harness: no main to decode against
  const decoded = await window.settingsAPI.decodeCode(net.codeInput.value);
  const typed = net.codeInput.value.trim().length > 0;
  if (decoded.ok) {
    net.connect.disabled = false;
    setText(net.joinResolved, t('net.resolved', { host: decoded.host.toUpperCase(), port: decoded.port }));
  } else {
    net.connect.disabled = true;
    setText(net.joinResolved, t(typed ? 'net.badCode' : 'net.pasteToConnect'));
  }
  // Same idiom as the host column: 01 is satisfied once the code parses, 02
  // once we are actually on that relay. `connected` comes from the snapshot,
  // so the tick reflects a live socket rather than a hopeful click.
  net.joinStep1.classList.toggle('is-done', decoded.ok);
  net.joinStep1.classList.toggle('is-running', !decoded.ok);
  net.joinStep2.classList.toggle('is-done', joinConnected);
  net.joinStep2.classList.toggle('is-running', decoded.ok && !joinConnected);
}

// --- intents ----------------------------------------------------------------

for (const item of document.querySelectorAll('.rail__item')) {
  item.addEventListener('click', () => {
    for (const other of document.querySelectorAll('.rail__item')) {
      other.classList.toggle('is-active', other === item);
    }
    body.dataset.page = item.dataset.page;
  });
}

// The relay choice is exclusive by construction: body[data-mode] hides the
// other path, so there is no state where a host control and a join control
// are both live.
for (const card of document.querySelectorAll('[data-set-mode]')) {
  card.addEventListener('click', () => {
    mode = card.dataset.setMode;
    modeDirty = true;
    body.dataset.mode = mode;
    for (const other of document.querySelectorAll('[data-set-mode]')) {
      other.classList.toggle('is-on', other.dataset.setMode === mode);
    }
    if (lastSnapshot) render(lastSnapshot); // status line hint follows the mode
    renderSavebar();
  });
}

pilot.callsign.addEventListener('input', renderSavebar);

// Language applies immediately — it is a display preference, not a form
// value, so it does not belong behind SAVE & APPLY.
langKeys.addEventListener('click', (event) => {
  const key = event.target.closest('[data-locale]');
  if (key) send('set-locale', key.dataset.locale);
});

el('btn-copy-code').addEventListener('click', () => send('copy-code'));
el('btn-new-token').addEventListener('click', () => {
  // Rotating invalidates every code ever issued — the key's own label says so.
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

el('btn-save').addEventListener('click', () => {
  modeDirty = false; // saving adopts the chosen mode; pushes may drive it again
  send('save', {
    callsign: pilot.callsign.value.trim(),
    relayHostEnabled: mode === 'host',
    hotkeys,
  });
  // Optimistic: the confirming push arrives in a beat, but the bar must not
  // flash "unsaved" in between.
  if (lastSnapshot) lastSnapshot = { ...lastSnapshot, callsign: pilot.callsign.value.trim() };
  renderSavebar();
});

el('btn-open-log').addEventListener('click', () => send('open-log'));
el('btn-copy-path').addEventListener('click', () => send('copy-log-path'));

// One visible control, whose action follows the step that needs doing.
passthrough.toggle.addEventListener('click', () => {
  send('set-passthrough-keys', !passthrough.toggle.classList.contains('is-on'));
});


net.funnelAction.addEventListener('click', () => {
  send('tailscale', net.funnelAction.dataset.action || 'refresh');
});

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
