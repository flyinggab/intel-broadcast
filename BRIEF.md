# Intel Broadcast — UI rebuild brief

For a Claude Code session working on `flyinggab/intel-broadcast`.
The design is done and the markup and CSS are written. **You are writing the
JavaScript that drives them, and the main-process changes underneath.**

> **This brief is phase 1 of four.** Read `ROADMAP.md` first, especially §5,
> "what phase 1 must not foreclose". Later phases add DCS-specific EFB pages
> (2), voice replacing SRS (3), and an OpenXR layer replacing OpenKneeboard
> (4). Six decisions taken now keep all three cheap, and two of them constrain
> the JavaScript in this brief: **the renderer owns no state** (§5.2) and
> **blobs are keyed by content hash** (§5.1).
>
> In scope now: the UI, `imagePrep.js`, §9.1, and the hardening list in
> `ROADMAP.md` §1. Out of scope: protocol v2 bulk transfer, Rust, hooks, voice.

---

## 1. What you've been given

```
ui/
├── viewer.html          replaces app/src/renderer/viewer/index.html
├── settings.html        replaces app/src/renderer/settings/index.html
├── preview.html         dev harness — open in a browser, not shipped
├── css/
│   ├── tokens.css       every colour, size, and type value
│   ├── base.css         @font-face, shell layout, page switching
│   └── components.css   the class contract
├── fonts/               B612 + B612 Mono, woff2, SIL OFL 1.1
└── img/
    └── frame-placeholder.svg
```

Drop `ui/` into `app/src/renderer/` so the two HTML files sit where the
current ones do, and the relative `css/`, `fonts/`, `img/` paths resolve.

**Do not restyle.** If something needs a value that isn't in `tokens.css`,
add a token rather than hard-coding it in a rule.

---

## 2. Three decisions to understand before you start

### Why setup is not a page in the viewer window

The viewer window is what OpenKneeboard captures and puts on the pilot's
knee. If SETUP were a page inside it, opening setup would display the
settings form on the kneeboard mid-flight.

So: the viewer keeps its **separate settings window**, exactly as the repo
does now. The SETUP tab in the viewer's tab bar is a launcher — it calls the
existing "open settings" path and does **not** set `data-page`. Every other
tab switches a page in place.

### Why LINK folded into NET

Hosting and the Tailscale funnel are one decision. Splitting them meant
reading two pages to answer "can my squad actually reach me". NET now shows
mode, the squad code, the funnel steps, and the advanced port/token row.

NET is also the fix for the real bug in the current settings window: the host
checkbox and the relay-URL field are both live at the same time, so the app
can be in a state that contradicts itself. `body[data-mode]` makes it
exclusive — **there is no state where both are visible.**

### The auto-switch conflict

The README currently says clicking a batch brings it back *"so a later reveal
no longer buries an earlier one you hadn't read."* Auto-switching on arrival
deliberately reverses that.

The risk is concrete: you're reading frame 3 of Joker's set, Ghostrider
reveals, and the page moves under you at the wrong moment. Three options:

| | behaviour | cost |
|---|---|---|
| A | always switch | can yank the page mid-read |
| B | switch only from BRIEF, otherwise badge | never switches when it matters most |
| **C** | switch unless the user paged or tapped in the last **8 s** | fiddlier; needs an activity timestamp |

**Ship C**, with the `SHOW NEW INTEL ON ARRIVAL` toggle on the PILOT page as
the escape hatch. Keep a single `lastInteractionAt` timestamp in the viewer
renderer; on arrival, switch only if `Date.now() - lastInteractionAt > 8000`.
When suppressed, badge the RECEIVED tab and leave the banner unshown.

Either way the banner is mandatory when it does switch. A page that moves on
its own without saying why reads as a bug.

---

## 3. The squad code

One string replaces the URL field and the token field.

```
IB1-Z2FiLXBjLnRhaWw5ZjJiLnRzLm5ldDo4MTQwOmtkOTM
 │   └── base64url( host ":" port ":" token ), padding stripped
 └────── format prefix + version
```

```js
const encodeSquadCode = (host, port, token) =>
  'IB1-' + Buffer.from(`${host}:${port}:${token}`)
    .toString('base64url').replace(/=+$/, '');

function decodeSquadCode(raw) {
  const s = String(raw).trim();
  if (!s.startsWith('IB1-')) throw new Error('not a squad code');
  const b = s.slice(4);
  const json = Buffer.from(b + '='.repeat((4 - b.length % 4) % 4), 'base64url')
    .toString('utf8');
  const i = json.lastIndexOf(':');
  const j = json.lastIndexOf(':', i - 1);
  if (i < 0 || j < 0) throw new Error('malformed squad code');
  const host = json.slice(0, j), port = json.slice(j + 1, i), token = json.slice(i + 1);
  if (!host || !/^\d+$/.test(port) || !token) throw new Error('malformed squad code');
  return { host, port: Number(port), token };
}
```

Split from the **right**, because hosts contain dots but the token and port
won't contain colons. Test vector, must round-trip exactly:

```
gab-pc.tail9f2b.ts.net : 8140 : kd93
  ↔  IB1-Z2FiLXBjLnRhaWw5ZjJiLnRzLm5ldDo4MTQwOmtkOTM
```

Rules:

- The prefix exists so the client can reject junk **before** opening a socket.
  Validate, then connect — never the other way round.
- Rotating the token invalidates every code ever issued. Say so at the point
  of the `NEW TOKEN` button.
- **The code is a password.** Don't log it, don't put it in a crash report,
  and don't paste it into the log tail on the LOG page.
- On JOIN, decode as the user types or pastes and fill the `RESOLVED` cells.
  A bad code populates nothing and disables CONNECT — it must not throw into
  the console and leave the UI looking fine.
- Keep `PROTOCOL.md` as the source of truth for the wire format. **This
  changes how a client is configured, not a single byte on the wire.**

---

## 4. Class contract

JS toggles these. JS should never write inline styles.

| Element | Attribute / class | Values |
|---|---|---|
| `<body>` viewer | `data-page` | `brief` `frame` `received` `share` `fault` |
| `<body>` viewer | `data-surface` | `window` today, `vr` in phase 2 — see ROADMAP §3.3 |
| `<body>` viewer | `.is-chrome-hidden` | Ctrl+Shift+H — blanks all chrome |
| `<body>` viewer | `.is-unfocused` | DCS has focus; chrome dims |
| `<body>` settings | `data-page` | `pilot` `net` `keys` `log` |
| `<body>` settings | `data-mode` | `host` `join` |
| `.tab`, `.subtab` | `.is-active` | one per bar |
| `.tab__badge` | `.is-hidden`, `.is-fault` | unread count; red only when the relay is down |
| `.row` | `.is-new`, `.is-open` | unread / currently on the stage |
| `.tile` | `.is-off` | deselected |
| `.step` | `.is-done`, `.is-running` | |
| `.toggle` | `.is-on` + `aria-checked` | keep both in sync |
| `.key` | `.is-active`, `[disabled]` | |
| `.field` | `.field--recording` | hotkey capture in progress |
| `.banner` | `.is-hidden` | |

### Live regions worth getting right

- `#banner` — show on arrival, auto-hide after ~6 s, dismissible.
- `#tab-badge` — unread batch count; `.is-hidden` at zero.
- `#stage-pager` — rebuild dots on batch change; `.is-current` on one.
- `.step__state` — the Tailscale panel already polls; keep that logic, just
  write into these nodes.

---

## 5. Wiring, file by file

**`app/src/renderer/viewer/viewer.js`**
- Tab clicks → `data-page`, except `#tab-setup` → IPC to open settings.
- Arrival: apply rule C, set banner text, switch page, rebuild pager.
- `#stage-prev` / `#stage-next` and the existing prev/next hotkeys → same handler.
- New hotkey **HIDE CHROME** toggles `.is-chrome-hidden`.
- Focus/blur → `.is-unfocused` (the current rail-fade logic moves here).
- Received rows → load that batch, drop `.is-new`, move `.is-open`.
- Share tiles → toggle `.is-off`, update `#share-count` and the button label.

**`app/src/renderer/settings/settings.js`**
- Sub-tabs → `data-page`; mode keys → `data-mode`.
- HOST: render + copy the squad code; `NEW TOKEN` regenerates, re-renders,
  and warns that old codes die.
- JOIN: decode into the RESOLVED cells; gate CONNECT on a valid decode.
- KEYS: recording adds `.field--recording`, button becomes `STOP`.
- Settings still apply immediately on save — keep that, it's good.

**`app/src/main/`**
- `scaling.js` → write the computed scale to `--ui-scale` instead of the
  current font-size approach. Every dimension is rem, so one variable moves
  the whole UI. Keep the `uiScale` override in `config.local.json`.
- `viewerWindow.js` → keep A4 portrait; register the HIDE CHROME accelerator.
- `relayClient.js` / `config.js` → accept a squad code, store the decoded
  host/port/token. Migrate any existing `relayUrl` + `token` config on first
  run so nobody has to re-pair.
- `tray.js` → unchanged.

**Delete:** the old side-panel rail and its CSS. The tab bar replaces it.

---

## 6. Checks before you call it done

1. `frame` + `.is-chrome-hidden` shows the photo and **nothing else**.
2. Opening setup never changes what the viewer window displays.
3. NET can't show a host toggle and a relay field at once, in any state.
4. The code round-trips the test vector, and a truncated code disables
   CONNECT instead of throwing.
5. Every interactive target is ≥ 44 px at `--ui-scale: 1`. Check `.key--sm`
   and `.tab__badge` first — those are the tight ones.
6. `--ui-scale: 0.8` and `1.4` both hold up: nothing clips, nothing overlaps.
7. Nothing reflows the stage when a batch arrives.
8. B612 loads from the vendored files with the network off.
9. The squad code appears in no log line.

---

## 7. Things I got wrong that you should check

- **I never saw these rendered.** The design was verified by measuring the
  output — string widths against container widths, contrast ratios, tone —
  because image preview was broken while I worked. The geometry is sound but
  trust your eyes over my numbers.
- **B612 is wide**, ~0.64 em per cap, much wider than the condensed face this
  was first drawn in. I refitted everything and checked every string, but any
  *new* copy you add needs measuring. Longer callsigns than `GHOSTRIDER 1-1`
  will be the first thing to break — `.truncate` is on the cells that need it,
  but confirm.
- **Mid-tone caps contrast at about 4.2:1** both directions. That's the
  ceiling for a mid surface, slightly under the 4.5 AA body-text bar. It's
  fine for the short bold labels here. If you add long-form body copy,
  it should be `--lit` on `--dn`, not `--ink` on `--bg`.
- **`HIDE CHROME` is a new hotkey** that doesn't exist in the repo. It needs a
  default (`Ctrl+Shift+H`), a config entry, and a row on the KEYS page —
  all present in the markup, none of it wired.
- **The five-key list on KEYS** includes that new binding, so the config
  schema grows by one. Migrate rather than reset.

---

## 8. Sender-side image compression

`ui/imagePrep.js` — drop into `app/src/main/`.

**Why it belongs on the sender.** The host fans every batch out to N clients,
so payload size is multiplied by the number of pilots. One compression pass by
the sharer removes it from N transmissions. Doing it on the host instead means
decode + re-encode on every rebroadcast, spending latency and CPU in the one
process that can least afford either.

**No new dependency.** It uses Electron's `nativeImage`, which
`photoLibrary.js` already uses for thumbnails. No native module, no
`electron-rebuild`, nothing new for the release workflow to build or sign.

**Nothing on the wire changes.** `buildRevealFrames()` derives `byteLength` and
`sha256` from the buffer it is handed, so compressing before that point keeps
frames self-consistent. Older clients cannot tell.

### Profiles

| | long edge | quality | for |
|---|---|---|---|
| **KNEEBOARD** (default) | 1600 px | 82 | recon photos |
| SHARP | 2200 px | 90 | maps and charts with fine text |
| ORIGINAL | — | — | pass through untouched |

1600 is derived, not guessed: the viewer is A4 portrait at ~85% of the work
area, so it renders at roughly 1200×1700 on a 4K display, and OpenKneeboard
resamples that into VR at lower effective resolution again. Above ~1600 you are
paying N× to ship pixels nobody can resolve.

### Wiring

1. Construct once in `index.js`: `const prep = createImagePrep({ onLog })`.
2. In `reveal.js`, between `readPhotoFolder()` and `relayClient.sendRevealBatch()`,
   map each item through `prep.get(fullPath, profileName)`.
3. **Warm the cache when the share selection changes**, not on the hotkey.
   Compressing eight photos costs a few hundred ms on the main process, and the
   keypress is exactly the moment you cannot afford to block. `prep.warm()`
   does this one file per tick.
4. Feed `prep.stagedBytes()` into the `STAGED` cell and the SHARE count, so the
   pilot sees what they are about to push at everybody.
5. Persist the profile in config; wire the three keys on the PILOT page.

### Behaviour worth knowing

- Falls back to the original buffer on any failure. A reveal that ships a fat
  photo beats a reveal that ships nothing.
- Keeps the original if the re-encode came out larger — flat-colour PNGs can
  grow as JPEG.
- Passes through only when the file is **both** under 400 KB and already within
  the target long edge. A 6000 px image at 300 KB still costs every client a
  decode.
- Re-encoding strips EXIF, so GPS and camera metadata stop leaving the machine.
  That is a side effect, but a welcome one.
- A JPEG re-encode of `foo.png` is renamed `foo.jpg`, so a future save-to-disk
  doesn't produce a mislabelled file.
- Cache key is `path + mtimeMs + size + profile`, so editing a photo in place
  or switching profile invalidates correctly. LRU, 60 entries.

### What it does to the numbers from the scaling question

Depends entirely on source material, which is why the STAGED readout matters:

| source | batch of 8 | after | at 20 clients | at 50 |
|---|---|---|---|---|
| 4K screenshots, ~3 MB each | 24 MB | ~2.8 MB | 480 → 56 MB | 1.2 GB → 140 MB |
| repo samples, ~400 KB each | 3.2 MB | ~1.8 MB | 64 → 36 MB | 160 → 90 MB |

The first row is the real case — people drop raw screenshots in. It does not
remove the need for backpressure and `maxPayload`; it buys headroom.

### Untested

`planCompression` and `rewriteExtension` are pure and were exercised against
ten cases including huge-pixels/small-bytes, small-pixels/fat-bytes, and an
absurd 80 MB source. **`prepareOne` was never run** — it needs an Electron
runtime, which I did not have. Verify the `nativeImage.resize()` aspect
handling and `toJPEG()` output on a real folder before trusting the sizes
above.

---

## 9. Transfer optimisations

Three changes, in dependency order. **9.1 is independent and is phase 1.**
**9.2 and 9.3 depend on protocol v2, which ships in phase 2** — the structured
artifacts in `ROADMAP.md` §2.2 force it. Listed here so the phase 1 work is
written pointing the right way.

### 9.1 Kill the data URL (ship this first, it is free)

`viewerWindow.js:51` builds `data:${mimeType};base64,${buffer.toString('base64')}`.
That inflates every photo by 33%, structured-clones the string across IPC, and
makes Chromium base64-decode it again on the other side. Three copies of every
image for no benefit.

Replace with a custom protocol in the main process:

```js
// main
const blobs = new Map();                       // itemId -> Buffer
protocol.handle('intel', (req) => {
  const id = new URL(req.url).pathname.slice(1);
  const buf = blobs.get(id);
  return buf ? new Response(buf, { headers: { 'content-type': mimeOf(id) } })
             : new Response(null, { status: 404 });
});
// renderer
photoEl.src = `intel://item/${itemId}`;
```

Register the scheme as privileged and `supportFetchAPI` before `app.ready`.
The renderer only ever holds a URL string. Range requests come free if clips
ever return.

### 9.2 Content-addressed transfer

`itemId` becomes the SHA-256 of the content — a hash v1 already computes and
never uses. Announce metadata first, transfer only the blobs the far side
lacks. Full exchange in `PROTOCOL-V2.md` §4.

Measured against the repo's own two photos: re-revealing the same folder goes
from **773 KB to 0.4 KB**. The sharer also stops downloading their own upload,
because in v1 the echo is their render path and it round-trips the whole batch
back to them.

Needs a blob cache keyed by hash. Put it on disk with an LRU and the dedup
survives restarts.

### 9.3 Stop re-hashing on rebroadcast

`relayServer.js` calls `buildRevealFrames()` on fan-out, re-computing SHA-256
over every byte and minting new ids. Under v2 the hashes arrive in the
announce, so the relay verifies once on ingest and forwards.

**Verify on ingest — do not skip it.** A content-addressed store that trusts
claimed hashes will serve wrong bytes forever. Verify once, trust thereafter.

### Order

```
9.1 data URL          independent, ship now
 └── 9.2 content addressing   needs v2 handshake
      └── 9.3 no re-hash      needs 9.2
```

Before any of it: add `HELLO`/`HELLO_ACK` to the current protocol as an
optional pre-auth frame. A v1 server ignores unknown frames, so it costs
nothing and it is the thing that makes every later change safe. **There is no
version field anywhere in v1** — that is the actual blocker.
