'use strict';

const { WebSocketServer } = require('ws');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { authenticateConnection } = require('./auth');

const ITEM_ID_LENGTH = 36; // ASCII UUID prefix on each binary frame

/**
 * Starts the embedded relay: a WebSocket server that authenticates connections
 * with a shared token, then fans out `reveal-batch` broadcasts (one JSON text
 * frame + one binary frame per item) to every currently-connected client.
 *
 * Only the process holding this server ever originates a broadcast — it's
 * called in-process by gmHotkey.js in Electron, or via the standalone dev CLI
 * below when testing without Electron.
 */
function createRelayServer({ port, token, onLog = () => {} }) {
  const wss = new WebSocketServer({ port });
  const clients = new Set();

  wss.on('connection', (ws) => {
    authenticateConnection(ws, token)
      .then((authMsg) => {
        clients.add(ws);
        onLog(`client connected: role=${authMsg.role} callsign=${authMsg.callsign || '(none)'}`);
        ws.on('close', () => {
          clients.delete(ws);
          onLog(`client disconnected: role=${authMsg.role} callsign=${authMsg.callsign || '(none)'}`);
        });
      })
      .catch((err) => {
        onLog(`auth failed: ${err.message}`);
      });
  });

  /**
   * items: [{ filename, mimeType, buffer }]
   */
  function broadcastRevealBatch(items, { sourceType = 'prebundled' } = {}) {
    const batchId = crypto.randomUUID();
    const itemsWithIds = items.map((item) => ({
      itemId: crypto.randomUUID(),
      filename: item.filename,
      mimeType: item.mimeType,
      byteLength: item.buffer.length,
      sha256: crypto.createHash('sha256').update(item.buffer).digest('hex'),
    }));

    const metaFrame = JSON.stringify({
      type: 'reveal-batch',
      batchId,
      count: items.length,
      sourceType,
      ts: new Date().toISOString(),
      items: itemsWithIds,
    });

    const binaryFrames = items.map((item, i) => {
      const idBuf = Buffer.from(itemsWithIds[i].itemId, 'ascii');
      return Buffer.concat([idBuf, item.buffer]);
    });

    for (const ws of clients) {
      if (ws.readyState !== ws.OPEN) continue;
      ws.send(metaFrame);
      for (const frame of binaryFrames) ws.send(frame, { binary: true });
    }

    onLog(`broadcast reveal-batch ${batchId}: ${items.length} item(s) to ${clients.size} client(s)`);
    return batchId;
  }

  function close() {
    wss.close();
  }

  return { broadcastRevealBatch, close, wss };
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
// + Enter on stdin — mirrors what gmHotkey.js will do in the real app, without
// needing Electron for Phase 0 testing.
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
