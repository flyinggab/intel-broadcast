# Changelog

Notable changes per release. The commit messages carry the full reasoning —
they are long on purpose.

Versions are `0.x`: minor bumps carry behaviour or interface changes, patches
are assets and fixes. No config migration has ever been required — existing
`config.local.json` files load unchanged across every version below, and the
wire protocol has not changed since `v0.3.0`, so mixed-version squads still
talk to each other.

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
