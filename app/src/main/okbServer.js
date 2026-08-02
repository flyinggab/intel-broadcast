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
// SECURITY POSTURE. This binds 127.0.0.1 only, never 0.0.0.0: it must not
// become a way onto this machine from the tailnet, which is emphatically not
// what the funnel is forwarding. It serves a fixed allow-list of static files
// under the renderer directory and nothing else — no directory listing, no
// traversal, no upload, no API. Photos are NOT served here; they continue to
// travel over intel:// inside Electron, and reaching them from WebView2 is a
// separate problem that this file deliberately does not pretend to solve.

const fs = require('fs');
const http = require('http');
const path = require('path');

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

function createOkbServer({ port = 8788, onLog = () => {} } = {}) {
  const server = http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' });
      return res.end();
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

  server.on('error', (err) => onLog(`dashboard server error: ${err.message}`));
  // Loopback only. See the note at the top of this file.
  server.listen(port, '127.0.0.1', () => onLog(`dashboard on http://127.0.0.1:${port}/viewer.html`));

  return {
    server,
    url: `http://127.0.0.1:${port}/viewer.html`,
    close: (done = () => {}) => server.close(done),
  };
}

module.exports = { createOkbServer, resolveSafe, RENDERER_DIR, TYPES };
