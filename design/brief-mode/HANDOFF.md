# Brief mode — presenter, live ink, follow

**Status** — **built, and tested on two machines by the owner (2026-08-06).**
Phase 2 (`/ROADMAP.md` §2), Tier A. Transport and ink model
(`inkStore.js`, the brief family in `protocol.js`, the `/rt` socket in
`relayServer.js`), the renderer, and the main-process wiring are all in.
Covered by `dev-ink-test`, `dev-brief-relay-test`, `dev-viewstate-test` and
`dev-e2e-brief-test`.
**Files here** — `brief-mode.png` (five screens + interaction outline).
**Depends on** — nothing from protocol v2; ships against the current wire with
one additive message family. The realtime socket it introduces *becomes*
channel 2 when v2 lands.
**Read alongside** — `design/okb-integration/HANDOFF.md` §4. If the EFB is ever
rendered as an OpenKneeboard web dashboard, the intel stage must be **one** OKB
page with images swapping inside our DOM, never one page per image. Assume that
split from the start; it costs nothing now and is expensive to unpick later.

The host looks at an image and presses PRESENT. Every EFB snaps to that image
and stays synced as the host pages; strokes and the presenter's cursor render
live on every client; each image keeps its ink for the session. Following is
not optional and not a flag: while someone presents, their brief **is** every
other pilot's view, and it ends when they end it.

---

## 1. Decided — do not re-litigate

**A follower's view belongs to the presenter.** *(Revised 2026-08-06, by the
owner, after testing casting on two machines. This replaces the original
"paging away leaves the brief, FOLLOW rejoins".)*

While someone else is presenting, this instance is locked: no paging, no
changing page, no launcher. The presenter's FOCUS moves it, and nothing else
does. `viewState.isFollower()` is the single test; the snapshot exposes it as
`brief.locked`.

The half of the original reasoning that survives is the important half: many
pilots view the EFB through OpenKneeboard and *cannot click anything*, so
there is still no invitation dialog and no consent prompt — a wall they cannot
accept. What did not survive is treating paging as the way out. A brief where
each pilot can quietly wander off is not a brief: the presenter says "look at
this" and has no way to know who still is, which is precisely what the owner
hit in testing.

Consequences, all of them intended:
- **FOLLOW is gone** — the `Ctrl+Shift+F` binding, the `brief-follow` intent,
  the OKB custom action, and the BREAK/REJOIN key on the brief bar. A control
  that can only ever refuse is worse than no control.
- **PRESENT (`Ctrl+Shift+P`) still starts/stops**, and the presenter is never
  locked out of anything.
- The bar tells a follower who holds their controls. Chrome that silently
  stops responding reads as a frozen app.

**The lock releases automatically, and only automatically.** There is no
manual escape, so these two are the entire safety story:
1. the presenter stops — `brief-present-stop`, fanned out to everyone;
2. the presenter vanishes — `relayServer.js` notices the socket close and
   fans out the same stop on their behalf; and if it is *our* link that
   dropped, `index.js` clears the presenter locally on `disconnected`.

The second matters more than it looks: a follower cannot page away by hand, so
a presenter we can no longer hear from would otherwise hold this pilot's
controls indefinitely — including the route to SETUP, i.e. the route to fixing
the connection. Re-locking after a blip is automatic, because the relay
re-announces a live brief (and its current FOCUS) to every client that
authenticates. **Never make a release conditional on a message that might have
been missed.**

**No ground/air split.** The EFB has no signal for it until phase 3 telemetry.
One behaviour, always. Mitigation for a brief starting mid-flight: PRESENT is
deliberate, the arrival is named (banner + the clean-view label), so a page
never changes anonymously.

**Ink is stored normalised against the image, never the screen.**
`{u, v}` in 0–1, uint16 each. Proven: the same coordinate resolves to the same
image pixel across five surface sizes (625×884, 781×1105, 900×700, 420×900…),
because surface size never enters the stored value. **Do not fix or assume any
client resolution — it is unnecessary and unenforceable.** Requirements that
make this hold:
- `object-fit: contain` — already shipped (`components.css`, `.stage__img`).
  Never change to `cover`.
- No zoom/pan exists in the app. Do not add it as part of this feature.
- Ink renders as image content, **not** stage chrome, so it survives
  capture-clean for free.

**Ink is keyed by content hash and lives per image.**
Store: `Map<imageHash, strokes[]>` — main-process authoritative, one per
instance. The FOCUS message carries the hash once per page turn (32 bytes);
strokes carry nothing. Clients keep what they watched being drawn, so
revisiting an annotated image costs zero bytes. Never key ink by filename — a
re-shared file with the same name must show *no* foreign ink rather than the
wrong ink.

**Host-only presenting, v1.** Deletes the arbitration protocol. Every message
still carries `{presenter}` from day one so handing the pen to a callsign later
is one new message (`GRANT_PRESENTER`), not a redesign. The relay stamps
presenter identity server-side, exactly as it stamps `sharedBy`.

**Two message kinds for ink, no third.**
- PEN is an append stream: `STROKE {strokeId, points[]}`, ~4 points per frame
  at 30 Hz, 26 bytes.
- ARROW and RING are parametric upserts: `SHAPE {strokeId, tool, a, b, final}`
  repeated at 30 Hz with the current geometry, `final: true` on release.
  Idempotent — a lost frame heals on the next. The rubber-band the clients
  watch *is* the message stream. RING stores centre + radius as a fraction of
  image width.
- **TEXT was cut.** Typing has no place in VR; a ring plus the radio says the
  same thing. Do not add it back for the desktop case — it splits the tool set
  into "works for everyone" and "works for some".

**Gestures** (mockup screen 4): PEN — hold, draw, release commits. ARROW —
press anchors the *tail*, drag rubber-bands the head, release commits. RING —
press anchors the *centre*, drag sets the radius, release commits.

**UNDO / CLEAR scope:** undo = presenter's last committed mark on the focused
image; CLEAR = focused image only. Both broadcast. A slip cannot erase the
brief.

**Icons, not labels.** Tool strip is icon keys at the 44 px floor: cast · pen,
arrow, ring · undo, clear. PRESENT is the cast icon in the stage foot. The
inset cast icon + "PRESENTING" in the strip is the whole live indicator —
**never use `--fault` for "live"**; red stays reserved for a broken relay.

**Paging never leaves — and every page turn is announced.** For the presenter
the chevrons and next/prev hotkeys stay live and simply broadcast: a page turn
= one FOCUS message. For everyone else they do nothing (see the follower lock
above).

This is driven off the presenter's *resulting* image hash, not off the
navigation intents — `syncFocus()` in `index.js`, called after anything that
can move `current`. The queue moves for reasons other than the chevrons
(intel arriving, curation restaging a hidden batch) and every one of them
means "the presenter is now looking at this". The first implementation sent a
FOCUS only from PRESENT itself, so followers were pinned to whichever image
the brief opened on while the presenter annotated photos they never saw.
`dev-e2e-brief-test` holds a real socket on the relay and fails if a page turn
produces no second FOCUS.

**Ephemeral by default; BURN IN is the escape.** Ink dies when its batch is
replaced. BURN IN composites the annotated frame into a new content-addressed
blob so it becomes ordinary shareable intel. (Ship BURN IN later if scope
needs cutting; the store design already permits it.)

**Cursor without ink.** The presenter's cursor streams as a labelled dot even
with no tool down (~12 bytes @ 20 Hz). Most of a brief is pointing.

---

## 2. Measured

- Stroke frame 26 B @ 30 Hz → **0.8 KB/s** per presenter; fan-out 38 KB/s at
  50 clients (one 400 KB photo to 50 = 20,000 KB — ink is noise).
- Cursor stream 0.23 KB/s.
- Rejoin snapshot capped at 500 strokes/page ≈ 157 KB — smaller than the photo.
- uint16 quantisation on a 2000 px image = 0.03 px.
- Funnel rides DERP: expect 30–80 ms RTT. **Local echo is mandatory** — the
  presenter renders their own stroke immediately, never waits for the relay.

## 3. Repo integration — read before writing code

Facts verified against `v0.7.0`; re-verify with `git log` first.

- **`relayServer.js` binds `new WebSocketServer({ port, maxPayload })` directly
  on the port.** Funnel forwards exactly one port, so the realtime socket
  CANNOT be a second port. Refactor to an `http.createServer()` +
  two `WebSocketServer({ noServer: true })` with path routing on `upgrade`
  (`/` = existing bulk, `/rt` = realtime). This is the one structural change
  the feature forces, and it is also what makes head-of-line blocking
  impossible: a 3 MB photo on the bulk socket can never delay a stroke.
- **Realtime frames skip the reassembler.** `protocol.js` owns framing — add
  the brief messages there and nowhere else (root `HANDOFF.md` §3 invariant).
  No `perMessageDeflate` on the realtime socket either.
- **The image hash already exists.** `blobStore.js` keys by sha256 and the
  queue item's `url` is the intel:// path to it — derive `hash` from the URL
  rather than re-hashing. `viewState.js` `state.current` is
  `{batchId, filename}`; FOCUS extends this with the hash.
- **State ownership under 30 Hz.** The renderer owns no state (root invariant),
  but pushing a full snapshot per stroke frame is absurd. Resolution: main's
  ink store is authoritative; strokes reach the renderer as **deltas on a
  dedicated IPC event**; the snapshot carries an ink revision per hash, and a
  renderer that detects a gap re-requests the full set. A full re-render from
  snapshot must always produce the same picture as the deltas did — write
  `dev-ink-test` to assert exactly that, plus the upsert semantics and the
  normalisation round-trip.
- **Intent routing trap** (root `HANDOFF.md` §3): brief intents are viewer
  intents — they go in `handleViewerIntent`, not the settings switch. A case
  in the wrong switch compiles, runs, and does nothing.
- **The clean-view marker is deliberately NOT chrome.** `base.css` hides
  `.strip`, `.launcher`, `.banner`, `.stage__chrome` under
  `body[data-surface="window"].is-chrome-hidden`. The hairline + "FOLLOWING
  GHOSTRIDER" label is a new element outside those classes — it is the only
  mark explaining why a no-input pilot's page turns by itself. Do not attach it
  to `.stage__chrome` or it vanishes exactly when it is needed.
- **Keybinds:** two entries in `config.default.json` `hotkeys` —
  present, clear-ink. (`follow` was removed with the follower lock.)
  They ride the existing dual backend
  (`globalShortcut` / `keyHook` passthrough). KEYBINDS page rows render the
  **live binding from config** — the "viewer prints no hotkey" invariant is
  deliberately bent here and only here; never hard-code a key string.
- **PANEL_PROBE:** new probe fields (presenting, following, presenter,
  focusHash, strokeCounts) join the single existing probe. Grep `scripts/` for
  every field you touch — the probe-rename trap has already burned one test
  silently (root `HANDOFF.md` §6).
- **i18n:** every new user-facing string in EN and IT (`dev-i18n-test` enforces
  parity). Banner, bar labels, gesture reference, KEYBINDS rows.
- **HELLO capabilities:** advertise `brief`. A client without it still receives
  photos and simply never sees FOCUS/STROKE — mixed-version squads keep
  working.
- **Preview:** demo brief state goes in `preview-state.js` through
  `window.__preview`, never in shipped markup (boots-empty invariant).

## 4. The wire, complete

Realtime socket (`/rt`), same auth token, JSON control + tiny binary frames:

```
PRESENT_START {presenter}
FOCUS         {hash, batchId, filename, presenter}
STROKE        {strokeId, points:[u16 u,v ×4]}          append (pen)
SHAPE         {strokeId, tool, a:{u,v}, b:{u,v}, final} upsert (arrow/ring)
CURSOR        {u, v}                                    20 Hz, no tool down
UNDO          {hash, strokeId}
CLEAR         {hash}
SNAPSHOT_REQ  {hash}   →  SNAPSHOT {hash, strokes[]}
PRESENT_STOP  {}
```

Relay behaviour: verify sender is the granted presenter, restamp `{presenter}`,
fan out on the realtime socket with the existing `bufferedAmount` ceiling.
Late joiner: on AUTH_OK over `/rt`, server sends current PRESENT state + FOCUS;
client SNAPSHOT_REQs the focused hash.

## 5. Open

- **BURN IN in v1 or later** — store design permits deferring; the button can
  wait.
- **Does presenting survive a host relay restart?** Simplest honest answer:
  no — PRESENT_STOP on disconnect, host re-presents. Say so in the UI.
- **Stroke colour/width:** none in v1. One ink style, the EFB's. If a second
  emphasis is ever needed it is semantic (like the card schema), not a palette.

## 6. Honest gaps

- Nothing rendered by a human eye yet; mockups verified by measurement
  (tone bands, string widths, gutters). Trust your eyes over the numbers.
- Latency figures are DERP-typical, not measured on this squad's funnel.
  Measure once the `/rt` socket exists — a 10-line RTT probe is enough.
- The 30 Hz / 4-points batch is a starting point, not a law; tune against feel
  with local echo on.
