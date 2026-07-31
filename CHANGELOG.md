# Changelog

Notable changes per release. The commit messages carry the full reasoning —
they are long on purpose.

Versions are `0.x`: minor bumps carry behaviour or interface changes, patches
are assets and fixes. No config migration has ever been required — existing
`config.local.json` files load unchanged across every version below, and the
wire protocol has not changed since `v0.3.0`, so mixed-version squads still
talk to each other.

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
