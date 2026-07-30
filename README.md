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

The host's Settings window shows a live "Connected clients" list of everyone currently on the
relay, by callsign.

### The side panel

The viewer window has a collapsible panel on its right edge, reachable from the narrow rail
(which fades out while another app has focus, so it stays invisible in the OpenKneeboard
capture). It has two tabs plus a Settings button — handy when the tray icon is hard to spot or
another app already owns the settings hotkey:

- **Received** — one line per incoming batch: who shared it, how many photos, and the time it
  arrived. New intel gets a red bubble until you've looked at it, with the unread count on the
  rail. Clicking a line brings that batch back, so a later reveal no longer buries an earlier
  one you hadn't read.
- **Share** — a thumbnail gallery of your photos folder. Everything starts selected; untick what
  you don't want, or use "Select all" / "None". **The reveal hotkey shares exactly this
  selection**, so you can set it up before a flight and still trigger it by keystroke mid-air.
  The "Share" button does the same thing with the mouse.

Windows size themselves to the screen: the viewer keeps A4-portrait kneeboard proportions at
~85% of the work-area height and the UI text zooms to match, so nothing renders tiny on a 4K
display at 100% OS scaling (nor overflows a 1080p one). If the automatic choice is ever wrong for
a setup, set `"uiScale": <number>` in `config.local.json` to override it.

## Sharing over the internet (Tailscale Funnel)

Only the **host** machine needs Tailscale; everyone else just needs the app and a URL. When
hosting is enabled, Settings shows an "Internet sharing" panel that walks the whole setup:

1. **Not installed** → the panel links to the Tailscale download page and detects the install
   automatically once it's done (nothing to restart).
2. **Not logged in** → "Log in to Tailscale…" opens the browser auth page for you.
3. **Ready** → tick "Share the relay publicly while the app runs" and Save. The app runs
   `tailscale funnel --bg <relay port>` for you. The first time, Tailscale requires a one-time
   approval for your tailnet — the panel detects that, links straight to the right admin-console
   page, and retries by itself once you've approved.
4. **Shared** → the panel shows your public `wss://<machine>.<tailnet>.ts.net` URL and a
   **Copy invite** button (URL + token, ready to paste into Discord). Squad members paste the URL
   into their own Settings' "Relay URL" field.

The public endpoint follows the host's session: it's taken down when the app quits or when you
untick the box, and a leftover funnel from a crash is cleaned up at the next startup.

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
