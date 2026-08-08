'use strict';

const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const { authenticateConnection } = require('./auth');
const {
  buildRevealFrames,
  BatchReassembler,
  ITEM_ID_LENGTH,
  REALTIME_PATH,
  MAX_REALTIME_FRAME_BYTES,
  PRESENTER_ONLY,
  parseBriefMessage,
  stampPresenter,
} = require('./protocol');

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

// The realtime equivalent. Three orders of magnitude smaller because the
// frames are: at 0.8 KB/s per presenter, 256 KB queued means roughly five
// minutes behind. That client is not slow, it is gone.
const MAX_REALTIME_BUFFERED_BYTES = 256 * 1024;

function createRelayServer({ port, token, onLog = () => {}, onClientsChanged = () => {}, onBrief = null }) {
  // ONE http server, TWO websocket servers routed by path on upgrade.
  //
  // Not a refactor for its own sake: Tailscale Funnel forwards exactly one
  // port, so the realtime socket brief mode needs cannot be a second listener
  // — it has to share this one. Splitting by path also makes head-of-line
  // blocking impossible, which is the real prize: a 3 MB photo in flight on
  // the bulk socket can never delay a 26-byte stroke on the realtime one.
  const httpServer = http.createServer((req, res) => {
    // Anything that is not an upgrade gets an honest answer. This is not a
    // web server and must never look like one.
    res.writeHead(426, { 'Content-Type': 'text/plain', Connection: 'close' });
    res.end('WebSocket only\n');
  });

  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_BYTES });
  // No permessage-deflate on the realtime socket. Compressing 26 bytes costs
  // more in latency than it saves in bytes, and latency is the whole point.
  const rtServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_REALTIME_FRAME_BYTES,
    perMessageDeflate: false,
  });

  // ws -> { role, callsign, connectedAt } for every authenticated client —
  // identity kept so SETUP can show who's connected and so
  // rebroadcasts can be attributed to their sender.
  const clients = new Map();
  // The realtime half. Separate map: a pilot on an older build has a bulk
  // socket and no realtime one, and must keep working exactly as before.
  const rtClients = new Map();
  // Host-only presenting in v1, but identity is carried from day one so
  // handing the pen to a callsign later is one new message, not a redesign.
  let presenter = null;

  httpServer.on('error', (err) => onLog(`server error: ${err.message}`));
  wss.on('error', (err) => onLog(`server error: ${err.message}`));
  rtServer.on('error', (err) => onLog(`realtime error: ${err.message}`));

  httpServer.on('upgrade', (req, socket, head) => {
    const route = (req.url || '/').split('?')[0];
    const target = route === REALTIME_PATH ? rtServer : route === '/' ? wss : null;
    if (!target) {
      // An unknown path is answered rather than dropped silently, so a
      // misconfigured client reports something useful instead of hanging.
      socket.write('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      socket.destroy();
      return;
    }
    target.handleUpgrade(req, socket, head, (ws) => target.emit('connection', ws, req));
  });

  httpServer.listen(port);

  rtServer.on('connection', (ws, req) => attachRealtime(ws, req));

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

  // -------------------------------------------------------------------------
  // Realtime socket. Same token, same auth handshake — a second socket must
  // not be a second way in.
  // -------------------------------------------------------------------------

  function attachRealtime(ws) {
    let callsign = null;
    const preAuthQueue = [];
    let authed = false;

    // Same reasoning as the bulk socket: attach the listener before auth
    // resolves, because ws can emit already-buffered frames synchronously.
    ws.on('message', (data, isBinary) => {
      if (isBinary) return; // the realtime socket is JSON only
      if (!authed) {
        if (preAuthQueue.length < 200) preAuthQueue.push(data);
        return;
      }
      handleRealtimeFrame(ws, callsign, data);
    });

    authenticateConnection(ws, token, { onLog })
      .then((authMsg) => {
        callsign = authMsg.callsign || '';
        rtClients.set(ws, { callsign, connectedAt: Date.now() });

        authed = true;
        for (const data of preAuthQueue) handleRealtimeFrame(ws, callsign, data);
        preAuthQueue.length = 0;

        // A late joiner needs to know a brief is already running, and on which
        // image, before it can ask for the ink. Without this it sits blank
        // until the presenter happens to turn a page.
        if (presenter) {
          send(ws, { type: 'brief-present-start', presenter });
          if (presenter.focus) send(ws, { ...presenter.focus, presenter: presenter.callsign });
        }

        ws.on('close', () => {
          rtClients.delete(ws);
          // A presenter whose socket drops stops presenting. The honest
          // answer, and the one the UI states: they re-present.
          if (presenter && presenter.ws === ws) stopPresenting('the presenter disconnected');
        });
      })
      .catch((err) => onLog(`realtime auth failed: ${err.message}`));
  }

  function handleRealtimeFrame(ws, callsign, data) {
    const msg = parseBriefMessage(data);
    if (!msg) return; // malformed or unknown — never forwarded

    if (msg.type === 'brief-present-start') {
      presenter = { ws, callsign, focus: null };
      onLog(`brief: ${callsign || '(none)'} is presenting`);
      fanOutRealtime(stampPresenter(msg, callsign), ws);
      if (onBrief) onBrief(stampPresenter(msg, callsign));
      return;
    }

    // Everything else that drives what other pilots see must come from the
    // client we currently recognise as the presenter — checked by socket
    // identity, not by the callsign in the frame, which the sender controls.
    if (PRESENTER_ONLY.has(msg.type)) {
      if (!presenter || presenter.ws !== ws) return;
      if (msg.type === 'brief-present-stop') {
        stopPresenting(`${callsign || '(none)'} stopped presenting`);
        return;
      }
      if (msg.type === 'brief-focus') presenter.focus = msg;
    }

    const stamped = stampPresenter(msg, callsign);
    // A snapshot request is a question for the host, not something to echo at
    // every pilot on the net.
    if (msg.type === 'brief-snapshot-req') {
      if (onBrief) onBrief(stamped, (reply) => send(ws, reply));
      return;
    }

    // NOT back to the sender. This is the one place the realtime path differs
    // from the bulk path above, and deliberately: a reveal is echoed to its
    // sharer because that echo IS their render path. A brief message is not —
    // every client applies its own the instant the pilot makes it, because a
    // presenter watching their own line lag 30-80ms behind the pen would stop
    // trusting the tool. So an echo here is not confirmation, it is the same
    // message applied twice.
    //
    // On a host that is doubly true: hosting also runs a client against its
    // own relay (that loopback is how the host hears everyone else's brief),
    // so without this the host applied every message it sent, twice more.
    // Harmless for a shape, which upserts; a stroke APPENDS, and a card
    // REPLACES — the host took back the card it had just cast, which reset
    // the steps they had already ticked off.
    fanOutRealtime(stamped, ws);
    if (onBrief) onBrief(stamped);
  }

  function stopPresenting(why) {
    if (!presenter) return;
    const who = presenter.callsign;
    presenter = null;
    onLog(`brief: ${why}`);
    fanOutRealtime({ type: 'brief-present-stop', presenter: who });
    if (onBrief) onBrief({ type: 'brief-present-stop', presenter: who });
  }

  /**
   * Fan-out on the realtime socket. Same backpressure ceiling as the bulk
   * path and for the same reason, but the numbers are different by orders of
   * magnitude: a client this far behind on 26-byte frames is not slow, it is
   * gone, and dropping frames for it is the only thing that keeps the host
   * from buffering for a socket that is never coming back.
   */
  function fanOutRealtime(msg, except = null) {
    const text = JSON.stringify(msg);
    for (const [ws, info] of rtClients) {
      if (ws === except) continue;
      if (ws.readyState !== ws.OPEN) continue;
      if (ws.bufferedAmount > MAX_REALTIME_BUFFERED_BYTES) {
        onLog(`realtime: dropping frame for ${info.callsign || '(none)'} (${ws.bufferedAmount}B queued)`);
        continue;
      }
      ws.send(text);
    }
  }

  function send(ws, msg) {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  }

  /** What the local (host's own) UI sends into the brief. */
  function broadcastBrief(msg) {
    const stamped = stampPresenter(msg, msg.presenter || '');
    if (msg.type === 'brief-present-start') presenter = { ws: null, callsign: stamped.presenter, focus: null };
    if (msg.type === 'brief-present-stop') presenter = null;
    if (msg.type === 'brief-focus' && presenter) presenter.focus = stamped;
    fanOutRealtime(stamped);
  }

  function getPresenter() {
    return presenter ? presenter.callsign : null;
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
   * Closes the server. Terminating the sockets is not optional: closing a
   * WebSocketServer only stops it accepting, and leaves established clients
   * connected to an object nothing will ever broadcast through again.
   *
   * The port now belongs to the http server, so that is what `done` has to
   * wait on — waiting on wss.close() alone would fire while the listener was
   * still bound, and a live settings apply restarting the relay on the same
   * port would hit EADDRINUSE intermittently.
   */
  function close(done = () => {}) {
    for (const ws of wss.clients) ws.terminate();
    for (const ws of rtServer.clients) ws.terminate();
    presenter = null;
    wss.close(() => {
      rtServer.close(() => httpServer.close(done));
    });
  }

  return {
    broadcastRevealBatch,
    getConnectedClients,
    broadcastBrief,
    getPresenter,
    close,
    wss,
    rtServer,
    httpServer,
  };
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
