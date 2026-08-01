'use strict';

const { EventEmitter } = require('events');
const WebSocket = require('ws');
const { buildRevealFrames, BatchReassembler } = require('./protocol');

const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 16000, 30000]; // caps at 30s

/**
 * WebSocket client for the relay: authenticates, reassembles incoming
 * reveal-batch fan-outs (via protocol.js), can originate its own reveal
 * upstream (sendRevealBatch — any client may share, the relay fans it out to
 * everyone including the sender), and reconnects with exponential backoff on
 * disconnect. Emits:
 *   - 'connected'
 *   - 'disconnected'
 *   - 'reveal-batch' ({ batchId, sourceType, sharedBy, ts, items: [{filename, mimeType, buffer}] })
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
    this.reassembler = new BatchReassembler();
  }

  connect() {
    this.closedByUser = false;
    this._openSocket();
  }

  close() {
    this.closedByUser = true;
    if (this.ws) this.ws.close();
  }

  get connected() {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /**
   * Sends a reveal batch UP to the relay, which fans it out to every
   * connected client — including this one (the echo is the single render
   * path: what comes back is what everyone sees). Returns the batchId, or
   * null when not connected.
   */
  sendRevealBatch(items, { sourceType = 'prebundled' } = {}) {
    if (!this.connected) return null;
    const { batchId, metaFrame, binaryFrames } = buildRevealFrames(items, {
      sourceType,
      sharedBy: this.callsign || '',
    });
    this.ws.send(metaFrame);
    for (const frame of binaryFrames) this.ws.send(frame, { binary: true });
    return batchId;
  }

  _openSocket() {
    const ws = new WebSocket(this.url);
    this.ws = ws;

    ws.on('open', () => {
      // Optional pre-auth HELLO. v1 has no version field anywhere, so this is
      // what makes any later protocol change safe: a server that doesn't know
      // the frame ignores it, and one that does can negotiate. Costs one
      // frame, unblocks phase 2.
      ws.send(
        JSON.stringify({
          type: 'hello',
          protocolVersion: 1,
          minVersion: 1,
          client: 'taclink-electron',
          capabilities: [],
        }),
      );
      ws.send(JSON.stringify({ type: 'auth', token: this.token, role: this.role, callsign: this.callsign }));
      this.reconnectAttempt = 0;
      this.emit('connected');
    });

    ws.on('message', (data, isBinary) => {
      let batch;
      try {
        batch = this.reassembler.feed(data, isBinary);
      } catch (err) {
        // Cap violation on an incoming fan-out — drop it, stay connected.
        console.error(`[relayClient] dropped incoming batch: ${err.message}`);
        return;
      }
      if (batch) this.emit('reveal-batch', batch);
    });

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
    // The FAULT page shows the attempt count and the countdown, so a pilot can
    // tell "reconnecting" from "hung".
    this.emit('reconnecting', { attempt: this.reconnectAttempt, nextInMs: delay });
    setTimeout(() => {
      if (!this.closedByUser) this._openSocket();
    }, delay);
  }
}

module.exports = { RelayClient };
