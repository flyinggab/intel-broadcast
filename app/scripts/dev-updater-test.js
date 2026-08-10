'use strict';

// The update state machine, driven with a fake autoUpdater. Pure Node — no
// Electron, no network, no GitHub.
//
//   node scripts/dev-updater-test.js
//
// The point of injecting the updater is that every branch a pilot can hit is
// reachable here, including the ones that only happen on a bad day: no
// network, a release body full of HTML, and the platform where updates cannot
// be applied at all.

const assert = require('assert');
const { EventEmitter } = require('events');
const { createUpdater, plainNotes } = require('../src/main/updater');

/** Stands in for electron-updater. Records what was asked of it. */
function fakeAutoUpdater() {
  const fake = new EventEmitter();
  fake.calls = [];
  fake.checkForUpdates = async () => {
    fake.calls.push('check');
  };
  fake.downloadUpdate = async () => {
    fake.calls.push('download');
  };
  fake.quitAndInstall = () => {
    fake.calls.push('quitAndInstall');
  };
  return fake;
}

// ---------------------------------------------------------------------------
// The happy path, one press at a time. NOTHING may happen without one.
// ---------------------------------------------------------------------------
{
  const fake = fakeAutoUpdater();
  const updater = createUpdater({ autoUpdater: fake, platform: 'win32' });

  assert.strictEqual(fake.autoDownload, false, 'a kneeboard must not download behind the pilot');
  assert.strictEqual(fake.autoInstallOnAppQuit, false, 'nor install on its own');
  assert.strictEqual(fake.fullChangelog, true, 'a pilot two versions behind wants both sets of notes');

  updater.check();
  fake.emit('checking-for-update');
  assert.strictEqual(updater.snapshot().checking, true);

  fake.emit('update-available', { version: '0.9.0', releaseNotes: '<h2>0.9.0</h2><ul><li>Cards</li></ul>' });
  const offered = updater.snapshot();
  assert.strictEqual(offered.checking, false);
  assert.strictEqual(offered.available, true);
  assert.strictEqual(offered.version, '0.9.0');
  assert.ok(offered.notes.includes('Cards'), 'the notes must survive to the panel');
  assert.ok(!offered.notes.includes('<'), 'and must arrive as plain text, never markup');

  // Downloading is a second, separate press.
  assert.deepStrictEqual(fake.calls, ['check'], 'nothing downloaded on its own');
  updater.download();
  fake.emit('download-progress', { percent: 42.7 });
  assert.strictEqual(updater.snapshot().percent, 43);
  fake.emit('update-downloaded', { version: '0.9.0' });
  const ready = updater.snapshot();
  assert.strictEqual(ready.downloaded, true);
  assert.strictEqual(ready.downloading, false);

  // ...and installing is a THIRD. The app never restarts itself.
  assert.ok(!fake.calls.includes('quitAndInstall'), 'downloading must not restart the app');
  assert.strictEqual(updater.install(), true);
  assert.ok(fake.calls.includes('quitAndInstall'));

  console.log('[test] check, download and install are three separate presses');
}

// ---------------------------------------------------------------------------
// Up to date, and the failures a squadron actually hits.
// ---------------------------------------------------------------------------
{
  const fake = fakeAutoUpdater();
  const updater = createUpdater({ autoUpdater: fake, platform: 'win32' });

  fake.emit('update-not-available', { version: '0.8.3' });
  const current = updater.snapshot();
  assert.strictEqual(current.available, false);
  assert.strictEqual(current.checking, false);

  // No network is the NORMAL case for a squadron, not an incident: it must
  // land in state, never as a dialog or a throw.
  fake.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
  const failed = updater.snapshot();
  assert.ok(failed.error.includes('ERR_INTERNET_DISCONNECTED'));
  assert.strictEqual(failed.checking, false);

  // Installing when nothing is downloaded does nothing at all.
  assert.strictEqual(updater.install(), false);
  assert.ok(!fake.calls.includes('quitAndInstall'));

  console.log('[test] up-to-date and offline both land in state, never in a dialog');
}

// ---------------------------------------------------------------------------
// The platform where an update cannot be applied. Saying so up front beats
// failing at the moment a pilot presses the button.
// ---------------------------------------------------------------------------
{
  const fake = fakeAutoUpdater();
  const mac = createUpdater({ autoUpdater: fake, platform: 'darwin' });
  assert.strictEqual(mac.snapshot().supported, false, 'Squirrel.Mac refuses unsigned updates');
  assert.strictEqual(mac.install(), false);
  assert.deepStrictEqual(fake.calls, [], 'and nothing is asked of the updater at all');

  const none = createUpdater({ autoUpdater: null, platform: 'win32' });
  assert.strictEqual(none.snapshot().supported, false, 'a dev run with no updater degrades quietly');

  console.log('[test] unsupported platforms report it rather than failing on the press');
}

// ---------------------------------------------------------------------------
// Release notes are a remote string. They never become markup.
// ---------------------------------------------------------------------------
{
  assert.strictEqual(plainNotes('<p>Hello</p><p>World</p>'), 'Hello\nWorld');
  assert.strictEqual(plainNotes('<ul><li>One</li><li>Two</li></ul>'), '· One\n· Two');
  assert.strictEqual(plainNotes('a &amp; b &lt;c&gt;'), 'a & b <c>');
  assert.strictEqual(plainNotes('line<br>break'), 'line\nbreak');
  assert.ok(!plainNotes('<script>alert(1)</script>drop').includes('<'), 'tags never survive');
  assert.strictEqual(plainNotes(null), '');
  assert.strictEqual(plainNotes(undefined), '');

  // fullChangelog hands back an ARRAY across releases, not a string.
  const many = plainNotes([
    { version: '0.9.0', note: '<li>Cards</li>' },
    { version: '0.8.4', note: 'Fixes' },
  ]);
  assert.ok(many.includes('0.9.0') && many.includes('0.8.4'), 'both releases appear');
  assert.ok(!many.includes('<'), 'still no markup');

  console.log('[test] release notes reach the panel as plain text, string or array');
}

console.log('[dev-updater-test] PASS');
