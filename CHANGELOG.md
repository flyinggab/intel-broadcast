# Changelog

Notable changes per release. The commit messages carry the full reasoning —
they are long on purpose.

Versions are `0.x`: minor bumps carry behaviour or interface changes, patches
are assets and fixes. The wire protocol has not changed since `v0.3.0`, so
mixed-version squads still talk to each other.

No `config.local.json` has ever needed rewriting, and none does now — but the
rename to Tac Link moved the directory Electron keeps it in, so from `v0.8.0`
the app adopts the file left behind under the old name on first launch. See
that entry.

---

## v0.9.2 — 2026-08-10

### Changed
- **The changelog gets the rest of the UPDATE page.** It was boxed into 12rem
  while two thirds of the page sat empty, and the release notes are the thing
  a pilot actually reads before deciding to restart. The pane now takes
  whatever is left below the button and scrolls internally, so the button
  stays put however long the release body runs. Measured against a real 186-line
  release body: the pane is 752px, it scrolls, the page does not.
- **The UPDATE panel lost its status rows.** "INSTALLED" was reporting that
  the installed version is installed, and "LATEST" said what the button
  already says — the button carries the version it is offering. What remains
  is the current version, one button, one hint and the notes. The download
  percentage moved onto the button, since it is both the thing moving and the
  thing you press.

---

## v0.9.1 — 2026-08-10

### Changed
- **Nothing, deliberately.** Cut so the in-app updater can be exercised
  against a real GitHub release: v0.9.0 is the first build that carries an
  updater at all, so there was no earlier version that could offer it
  anything. Install v0.9.0, open SETUP → UPDATE, and this is what it should
  find — download, changelog, and RESTART TO INSTALL.
- The release body is this section, which is also what the panel shows: the
  notes a pilot reads before deciding to restart are the hand-written ones,
  not a list of commit subjects.

---

## v0.9.0 — 2026-08-07

### Added
- **Card templates are a library you can add to.** TEMPLATES is a second view
  of CARD, picked from the bottom bar exactly as RECEIVED and SHARE are views
  of INTEL — choosing a template is something you do while looking at the card,
  not something you go and configure. Two ship (`strike-package`, `cas-9line`);
  importing one validates it, asks for a name prefilled from the file, and
  copies it into the app's own data folder. Copied, not referenced: a template
  linked from Downloads is a kneeboard that stops working the week the pilot
  tidies up. Yours can be removed; shipped ones carry no remove key at all
  rather than one that refuses.
- **A template can be looked at before you have data for it** — chosen from the
  library it renders empty, with its real blocks and a line saying there is no
  data, because a sheet of dashes with nothing to explain it reads as real
  answers. The preview is built by synthesising a card that satisfies the
  layout and says nothing, then running it through the SAME resolver a real
  card uses, so a preview cannot drift from the thing it previews. CAST is
  absent there: it would send the previous card.
- **A mark on the rail when something landed while you were elsewhere** — one
  dot per destination, on INTEL and on CARD, cleared by going there. An unread
  badge was carried once and deliberately removed, on the reasoning that "the
  banner announces arrivals; RECEIVED holds the history". That held for the app
  it was written for and does not hold for this one: a card raises NO banner,
  by design, so a lead could cast a card onto a pilot's kneeboard with nothing
  anywhere on screen saying it had happened. A dot rather than a count — the
  rail collapses to 44px icons on a knee, where a number is a thing to squint
  at, and "is there anything over there" is the whole question. The tile also
  says it in words, because a coloured dot is not information to a pilot using
  a screen reader. Arriving is what clears it: there is no second gesture and
  nothing to remember. A mark survives a navigation the app REFUSED — a held
  follower pressing CARD must not wipe the one thing telling them a card came.
- **`dev-e2e-card-test`** ticks and unticks a route step in a real window. The
  bug it exists for needed the card DATA, MAIN and the RENDERER to disagree,
  so neither the resolver test nor the geometry test could see it — only the
  round trip does.
- **`dev-card-geometry-test`** renders the real card in Electron with the real
  B612 and fails on any value wider than the box it lands in, naming it:
  `"N29 09'58.8 E53 07'38.6" needs 254px, has 214px`. This is the string-width
  check `design/kneeboard/HANDOFF.md` §5 asked for, and the answer to its §7
  admission that nobody had looked at the card rendered. A deliberately
  over-long fixture is kept and asserted to still overflow, so the check cannot
  quietly stop proving anything.
- **The window draws its own controls** — minimise, maximise, close, in the
  strip beside the launcher key. The OS frame is gone, because OpenKneeboard's
  Window Capture takes the whole window and a Windows title bar was riding on
  the pilot's knee for the entire flight. They appear on the Electron surface
  only; as an OpenKneeboard web dashboard there is no window to control. The
  window is dragged by the strip's status text, and note which way round that
  is set up: the drag region is opted INTO by the non-interactive segments
  rather than declared on the strip with exceptions for each control, because
  anything inside a drag region silently stops receiving clicks. A test asserts
  no control ever ends up in one.

### Changed
- **Marking a route step flown now reaches every pilot holding that card**, so
  a flight shares one checklist rather than each keeping a private one. Ticks
  also ride WITH a card when it is cast — casting mid-mission is the normal
  case, and a card that arrives claiming nothing has been flown is worse than
  no card at all. Any pilot may tick: a route card is a shared checklist, not
  a performance, so unlike ink there is no presenter lock on it and last write
  wins. Each tick names its card by content hash, so a pilot holding a
  different card — or none — ignores it rather than marking whatever sits at
  that row of theirs.
- **The highlighted step is now the first one not yet flown**, derived from
  the ticks instead of read off the card. A card can declare `state:
  "current"`, but a fixed marker is only true until the first leg is flown,
  after which the highlight sits on something already behind the flight. Being
  derived also settles the harder half for free: the ticks travel, so anything
  computed from them travels too, and two pilots cannot end up looking at
  different current steps while holding the same ticks. Nothing named
  "current" goes on the wire at all.
- **A follower's view now belongs to the presenter.** While someone else is
  casting, this instance is held: paging, changing page and opening the
  launcher are all refused, and the presenter's FOCUS is the only thing that
  moves it. This replaces the previous model, where paging away quietly left
  the brief and FOLLOW rejoined — a brief nobody could be sure anyone was
  watching. The lock releases when the presenter stops, when the presenter
  vanishes (the relay fans out a stop on their behalf), or if our own link to
  the relay drops. There is no manual escape by design, so a stale lock is the
  failure that mattered most: a follower cannot page away by hand, and a
  presenter we can no longer hear from must never hold a pilot's controls —
  including the route to SETUP. Re-locking after a blip is automatic, because
  the relay re-announces a live brief to every client that authenticates.
- **FOLLOW is gone** with the model it belonged to: the `Ctrl+Shift+F`
  binding, the `brief-follow` intent, the OpenKneeboard custom action and the
  BREAK/REJOIN key on the brief bar. The bar now names who holds your
  controls instead — chrome that silently stops responding reads as a frozen
  app. PRESENT (`Ctrl+Shift+P`) is unchanged, and a presenter is never locked.

### Fixed
- **A card block could sit outside its own border.** The comms row was a grid
  of three fixed tracks, and the ratios were measured against the shipped
  strike card's three comms blocks. Any template with a different number got
  the wrong tracks: the ferry sample's second block landed in the narrow middle
  one and every row in it hung 215px past the box — and the shipped `cas-9line`
  did the same. Nothing was clipped, so the geometry check saw nothing wrong;
  the text was simply outside the box it belonged to. The row now takes as many
  columns as the template has, each floored at its own content width.
  `dev-card-geometry-test` gained the check that catches this, verified by
  reverting the fix and watching it go red on both cards.
- **SAVE was buried when naming an imported template.** The panel shares the
  library's tile grid and was being dealt one 165px column out of 518, so the
  name field, CANCEL and SAVE were crushed into a third of the page. Nothing
  was hidden or clipped — SAVE was simply somewhere nobody would look. It now
  replaces the tiles rather than being one, and the e2e measures it against a
  tile track so it cannot silently become one again.
- **Casting a mission card did nothing at all.** The receive handler had been
  written into the wrong switch — `handleBriefIntent`, which takes an intent
  name and a payload and never sees a message — so it was unreachable code
  referencing a `msg` that did not exist there. Incoming cards fell through
  `applyBriefMessage`'s `default: return` and were dropped in silence. The
  press was fine, the frame crossed the relay, the far side simply threw it
  away. `dev-brief-relay-test` had covered the wire and `dev-card-test` the
  resolver, and the app's own handler sat untested between them; the new
  `dev-e2e-card-share-test` presses the key a pilot presses in one instance
  and reads the card off a second instance's screen, so it asserts the
  feature rather than a component of it.
- **Every brief message was applied twice, by everyone.** The relay echoed a
  realtime frame back to the client that sent it, and each client had already
  applied its own the instant the pilot made it — local echo is mandatory, a
  presenter watching their line lag 30-80ms behind the pen would stop trusting
  the tool. Unlike a reveal, where the echo IS the sharer's render path, this
  was pure duplication. It was worst on a host, which also runs a client
  against its own relay and additionally sent by both paths at once: four
  applications of every frame, and the card a lead had just cast came straight
  back at them, resetting every step they had already ticked off. Shapes
  upsert and hid it; strokes append and cards replace, so those did not.
- **Casting a card gave the sender no sign it had gone.** The card on their
  screen is the card they sent, so a working key was indistinguishable from a
  dead one — which is how this was first reported. The brief bar now says
  `CARD SENT · TO 3 ON THE NET` for three seconds. The count is the point: `0`
  means nobody is on the net, which is the answer a pilot most needs when they
  thought they had just shared.
- **The mission card was silently truncating 16 values, including the
  bullseye.** Card cells carry `text-overflow: ellipsis`, so a value too long
  for its column renders as a shorter one that still looks like a value:
  `N29 09'58.8 E53 07'38.6` became `N29 09'58.8 E53 07…`. Nothing errored and
  nothing looked broken — the pilot simply read a bullseye missing its
  eastings, which is the reference every bearing and range call is made from.
  The S-A threat list lost MANPAD the same way, and five route legs lost their
  tails. All 16 now render in full.
- **A comms cell could shrink below its own text even with room to spare.**
  Uniform `flex-shrink` against `min-width: 0` squeezed cells past their
  content: a TANKER row carries 205px of text in a 429px column and was still
  clipping four values. Column fractions were the wrong lever — the widths they
  were derived from were circular, since `scrollWidth` on a cell that fits
  reports what it was given, not what its text wants. `min-width: min-content`
  on a comms cell fixed every remaining clip at once, and turns any genuine
  overflow into something visible rather than an ellipsis that reads as a
  value.
- Comms agency names are one word — MOTHER, not MOTHER (CVN-71); SHELL, not
  SHELL KC-135. On a kneeboard the agency is the callsign and the parenthetical
  is explanatory text charging the column for it.
- **Route steps the card marked flown could not be unticked.** The first three
  legs of a card simply did not respond, with no error — the click was received
  and handled. A card can say a leg is flown two ways, a `complete` flag or a
  state of `"done"`, and the renderer accepted either while the pilot's tick
  wrote only `done`: the tick set `done: false`, `state` still said `"done"`,
  and the OR kept the row flown for ever. Whether a step is flown now lives in
  exactly one field, folded in when the card is resolved; `state` keeps only
  what it alone can say, which step is CURRENT.
- **A table's columns now line up down the page.** Rows were independent flex
  lines that each sized themselves, so a row missing a value slid everything
  after it left: a tanker with no altitude put its heading where the row above
  put its altitude, and a comms entry with no TACAN put its frequency somewhere
  new. Tables lay out as tables now, every row sharing one set of
  content-sized columns. `dev-card-geometry-test` fails if any two rows put the
  same column at different x.
- **A host could not tell that sharing over the internet was a button.** It
  was a flat panel the same tone as the status rows above it, on a page where
  the recessed "primary" key treatment looked like the read-only PORT and
  TOKEN wells. So the setup read as finished while the squad code never left
  the LAN. The internet-link key now uses the app's one call-to-action
  treatment — raised, filled `--go` — while a step is still owed, and drops
  back to an ordinary key once sharing is on, so the colour keeps meaning
  "your move" rather than becoming decoration.
- **A presenter's page turns reached nobody.** PRESENT sent exactly one FOCUS
  — for whichever image the presenter happened to be on when they started —
  and every photo they moved to afterwards went unannounced. Followers sat on
  the opening image watching ink appear on a picture they could not see. FOCUS
  is now driven off the presenter's resulting image hash after anything that
  can move it (chevrons, hotkeys, intel arriving, curation restaging), not off
  the navigation intents. `dev-e2e-brief-test` holds a real socket on the
  relay and fails if a page turn produces no second FOCUS.

## v0.8.3 — 2026-08-02

### Fixed
- **The launcher key in the strip was a 36×44 target.** The floor for anything
  pressed on a flight surface is 44px, and it was under it in width — a corner
  key you had to aim at rather than hit. Both it and the OFFLINE key beside it
  are now square at the floor.
- **`dev-ui-geometry-test` only ever measured HEIGHT.** That is why a 36px-wide
  key passed the 44px check for its whole life. It now requires both axes,
  since a target is only reachable if it clears the floor in both — and it
  reports the width alongside the height so the failure names itself.
- `dev-e2e-brief-test`'s hit test retries until the window has actually laid
  out. It passed alone and failed under suite load, answering about a
  zero-sized rect; a flaky assertion trains you to re-run instead of to look.

## v0.8.2 — 2026-08-02

### Fixed
- **Pressing PRESENT blanked every other pilot's kneeboard.** The presenter
  drew happily; everyone following went straight to STANDBY. FOCUS was resolved
  by the `batchId` and `filename` the message carries, and `nextBatchId` is a
  *per-instance* counter starting at 1 — so the presenter's "batch 3" names a
  different batch on every other machine, `current` pointed at a photo that
  does not exist there, and the stage emptied. (It was also sent as a string
  against numeric local ids, so it could not have matched even on one machine.)
  FOCUS now resolves by **content hash**, the only identifier that means the
  same thing on two machines — which is exactly why ink was already keyed by
  it — and lands on the follower's own local coordinates.
- A follower who does not have the presenter's photo — joined late, or curated
  it out — keeps their current page instead of being blanked, and the brief bar
  now says `THEY ARE ON A PHOTO YOU DO NOT HAVE`. Silently showing one pilot a
  different image from the rest of the flight is the worst outcome in a brief,
  so it is stated rather than guessed at.

## v0.8.1 — 2026-08-02

### Fixed
- **Drawing did not draw.** Pressing a tool did nothing and dragging on the
  photo dragged the *photo* — ghost thumbnail, no-entry cursor, no ink. Two
  causes, both invisible:
  - The ink canvas carried `z-index: 1` while `.stage__chrome` carried none,
    so once presenting made the canvas live it sat **on top of the tool strip
    and the page chevrons**. Every press meant for a tool hit the canvas.
  - `object-fit: contain` means the `<img>` *element* fills the whole stage
    while the *painted* photo is letterboxed inside it. On a wide recon shot
    in a portrait window that leaves broad bands top and bottom which are bare
    `<img>` — and an `<img>` is draggable by default, so a press there started
    a native HTML5 image drag. The photo is now passive to pointer events and
    not draggable, and the stacking order is explicit: ink above the photo,
    below everything a pilot presses.
- The ink canvas is now re-measured on every brief render rather than only
  when the image changes, so geometry that moves for any other reason cannot
  leave it at its unsized default.
- `dev-e2e-brief-test` now hit-tests with `elementFromPoint` instead of
  trusting `element.click()`. That is why all of this reached a release:
  `.click()` dispatches straight at a node and cannot tell that something is
  covering it, so the suite was green while the feature was unusable. Both
  bugs were re-introduced deliberately to confirm the new assertions fail.

## v0.8.0 — 2026-08-02

### Fixed (release pipeline)
- **`v0.8.0` first published with macOS artifacts only.** Both matrix jobs
  called electron-builder with `--publish always`, so both tried to *create*
  the GitHub release; macOS won and Windows died with
  `422 ... tag_name already_exists` — after building perfectly well. It had
  been passing on luck, with the two builds finishing far enough apart that
  one saw the other's release already there. The release is now created once
  in its own job that the builds depend on, and each build lists the assets
  actually on the release afterwards, because a green build that published
  nothing is precisely the failure this needs to catch.
  (`dev-release.yml` never had the bug — it builds with `--publish never` and
  assembles the release in a single later job.)

### Added
- **A LICENSE, at last: GPL-3.0-or-later.** The repo was public but legally
  all-rights-reserved, so nobody could fork or redistribute it. It also
  disqualified the project from free code-signing, which now matters more than
  it did.

### Changed
- **The Windows build is an installer, not a portable exe.** `portable` builds
  a self-extracting executable that unpacks the whole app into `%TEMP%` and
  runs it from there — which is, structurally, exactly what a dropper does.
  Combined with being unsigned and shipping a low-level keyboard hook, that was
  enough for Defender to start quarantining the build as
  `Trojan:Win32/Wacatac.B!ml` (an ML heuristic, not a signature — nothing
  matched known malware). The NSIS installer is per-user, so it asks for no
  administrator rights, and it adds a Start Menu entry and a desktop shortcut.
  The licence text now ships alongside the binary.
  README tells pilots what the detection means, what in the app causes it, and
  how to report it; `HANDOFF.md` §7 has the remediation order.
- **Brief mode.** A host presses PRESENT and every following EFB snaps to the
  same image and stays synced as they page; pen, arrow and ring render live on
  every client; ink belongs to the image and survives paging away and back.
  Coordinates are normalised against the *image*, never the screen, so the
  same mark lands on the same pixel at any surface size with no client ever
  agreeing a resolution. Every control has a global keybind, because many
  pilots see the EFB only through OpenKneeboard and cannot click anything —
  which is also why paging away is how you leave a brief, and why there is no
  consent dialog to accept.
- **OpenKneeboard web-dashboard tab, partly built and unverified.** Registry
  probe, plugin manifest and registration, a loopback server for the page, and
  the renderer bridge that sets `data-surface="okb"` and wires their page and
  cursor APIs. **Off by default — window capture is unchanged and remains the
  shipped path.** The intel stage maps to exactly ONE OpenKneeboard page with
  images swapping inside our DOM, so `RequestPageChanged` is never called for
  sync and the restriction their docs warn about cannot break a brief on
  someone else's update. Nothing here has run against a real OpenKneeboard;
  the SETUP panel and reaching photos from WebView2 are both still missing.
  See `design/okb-integration/HANDOFF.md`.
- **Brief mode, foundations.** The transport and the ink model, both tested;
  no UI yet. `inkStore.js` holds strokes normalised against the *image* — not
  the screen — quantised to uint16 and keyed by the image's content hash, so
  the same mark lands on the same pixel at any surface size without anyone
  agreeing a resolution, and a re-shared file can never inherit a stranger's
  annotations. The relay grew a second WebSocket on the **same port**, routed
  by path on upgrade (`/` bulk, `/rt` realtime): Tailscale Funnel forwards one
  port so a second listener was never an option, and the split makes
  head-of-line blocking impossible — a 3 MB photo can no longer delay a
  26-byte stroke. HELLO now advertises a `brief` capability, so a peer on an
  older build still receives photos and simply never sees a stroke.

- **The app is now Tac Link.** Renamed throughout: product name, bundle id
  (`com.flyinggab.taclink`), window title, menus, tray and docs. The GitHub
  repository keeps its `intel-broadcast` name for now, so clone URLs and
  release links are unchanged.

### Fixed
- **The rename would have stranded every existing install on defaults.**
  Electron derives its userData directory from the product name, so
  `Intel Broadcast/config.local.json` was simply not where `Tac Link` looks.
  Nothing would have warned the pilot — the app would have come up looking
  freshly installed, on the **default token**, which means their squad code
  silently changes and nobody can reach them; hosting switched back off;
  callsign, keybinds and photos folder gone. The config left behind under the
  old name is now adopted once, on first launch, and copied rather than moved
  so a downgrade still works. An existing config always wins over it.

## v0.7.0 — 2026-08-01

### Fixed
- **`dev-e2e-funnel-flow-test` had stopped testing anything.** Merging settings
  into the viewer replaced `SETTINGS_PROBE` with the viewer's `PANEL_PROBE`,
  and this test still waited for the old name — so it timed out reporting that
  the funnel UI never showed a blocked state, when in fact no probe was being
  emitted to it at all. The whole Tailscale Funnel flow (blocked → admin
  approves → automatic retry → quit tears the funnel down) went unverified for
  four commits. The test now reads `PANEL_PROBE`, and `funnelAction` — dropped
  in the same merge — is back in the payload.
- **SHARE rendered on top of every other page.** Its layout rule set `display`
  from a class on the page element itself, which ties with `.page { display:
  none }` on specificity and sits in a later stylesheet — so it always won.
  Visible on any page long enough to scroll, which is how it showed up
  underneath SETUP. `dev-ui-geometry-test` now asserts exactly one page is
  visible, on every page at every scale.
- **The squad code could not be pasted.** Neither Ctrl/Cmd+V nor right-click
  worked, in the one field the app explicitly tells you to paste into.
  Electron binds the standard editing shortcuts through menu items carrying
  the `cut`/`copy`/`paste` roles, and this app replaced the default menu
  without them; it also ships no context menu at all. Both are now provided,
  in both languages.

### Changed
- **Host or join is an accordion now, not two cards.** Which one was selected
  had been unreadable through three attempts to fix it, because the problem was
  structural: the palette keeps every surface within a narrow band so both dark
  and light text stay legible on it, and `--up` against `--dn` is about a 15%
  step. Saying "selected" by being slightly darker asks that band to carry the
  whole message. So the comparison is gone — only the chosen path opens, and
  that path's content lives inside its own card. One is open with your squad
  code in it; the other is a closed line. The strongest signal available, the
  content you asked for appearing, is now attached to the control that causes
  it instead of sitting in a detached block below both.
- **JOIN has no CONNECT key.** A squad code that parses is an instruction, not
  a proposal — pasting one connects. Guarded so that typing does not reconnect
  on every keystroke.
- SHARE: SELECT ALL and NONE became one key whose label follows the state
  (anything selected → DESELECT ALL), sized to its label and pushed right
  rather than stretched full width, since REVEAL is the page's primary action.
  The folder and staged-selection readout moved to a strip along the bottom,
  mirroring the connection strip at the top.
- The OFFLINE bar is gone. Going offline costs one key in the strip beside the
  word itself — the SETUP glyph, in the fault colour — because it never needed
  a row of its own: the intel already received is still there. One glyph, one
  destination.
- SETUP → NETWORK no longer repeats the connection state: the strip at the top
  of the window already says it.
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
- The OFFLINE bar hides itself on SETUP → NETWORK: that page states the
  connection in its own status line, and the bar's OPEN SETUP key would point
  at the page you are already reading. From anywhere else the key now lands on
  NETWORK specifically, rather than wherever the rail was last left.
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
