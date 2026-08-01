'use strict';

const { WebSocketServer } = require('ws');
const fs = require('fs');
const path = require('path');

const { authenticateConnection } = require('./auth');
const { buildRevealFrames, BatchReassembler, ITEM_ID_LENGTH } = require('./protocol');

/**
 * Starts the embedded relay: a WebSocket server that authenticates connections
 * with a shared token, then fans out `reveal-batch` broadcasts (one JSON text
 * frame + one binary frame per item) to every currently-connected client.
 *
 * Any authenticated client may originate a reveal: the server reassembles the
 * client's frames (per-connection BatchReassembler, so concurrent senders
 * can't interleave-corrupt each other) and re-broadcasts the batch to every
 * client, INCLUDING the sender — the echo is each sharer's own render path
 * and delivery confirmation. `sharedBy` on the fan-out is stamped from the
 * sender's authenticated callsign, never trusted from the incoming frame.
 */
// `ws` defaults maxPayload to 100 MiB per message — far more than any single
// photo frame should ever be, and an easy way for one client to make the host
// allocate. The protocol caps a whole batch at 256 MB; a single frame has no
// business exceeding this.
const MAX_FRAME_BYTES = 32 * 1024 * 1024;

// Backpressure ceiling for the fan-out. A slow client must not make the host
// buffer without bound: past this, that client's copy of the batch is dropped
// rather than queued. Dropping one recipient's batch beats the host swelling
// until it dies, and they get the next reveal normally.
const MAX_BUFFERED_BYTES = 48 * 1024 * 1024;

function createRelayServer({ port, token, onLog = () => {}, onClientsChanged = () => {} }) {
  const wss = new WebSocketServer({ port, maxPayload: MAX_FRAME_BYTES });
  // ws -> { role, callsign, connectedAt } for every authenticated client —
  // identity kept so SETUP can show who's connected and so
  // rebroadcasts can be attributed to their sender.
  const clients = new Map();

  // Without a handler, an 'error' event (e.g. EADDRINUSE when a live settings
  // apply picks a port something else holds) would throw and take down the
  // whole app instead of just logging.
  wss.on('error', (err) => onLog(`server error: ${err.message}`));

  wss.on('connection', (ws) => {
    const reassembler = new BatchReassembler();
    let senderCallsign = null; // set once authenticated

    function handleFrame(data, isBinary) {
      let batch;
      try {
        batch = reassembler.feed(data, isBinary);
      } catch (err) {
        onLog(`rejected batch from ${senderCallsign || '(none)'}: ${err.message}`);
        return;
      }
      if (!batch) return;
      // sharedBy is stamped from the AUTHENTICATED callsign — whatever the
      // incoming frame claimed is ignored.
      broadcastRevealBatch(batch.items, { sourceType: batch.sourceType, sharedBy: senderCallsign || '' });
    }

    // The listener is attached NOW, not after auth resolves: auth resolution
    // is a microtask, and ws can emit several already-buffered frames
    // synchronously back-to-back — frames right behind the auth frame would
    // otherwise be emitted with no listener and silently lost. Until auth
    // completes, frames are queued (bounded); the auth frame itself also
    // lands in the queue (auth.js consumes it via its own once-listener) and
    // is harmlessly ignored by the reassembler on flush.
    const preAuthQueue = [];
    let authed = false;
    ws.on('message', (data, isBinary) => {
      if (!authed) {
        if (preAuthQueue.length < 200) preAuthQueue.push([data, isBinary]);
        return;
      }
      handleFrame(data, isBinary);
    });

    authenticateConnection(ws, token, { onLog })
      .then((authMsg) => {
        senderCallsign = authMsg.callsign || '';
        clients.set(ws, { role: authMsg.role, callsign: senderCallsign, connectedAt: Date.now() });
        onLog(`client connected: role=${authMsg.role} callsign=${senderCallsign || '(none)'}`);
        onClientsChanged(getConnectedClients());

        authed = true;
        for (const [data, isBinary] of preAuthQueue) handleFrame(data, isBinary);
        preAuthQueue.length = 0;

        ws.on('close', () => {
          clients.delete(ws);
          onLog(`client disconnected: role=${authMsg.role} callsign=${senderCallsign || '(none)'}`);
          onClientsChanged(getConnectedClients());
        });
      })
      .catch((err) => {
        onLog(`auth failed: ${err.message}`);
      });
  });

  /** Snapshot of every authenticated client, ordered by connect time. */
  function getConnectedClients() {
    return [...clients.values()].sort((a, b) => a.connectedAt - b.connectedAt);
  }

  /**
   * items: [{ filename, mimeType, buffer }]
   */
  function broadcastRevealBatch(items, { sourceType = 'prebundled', sharedBy = '' } = {}) {
    const { batchId, metaFrame, binaryFrames } = buildRevealFrames(items, { sourceType, sharedBy });

    let dropped = 0;
    for (const [ws, info] of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      // Backpressure: a client too far behind gets this batch dropped rather
      // than letting the host's send queue grow without bound.
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
        dropped += 1;
        onLog(
          `dropped batch for ${info.callsign || '(none)'}: ${(ws.bufferedAmount / (1024 * 1024)).toFixed(0)}MB still queued`,
        );
        continue;
      }
      ws.send(metaFrame);
      for (const frame of binaryFrames) ws.send(frame, { binary: true });
    }

    onLog(
      `broadcast reveal-batch ${batchId}: ${items.length} item(s) to ${clients.size - dropped}/${clients.size} client(s)` +
        (sharedBy ? ` (shared by ${sharedBy})` : '') +
        (dropped ? ` — ${dropped} too far behind` : ''),
    );
    return batchId;
  }

  /**
   * Closes the server. wss.close() alone only stops the listener — it leaves
   * established client sockets connected (to a server object nothing will
   * ever broadcast through again), so terminate them explicitly. `done` fires
   * once the port is fully released, which is what lets a live settings apply
   * restart the relay on the same port without hitting EADDRINUSE.
   */
  function close(done = () => {}) {
    for (const ws of wss.clients) ws.terminate();
    wss.close(done);
  }

  return { broadcastRevealBatch, getConnectedClients, close, wss };
}

/**
 * Reads every file directly inside `folderPath` and returns them as
 * `{filename, mimeType, buffer}` items, sorted by filename (numeric prefix
 * convention, e.g. 01-, 02-, sets browsing order).
 */
function readPhotoFolder(folderPath) {
  const MIME_BY_EXT = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png' };
  return fs
    .readdirSync(folderPath)
    .filter((name) => MIME_BY_EXT[path.extname(name).toLowerCase()])
    .sort()
    .map((name) => ({
      filename: name,
      mimeType: MIME_BY_EXT[path.extname(name).toLowerCase()],
      buffer: fs.readFileSync(path.join(folderPath, name)),
    }));
}

module.exports = { createRelayServer, readPhotoFolder, ITEM_ID_LENGTH };

// Standalone dev mode: `node relayServer.js` (or `npm run relay:standalone`).
// Starts the server, then lets you trigger broadcasts by typing a folder path
// + Enter on stdin — mirrors what a reveal hotkey does in the real app,
// without needing Electron.
if (require.main === module) {
  const port = Number(process.env.RELAY_PORT) || 8787;
  const token = process.env.RELAY_TOKEN || 'dev-secret';

  const server = createRelayServer({ port, token, onLog: (msg) => console.log(`[relay] ${msg}`) });
  console.log(`[relay] listening on ws://localhost:${port} (token=${token})`);
  console.log('[relay] type a folder path + Enter to broadcast every photo in it, or Ctrl+C to quit');

  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (line) => {
    const folderPath = line.trim();
    if (!folderPath) return;
    try {
      const items = readPhotoFolder(folderPath);
      if (items.length === 0) {
        console.log(`[relay] no photos found in ${folderPath}`);
        return;
      }
      server.broadcastRevealBatch(items);
    } catch (err) {
      console.log(`[relay] failed to read ${folderPath}: ${err.message}`);
    }
  });
}
