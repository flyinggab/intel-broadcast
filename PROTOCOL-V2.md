# Wire Protocol v2 — design

Supersedes `PROTOCOL.md` (v1). **Ships in phase 2** — see `ROADMAP.md` §2.2:
shared 9-lines, comms plans and annotations are structured artifacts, and
`reveal-batch` cannot carry them without becoming an unversionable union type.

Written to satisfy three goals at once:

1. typed artifacts beyond photo batches, plus the transfer optimisations
   (content addressing, no re-hash on rebroadcast)
2. a relay that can later be reimplemented as a standalone server, in Rust
3. room for a realtime channel (voice, phase 3) without redesigning anything

v1 has **no version field anywhere** — not in the auth frame, not in the batch
frame. That is the first thing to fix, because until it exists no other change
can be made safely.

---

## 1. What stays

Star topology. The host runs the relay; everyone connects as a client,
including the host via loopback. There is no peer-to-peer path and there does
not need to be one — see "Topology" at the end.

Auth is still a shared token. Fan-out is still server-mediated so the sender
gets the echo and the server can stamp `sharedBy` from the authenticated
identity rather than trusting the frame.

## 2. Frame envelope

Every v2 message, control or bulk, is a binary frame with an 8-byte header:

```
offset  size  field
0       1     version        = 2
1       1     channel        0 control · 1 bulk · 2 realtime (reserved)
2       1     type           see per-channel tables
3       1     flags          bit0 = payload is JSON (UTF-8)
4       4     length (BE)    payload bytes following the header
8       …     payload
```

The length is redundant over WebSocket, which already delimits messages. It is
there so the same framing survives a move to raw TCP or QUIC without a second
format. Four bytes is cheap insurance.

Fixed-offset, no varints, no nesting. `&buf[..8]` parses with a couple of
`u32::from_be_bytes` calls and nothing allocates. Control payloads stay JSON
because they are infrequent and you want to read them in a log; bulk payloads
are raw bytes.

### Why not protobuf / flatbuffers

Two implementations do not justify a codegen step and a schema build
dependency in both toolchains. A fixed header plus JSON control frames is
readable, debuggable with `wscat`, and trivially correct in both languages.
What you actually need to keep two implementations honest is **conformance
vectors**, not a schema compiler — see `protocol-vectors.json`.

## 3. Handshake — the part v1 is missing

```
C → S   control/HELLO      {"protocolVersion":2,"minVersion":2,
                            "client":"intel-broadcast-electron/0.5.0",
                            "capabilities":["content-addressing","chunked-blobs"]}

S → C   control/HELLO_ACK  {"protocolVersion":2,
                            "server":"intel-broadcast-relay-rs/0.1.0",
                            "capabilities":["content-addressing","chunked-blobs","batch-history"],
                            "maxChunkBytes":262144,"sessionId":"…"}

C → S   control/AUTH       {"token":"…","callsign":"GHOSTRIDER 1-1"}
S → C   control/AUTH_OK    {"peerId":"…","roster":[…]}
```

Rules that make later change possible:

- The effective feature set is the **intersection** of both capability lists.
  Never infer a feature from a version number.
- A server that speaks v2 and v1 sniffs the first frame: a JSON text frame
  whose `type` is `auth` is a v1 client, and it drops into legacy mode. This is
  how a Rust relay serves today's Electron build on day one.
- Unknown control types are ignored, not fatal. Unknown **bulk** types are
  fatal, because silently dropping a blob corrupts a batch.
- `role` is gone. It was documented as informational and the server granted
  everyone the same rights anyway, so it was a field that looked like a
  permission and was not one. If origination ever needs gating, it belongs in
  `AUTH_OK` as a real grant.

## 4. Content-addressed bulk transfer

**`itemId` becomes the SHA-256 of the content.** v1 already computes this hash
per item and never uses it; v2 makes it the identity. Everything else follows.

```
CHANNEL 1 — BULK
type  name             direction  payload
0x01  BATCH_ANNOUNCE   both       JSON, metadata only, no bytes
0x02  BLOB_REQUEST     both       JSON {"hashes":["…"]}
0x03  BLOB_CHUNK       both       binary, see below
0x04  BATCH_READY      S → C      JSON {"batchId":"…"}
0x05  BATCH_FAILED     S → C      JSON {"batchId":"…","reason":"…"}
```

`BATCH_ANNOUNCE`:

```json
{ "batchId":"…", "sharedBy":"GHOSTRIDER 1-1", "ts":"2026-07-30T14:32:07Z",
  "items":[ {"hash":"<64 hex>","filename":"01-target-area.jpg",
             "mimeType":"image/jpeg","byteLength":318076} ] }
```

`BLOB_CHUNK` payload:

```
offset  size  field
0       32    hash (raw bytes, not hex)
32      4     offset into the blob (BE)
36      …     chunk data
```

32 raw bytes replaces v1's 36-byte **ASCII** UUID prefix — smaller, and it is
the identity rather than a pointer to it.

### The exchange

```
sharer → relay   BATCH_ANNOUNCE                    ~200 bytes per item
relay  → sharer  BLOB_REQUEST  (only what it lacks)
sharer → relay   BLOB_CHUNK ×  (only those blobs)
relay  → all     BATCH_ANNOUNCE
each   → relay   BLOB_REQUEST  (only what they lack)
relay  → each    BLOB_CHUNK ×  (only to those who asked)
relay  → all     BATCH_READY
```

Three wins, one of which is free:

- **Re-revealing the same folder costs metadata only.** That is the normal
  case across a mission.
- **The sharer stops downloading their own upload.** In v1 the echo is the
  sharer's render path, so they push the batch up and pull it straight back.
  In v2 their echo is a `BATCH_ANNOUNCE` they already have every blob for.
- **A client that has seen a photo in an earlier batch never receives it
  again**, across batches and across sessions if the cache is on disk.

### No re-hash on rebroadcast

v1's server calls `buildRevealFrames()` on fan-out, which re-computes SHA-256
over every byte and mints new ids. In v2 the hashes **are** the ids and they
arrive in the announce, so the relay verifies on ingest once — cheap, and it
must, or a client could poison the cache with mislabelled content — then
forwards the announce with `sharedBy` restamped. No second pass.

**Verify on ingest, trust thereafter.** A relay that skips ingest verification
is a content-addressed store that will happily serve the wrong bytes forever.

## 5. Realtime channel — reserved, not specified

Channel 2 exists so voice does not force a redesign. Two constraints matter
more than the payload format:

**It must not share a socket with bulk.** A 3 MB photo transfer ahead of a
voice packet in the same TCP stream delays it by the whole transfer.
Head-of-line blocking is not tuneable away. Channel 2 therefore **must** use a
separate transport: UDP where it can, a second WebSocket as a poor fallback.

**Funnel cannot carry it.** Funnel is a TLS/TCP proxy through DERP relays, so
UDP voice will not traverse it. Voice works direct on the tailnet, or through
a real server with a public UDP port. This is the same fork as optimisation 4
in the transport discussion, and it lands harder here.

Sketch only, for shape:

```
[u32 seq][u32 timestampMs][u8 radioId][u8 flags][…opus frame]
```

## 6. Server statefulness

v1 says the server holds no session state across reconnects. A standalone
relay should hold three things, and they are what make it worth extracting:

| state | why | bound |
|---|---|---|
| blob cache, hash → bytes | dedup across batches and sessions | LRU by bytes, TTL |
| batch history, last N announces | a pilot who joins late or reconnects mid-mission catches up | N ≈ 20 |
| roster | already exists, needs to survive reconnect | — |

Add `control/CATCH_UP` → server replies with recent announces; the client
requests only blobs it lacks. Reconnect stops being "wait for the next reveal".

## 7. Would Rust help, concretely

Not for throughput on this workload — the costs are copies and redundant
transmission, and those are fixed above in either language. Rust earns its
place on **memory behaviour under fan-out**, which is exactly what v1 has no
answer for.

- `bytes::Bytes` — one refcounted buffer per blob, cloned into every client's
  send queue without copying the payload. Node holds references too, but here
  it is the type system rather than a convention.
- **Bounded channels per client.** A slow pilot fills their queue and gets
  dropped by policy, at a place in the code you can point at. v1's
  `ws.send()` loop has no `bufferedAmount` check and no ceiling at all.
- `HashMap<[u8;32], Bytes>` is the entire blob cache.
- Sharing code with Electron, if wanted: **napi-rs**. N-API is ABI-stable
  across Node and Electron versions, so no `electron-rebuild` and no per-target
  matrix in the release workflow.

Suggested split, if it goes that way:

```
intel-broadcast-core   (Rust)  framing, hashing, reassembly, cache
  ├── napi bindings           → Electron main process
  └── intel-broadcast-relay   → standalone binary
```

Your `srs-rs` work is already the same shape of problem — a wire protocol, a
reconnect loop, a jitter-sensitive path — so the patterns carry.

## 8. On replacing SRS — read before committing

The transport is the easy part and it is maybe 20% of SRS. The other 80% is:
per-aircraft radio state, AM/FM modulation, frequency and channel handling,
encryption, line-of-sight and distance-based degradation, intercom, hot mic,
guard, and the jitter buffer that makes it sound acceptable.

**All of the radio state comes from DCS**, through `Export.lua`. SRS needs to
know which radio you have selected, what frequency it is on, where your
aircraft is, and whether you are alive. There is no way to get that without
integrating with DCS.

That is in direct conflict with this project's stated principle:

> No DCS scripting, mission file, or Hooks install is involved anywhere

Intel photos need no integration, which is why the hotkey approach works. Voice
cannot avoid it. So merging them means the combined app **does** require a DCS
install step, and the thing that makes intel-broadcast pleasant to adopt goes
away.

Three honest options:

1. **Keep them separate**, share `intel-broadcast-core` and the relay binary.
   Two apps, one protocol, one server, one install decision each. Least
   coupling, keeps the no-integration promise for intel.
2. **One app, optional voice module** that pulls in the DCS export only if the
   pilot enables it. Preserves the promise for anyone who only wants intel.
3. **Full merge.** Only worth it if the goal is genuinely to replace SRS for
   your squad, and you accept the integration and the radio-model work.

Option 2 is the one I would build. It keeps the adoption story and still gets
you one server, one roster, one auth token, and one code base for framing.

## 9. Migration

1. Add `HELLO` / `HELLO_ACK` to v1 as an optional pre-auth exchange. A v1
   server ignores an unknown frame; a v2-aware client learns nothing and
   proceeds. Ship this first, alone — it costs nothing and unblocks the rest.
2. Ship v2 bulk behind the `content-addressing` capability. Clients that do not
   advertise it keep getting v1 fan-out from the same server.
3. Move the Electron relay behind the same interface the Rust relay will
   implement, so swapping it is a config change.
4. Retire v1 when the squad has updated. The token in the squad code can carry
   a minimum-version hint, so an out-of-date client gets told why rather than
   failing to connect.
