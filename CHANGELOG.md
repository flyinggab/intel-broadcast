# Changelog

Notable changes per release. The commit messages carry the full reasoning —
they are long on purpose.

Versions are `0.x`: minor bumps carry behaviour or interface changes, patches
are assets and fixes. No config migration has ever been required — existing
`config.local.json` files load unchanged across every version below, and the
wire protocol has not changed since `v0.3.0`, so mixed-version squads still
talk to each other.

---

## Unreleased

### Changed
- **Settings is a page, not a window.** This reverses a founding invariant, on
  purpose: the product is an EFB, and the tablet a pilot actually flies with
  carries its own settings — reaching them should not conjure a second window
  to manage. SETUP is now a destination in the launcher like any other.
  `settings.js` runs inside the viewer document (scoped, since both files
  declared `body`) and renders from the same snapshot; there is one window, one
  state push and one intent channel. `settings.html`, its preload and
  `settingsWindow.js` are gone — what survived is `settingsConfig.js`, the
  config writer and the folder dialog.
- **The tab bar is gone; navigation is a grouped launcher.** A bar divides a
  fixed width by the number of destinations and stopped working at six — the
  roadmap needs many more than six. The strip now carries a breadcrumb (where
  you are, and where you are in it) and a key that opens a full-screen grid,
  grouped INTEL / MISSION / REFERENCE / TOOLS / SYSTEM. Adding a page is one
  entry in `DESTINATIONS` plus two i18n keys. Chrome cost drops from 28px of
  strip + 58px of tab bar to 44px of strip.
- The launcher names the product: app icon, `INTEL BROADCAST` and the version
  sit above the groups, so the window says what it is to anyone looking at the
  kneeboard.
- The strip grew from 28px to 44px, because it now holds interactive targets
  and the viewer's 44px floor exists for VR controller pointing in phase 4.

- **Losing the connection no longer takes the screen.** It used to switch to a
  full RELAY LOST page, which replaced a photo the pilot was reading with an
  error card — and going offline does not lose the intel already received: the
  queue is local, browsing and sharing keep working. It is now reported in
  place by a bar under the strip, with RETRY and OPEN SETUP, and it is chrome,
  so it stays out of the capture and hides with the rest.
- **"Relay" is gone from the interface.** It is how the app is built, not
  something a pilot should have to know. The EFB says ONLINE / OFFLINE, in both
  languages; settings asks WHO HOSTS THE SQUAD? instead of WHERE IS THE RELAY?.
- The launcher no longer repeats the product name and version, and the grid has
  breathing room at the top instead.

### Fixed
- **The app could not start on macOS.** `keyHook.js` required `uiohook-napi` at
  module load, and there is no prebuild for every platform, so the require
  threw before any window existed. The dependency is now *optional*, the
  require is guarded, and its absence degrades exactly as designed: pass-through
  reports unavailable and Electron's exclusive `globalShortcut` is used instead.
  `dev-keyhook-test` skips loudly rather than failing where the module is absent,
  and the mac build no longer packs it.

---

## v0.6.0 — 2026-07-31

### Added
- **Pass-through keybinds (`passthroughKeys`, off by default).** Electron's
  `globalShortcut` uses Windows' `RegisterHotKey`, which is exclusive *and*
  consuming — bind plain `B` and the letter b stops working machine-wide. The
  new backend is a low-level hook that observes keys and passes them on, so
  bare letters and arrows are usable bindings and other apps still see the same
  press. Off by default: the hook sees every keystroke, which deserves an
  explicit opt-in on an unsigned build. It never logs, buffers or transmits a
  keystroke, and modifiers match exactly, so a bare `B` never fires on Ctrl+B.
- **The chrome hides itself.** After six idle seconds on BRIEF the status
  strip, tab bar and on-photo controls disappear, leaving the photo alone —
  which is what OpenKneeboard captures onto the pilot's knee. Any activity
  brings it back; losing focus hides it at once. RECEIVED and SHARE keep their
  chrome.

### Changed
- SHARE's SELECT ALL / NONE / FOLDER moved above the gallery: below it, a
  folder larger than a screen pushed them out of reach.
- A completed setup step's mark is `--go` green, on both the host and join
  paths. JOIN's steps gained real done-state, with step 02 ticking only once a
  socket is actually up.

### Removed
- **The HIDE CHROME and OPEN SETUP keybinds.** The first is now automatic; the
  second was redundant (the SETUP tab, tray icon and menu all reach settings)
  and failed whenever another app already owned the combination.
- **RESCAN.** The photos folder has been watched unconditionally since v0.5.

### Fixed
- The pass-through toggle was inert in the testing builds: its intent was
  registered in the viewer's IPC handler instead of the settings one, so the
  click fired, the message arrived, and main answered `unknown intent` while
  the switch appeared to move.
- The toggle's `data-i18n` sat on the element wrapping its hint, and
  `applyStatic` writes `textContent` — so the hint was erased on every render.

### Packaging
- `npmRebuild: false` and `asarUnpack` for the native module. electron-builder
  otherwise tries to *compile* it, which needs a toolchain it does not have and
  cannot produce both mac arches from one builder. The N-API prebuilds are used
  as shipped.

### Development
- Every commit on `main` now publishes `v<version>-dev.<short sha>` as a
  pre-release and deletes the previous one, so exactly one dev build exists at
  a time. It sorts below every real release, so `releases/latest` keeps
  pointing at the real one.

---

## v0.5.3 — 2026-07-31

### Fixed
- **The Tailscale panel had no control you could see.** The three steps
  (TAILSCALE / ACCOUNT / FUNNEL) are recessed status rows, and they carried the
  only click handlers on the panel — no cursor, no focus, nothing that reads as
  interactive, because they were designed to *report* progress. A host could
  see the funnel was off and had no way to discover how to turn it on. There is
  now one visible key beneath them whose label and action follow whichever step
  needs doing: INSTALL TAILSCALE, SIGN IN TO TAILSCALE, ENABLE FUNNEL IN ADMIN,
  SHARE OVER THE INTERNET, STOP SHARING — with a line of hint text under it,
  in both locales. The steps are pure status again and the hidden handlers are
  gone, so there is exactly one path.
- **A failed `tailscale status` reported itself as "SIGN IN REQUIRED".** The
  error path returns no `loggedIn` field, and the renderer's `!f.loggedIn`
  branch could not tell "the command failed" from "you are not signed in", so
  it sent you to a login you had already done. The new control keys off the
  same state and offers CHECK AGAIN instead.

### Verified on the real platform
- Funnel detection is **correct against real Tailscale (1.98.10) on Windows**.
  `parseFunnelStatus` matches the live output shape exactly, and `getState()`
  returns `Running / loggedIn / funnelOn` with the right proxy target. The
  long-standing doubt about the parser — dating to the v0.2.x on/off flapping —
  is closed; that flapping was the second-instance fight the single-instance
  lock already prevents.
- The Windows dev environment is documented in `HANDOFF.md` §6.

---

## v0.5.2 — 2026-07-31

### Fixed
- **Language detection now reads the OS preference list properly.** It used
  `app.getLocale()`, which is Chromium's own UI locale and can disagree with
  the system — the dev Mac reports `en-GB` while the OS list is
  `["en-IT", "it-IT"]`. It now walks `app.getPreferredSystemLanguages()` in
  order (the correct source on Windows, macOS and Linux) and takes the first
  language it ships, matching on the **language subtag only**: `en-IT` is
  English in Italy, and a substring test would have flipped that machine to
  Italian. Falls back to English.
- The rules moved into a pure `i18n.pickLocale()` and are covered by 18 cases
  in `dev-i18n-test`, including the region trap and preference order.

### Added
- One `[i18n]` line at boot recording what the OS asked for and what was
  chosen — "the app is in the wrong language" is otherwise undiagnosable from
  a bug report.
- `INTEL_BROADCAST_SYSTEM_LANGUAGES` to test a translation without changing
  the machine's language.

---

## v0.5.1 — 2026-07-31

### Added
- A real app icon: the kneeboard page wearing the targeting brackets the app
  has drawn on every frame since `v0.1`. Present in the macOS dock, the Windows
  taskbar and installer, the menu-bar tray, both window title bars, and as the
  favicon.
- `branding/*.svg` masters and `scripts/dev-make-icons.js`, which renders them
  through Electron and packs `.icns` (via `iconutil`) and `.ico` (via a small
  built-in encoder — an `.ico` is a header plus PNG payloads, so no image
  dependency is needed).

### Fixed
- The tray was a **1×1 transparent placeholder PNG** with a TODO, so it had
  been rendering an invisible menu-bar item. It is now a proper macOS template
  image, black + alpha, which the OS recolours for light and dark menu bars.

### Notes
- Small sizes come from a **separate master**: downscaling the full artwork to
  16px turns the page into a featureless white rectangle. `.icns` and `.ico`
  are containers of independent bitmaps, so each size gets artwork that reads
  at it; the crossover is 64px.

---

## v0.5.0 — 2026-07-31

### Added
- **English and Italian throughout.** `i18n.js` is a UMD dictionary loaded by
  both renderers and the main process (tray, app menu). The locale rides the
  state snapshot, so switching retranslates on the next push — no reload, and
  the renderer still owns nothing. Follows the OS language by default;
  switchable at the foot of the settings rail, applied immediately.
- `dev-i18n-test`, which pins key parity both ways, non-empty values, identical
  placeholder sets, and that every `data-i18n` key in the markup exists.
- The folder watcher now actually exists: `fs.watch` on the photos folder with
  a debounced rescan.

### Changed
- **Settings rebuilt around a vertical navigation rail** — NETWORK, KEYBINDS,
  LOG. The old horizontal tab row divided the window width by the section count
  and would have clipped at five; a rail row is always full width and a new
  section is one more 44px row.
- The two-cell topbar is gone: SECTION echoed the active nav item and CALLSIGN
  echoed a field below it.
- **NETWORK leads with the question it asks** — WHERE IS THE RELAY? — as two
  radio cards that state their consequence, with a status line above that
  always says what you *are*. JOIN is now numbered steps (`01 PASTE` →
  `02 CONNECT`), the same idiom as the Tailscale checklist.
- The callsign moved to NETWORK; the photos-folder picker moved to the viewer's
  SHARE page, next to the gallery it feeds.
- Keybind rows restacked (label above, field + RECORD below) so nothing clips
  at the narrower content width.
- The geometry test now runs **both locales** at all three UI scales — Italian
  is the longer language, so if it fits, English does.

### Removed
- **Watch-folder toggle.** It only ever wrote config; nothing consumed it, so
  it silently did nothing. The behaviour is now real and always on.
- **Send-quality control.** `sendProfile` stays in config for power users.
- **SHOW NEW INTEL ON ARRIVAL** moved out of settings to the top of the
  viewer's RECEIVED page, above the batches it governs.
- The PILOT settings page, now empty.

---

## v0.4.0 — 2026-07-31

### Changed
- **BRIEF is the kneeboard.** A 28px connection strip (callsign · net · relay)
  replaces the 46px cell bar, and the photo owns the rest of the window. The
  separate `frame` page is gone.
- **All received photos form one flat queue**, newest batch first; an arrival
  prepends and, when the auto-switch rule fires, lands at 1/N. Paging wraps
  across the whole queue rather than within one batch.
- The stage tracks **photo identity, not an index**, so curating elsewhere
  renumbers the position but never moves what is on the pilot's knee. Dropping
  the current photo advances in place.
- **RECEIVED became curation**: every photo of every batch as a tile, ticked =
  in the brief, plus HIDE/RESTORE per batch. Same tile idiom as SHARE, so
  selection means the same thing in both directions.
- The banner now announces **every** arrival — `SWITCHED AUTOMATICALLY` or
  `QUEUED` — and dismisses itself after 10s.
- Settings' SAVE & APPLY moved out of the PILOT page into a bar pinned to every
  sub-page, wearing a new `--go` green exactly while there is something to
  commit.
- PILOTS ON NET moved from the viewer's BRIEF to settings → NET.
- Shipped HTML now boots **empty** — no demo batches, fake callsigns or
  placeholder tiles. Demo state lives in `preview-state.js` and drives the real
  render functions, so the preview harness exercises renderer code instead of
  parallel markup.

### Removed
- The unread badge and all unread state. The banner announces arrivals;
  RECEIVED holds the history.
- The REVEAL / BROWSE / HIDE keys from BRIEF, and with them every printed
  hotkey — they went stale the moment a binding was recorded. SETUP → KEYBINDS
  is the single source.

### Fixed
- **The tab bar floated off the bottom edge**, with 56px of dead space beneath
  it. `.shell` declared four grid rows but the arrival banner is `display:none`
  in the normal case, so auto-placement shifted every later child up a row. The
  layout was only ever correct while the banner happened to be showing. Now a
  flex column, which ignores hidden children.
- The banner's dismiss timer restarted on every state push; with the settings
  window open (pushes every 3s) it never fired. Now keyed on a per-arrival
  stamp.

---

## v0.3.0 — 2026-07-30

Phase 1 of the UI roadmap: the cockpit-EFB interface, all view state moved to
the main process, `intel://` content-addressed blobs replacing base64 data
URLs, squad codes, sender-side image compression, and the network hardening
list (`maxPayload`, a `bufferedAmount` ceiling, `timingSafeEqual`, a minimum
token length).

See `BRIEF.md` for the specification this implemented and `app/PLAN.md` for the
architecture that preceded it.

---

## Earlier

`v0.2.2` and below predate the current UI. `v0.2.0` in particular is **broken**
— settings never persisted in packaged builds, because `config.local.json` was
written relative to `__dirname`, which lives inside the read-only `app.asar`.
The post-mortem is in `app/PLAN.md` and is worth reading before touching
anything that writes to disk at runtime.
