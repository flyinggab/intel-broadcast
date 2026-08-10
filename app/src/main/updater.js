'use strict';

// In-app updates, and the release notes that come with them.
//
// The publishing half already existed: `--publish always` with the GitHub
// provider makes electron-builder upload `latest.yml` and a `.blockmap`
// alongside the installer, which is exactly what electron-updater consumes —
// the blockmap means an update downloads only the chunks that changed. This
// file is the client half nobody had written.
//
// THREE DECISIONS, all of them about a kneeboard rather than an app:
//
//   1. NOTHING happens without a press. autoDownload is off and quitAndInstall
//      is never called on our own initiative. An update that restarts the app
//      mid-sortie is worse than a stale version — the pilot is looking at it
//      when it vanishes.
//   2. WINDOWS ONLY. Squirrel.Mac refuses an unsigned update and the mac
//      builds are unsigned, so on macOS this reports "unsupported" rather than
//      failing at the moment a pilot presses the button. DCS is Windows-only
//      anyway.
//   3. RELEASE NOTES ARE UNTRUSTED TEXT. They arrive from a GitHub release
//      body, so they are stripped to plain text here and rendered with
//      textContent there. Same rule as a card: remote content never reaches
//      the DOM as markup.
//
// The `autoUpdater` is injected so dev-updater-test can drive the whole state
// machine in plain node, with no Electron and no network.

const DEFAULT_STATE = {
  supported: false,
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  percent: 0,
  version: null, // the version on offer, once known
  notes: '', // plain-text release notes
  error: null,
};

/**
 * Strips a GitHub release body to plain text.
 *
 * Not a sanitiser in the "make this HTML safe" sense — the output never
 * becomes markup at all. It exists so the panel shows readable lines instead
 * of `<h2>` and `&amp;`, and so a release body cannot smuggle anything shaped
 * like markup into a place someone later renders unsafely.
 */
function plainNotes(raw) {
  if (Array.isArray(raw)) {
    // fullChangelog gives [{version, note}, ...] across several releases. Each
    // note is its own release body and has to be stripped in turn — joining
    // them first and stripping the result would work, but recursing means the
    // array branch cannot silently skip the stripping, which is exactly what
    // it did on the first version of this function.
    return raw
      .map((entry) =>
        entry && typeof entry === 'object'
          ? `${entry.version || ''}\n${plainNotes(entry.note)}`.trim()
          : plainNotes(String(entry)),
      )
      .filter(Boolean)
      .join('\n\n')
      .trim();
  }
  if (typeof raw !== 'string') return '';
  return raw
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|h\d)>/gi, '\n')
    .replace(/<li[^>]*>/gi, '· ')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Wires an electron-updater instance into a small state object.
 *
 * `onChange` fires whenever the state moves, so main can push a snapshot.
 */
function createUpdater({ autoUpdater, platform = process.platform, onLog = () => {}, onChange = () => {} } = {}) {
  const state = { ...DEFAULT_STATE, supported: platform === 'win32' && Boolean(autoUpdater) };

  function set(patch) {
    Object.assign(state, patch);
    onChange(snapshot());
  }

  function snapshot() {
    return { ...state };
  }

  if (!state.supported) {
    // macOS and Linux land here, and so does a dev run with no updater. The
    // panel says so; nothing throws at the moment a pilot presses a button.
    return { snapshot, check: async () => snapshot(), download: async () => snapshot(), install: () => false };
  }

  // Nothing downloads and nothing installs on its own — see decision 1.
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  // Notes for every release between the installed version and the newest one,
  // not just the newest: a pilot two versions behind wants both.
  autoUpdater.fullChangelog = true;
  autoUpdater.logger = { info: onLog, warn: onLog, error: onLog, debug: () => {} };

  autoUpdater.on('checking-for-update', () => set({ checking: true, error: null }));

  autoUpdater.on('update-available', (info) => {
    onLog(`update available: ${info && info.version}`);
    set({
      checking: false,
      available: true,
      version: (info && info.version) || null,
      notes: plainNotes(info && info.releaseNotes),
    });
  });

  autoUpdater.on('update-not-available', (info) => {
    set({ checking: false, available: false, version: (info && info.version) || null, notes: '' });
  });

  autoUpdater.on('download-progress', (p) => {
    set({ downloading: true, percent: Math.round((p && p.percent) || 0) });
  });

  autoUpdater.on('update-downloaded', (info) => {
    onLog(`update downloaded: ${info && info.version} — waiting for the pilot to restart`);
    set({ downloading: false, downloaded: true, percent: 100 });
  });

  autoUpdater.on('error', (err) => {
    // Never a dialog and never a throw: a squadron member with no network is
    // the normal case, not an incident.
    const message = (err && err.message) || String(err);
    onLog(`update check failed: ${message}`);
    set({ checking: false, downloading: false, error: message });
  });

  return {
    snapshot,
    async check() {
      try {
        await autoUpdater.checkForUpdates();
      } catch (err) {
        set({ checking: false, error: (err && err.message) || String(err) });
      }
      return snapshot();
    },
    async download() {
      if (!state.available || state.downloading || state.downloaded) return snapshot();
      set({ downloading: true, percent: 0, error: null });
      try {
        await autoUpdater.downloadUpdate();
      } catch (err) {
        set({ downloading: false, error: (err && err.message) || String(err) });
      }
      return snapshot();
    },
    /** The ONE place the app restarts itself, and only from a press. */
    install() {
      if (!state.downloaded) return false;
      onLog('installing update — the app will restart');
      autoUpdater.quitAndInstall();
      return true;
    },
  };
}

module.exports = { createUpdater, plainNotes, DEFAULT_STATE };
