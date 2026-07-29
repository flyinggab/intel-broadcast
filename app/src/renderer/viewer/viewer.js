'use strict';

const idleEl = document.getElementById('idle');
const photoEl = document.getElementById('photo');
const indexEl = document.getElementById('index-indicator');
const disconnectedEl = document.getElementById('disconnected-banner');

let items = [];
let currentIndex = 0;

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
  indexEl.style.display = items.length > 1 ? 'block' : 'none';
  indexEl.textContent = `${currentIndex + 1} / ${items.length}`;
}

window.viewerAPI.onShowBatch((batch) => {
  items = batch.items;
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
