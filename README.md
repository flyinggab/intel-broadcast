# Intel Broadcast

A companion Electron app for DCS World: one Game Master (GM), who is also flying, presses a
keybind and every pre-bundled recon/intel photo for the mission pops up simultaneously on every
connected pilot's screen — even across the internet, on separate physical PCs. Each pilot's
screen shows the photos in a fixed, borderless Electron window that
[OpenKneeboard](https://openkneeboard.com/)'s Window Capture source can grab and present as a
virtual kneeboard page in the cockpit.

No DCS scripting, mission file, or Hooks install is involved anywhere — the trigger is a global
OS-level hotkey (à la [rkusa/dcs-scratchpad](https://github.com/rkusa/dcs-scratchpad)), and the
cross-client fan-out is a small relay embedded directly in the GM's own app instance (the same
shape [DCS-SimpleRadioStandalone](https://github.com/ciribob/dcs-simpleradiostandalone) uses for
voice, minus the standalone server — see [PROTOCOL.md](./PROTOCOL.md) for the wire format and
`~/.claude/plans/i-want-to-create-resilient-wigderson.md` in the `dcs-workspace` repo for the full
design writeup).

## How it works

Everyone runs the exact same app — there's no separate launch flag or build for the GM. Whoever's
running the mission opens Settings (tray icon, the "Intel Broadcast" menu, or `Ctrl+Shift+O`) and
checks "Enable Game Master mode," which starts an embedded WebSocket relay server and registers the
reveal hotkey (default `Ctrl+Shift+I`) after a restart.

1. The GM picks a folder of photos for the mission via Settings' folder picker.
2. Every other pilot just runs the plain app (GM mode left unchecked) — a normal, movable viewer
   window that connects out to the GM's relay over a public
   [Tailscale Funnel](https://tailscale.com/kb/1223/funnel) URL baked into the build config.
3. Pressing the reveal hotkey sends every photo in the mission folder to all connected viewers at
   once. Each pilot can browse the received set with their own local hotkeys
   (`Ctrl+Shift+Right` / `Ctrl+Shift+Left`) without touching the network or affecting anyone else.

## Local testing (two instances, one machine)

Both GM and viewer are the same app now, which means two instances launched from the same
`app/` folder normally fight over the same `resources/config.local.json` — enabling GM mode in
one makes both think they're the GM, and they collide on the relay port. Give each terminal its
own config file via `INTEL_BROADCAST_LOCAL_CONFIG_PATH`:

```
# Terminal 1 — GM
cd app
INTEL_BROADCAST_LOCAL_CONFIG_PATH=/tmp/gm-config.json npm start
# open Settings, enable GM mode, save & restart

# Terminal 2 — viewer
cd app
INTEL_BROADCAST_LOCAL_CONFIG_PATH=/tmp/viewer-config.json npm start
```

Only needed for testing two roles on one machine — real deployments don't need this at all, since
every pilot's machine already has its own separate install.

## Repo layout

```
intel-broadcast/
├── README.md
├── PROTOCOL.md          # wire protocol spec — source of truth
└── app/                 # the Electron app (viewer + gm modes, single codebase)
```

## Status

Early scaffolding — see `PROTOCOL.md` and the task list for current phase.
