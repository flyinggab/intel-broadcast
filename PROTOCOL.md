# Wire Protocol

Transport: WebSocket (`ws`). The GM's app instance (`--gm` mode) runs the server; every other
instance (viewer mode, including the GM's own window) connects as a client. In production the
server is reached via a Tailscale Funnel public HTTPS/WSS URL baked into
`resources/config.default.json`; nothing below changes based on how the socket was reached.

All messages are either a JSON text frame or a binary frame. Binary frames always immediately
follow the text frame that describes them, but consumers should match by `itemId`, not by strict
arrival order.

## 1. Auth (client → server, first frame after connect)

```json
{ "type": "auth", "token": "<shared secret>", "role": "viewer" | "gm", "callsign": "<free text>" }
```

- Must arrive within 5s of connecting or the server closes the socket.
- Server validates `token` against its configured secret. On mismatch, closes with code `4001`.
- `role` is informational (logging/UI) — the server doesn't grant different permissions per role;
  only the GM's own app process can originate a `reveal-batch` in the first place, since it's the
  one holding the embedded server and the local photo folder.

## 2. Reveal batch (server → all connected clients except none — full fan-out, including a normal
   echo back to the GM's own viewer socket if it connects as one)

Text frame:

```json
{
  "type": "reveal-batch",
  "batchId": "<uuid>",
  "count": 3,
  "sourceType": "prebundled" | "live-capture",
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
- A future live-capture source that only ever produces one frame at a time sends `count: 1`.
- `sha256` lets a viewer verify payload integrity but is not required to be checked in the MVP.

## Error / lifecycle notes

- Server → client close codes: `4001` auth failure, `4002` malformed auth frame (timeout or bad
  JSON).
- Clients reconnect with exponential backoff (1s → 2s → 4s → 8s, capped 30s) and re-auth on every
  reconnect. The server holds no session state across reconnects — a freshly reconnected viewer
  simply waits for the next `reveal-batch`.
- No message currently exists for "clear the screen" — out of MVP scope; a later
  `{ "type": "clear" }` broadcast is a natural, non-breaking addition if needed.
