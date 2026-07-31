'use strict';

// VIEWER — the window OpenKneeboard captures.
//
// ROADMAP §5.2: this file owns NO state. It renders whatever snapshot main
// pushes and sends intents back. There is deliberately no `currentIndex` here
// — phase 4 renders this same markup offscreen into a VR quad alongside the
// desktop window, and state living in one DOM cannot be shared between two
// surfaces. The only mutable module binding is the banner timer handle.
//
// It also never writes inline styles: it toggles the classes and attributes
// in the BRIEF §4 contract, and nothing else. And it never prints a hotkey:
// a printed binding goes stale the moment the pilot records a new one —
// SETUP → KEYS is the single source.

const body = document.body;

const el = (id) => document.getElementById(id);

const strip = { callsign: el('strip-callsign'), net: el('strip-net'), relay: el('strip-relay') };
const banner = {
  root: el('banner'),
  who: el('banner-who'),
  meta: el('banner-meta'),
  close: el('banner-close'),
};
const stage = {
  img: el('stage-img'),
  file: el('stage-file'),
  posN: el('stage-pos-n'),
  posMeta: el('stage-pos-meta'),
  prev: el('stage-prev'),
  next: el('stage-next'),
  standby: el('stage-standby'),
  standbyLine1: el('standby-line1'),
  standbyLine2: el('standby-line2'),
};
const batches = el('batches');
const autoshow = el('tg-autoshow');
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

const PLACEHOLDER = 'img/frame-placeholder.svg';

// Every arrival banner dismisses itself. Keyed on banner.at so a later state
// push re-rendering the SAME banner cannot extend its life.
const BANNER_DISMISS_MS = 10000;
let bannerTimer = null;
let bannerShownAt = null;

// --- formatting -------------------------------------------------------------
// In viewer/format.js so plain node can require and test them; loaded by the
// <script> tag above this one.
const { zulu, megabytes } = self.Format;
// i18n.js is loaded by the <script> tag above format.js.
const { t, photos: photoWord, setLocale, applyStatic } = self.I18n;

// Callsigns and filenames are remote-supplied strings — everything user-facing
// goes in via textContent, never innerHTML.
function setText(node, text) {
  if (node) node.textContent = text;
}

// --- render -----------------------------------------------------------------

function renderStrip(s) {
  setText(strip.callsign, (s.callsign || t('strip.unnamed')).toUpperCase());
  setText(
    strip.net,
    s.isHost ? t('strip.host', { n: s.peers.length }) : s.connected ? t('strip.joined') : t('strip.nonet'),
  );
  setText(strip.relay, s.connected ? t('strip.relayUp', { t: zulu(s.lastContactAt) }) : t('strip.relayDown'));
  strip.relay.classList.toggle('strip__seg--fault', !s.connected);
}

function renderBanner(s) {
  if (!s.banner) {
    banner.root.classList.add('is-hidden');
    bannerShownAt = null;
    clearTimeout(bannerTimer);
    return;
  }
  setText(banner.who, t('banner.newFrom', { who: (s.banner.who || t('fault.unknown')).toUpperCase() }));
  setText(banner.meta, `${photoWord(s.banner.count)} · ${t(s.banner.switched ? 'banner.switched' : 'banner.queued')}`);
  banner.root.classList.remove('is-hidden');
  if (bannerShownAt !== s.banner.at) {
    bannerShownAt = s.banner.at;
    clearTimeout(bannerTimer);
    bannerTimer = setTimeout(() => window.viewerAPI.send('banner-dismiss'), BANNER_DISMISS_MS);
  }
}

function renderStage(s) {
  const q = s.queue;
  const empty = !q.current;
  stage.standby.classList.toggle('is-hidden', !empty);
  if (empty) {
    if (stage.img.getAttribute('src') !== PLACEHOLDER) stage.img.src = PLACEHOLDER;
    setText(stage.file, t('stage.noIntel'));
    setText(stage.posN, '');
    setText(stage.posMeta, '');
    setText(stage.standbyLine1, t('standby.nothing'));
    setText(stage.standbyLine2, t(s.connected ? 'standby.sincePowerUp' : 'standby.relayDown'));
    return;
  }
  // Only reassign src when it actually changed: re-setting it restarts the
  // decode and flashes the stage, which is the one thing that must never
  // happen on the surface a pilot is reading.
  if (stage.img.getAttribute('src') !== q.current.url) stage.img.src = q.current.url;
  setText(stage.file, (q.current.filename || '').toUpperCase());
  setText(stage.posN, `${q.pos + 1} / ${q.total}`);
  setText(stage.posMeta, ` · ${(q.current.sharedBy || t('fault.unknown')).toUpperCase()} · ${zulu(q.current.receivedAt)}`);
}

function renderReceived(s) {
  autoshow.classList.toggle('is-on', Boolean(s.autoShow));
  autoshow.setAttribute('aria-checked', s.autoShow ? 'true' : 'false');

  batches.textContent = '';
  if (s.batches.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'batch';
    const head = document.createElement('div');
    head.className = 'batch__head';
    const who = document.createElement('span');
    who.className = 'batch__who';
    who.textContent = t('received.emptyTitle');
    const meta = document.createElement('span');
    meta.className = 'batch__meta';
    meta.textContent = t('received.emptyHint');
    head.append(who, meta);
    empty.appendChild(head);
    batches.appendChild(empty);
    return;
  }

  for (const batch of s.batches) {
    const root = document.createElement('div');
    root.className = 'batch';
    root.dataset.batchId = String(batch.id);

    const head = document.createElement('div');
    head.className = 'batch__head';
    const who = document.createElement('span');
    who.className = 'batch__who';
    who.textContent = (batch.sharedBy || t('fault.unknown')).toUpperCase();
    const meta = document.createElement('span');
    meta.className = 'batch__meta';
    meta.textContent = t('received.inBrief', {
      sel: batch.selectedCount,
      n: batch.count,
      t: zulu(batch.receivedAt),
    });
    const all = document.createElement('button');
    all.className = 'key key--sm batch__all';
    all.dataset.batchId = String(batch.id);
    all.dataset.on = batch.selectedCount === 0 ? '1' : '0';
    all.textContent = t(batch.selectedCount === 0 ? 'received.restore' : 'received.hide');
    head.append(who, meta, all);

    const tiles = document.createElement('div');
    tiles.className = 'tiles batch__tiles';
    for (const item of batch.items) {
      const tile = document.createElement('button');
      tile.className = 'tile' + (item.selected ? '' : ' is-off');
      tile.dataset.batchId = String(batch.id);
      tile.dataset.filename = item.filename;

      const check = document.createElement('i');
      check.className = 'tile__check';
      const img = document.createElement('img');
      img.className = 'tile__img';
      img.src = item.url || PLACEHOLDER;
      img.alt = '';
      const name = document.createElement('span');
      name.className = 'tile__name';
      name.textContent = item.filename.toUpperCase();

      tile.append(check, img, name);
      tiles.appendChild(tile);
    }

    root.append(head, tiles);
    batches.appendChild(root);
  }
}

function renderShare(s) {
  setText(share.folder, (s.folder ? s.folder.split(/[\\/]/).pop() : t('share.notSet')).toUpperCase());
  setText(
    share.count,
    s.photoCount
      ? t('share.count', { sel: s.selectedCount, n: s.photoCount, size: megabytes(s.stagedBytes) })
      : t('share.noPhotos'),
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
  setText(
    share.reveal,
    s.selectedCount === 0 ? t('share.nothingSelected') : t('share.reveal', { photos: photoWord(s.selectedCount) }),
  );
}

function renderFault(s) {
  const r = s.reconnect || {};
  setText(
    fault.attempt,
    r.attempt
      ? t('fault.attempt', { n: r.attempt, s: Math.ceil((r.nextInMs || 0) / 1000) })
      : t('fault.reconnecting'),
  );
  setText(fault.last, zulu(s.lastContactAt));
  setText(fault.relay, (s.relayLabel || t('fault.unknown')).toUpperCase());
  const photoCount = s.batches.reduce((n, b) => n + b.count, 0);
  setText(fault.cached, t('fault.cached', { batches: s.batches.length, photos: photoCount }));
}

let renderedLocale = null;

function render(s) {
  // Locale first: every string below reads through t().
  if (s.locale !== renderedLocale) {
    renderedLocale = s.locale;
    setLocale(s.locale);
    document.documentElement.lang = s.locale || 'en';
    applyStatic(document);
  }

  body.dataset.page = s.page;
  body.classList.toggle('is-chrome-hidden', s.chromeHidden);
  body.classList.toggle('is-unfocused', !s.focused);

  for (const tab of document.querySelectorAll('.tab')) {
    // SETUP is a launcher, never a page — it must never look selected.
    tab.classList.toggle('is-active', tab.dataset.tab === s.page && tab.dataset.tab !== 'setup');
  }

  renderStrip(s);
  renderBanner(s);
  renderStage(s);
  renderReceived(s);
  renderShare(s);
  renderFault(s);
}

// --- intents ----------------------------------------------------------------
// Every handler sends; none of them mutate. Main decides and pushes back.
// Guarded: under the dev harnesses (preview.html, geometry) there is no
// preload and no main — intents go nowhere.

const send = (intent, payload) => window.viewerAPI && window.viewerAPI.send(intent, payload);

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

// The auto-switch rule. The desired value derives from the rendered state
// (aria-checked mirrors the snapshot), not from renderer-owned state.
autoshow.addEventListener('click', () => {
  send('set-auto-show', autoshow.getAttribute('aria-checked') !== 'true');
});

// RECEIVED curation: a tile drops/restores one photo; the head key a batch.
batches.addEventListener('click', (event) => {
  const all = event.target.closest('.batch__all[data-batch-id]');
  if (all) {
    send('set-batch', { batchId: Number(all.dataset.batchId), on: all.dataset.on === '1' });
    return;
  }
  const tile = event.target.closest('.tile[data-batch-id][data-filename]');
  if (tile) {
    send('toggle-received', { batchId: Number(tile.dataset.batchId), filename: tile.dataset.filename });
  }
});

share.grid.addEventListener('click', (event) => {
  const tile = event.target.closest('.tile[data-filename]');
  if (tile) send('toggle-photo', tile.dataset.filename);
});

el('share-all').addEventListener('click', () => send('select-all'));
el('share-none').addEventListener('click', () => send('select-none'));
el('share-folder-btn').addEventListener('click', () => send('browse-folder'));
share.reveal.addEventListener('click', () => send('reveal'));

el('fault-retry').addEventListener('click', () => send('reconnect'));
el('fault-setup').addEventListener('click', () => send('open-settings'));

// Focus drives the chrome dimming, and counts as the pilot being present —
// main uses that for the auto-switch grace window.
window.addEventListener('focus', () => send('focus', true));
window.addEventListener('blur', () => send('focus', false));

if (window.viewerAPI) {
  window.viewerAPI.onState(render);
  send('ready');
} else {
  // preview.html / the geometry harness, loading this file without Electron:
  // expose the real render so they can drive it with fake snapshots. The
  // shipped HTML carries no demo content — this hook is what populates it.
  window.__preview = { render };
}
