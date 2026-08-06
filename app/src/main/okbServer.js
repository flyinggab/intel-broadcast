'use strict';

// Serves the EFB's renderer files over loopback HTTP so OpenKneeboard's
// WebView2 can load them as a web dashboard tab.
//
// Electron loads the same files over file:// in its own window. WebView2 is a
// separate browser in a separate process and cannot reach into our bundle, so
// the page has to be served. Note what this changes and what it does not: the
// SAME viewer.html renders in both, from the same CSS and the same JS. There
// is no second UI to keep in step — okb-bridge.js detects which surface it is
// on and adapts, which is what `data-surface` was always for.
//
// THE TRANSPORT. WebView2 has no Electron preload, so the page cannot reach
// main the way the Electron window does. Three things cross that boundary and
// all three ride this server:
//
//   GET  /blob/<sha256>   photo bytes, by content hash and nothing else
//   WS   /ws              state snapshots down, intents and ink up
//
// The page is the SAME viewer.html; okb-bridge.js installs a `window.viewerAPI`
// backed by that socket, so viewer.js cannot tell which surface it is on.
//
// SECURITY POSTURE. This binds 127.0.0.1 only, never 0.0.0.0: it must not
// become a way onto this machine from the tailnet, which is emphatically not
// what the funnel is forwarding. It serves a fixed allow-list of static files
// under the renderer directory, plus blobs addressed BY HASH ONLY — a 64-hex
// name that the caller cannot turn into a path. No directory listing, no
// traversal, no upload.
//
// What it does mean: any process on this machine can read the photos and
// drive the app while the dashboard is enabled. That is a real widening and
// it is the price of the native path; the mitigation is that it is loopback,
// off by a toggle, and carries nothing the local user could not already read
// off disk.

const fs = require('fs');
const http = require('http');
const path = require('path');
const WebSocket = require('ws');

const RENDERER_DIR = path.join(__dirname, '..', 'renderer');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
};

/**
 * Resolves a request path to a real file inside RENDERER_DIR, or null.
 *
 * Exported so a test can hammer it with traversal attempts without opening a
 * socket. The check is on the RESOLVED path, not the raw string: `..%2f`,
 * double-encoding and symlink-shaped inputs all collapse to a real path
 * first, and only then is it required to be inside the directory.
 */
function resolveSafe(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent((urlPath || '/').split('?')[0]);
  } catch {
    return null; // malformed percent-encoding
  }
  if (decoded.includes('\0')) return null;
  if (decoded === '/' || decoded === '') decoded = '/viewer.html';

  const full = path.resolve(RENDERER_DIR, `.${path.posix.normalize(decoded)}`);
  const rel = path.relative(RENDERER_DIR, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  if (!TYPES[path.extname(full).toLowerCase()]) return null;
  return full;
}

/** `/blob/<64 hex>` and nothing else. Deliberately not a path: the only thing
 *  a caller can ask for is a content hash it already knows. */
const BLOB_RE = /^\/blob\/([0-9a-f]{64})$/;

function createOkbServer({
  port = 8788,
  onLog = () => {},
  blobs = null,
  onIntent = () => {},
  getSnapshot = () => null,
} = {}) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
    }

    const blobMatch = BLOB_RE.exec((req.url || '').split('?')[0]);
    if (blobMatch) {
      const entry = blobs && blobs.get(blobMatch[1]);
      if (!entry) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        return res.end('not found\n');
      }
      res.writeHead(200, {
        'Content-Type': entry.mimeType,
        // Content-addressed: the bytes at a hash can never change, so this is
        // the one thing here that is safe to cache hard.
        'Cache-Control': 'public, max-age=31536000, immutable',
        'X-Content-Type-Options': 'nosniff',
      });
      if (req.method === 'HEAD') return res.end();
      return res.end(entry.buffer);
    }

    const file = resolveSafe(req.url);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      return res.end('not found\n');
    }
    res.writeHead(200, {
      'Content-Type': TYPES[path.extname(file).toLowerCase()],
      // The renderer changes with every build and this is loopback: caching
      // buys nothing and costs a confusing stale page after an update.
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    });
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).pipe(res);
  });

  // State down, intents up. One socket, same snapshots the Electron window
  // gets — there is no second shape of state to keep in step.
  //
  // Attached only AFTER the port is ours. Constructing it against a server
  // that then fails to bind gives a WebSocketServer with no 'error' listener,
  // and an unhandled 'error' on an EventEmitter throws — which took down the
  // second of two instances on one machine, a completely normal thing to run.
  let wss = null;

  function attachSocket() {
    wss = new WebSocket.Server({ server, path: '/ws' });
    // Never let a socket-level failure reach the app.
    wss.on('error', (err) => onLog(`dashboard socket error: ${err.message}`));
    wss.on('connection', (ws) => {
      onLog('dashboard connected');
      // A tab can be added, or OpenKneeboard restarted, at any moment. Send
      // the current state immediately rather than leaving the page on STANDBY
      // until something happens to change.
      try {
        const snapshot = getSnapshot();
        if (snapshot) ws.send(JSON.stringify({ type: 'state', snapshot }));
      } catch (err) {
        onLog(`could not send the opening snapshot: ${err.message}`);
      }
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(data.toString());
        } catch {
          return; // not ours to police
        }
        if (msg && msg.type === 'intent' && typeof msg.intent === 'string') {
          onIntent(msg.intent, msg.payload);
        }
      });
      ws.on('close', () => onLog('dashboard disconnected'));
      ws.on('error', () => {});
    });
  }

  /** Fans one message to every dashboard tab. Silent when there are none. */
  function send(message) {
    if (!wss || !wss.clients.size) return;
    const text = JSON.stringify(message);
    for (const ws of wss.clients) {
      if (ws.readyState === WebSocket.OPEN) ws.send(text);
    }
  }

  // Whether we actually got the port. A second instance on the same machine
  // will not — two dev instances, or a squadmate testing two copies, is a
  // normal thing to do — and it must fail as a clean "not this instance"
  // rather than as a broken app. The port cannot simply be reassigned:
  // OpenKneeboard stores the tab's URI when the pilot adds it, so a moving
  // port would break their saved tab on the next flight.
  const ready = new Promise((resolve) => {
    server.once('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        onLog(`port ${port} is already in use — another Tac Link is serving the dashboard`);
      } else {
        onLog(`dashboard server error: ${err.message}`);
      }
      resolve(false);
    });
    // Loopback only. See the note at the top of this file.
    server.listen(port, '127.0.0.1', () => {
      attachSocket();
      onLog(`dashboard on http://127.0.0.1:${port}/viewer.html`);
      resolve(true);
    });
  });
  // Errors after startup must never take the app down with them.
  server.on('error', (err) => onLog(`dashboard server error: ${err.message}`));

  return {
    server,
    ready,
    url: `http://127.0.0.1:${port}/viewer.html`,
    pushState: (snapshot) => send({ type: 'state', snapshot }),
    pushInk: (delta) => send({ type: 'ink', delta }),
    pushInkSnapshot: (snap) => send({ type: 'ink-snapshot', snapshot: snap }),
    clientCount: () => (wss ? wss.clients.size : 0),
    close: (done = () => {}) => {
      if (wss) for (const ws of wss.clients) ws.terminate();
      // Never listened (the port was taken) — closing would error, and there
      // is nothing to close.
      if (!server.listening) return done();
      server.close(done);
    },
  };
}

module.exports = { createOkbServer, resolveSafe, RENDERER_DIR, TYPES, BLOB_RE };
