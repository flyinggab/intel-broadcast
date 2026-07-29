'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');

const ITEM_ID_LENGTH = 36;
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000]; // caps at 30s

/**
 * WebSocket client for the relay: authenticates, reassembles reveal-batch
 * messages (metadata frame + N binary frames matched by itemId), and
 * reconnects with exponential backoff on disconnect. Emits:
 *   - 'connected'
 *   - 'disconnected'
 *   - 'reveal-batch' ({ batchId, sourceType, ts, items: [{filename, mimeType, buffer}] })
 */
class RelayClient extends EventEmitter {
  constructor({ url, token, role, callsign }) {
    super();
    this.url = url;
    this.token = token;
    this.role = role;
    this.callsign = callsign;
    this.reconnectAttempt = 0;
    this.closedByUser = false;
    this.ws = null;
    this.pendingMeta = null;
    this.pendingBuffers = new Map();
  }

  connect() {
    this.closedByUser = false;
    this._openSocket();
  }

  close() {
    this.closedByUser = true;
    if (this.ws) this.ws.close();
  }

  _openSocket() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: this.token, role: this.role, callsign: this.callsign }));
      this.reconnectAttempt = 0;
      this.emit('connected');
    });

    ws.on('message', (data, isBinary) => this._handleMessage(data, isBinary));

    ws.on('close', () => {
      this.emit('disconnected');
      if (!this.closedByUser) this._scheduleReconnect();
    });

    ws.on('error', () => {
      // 'close' always follows 'error' for ws; avoid double-handling here.
    });
  }

  _scheduleReconnect() {
    const delay = RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt += 1;
    setTimeout(() => {
      if (!this.closedByUser) this._openSocket();
    }, delay);
  }

  _handleMessage(data, isBinary) {
    if (!isBinary) {
      const msg = JSON.parse(data.toString('utf8'));
      if (msg.type === 'reveal-batch') {
        this.pendingMeta = msg;
        this.pendingBuffers = new Map();
      }
      return;
    }

    if (!this.pendingMeta) return; // binary frame with no matching batch in flight, ignore

    const itemId = data.subarray(0, ITEM_ID_LENGTH).toString('ascii');
    const bytes = Buffer.from(data.subarray(ITEM_ID_LENGTH));
    this.pendingBuffers.set(itemId, bytes);

    if (this.pendingBuffers.size === this.pendingMeta.count) {
      const items = this.pendingMeta.items.map((item) => ({
        filename: item.filename,
        mimeType: item.mimeType,
        buffer: this.pendingBuffers.get(item.itemId),
      }));
      this.emit('reveal-batch', {
        batchId: this.pendingMeta.batchId,
        sourceType: this.pendingMeta.sourceType,
        ts: this.pendingMeta.ts,
        items,
      });
      this.pendingMeta = null;
      this.pendingBuffers = new Map();
    }
  }
}

module.exports = { RelayClient };
