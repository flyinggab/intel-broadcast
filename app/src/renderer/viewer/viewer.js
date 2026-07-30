'use strict';

const { IntelHistory, formatTime, describeCount } = window.IntelHistory;

const idleEl = document.getElementById('idle');
const photoEl = document.getElementById('photo');
const indexEl = document.getElementById('index-indicator');
const disconnectedEl = document.getElementById('disconnected-banner');

const sidePanel = document.getElementById('side-panel');
const unreadBadge = document.getElementById('unread-badge');
const tabBadge = document.getElementById('tab-badge');
const intelListEl = document.getElementById('intel-list');
const shareGridEl = document.getElementById('share-grid');
const shareFolderEl = document.getElementById('share-folder');
const shareBtn = document.getElementById('share-btn');
const shareNoteEl = document.getElementById('share-note');

const intelHistory = new IntelHistory();
let currentIndex = 0;
let activeTab = 'received';
let gallery = { folder: '', photos: [] };

// ---------------------------------------------------------------------------
// Photo stage
// ---------------------------------------------------------------------------

function renderPhoto() {
  const entry = intelHistory.current;
  if (!entry || entry.items.length === 0) {
    idleEl.style.display = 'block';
    photoEl.style.display = 'none';
    indexEl.style.display = 'none';
    return;
  }

  idleEl.style.display = 'none';
  photoEl.style.display = 'block';
  photoEl.src = entry.items[currentIndex].dataUrl;
  // Position within the batch, plus who shared it (any client can, in
  // unified mode) — kept to one unobtrusive corner line.
  const position = entry.items.length > 1 ? `${currentIndex + 1} / ${entry.items.length}` : '';
  const attribution = entry.sharedBy ? `from ${entry.sharedBy}` : '';
  const label = [position, attribution].filter(Boolean).join(' — ');
  indexEl.style.display = label ? 'block' : 'none';
  indexEl.textContent = label;
}

// ---------------------------------------------------------------------------
// Received tab
// ---------------------------------------------------------------------------

function renderBadges() {
  const count = intelHistory.unreadCount;
  for (const badge of [unreadBadge, tabBadge]) {
    badge.hidden = count === 0;
    badge.textContent = String(count);
  }
}

/** One row per received batch. Built with textContent, never innerHTML —
 *  callsigns are remote-supplied strings. */
function renderIntelList() {
  intelListEl.textContent = '';
  if (intelHistory.entries.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = 'No intel received yet. Anything shared with the squad shows up here.';
    intelListEl.appendChild(empty);
    renderBadges();
    return;
  }

  for (const entry of intelHistory.entries) {
    const row = document.createElement('div');
    row.className = 'intel-row';
    if (entry.unread) row.classList.add('unread');
    if (entry.id === intelHistory.currentId) row.classList.add('current');
    row.dataset.entryId = String(entry.id);

    const dot = document.createElement('span');
    dot.className = 'intel-dot';

    const who = document.createElement('span');
    who.className = 'intel-who';
    who.textContent = entry.sharedBy || 'unknown pilot';

    const meta = document.createElement('span');
    meta.className = 'intel-meta';
    meta.textContent = `${describeCount(entry.items.length)} · ${formatTime(entry.receivedAt)}`;

    row.title = `${entry.sharedBy || 'unknown pilot'} — ${new Date(entry.receivedAt).toLocaleString()}`;
    row.append(dot, who, meta);
    row.addEventListener('click', () => {
      intelHistory.select(entry.id);
      currentIndex = 0;
      renderPhoto();
      renderIntelList();
    });
    intelListEl.appendChild(row);
  }
  renderBadges();
}

// ---------------------------------------------------------------------------
// Share tab
// ---------------------------------------------------------------------------

function selectedFilenames() {
  return gallery.photos.filter((photo) => photo.selected).map((photo) => photo.filename);
}

function renderShareAction() {
  const count = selectedFilenames().length;
  shareBtn.disabled = count === 0;
  shareBtn.textContent = count === 0 ? 'Share' : `Share ${describeCount(count)}`;
  shareNoteEl.textContent =
    gallery.photos.length === 0 ? '' : 'Your reveal hotkey shares this same selection.';
}

function renderGallery() {
  shareFolderEl.textContent = gallery.folder || '';
  shareFolderEl.title = gallery.folder || '';
  shareGridEl.textContent = '';

  if (gallery.photos.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'panel-empty';
    empty.textContent = gallery.folder
      ? 'No photos (.jpg/.png) in this folder.'
      : 'No photos folder set yet — pick one in Settings.';
    shareGridEl.appendChild(empty);
    renderShareAction();
    return;
  }

  for (const photo of gallery.photos) {
    const tile = document.createElement('div');
    tile.className = 'share-tile' + (photo.selected ? ' selected' : '');
    tile.dataset.filename = photo.filename;

    const check = document.createElement('span');
    check.className = 'tile-check';
    check.textContent = photo.selected ? '✓' : '';

    if (photo.thumbnail) {
      const img = document.createElement('img');
      img.src = photo.thumbnail;
      img.alt = '';
      tile.appendChild(img);
    } else {
      const missing = document.createElement('div');
      missing.className = 'tile-missing';
      missing.textContent = 'no preview';
      tile.appendChild(missing);
    }

    const name = document.createElement('div');
    name.className = 'tile-name';
    name.textContent = photo.filename;
    name.title = photo.filename;

    tile.append(check, name);
    tile.addEventListener('click', () => {
      photo.selected = !photo.selected;
      pushSelection();
      renderGallery();
    });
    shareGridEl.appendChild(tile);
  }
  renderShareAction();
}

/** Mirrors the selection into the main process so the reveal HOTKEY shares
 *  the same set the gallery shows (they're one setting, two entry points). */
function pushSelection() {
  window.viewerAPI.setShareSelection(selectedFilenames());
}

async function refreshGallery() {
  gallery = await window.viewerAPI.listPhotos();
  renderGallery();
}

function setAllSelected(selected) {
  for (const photo of gallery.photos) photo.selected = selected;
  pushSelection();
  renderGallery();
}

// ---------------------------------------------------------------------------
// Panel chrome
// ---------------------------------------------------------------------------

function setTab(tab) {
  activeTab = tab;
  for (const button of document.querySelectorAll('.tab-btn')) {
    button.classList.toggle('active', button.dataset.tab === tab);
  }
  document.getElementById('panel-received').classList.toggle('active', tab === 'received');
  document.getElementById('panel-share').classList.toggle('active', tab === 'share');
  document.getElementById('rail-received').classList.toggle('active', tab === 'received');
  document.getElementById('rail-share').classList.toggle('active', tab === 'share');
  if (tab === 'share') refreshGallery();
}

function openPanel(tab) {
  sidePanel.classList.add('open');
  setTab(tab);
  // Opening the panel means the pilot is at the machine looking at it, so
  // whatever is on screen counts as read.
  intelHistory.markCurrentRead();
  renderIntelList();
}

function closePanel() {
  sidePanel.classList.remove('open');
}

document.getElementById('rail-received').addEventListener('click', () => openPanel('received'));
document.getElementById('rail-share').addEventListener('click', () => openPanel('share'));
document.getElementById('panel-close').addEventListener('click', closePanel);
document.getElementById('tab-received').addEventListener('click', () => setTab('received'));
document.getElementById('tab-share').addEventListener('click', () => setTab('share'));

for (const id of ['rail-settings', 'panel-settings']) {
  document.getElementById(id).addEventListener('click', () => window.viewerAPI.openSettings());
}

document.getElementById('select-all').addEventListener('click', () => setAllSelected(true));
document.getElementById('select-none').addEventListener('click', () => setAllSelected(false));
document.getElementById('share-refresh').addEventListener('click', refreshGallery);
shareBtn.addEventListener('click', async () => {
  const filenames = selectedFilenames();
  if (filenames.length === 0) return;
  shareBtn.disabled = true;
  shareNoteEl.textContent = 'Sending…';
  const result = (await window.viewerAPI.shareSelected(filenames)) || {};
  renderShareAction(); // re-enables the button and resets its label
  shareNoteEl.textContent = result.ok
    ? `Shared ${describeCount(result.count)} at ${formatTime(Date.now())}.`
    : `Not sent: ${result.reason || 'unknown error'}`;
});

// The rail fades out while another app has focus so it stays invisible in the
// OpenKneeboard capture; these keep that state in sync.
window.addEventListener('focus', () => {
  document.body.classList.add('focused');
  intelHistory.markCurrentRead();
  renderIntelList();
});
window.addEventListener('blur', () => document.body.classList.remove('focused'));
if (document.hasFocus()) document.body.classList.add('focused');

// ---------------------------------------------------------------------------
// Main-process events
// ---------------------------------------------------------------------------

window.viewerAPI.onShowBatch((batch) => {
  // Already-focused window means the pilot is looking at it — no unread bubble.
  intelHistory.add(batch, { read: document.hasFocus() });
  currentIndex = 0;
  renderPhoto();
  renderIntelList();
});

window.viewerAPI.onConnectionState((state) => {
  disconnectedEl.style.display = state.connected ? 'none' : '';
});

window.viewerAPI.onNavigate((direction) => {
  const entry = intelHistory.current;
  if (!entry || entry.items.length === 0) return;
  const delta = direction === 'next' ? 1 : -1;
  currentIndex = (currentIndex + delta + entry.items.length) % entry.items.length;
  intelHistory.markCurrentRead(); // browsing it is reading it
  renderPhoto();
  renderIntelList();
});

// The photos folder can change in Settings while the panel is open.
window.viewerAPI.onGalleryInvalidated(() => {
  if (activeTab === 'share' && sidePanel.classList.contains('open')) refreshGallery();
});

setTab('received');
renderPhoto();
renderIntelList();
