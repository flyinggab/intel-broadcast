# Tac Link

A companion Electron app for DCS World: any pilot presses a keybind and every recon/intel photo
in their mission folder pops up simultaneously on every connected pilot's screen — even across
the internet, on separate physical PCs. Each pilot's screen shows the photos in an Electron
window that [OpenKneeboard](https://openkneeboard.com/)'s Window Capture source can grab and
present as a virtual kneeboard page in the cockpit.

No DCS scripting, mission file, or Hooks install is involved anywhere — the trigger is a global
OS-level hotkey (à la [rkusa/dcs-scratchpad](https://github.com/rkusa/dcs-scratchpad)), and the
cross-client fan-out is a small relay embedded directly in one pilot's own app instance (the same
shape [DCS-SimpleRadioStandalone](https://github.com/ciribob/dcs-simpleradiostandalone) uses for
voice, minus the standalone server — see [PROTOCOL.md](./PROTOCOL.md) for the wire format).

## How it works

Everyone runs the exact same app, and **everyone can both share and receive** — there's no GM
build, GM mode, or separate viewer role. One machine additionally acts as the squad's center
node: that person picks "I host the squad" in SETUP → NETWORK, which starts an embedded
WebSocket relay everyone else connects to. Settings apply immediately on save — no restart; only the pieces a changed
value affects (hotkeys, relay server, relay connection) restart in-process.

1. Each pilot points SHARE's folder picker at their own mission photos and sets a callsign in
   Settings.
2. Pressing the reveal hotkey (default `Ctrl+Shift+I`) sends the selected photos from *that
   pilot's* folder up to the relay, which fans them out to everyone — the sharer included. The
   receiving window shows who shared it ("2 / 5 — from Ghostrider-1").
3. Each pilot browses the received set with their own local hotkeys (`Ctrl+Shift+Right` /
   `Ctrl+Shift+Left`) without touching the network or affecting anyone else.

Settings → NETWORK shows a live list of everyone currently on the net, by callsign.

The interface is available in **English and Italian**. It follows your computer's language
automatically — on Windows the preferred UI language list, on macOS Preferred Languages — and
falls back to English for anything else. Only the *language* matters, not the region: a machine
set to English in Italy stays English. Override it any time at the foot of the settings rail.

### The interface

The viewer window is a four-tab instrument panel — BRIEF, RECEIVED, SHARE and SETUP — styled
after a cockpit EFB, in B612 (the typeface Airbus commissioned for flight decks). It is the
window OpenKneeboard captures, so **Ctrl+Shift+H blanks every bit of chrome** and leaves just the
photo: that is the state that matters in the air. The chrome also dims on its own whenever DCS
has focus.

- **BRIEF** is the kneeboard itself: a one-line connection strip (callsign · net · relay), then
  the photo. Every received photo forms **one queue, newest batch first** — a new reveal goes to
  the front — and the browse hotkeys page through all of it, across batches. STANDBY when
  nothing has arrived. No hotkey is printed anywhere in the window: bindings live in
  SETUP → KEYBINDS, the one place they are always current.
- **RECEIVED** curates that queue: every photo of every batch as a tile, ticked = in the brief.
  Untick what you're done with; HIDE drops a whole batch, RESTORE brings it back. Dropping the
  photo you are looking at advances to the next one; dropping any other never moves your page.
- **SHARE** — a thumbnail grid of your folder (picked right here). Tick what you want; your
  reveal hotkey sends exactly that selection.
- **SETUP** is a page like the others — an EFB carries its own settings, the way the tablet a
  pilot actually flies with does. Three sections on a rail: NETWORK (callsign, hosting vs
  joining, who is on the net), KEYBINDS, LOG.

Every arrival is announced in a banner that dismisses itself: "SWITCHED AUTOMATICALLY" when the
viewer jumped to the new intel, "QUEUED" when you were mid-something and it held still (it joins
the front of the queue either way). The auto-switching has an off switch at the top of RECEIVED.

### Joining a squad

One string carries everything:

```
IB1-Z2FiLXBjLnRhaWw5ZjJiLnRzLm5ldDo4MTQwOmtkOTM
```

The host copies it from Setup → NETWORK; everyone else pastes it into the same page and hits CONNECT.
It encodes the host, port and token, so there is nothing else to type. **Treat it as a password** —
anyone holding it can join. Rotating the token in Setup invalidates every code previously issued.

## Local testing (two instances, one machine)

Two instances launched from the same `app/` folder normally fight over the same
`resources/config.local.json` — enabling hosting in one makes both think they host, and they
collide on the relay port. Give each terminal its own config file via
`INTEL_BROADCAST_LOCAL_CONFIG_PATH`:

```
# Terminal 1 — the host
cd app
INTEL_BROADCAST_LOCAL_CONFIG_PATH=/tmp/host-config.json npm start
# open Settings, tick "Host the relay on this machine", save — applies immediately

# Terminal 2 — another pilot
cd app
INTEL_BROADCAST_LOCAL_CONFIG_PATH=/tmp/pilot-config.json npm start
```

Either instance can press the reveal hotkey; both windows show the result. (Global hotkeys can
only be owned by one process at a time, so on a single machine only the instance that launched
first responds to them — use the menu bar for the second one. Not an issue on separate PCs.)

## Repo layout

```
taclink/
├── README.md
├── HANDOFF.md           # current state + next task — start here
├── CHANGELOG.md         # what shipped in each release
├── ROADMAP.md           # the four phases
├── PROTOCOL.md          # wire protocol spec — source of truth
├── PROTOCOL-V2.md       # v2 design, lands in phase 2
├── protocol-vectors.json# v2 conformance vectors
├── BRIEF.md             # phase 1 spec (historical; §4 superseded by HANDOFF §4)
└── app/                 # the Electron app (one unified mode, single codebase)
    ├── branding/        # icon SVG masters — edit these, never the PNGs
    ├── build/           # generated .icns/.ico/.png (committed; CI consumes them)
    └── PLAN.md          # historical — original architecture + packaging post-mortem
```

## Status

**Current release: `v0.5.2`** — language now follows your computer's preferred-language list
properly, on Windows and macOS alike. On top of v0.5.1's app icon, v0.5.0's English/Italian
support and settings navigation rail (NETWORK · KEYBINDS · LOG), v0.4.0's queue-first viewer,
and phase 1's EFB UI, content-addressed blobs, squad codes and transport hardening.

See [CHANGELOG.md](./CHANGELOG.md) for what shipped when, and [HANDOFF.md](./HANDOFF.md) for
what's verified, what the known gaps are, and what's next.
`app/PLAN.md` is **historical** and reports a release two versions old — don't resume from it.
