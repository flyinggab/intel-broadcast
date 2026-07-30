# Intel Broadcast

Electron companion app for DCS World: any pilot broadcasts recon/intel photos to every connected
pilot's screen via a hotkey, captured by OpenKneeboard on each pilot's PC. One instance hosts the
relay (the center node) and exposes it to the internet via Tailscale Funnel.

**Before doing anything else, read `app/PLAN.md`** — its "Session status / how to resume" section
at the top has the full current state: what's built, what's verified, known bugs and their root
causes, a warning about the published GitHub release being stale, and open items. This file is
deliberately short; that section is the real handoff doc and gets kept up to date.

## Quick facts

- Repo: this directory, pushed to `https://github.com/flyinggab/intel-broadcast` (public).
- App code lives in `app/`. Run tests with plain `node app/scripts/dev-*.js` (no test framework) —
  see `app/PLAN.md` for what each one covers.
- `npm start` in `app/` runs the app. There is no GM vs. viewer mode any more — everyone shares
  and receives; a "Host the relay" Settings checkbox (`relayHostEnabled`) picks the center node.
- To test two instances on one machine: give each terminal its own
  `INTEL_BROADCAST_LOCAL_CONFIG_PATH` env var — see `README.md`.
- Releases are built by `.github/workflows/release.yml` on GitHub Actions (can't cross-compile
  Windows/Mac from this Linux dev environment) — triggered by pushing a `v*` tag.

## Working environment

This has been developed from a WSL/Linux sandbox. Some things don't work reliably there and
aren't worth re-investigating (see `app/PLAN.md` for the full list): Electron's `capturePage()`
screenshot verification, and System Tray icon visibility. GUI windows render onto the real
Windows desktop via WSLg — be careful about spawning test app instances without warning, since
they're not actually hidden/headless from the user's perspective.
