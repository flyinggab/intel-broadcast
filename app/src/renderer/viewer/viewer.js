'use strict';

const idleEl = document.getElementById('idle');
const photoEl = document.getElementById('photo');
const indexEl = document.getElementById('index-indicator');
const disconnectedEl = document.getElementById('disconnected-banner');

let items = [];
let currentIndex = 0;
let sharedBy = '';

function render() {
  if (items.length === 0) {
    idleEl.style.display = 'block';
    photoEl.style.display = 'none';
    indexEl.style.display = 'none';
    return;
  }

  idleEl.style.display = 'none';
  photoEl.style.display = 'block';
  photoEl.src = items[currentIndex].dataUrl;
  // Position within the batch, plus who shared it (any client can, in
  // unified mode) — kept to one unobtrusive corner line.
  const position = items.length > 1 ? `${currentIndex + 1} / ${items.length}` : '';
  const attribution = sharedBy ? `from ${sharedBy}` : '';
  const label = [position, attribution].filter(Boolean).join(' — ');
  indexEl.style.display = label ? 'block' : 'none';
  indexEl.textContent = label;
}

window.viewerAPI.onShowBatch((batch) => {
  items = batch.items;
  sharedBy = batch.sharedBy || '';
  currentIndex = 0;
  render();
});

window.viewerAPI.onConnectionState((state) => {
  disconnectedEl.style.display = state.connected ? 'none' : '';
});

window.viewerAPI.onNavigate((direction) => {
  if (items.length === 0) return;
  const delta = direction === 'next' ? 1 : -1;
  currentIndex = (currentIndex + delta + items.length) % items.length;
  render();
});

render();
