'use strict';

// VIEWER — the window OpenKneeboard captures.
//
// ROADMAP §5.2: this file owns NO state. It renders whatever snapshot main
// pushes and sends intents back. There is deliberately no `currentIndex` here
// — phase 4 renders this same markup offscreen into a VR quad alongside the
// desktop window, and state living in one DOM cannot be shared between two
// surfaces.
//
// It also never writes inline styles: it toggles the classes and attributes
// in the BRIEF §4 contract, and nothing else.

const body = document.body;

const el = (id) => document.getElementById(id);

const bar = { callsign: el('bar-callsign'), net: el('bar-net'), staged: el('bar-staged') };
const banner = {
  root: el('banner'),
  who: el('banner-who'),
  meta: el('banner-meta'),
  close: el('banner-close'),
};
const brief = {
  folder: el('brief-folder'),
  funnel: el('brief-funnel'),
  count: el('brief-count'),
  pilots: el('brief-pilots'),
  status: el('brief-status'),
  plateTitle: document.querySelector('[data-page="brief"] .plate__title'),
  plateSubs: document.querySelectorAll('[data-page="brief"] .plate__sub'),
};
const stage = {
  img: el('stage-img'),
  file: el('stage-file'),
  pager: el('stage-pager'),
  prev: el('stage-prev'),
  next: el('stage-next'),
};
const share = {
  folder: el('share-folder'),
  count: el('share-count'),
  grid: el('share-grid'),
  reveal: el('share-reveal'),
};
const fault = {
  attempt: el('fault-attempt'),
  last: el('fault-last'),
  relay: el('fault-relay'),
  cached: el('fault-cached'),
};
const receivedList = el('received-list');
const tabBadge = el('tab-badge');

const PLACEHOLDER = 'img/frame-placeholder.svg';

let bannerTimer = null;

// --- formatting -------------------------------------------------------------
// Zulu time throughout: this is a flight-sim tool and the design specifies
// "1432Z". UTC, no separator, matching how a mission brief reads.
function zulu(ts) {
  if (!ts) return '----Z';
  const d = new Date(ts);
  return `${String(d.getUTCHours()).padStart(2, '0')}${String(d.getUTCMinutes()).padStart(2, '0')}Z`;
}

function megabytes(bytes) {
  if (!bytes) return '0 MB';
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function photoWord(n) {
  return `${n} ${n === 1 ? 'PHOTO' : 'PHOTOS'}`;
}

// Callsigns are remote-supplied strings — everything user-facing goes in via
// textContent, never innerHTML.
function setText(node, text) {
  if (node) node.textContent = text;
}

// --- render -----------------------------------------------------------------

function renderTopBar(s) {
  setText(bar.callsign, (s.callsign || 'UNNAMED').toUpperCase());
  setText(bar.net, `${s.isHost ? 'HOST' : 'JOIN'} · ${s.peers.length}`);
  setText(
    bar.staged,
    s.photoCount ? `${s.selectedCount} OF ${s.photoCount} · ${megabytes(s.stagedBytes)}` : 'NO FOLDER',
  );
}

function renderBanner(s) {
  if (!s.banner) {
    banner.root.classList.add('is-hidden');
    return;
  }
  setText(banner.who, `NEW FROM ${(s.banner.who || 'UNKNOWN').toUpperCase()}`);
  setText(banner.meta, `${photoWord(s.banner.count)} · SWITCHED AUTOMATICALLY`);
  banner.root.classList.remove('is-hidden');
  clearTimeout(bannerTimer);
  bannerTimer = setTimeout(() => window.viewerAPI.send('banner-dismiss'), 6000);
}

function renderBrief(s) {
  const newest = s.batches[0];
  if (newest) {
    setText(brief.plateTitle, zulu(newest.receivedAt));
    const subs = [...brief.plateSubs];
    setText(subs[0], `LAST FROM ${(newest.sharedBy || 'UNKNOWN').toUpperCase()}`);
    setText(subs[1], photoWord(newest.count));
  } else {
    setText(brief.plateTitle, 'STANDBY');
    const subs = [...brief.plateSubs];
    setText(subs[0], 'NO INTEL RECEIVED');
    setText(subs[1], 'SINCE POWER UP');
  }

  setText(brief.folder, (s.folder ? s.folder.split(/[\\/]/).pop() : 'NOT SET').toUpperCase());
  const funnelState = s.funnel && s.funnel.funnelOn ? `UP · ${zulu(s.funnel.since)}` : s.isHost ? 'DOWN' : 'N/A';
  setText(brief.funnel, funnelState);
  setText(brief.count, String(s.peers.length));

  brief.pilots.textContent = '';
  if (s.peers.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'pilot';
    const name = document.createElement('span');
    name.className = 'pilot__name';
    name.textContent = s.connected ? 'NOBODY ELSE ON NET' : 'NOT CONNECTED';
    empty.appendChild(name);
    brief.pilots.appendChild(empty);
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
    brief.pilots.appendChild(row);
  }

  setText(brief.status, s.connected ? `Relay up · ${zulu(s.lastContactAt)}` : 'Relay down');
}

function renderFrame(s) {
  if (!s.frame || !s.frame.url) {
    stage.img.src = PLACEHOLDER;
    setText(stage.file, 'NO INTEL');
    stage.pager.textContent = '';
    return;
  }
  // Only reassign src when it actually changed: re-setting it restarts the
  // decode and flashes the stage, which is the one thing that must never
  // happen on the surface a pilot is reading.
  if (stage.img.getAttribute('src') !== s.frame.url) stage.img.src = s.frame.url;
  setText(stage.file, (s.frame.filename || '').toUpperCase());

  stage.pager.textContent = '';
  if (s.frame.count > 1) {
    for (let i = 0; i < s.frame.count; i++) {
      const dot = document.createElement('i');
      dot.className = 'pager__dot' + (i === s.frame.index ? ' is-current' : '');
      stage.pager.appendChild(dot);
    }
  }
}

function renderReceived(s) {
  receivedList.textContent = '';
  if (s.batches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'row';
    const text = document.createElement('div');
    text.className = 'row__text';
    const who = document.createElement('div');
    who.className = 'row__who';
    who.textContent = 'NOTHING RECEIVED YET';
    const meta = document.createElement('div');
    meta.className = 'row__meta';
    meta.textContent = 'ANYTHING THE SQUAD SHARES LANDS HERE';
    text.append(who, meta);
    empty.appendChild(text);
    receivedList.appendChild(empty);
    return;
  }

  for (const batch of s.batches) {
    const row = document.createElement('div');
    row.className = 'row' + (batch.unread ? ' is-new' : '') + (batch.open ? ' is-open' : '');
    row.dataset.batchId = String(batch.id);

    const thumb = document.createElement('img');
    thumb.className = 'row__thumb';
    thumb.src = batch.thumbUrl || PLACEHOLDER;
    thumb.alt = '';

    const text = document.createElement('div');
    text.className = 'row__text';
    const who = document.createElement('div');
    who.className = 'row__who';
    who.textContent = (batch.sharedBy || 'UNKNOWN').toUpperCase();
    const meta = document.createElement('div');
    meta.className = 'row__meta';
    meta.textContent = `${photoWord(batch.count)} · ${zulu(batch.receivedAt)}`;
    text.append(who, meta);

    row.append(thumb, text);
    if (batch.unread) {
      const mark = document.createElement('i');
      mark.className = 'row__mark';
      row.appendChild(mark);
    }
    receivedList.appendChild(row);
  }
}

function renderShare(s) {
  setText(share.folder, (s.folder ? s.folder.split(/[\\/]/).pop() : 'NOT SET').toUpperCase());
  setText(
    share.count,
    s.photoCount ? `${s.selectedCount} OF ${s.photoCount} · ${megabytes(s.stagedBytes)}` : 'NO PHOTOS',
  );

  share.grid.textContent = '';
  for (const photo of s.photos) {
    const tile = document.createElement('button');
    tile.className = 'tile' + (photo.selected ? '' : ' is-off');
    tile.dataset.filename = photo.filename;

    const check = document.createElement('i');
    check.className = 'tile__check';
    const img = document.createElement('img');
    img.className = 'tile__img';
    img.src = photo.thumbUrl || PLACEHOLDER;
    img.alt = '';
    const name = document.createElement('span');
    name.className = 'tile__name';
    name.textContent = photo.filename.toUpperCase();

    tile.append(check, img, name);
    share.grid.appendChild(tile);
  }

  share.reveal.disabled = s.selectedCount === 0;
  const label = s.selectedCount === 0 ? 'NOTHING SELECTED' : `REVEAL ${photoWord(s.selectedCount)}`;
  share.reveal.firstChild.textContent = label;
}

function renderFault(s) {
  const r = s.reconnect || {};
  setText(
    fault.attempt,
    r.attempt ? `ATTEMPT ${r.attempt} · NEXT IN ${Math.ceil((r.nextInMs || 0) / 1000)}S` : 'RECONNECTING',
  );
  setText(fault.last, zulu(s.lastContactAt));
  setText(fault.relay, (s.relayLabel || 'UNKNOWN').toUpperCase());
  const photos = s.batches.reduce((n, b) => n + b.count, 0);
  setText(fault.cached, `${s.batches.length} BATCHES · ${photos} PHOTOS`);
}

function render(s) {
  body.dataset.page = s.page;
  body.classList.toggle('is-chrome-hidden', s.chromeHidden);
  body.classList.toggle('is-unfocused', !s.focused);

  for (const tab of document.querySelectorAll('.tab')) {
    // SETUP is a launcher, never a page — it must never look selected.
    tab.classList.toggle('is-active', tab.dataset.tab === s.page && tab.dataset.tab !== 'setup');
  }

  tabBadge.textContent = String(s.unread);
  tabBadge.classList.toggle('is-hidden', s.unread === 0);
  // Red is reserved for a broken relay. If it shows up anywhere else it stops
  // meaning anything.
  tabBadge.classList.toggle('is-fault', !s.connected);

  renderTopBar(s);
  renderBanner(s);
  renderBrief(s);
  renderFrame(s);
  renderReceived(s);
  renderShare(s);
  renderFault(s);
}

// --- intents ----------------------------------------------------------------
// Every handler sends; none of them mutate. Main decides and pushes back.

const send = (intent, payload) => window.viewerAPI.send(intent, payload);

for (const tab of document.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    // BRIEF §2: SETUP opens the separate settings window. If it switched a
    // page here, opening setup would put the settings form on the pilot's
    // knee mid-flight.
    if (tab.dataset.tab === 'setup') send('open-settings');
    else send('set-page', tab.dataset.tab);
  });
}

banner.close.addEventListener('click', () => send('banner-dismiss'));

stage.prev.addEventListener('click', () => send('step', -1));
stage.next.addEventListener('click', () => send('step', 1));

receivedList.addEventListener('click', (event) => {
  const row = event.target.closest('.row[data-batch-id]');
  if (row) send('open-batch', Number(row.dataset.batchId));
});

share.grid.addEventListener('click', (event) => {
  const tile = event.target.closest('.tile[data-filename]');
  if (tile) send('toggle-photo', tile.dataset.filename);
});

el('share-all').addEventListener('click', () => send('select-all'));
el('share-none').addEventListener('click', () => send('select-none'));
el('share-rescan').addEventListener('click', () => send('rescan'));
share.reveal.addEventListener('click', () => send('reveal'));

el('key-reveal').addEventListener('click', () => send('reveal'));
el('key-browse').addEventListener('click', () => send('set-page', 'received'));
el('key-hide').addEventListener('click', () => send('toggle-chrome'));

el('fault-retry').addEventListener('click', () => send('reconnect'));
el('fault-setup').addEventListener('click', () => send('open-settings'));

// Focus drives the chrome dimming, and counts as the pilot being present —
// main uses that for the auto-switch grace window.
window.addEventListener('focus', () => send('focus', true));
window.addEventListener('blur', () => send('focus', false));

window.viewerAPI.onState(render);
send('ready');
