# Intel Broadcast

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
node: that person ticks "Host the relay on this machine" in Settings (tray icon, the
"Intel Broadcast" menu, or `Ctrl+Shift+O`), which starts an embedded WebSocket relay everyone
else connects to. Settings apply immediately on save — no restart; only the pieces a changed
value affects (hotkeys, relay server, relay connection) restart in-process.

1. Each pilot points Settings' folder picker at their own mission photos and sets a
   callsign/username.
2. Pressing the reveal hotkey (default `Ctrl+Shift+I`) sends the selected photos from *that
   pilot's* folder up to the relay, which fans them out to everyone — the sharer included. The
   receiving window shows who shared it ("2 / 5 — from Ghostrider-1").
3. Each pilot browses the received set with their own local hotkeys (`Ctrl+Shift+Right` /
   `Ctrl+Shift+Left`) without touching the network or affecting anyone else.

The viewer's BRIEF page shows a live list of everyone currently on the net, by callsign.

### The interface

The viewer window is a four-tab instrument panel — BRIEF, RECEIVED, SHARE and SETUP — styled
after a cockpit EFB, in B612 (the typeface Airbus commissioned for flight decks). It is the
window OpenKneeboard captures, so **Ctrl+Shift+H blanks every bit of chrome** and leaves just the
photo: that is the state that matters in the air. The chrome also dims on its own whenever DCS
has focus.

- **BRIEF** — who is on the net, which folder is staged, whether the funnel is up.
- **RECEIVED** — one row per batch: who shared it, how many photos, the time it landed. Unread
  rows carry a bar and the tab carries a count. Clicking a row brings that batch back, so a later
  reveal never buries one you hadn't read.
- **SHARE** — a thumbnail grid of your folder. Tick what you want; your reveal hotkey sends
  exactly that selection.
- **SETUP** opens the *separate* settings window rather than switching a page — putting a
  settings form on the pilot's knee mid-flight is not a feature.

When intel arrives the viewer switches to it and says so in a banner — unless you were doing
something in the last few seconds, in which case it just badges the tab and holds still. You can
turn the switching off entirely in Setup.

### Joining a squad

One string carries everything:

```
IB1-Z2FiLXBjLnRhaWw5ZjJiLnRzLm5ldDo4MTQwOmtkOTM
```

The host copies it from Setup → NET; everyone else pastes it into the same page and hits CONNECT.
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
intel-broadcast/
├── README.md
├── PROTOCOL.md          # wire protocol spec — source of truth
└── app/                 # the Electron app (one unified mode, single codebase)
```

## Status

Working end to end locally; see `app/PLAN.md`'s status section for what's verified, what's
outstanding, and how to resume.
