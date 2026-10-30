# Wire Protocol

Transport: WebSocket (`ws`). The instance with "Host the relay" enabled (a Settings checkbox)
runs the server; **every** instance — the host's own included — connects as a client (the host's
client simply targets `ws://127.0.0.1:<port>`). A pilot's relay is reached via a Tailscale
Funnel public HTTPS/WSS URL (`wss://<host-machine>.<tailnet>.ts.net`); the headless relay on a
DCS server ([RELAY.md](./RELAY.md)) directly, at `ws://<server>:<port>`. Nothing below changes
based on how the socket was reached.

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

## 3. Intel from DCS

A relay that follows a DCS `dcs.log` (the headless relay, [RELAY.md](./RELAY.md)) sends what the
mission writes there to every pilot. The mission cannot reach the network itself — its scripting
is sandboxed — but it can write a line to `dcs.log` with `env.info()`, and the relay runs on the
same machine.

### 3.1 The dcs.log line (mission → relay)

```
2026-10-30 07:41:12.880 INFO    SCRIPTING (Main): TACLINK: {"v":1,"kind":"nineline",...}
```

- What the mission writes is `TACLINK: ` followed by one JSON object on one line, UTF-8, no
  newline inside. DCS adds the timestamp (UTC) and `INFO    SCRIPTING (Main): `. `env.warning()`
  lines count too; any other level, or the prefix anywhere but at the start of the message, does not.
- The whole dcs.log line is at most 4,096 bytes. Keep a 9-line under about 1,000 characters until
  the longest line DCS writes without cutting it has been measured (the longest seen so far: 598).

```json
{"v":1,"kind":"nineline","id":"abu-musa-cas-test-0007","mission":"abu-musa-cas-test","time":"07:41:12",
 "from":"Pointer","to":"Joker",
 "lines":["IP SOUTH","003, no offset","9.0","10 feet","Silkworm launcher, one vehicle",
          "N25 52.799 E055 02.596 (40R CP 04321 62345)","laser, 1536","none on the island",
          "Egress south to IP SOUTH, above one zero thousand"],
 "remarks":"Laser-target line 086. Threats: 8 ZU-23 north of the runway, effective to 8,200 feet. Call IN with heading.",
 "target":{"lat":25.879983,"lon":55.043267,"elev_ft":10},"laser":1536}
```

```json
{"v":1,"kind":"call","id":"abu-musa-cas-test-0008","mission":"abu-musa-cas-test","time":"07:43:40",
 "from":"Pointer","to":"Joker","text":"Joker, cleared hot. Laser on, 1536."}
```

| Field | Kinds | Rule |
|---|---|---|
| `v` | all | `1`. Any other version is ignored. |
| `kind` | all | `nineline` or `call`. Others are ignored, so new kinds can be added later. |
| `id` | all | 1-80 characters, unique within one mission load. |
| `mission` | all | 1-80 characters. |
| `time` | all | Mission local time as text, up to 16 characters. Optional. |
| `from`, `to` | all | Up to 40 characters each. Optional. Everyone sees everything; `to` is shown, not enforced. |
| `lines` | nineline | Exactly nine strings, in order, up to 120 characters each. `""` is allowed. The mission formats them; the app only shows them. |
| `remarks` | nineline | Up to 600 characters. Optional. |
| `target` | nineline | `{lat, lon, elev_ft}`, numbers. Optional; carried, not shown. |
| `laser` | nineline | Integer 1111-1788. Optional; carried, not shown (line 7 says it). |
| `text` | call | 1-200 characters. |

Strings lose control characters (a tab becomes a space) and are trimmed. Fields not listed are
dropped. A line that breaks a rule is skipped and logged by the relay, once per reason a minute.

The relay sends each `id` once per mission load: a line DCS wrote twice goes out once. Its memory
of what it sent is cleared when DCS logs `Dispatcher (Main): loadMission <path>` (a mission
starting to load) and when DCS starts a new `dcs.log`, so a reloaded mission may use its ids again.

### 3.2 On the wire (relay → apps, realtime socket `/rt`)

```json
{ "type":"intel-nineline", "id":"…", "mission":"…", "time":"07:41:12", "from":"Pointer", "to":"Joker",
  "lines":["…", "…", "…", "…", "…", "…", "…", "…", "…"], "remarks":"…",
  "target":{"lat":25.879983,"lon":55.043267,"elev_ft":10}, "laser":1536,
  "logTime":"2026-10-30T07:41:12.880Z" }
{ "type":"intel-call", "id":"…", "mission":"…", "time":"07:43:40", "from":"Pointer", "to":"Joker",
  "text":"…", "logTime":"…" }
```

- `logTime` is when DCS wrote the line, in UTC, from the dcs.log timestamp.
- An app checks each message again against §3.1 and drops one that fails.
- A pilot who signs in on `/rt` gets the current mission's last 50 messages, oldest first. Apps
  ignore an `id` they already have, so a reconnect adds nothing twice.
- **Only the relay sends these.** A relay drops `intel-*` and `net-roster` frames from clients and
  logs it, so nobody holding the squad code can put words in the JTAC's mouth.

### 3.3 Roster (relay → apps, `/rt`)

```json
{ "type":"net-roster", "peers":[ { "callsign":"JOKER 1-1", "connectedAt":1761810000000 } ] }
```

Sent to everyone when a pilot joins or leaves, and to each pilot when they sign in. It is the
"who is on the net" list for pilots who do not host.

### 3.4 Capabilities

A relay that sends §3 answers `hello` with `"capabilities":["brief","intel","roster"]`; the
headless relay names itself `"server":"taclink-relay/<version>"`. Apps older than these messages
drop them, as they drop any `/rt` type they do not know, and keep working otherwise.

## Error / lifecycle notes

- Server → client close codes: `4001` auth failure, `4002` malformed auth frame (timeout or bad
  JSON), `4003` too many failed attempts from this address, `1008` too much sent before signing in.
  A relay that is full answers the upgrade with HTTP `503`.
- On `4001` the app stops retrying and says the code was refused: retrying cannot fix a wrong token.
  On `4003` it waits the longest backoff step.
- Clients reconnect with exponential backoff (1s → 2s → 4s → 8s, capped 30s) and re-auth on every
  reconnect. The server holds no session state across reconnects — a freshly reconnected viewer
  simply waits for the next `reveal-batch`.
- A client may send its first reveal frames immediately after the auth frame; the server queues
  frames received before auth resolves and processes them once it does.
- No message currently exists for "clear the screen" — out of MVP scope; a later
  `{ "type": "clear" }` broadcast is a natural, non-breaking addition if needed.
