'use strict';

// SETUP — a PAGE of the viewer, not a window of its own.
//
// The EFB carries its own settings, the way the tablet a pilot actually flies
// with does. This file runs in the viewer document alongside viewer.js and
// talks over the same channel; only the pieces it owns are here.
//
// Like the viewer, it owns no state: it renders a pushed snapshot and sends
// intents. The one exception is in-progress form input (what you have typed
// but not saved), which is local by definition until you press save. Exactly
// two things are deferred form state: the callsign text and the host/join
// choice — everything else applies the moment you touch it.
//
// It must survive being loaded where its markup is absent (the preview
// harness renders pages one at a time), so every lookup is guarded.

// One document now, so this file gets its own scope: viewer.js already
// declares `body`, `el`, `send` and `setText` at the top level, and a second
// `const body` in the same document is a SyntaxError that takes both
// renderers down. Only __renderSetup escapes.
(function () {
const body = document.body;
const el = (id) => document.getElementById(id);
// SETUP may not be in the document at all (a harness rendering one page); in
// that case this file must load and do nothing rather than throw and take
// viewer.js's listeners down with it.
if (!el('in-callsign')) {
  window.__renderSetup = () => {};
  return;
}

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
  joinStep1: el('join-step1'),
  joinStep2: el('join-step2'),
  joinResolved: el('join-resolved'),
  pilots: el('net-pilots'),
  count: el('net-count'),
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
const update = {
  current: el('up-current'),
  action: el('btn-update-action'),
  hint: el('update-hint'),
  notesWrap: el('update-notes-wrap'),
  notes: el('update-notes'),
};
const okb = {
  toggle: el('tg-okb'),
  hint: el('okb-hint'),
  stepFound: el('okb-step-found'),
  stateFound: el('okb-state-found'),
  stepRegistered: el('okb-step-registered'),
  stateRegistered: el('okb-state-registered'),
  stepTab: el('okb-step-tab'),
  stateTab: el('okb-state-tab'),
};
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

const send = (intent, payload) => window.viewerAPI && window.viewerAPI.send(intent, payload);
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
  // Whether this key is a step still owed. Everything but "stop sharing" is:
  // the host's squad code does not leave their LAN until they press it, and
  // being a flat panel the same tone as the status rows above it, it did not
  // read as a control at all — a host could sit on a finished-looking page
  // with sharing off. --go says "your move"; see tokens.css.
  let owed = true;

  if (!f.installed) {
    [action, label, hint] = ['open-download', 'ts.actInstall', 'ts.hintInstall'];
  } else if (!f.loggedIn) {
    [action, label, hint] = ['login', 'ts.actSignIn', 'ts.hintSignIn'];
  } else if (f.enableUrl) {
    [action, label, hint] = ['open-enable-url', 'ts.actEnable', 'ts.hintEnable'];
  } else if (f.funnelOn) {
    [action, label, hint] = ['toggle-funnel', 'ts.actStop', 'ts.hintOn'];
    owed = false; // nothing is owed once the squad can reach you
  } else {
    [action, label, hint] = ['toggle-funnel', 'ts.actShare', f.funnelError ? 'ts.hintEnable' : 'ts.hintShare'];
  }

  net.funnelAction.dataset.action = action;
  net.funnelAction.classList.toggle('key--cta', owed);
  net.funnelAction.classList.toggle('key--primary', !owed);
  setText(net.funnelAction, t(label));
  setText(net.funnelHint, t(hint));
}

/**
 * The OpenKneeboard panel. Same division as the Tailscale one: the toggle is
 * the only control, the numbered rows are status and are never clickable.
 *
 * Step 03 is honest about what it cannot see. "Tab added" is only knowable
 * once a WebView2 running our page talks back to us, and that transport does
 * not exist yet (design/okb-integration §5) — so it says what the pilot has
 * to do rather than claiming to have detected it.
 */
function renderOkb(o) {
  const on = Boolean(o.enabled);
  okb.toggle.classList.toggle('is-on', on);
  okb.toggle.setAttribute('aria-checked', on ? 'true' : 'false');
  setText(okb.hint, t(!o.supported ? 'okb.notWindows' : on ? 'okb.onHint' : 'okb.offHint'));

  const mark = (node, stateNode, done, label) => {
    node.classList.toggle('is-done', done);
    setText(stateNode, t(label));
  };
  mark(okb.stepFound, okb.stateFound, o.installed, o.installed ? 'okb.found' : 'okb.notFound');
  mark(okb.stepRegistered, okb.stateRegistered, o.registered, o.registered ? 'okb.offered' : 'okb.notOffered');
  mark(okb.stepTab, okb.stateTab, o.connected, o.connected ? 'okb.tabOpen' : 'okb.tabWaiting');
}

/**
 * The update panel. Rows are status, one button is the control, and its label
 * follows whichever step needs doing — the NETWORK panel's shape.
 *
 * `.key--cta` only while something is OWED. An update waiting to be fetched or
 * installed is exactly "there is an action waiting on you here"; "check again"
 * on an up-to-date app is not, and a green key that never goes away stops
 * meaning anything (see the --go note in tokens.css).
 */
function renderUpdate(u, version) {
  // No step rows. "INSTALLED" was reporting that the installed version is
  // installed, and "LATEST" said what the button already says — the button
  // carries the version it is offering, and the hint carries everything else.
  setText(update.current, String(version || '').toUpperCase());

  let action = 'check';
  let label = 'up.actCheck';
  let hint = 'up.hintIdle';
  let owed = false;

  if (!u.supported) {
    [hint] = ['up.hintUnsupported'];
    update.action.disabled = true;
  } else {
    update.action.disabled = Boolean(u.checking || u.downloading);
    if (u.checking) {
      [label, hint] = ['up.actChecking', 'up.hintIdle'];
    } else if (u.error) {
      [label, hint] = ['up.actCheck', 'up.hintFailed'];
    } else if (u.downloaded) {
      [action, label, hint, owed] = ['install', 'up.actRestart', 'up.hintReady', true];
    } else if (u.downloading) {
      // The percentage lives on the button now that there is no status row to
      // put it in — it is the thing moving, so it belongs on the thing pressed.
      [label, hint] = ['up.actDownloading', 'up.hintDownloading'];
    } else if (u.available) {
      [action, label, hint, owed] = ['download', 'up.actDownload', 'up.hintAvailable', true];
    } else {
      [hint] = ['up.hintCurrent'];
    }
  }

  update.action.dataset.action = action;
  update.action.classList.toggle('key--cta', owed);
  update.action.classList.toggle('key--primary', !owed);
  setText(update.action, t(label, { v: u.version || '', n: u.percent || 0 }));
  setText(update.hint, t(hint, { v: u.version || '' }));

  // Release notes are a remote string: textContent, never innerHTML.
  const notes = typeof u.notes === 'string' ? u.notes : '';
  update.notesWrap.classList.toggle('is-hidden', notes.length === 0);
  setText(update.notes, notes);
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

  // The connection state used to be repeated here in a status line. It is in
  // the strip at the top of the window, which is always on screen, so saying
  // it twice was noise. The funnel detail below is still needed.
  const f = s.funnel || {};

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

  renderOkb(s.okb || {});
  renderUpdate(s.update || {}, s.version);

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
// Decode as the user types. A bad code populates nothing and says so in step
// 02 — it must not throw into the console and leave the UI looking fine.
//
// A code that PARSES connects, immediately. There is no CONNECT key: the code
// is an instruction, not a proposal, and a button that only ever gets pressed
// once after a paste is a step for its own sake. `connectedWith` guards the
// obvious hazard — `input` fires per keystroke, and reconnecting on each one
// would tear the socket down over and over.
let connectedWith = null;

async function refreshJoinPreview() {
  if (!window.viewerAPI) return; // dev harness: no main to decode against
  const raw = net.codeInput.value.trim();
  const decoded = await window.viewerAPI.decodeCode(raw);
  if (decoded.ok) {
    setText(net.joinResolved, t('net.resolved', { host: decoded.host.toUpperCase(), port: decoded.port }));
    if (raw !== connectedWith) {
      connectedWith = raw;
      modeDirty = false; // connecting adopts JOIN; it is not a pending edit
      send('connect', raw);
      renderSavebar();
    }
  } else {
    setText(net.joinResolved, t(raw ? 'net.badCode' : 'net.pasteToConnect'));
    connectedWith = null;
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

/** Shows one SETUP section. Exposed so the OFFLINE bar's OPEN SETUP key can
 *  land on NETWORK rather than wherever the rail was left. */
function showSection(name) {
  for (const other of document.querySelectorAll('.rail__item[data-setup]')) {
    other.classList.toggle('is-active', other.dataset.setup === name);
  }
  body.dataset.setup = name;
}
window.__setupSection = showSection;

for (const item of document.querySelectorAll('.rail__item[data-setup]')) {
  item.addEventListener('click', () => showSection(item.dataset.setup));
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
  net.codeInput.value = await window.viewerAPI.readClipboard();
  refreshJoinPreview();
});
net.codeInput.addEventListener('input', refreshJoinPreview);


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
update.action.addEventListener('click', () => {
  if (!update.action.disabled) send('update-action', update.action.dataset.action);
});

okb.toggle.addEventListener('click', () => {
  send('set-okb-enabled', !okb.toggle.classList.contains('is-on'));
});

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

// viewer.js owns onState and drives this through window.__renderSetup, so the
// two renderers cannot disagree about which snapshot they are showing.
window.__renderSetup = render;
if (window.viewerAPI) refreshJoinPreview();
})();
