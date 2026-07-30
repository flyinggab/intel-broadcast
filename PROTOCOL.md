# Wire Protocol

Transport: WebSocket (`ws`). The instance with "Host the relay" enabled (a Settings checkbox)
runs the server; **every** instance — the host's own included — connects as a client (the host's
client simply targets `ws://127.0.0.1:<port>`). In production the server is reached via a
Tailscale Funnel public HTTPS/WSS URL (`wss://<host-machine>.<tailnet>.ts.net`); nothing below
changes based on how the socket was reached.

Unified mode: any authenticated client can both **receive** reveal batches and **originate**
them. A client-originated batch travels up to the host, which re-broadcasts it to every
connected client — including the sender. The echo is the sender's own render path and doubles as
delivery confirmation.

All messages are either a JSON text frame or a binary frame. Binary frames always immediately
follow the text frame that describes them, but consumers should match by `itemId`, not by strict
arrival order.

## 1. Auth (client → server, first frame after connect)

```json
{ "type": "auth", "token": "<shared secret>", "role": "viewer" | "gm", "callsign": "<free text>" }
```

- Must arrive within 5s of connecting or the server closes the socket.
- Server validates `token` against its configured secret. On mismatch, closes with code `4001`.
- `role` is informational (logging/UI) and kept for wire compatibility — the server grants every
  authenticated client the same rights, including originating reveals.
- `callsign` is the username shown in the host's "Connected clients" list and stamped onto any
  batch this client shares (`sharedBy` below).

## 2. Reveal batch

The same frame shape travels in both directions:

- **client → server** (a share): any authenticated client sends it to ask the host to fan it out.
- **server → all clients** (the fan-out): the host re-broadcasts the reassembled batch to every
  connected client, **including the sender**, with a fresh `batchId` and `sharedBy` set to the
  sender's *authenticated* callsign (whatever the incoming frame claimed is ignored).

Text frame:

```json
{
  "type": "reveal-batch",
  "batchId": "<uuid>",
  "count": 3,
  "sourceType": "prebundled" | "live-capture",
  "sharedBy": "<sender callsign, may be empty>",
  "ts": "<ISO 8601>",
  "items": [
    { "itemId": "<uuid>", "filename": "01-target-area.jpg", "mimeType": "image/jpeg", "byteLength": 482113, "sha256": "<hex>" },
    { "itemId": "<uuid>", "filename": "02-tarps-recon.jpg", "mimeType": "image/jpeg", "byteLength": 601442, "sha256": "<hex>" }
  ]
}
```

Followed by `count` binary frames, one per item:

```
[ 36 bytes: itemId as ASCII UUID ][ remaining bytes: raw image data ]
```

Semantics:
- A `reveal-batch` **replaces** the receiving viewer's currently-browsable set entirely — no
  merging across batches. "One hotkey press = one full folder snapshot."
- The server reassembles a client-originated batch fully before re-broadcasting (per-connection
  reassembly state), so two clients sharing simultaneously can never interleave-corrupt each
  other's frames on the way out.
- Sanity caps, enforced by the reassembler on both ends (`src/main/protocol.js`): max 100 items
  per batch, max 256 MB total payload. An over-cap batch is dropped (logged), the socket stays
  open.
- A future live-capture source that only ever produces one frame at a time sends `count: 1`.
- `sha256` lets a viewer verify payload integrity but is not required to be checked in the MVP.

## Error / lifecycle notes

- Server → client close codes: `4001` auth failure, `4002` malformed auth frame (timeout or bad
  JSON).
- Clients reconnect with exponential backoff (1s → 2s → 4s → 8s, capped 30s) and re-auth on every
  reconnect. The server holds no session state across reconnects — a freshly reconnected viewer
  simply waits for the next `reveal-batch`.
- A client may send its first reveal frames immediately after the auth frame; the server queues
  frames received before auth resolves and processes them once it does.
- No message currently exists for "clear the screen" — out of MVP scope; a later
  `{ "type": "clear" }` broadcast is a natural, non-breaking addition if needed.
