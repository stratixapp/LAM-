// ============================================================
// LAM LAN Sync Engine v1 — WebRTC DataChannel peer-to-peer sync
// Two devices on same WiFi sync data directly — no internet needed.
// Signaling via BroadcastChannel (same device) or manual QR code
// exchange for cross-device. Full conflict resolution (LWW).
// ============================================================

const LAMLAN = (() => {

  // ── Configuration ─────────────────────────────────────────
  const PEER_ID_KEY    = 'lam_peer_id';
  const SIGNAL_CHANNEL = 'lam_lan_signal';
  const CHUNK_SIZE     = 65536; // 64KB chunks for large data transfers
  const HEARTBEAT_MS   = 5000;

  // ── State ─────────────────────────────────────────────────
  let _peerId      = null;
  let _peers       = new Map(); // peerId → { conn, channel, state, lastSeen }
  let _signalCh    = null;
  let _onPeer      = null;
  let _onData      = null;
  let _onSync      = null;
  let _heartbeatId = null;
  let _pendingChunks = new Map(); // transferId → { chunks, total, meta }

  // ICE servers — using only free STUN (no TURN needed on LAN)
  const ICE_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
    iceTransportPolicy: 'all',
  };

  // ── Peer ID ───────────────────────────────────────────────
  function _getPeerId() {
    if (_peerId) return _peerId;
    let id = localStorage.getItem(PEER_ID_KEY);
    if (!id) {
      id = 'LAM-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).slice(2,6).toUpperCase();
      localStorage.setItem(PEER_ID_KEY, id);
    }
    _peerId = id;
    return id;
  }

  // ── Signaling (same-device tabs via BroadcastChannel) ────
  // For cross-device: QR code carries the offer SDP which is scanned on the other device

  function _getSignalChannel() {
    if (!_signalCh) {
      _signalCh = new BroadcastChannel(SIGNAL_CHANNEL);
      _signalCh.onmessage = (e) => _handleSignal(e.data);
    }
    return _signalCh;
  }

  function _signal(msg) {
    try { _getSignalChannel().postMessage({ ...msg, from: _getPeerId() }); } catch {}
  }

  async function _handleSignal(msg) {
    if (!msg || msg.from === _getPeerId()) return;
    const { type, from, to, sdp, candidate } = msg;

    if (to && to !== _getPeerId()) return; // not for us

    if (type === 'discover') {
      // Someone is looking for peers — announce ourselves
      _signal({ type: 'announce', deviceName: _getDeviceName() });
    }

    if (type === 'announce') {
      // Track discovered peers
      _onPeer?.({ peerId: from, deviceName: msg.deviceName, type: 'discovered' });
    }

    if (type === 'offer') {
      await _handleOffer(from, sdp);
    }

    if (type === 'answer') {
      const peer = _peers.get(from);
      if (peer?.conn) {
        await peer.conn.setRemoteDescription({ type: 'answer', sdp });
      }
    }

    if (type === 'ice') {
      const peer = _peers.get(from);
      if (peer?.conn && candidate) {
        await peer.conn.addIceCandidate(candidate).catch(() => {});
      }
    }
  }

  // ── WebRTC Connection ─────────────────────────────────────

  async function _createConnection(targetPeerId) {
    const conn    = new RTCPeerConnection(ICE_CONFIG);
    const channel = conn.createDataChannel('lam-sync', {
      ordered:  true,
      protocol: 'lam-v1',
    });

    _setupDataChannel(channel, targetPeerId);
    _peers.set(targetPeerId, { conn, channel, state: 'connecting', lastSeen: Date.now() });

    conn.onicecandidate = (e) => {
      if (e.candidate) {
        _signal({ type: 'ice', to: targetPeerId, candidate: e.candidate });
      }
    };

    conn.onconnectionstatechange = () => {
      const peer = _peers.get(targetPeerId);
      if (peer) peer.state = conn.connectionState;

      if (conn.connectionState === 'disconnected' || conn.connectionState === 'failed') {
        _peers.delete(targetPeerId);
        _onPeer?.({ peerId: targetPeerId, type: 'disconnected' });
      }
    };

    return conn;
  }

  async function _handleOffer(fromPeerId, sdp) {
    const conn = new RTCPeerConnection(ICE_CONFIG);

    conn.ondatachannel = (e) => {
      const channel = e.channel;
      _setupDataChannel(channel, fromPeerId);
      _peers.set(fromPeerId, { conn, channel, state: 'connected', lastSeen: Date.now() });
      _onPeer?.({ peerId: fromPeerId, type: 'connected' });
    };

    conn.onicecandidate = (e) => {
      if (e.candidate) {
        _signal({ type: 'ice', to: fromPeerId, candidate: e.candidate });
      }
    };

    conn.onconnectionstatechange = () => {
      if (conn.connectionState === 'disconnected' || conn.connectionState === 'failed') {
        _peers.delete(fromPeerId);
        _onPeer?.({ peerId: fromPeerId, type: 'disconnected' });
      }
    };

    await conn.setRemoteDescription({ type: 'offer', sdp });
    const answer = await conn.createAnswer();
    await conn.setLocalDescription(answer);
    _signal({ type: 'answer', to: fromPeerId, sdp: answer.sdp });

    _peers.set(fromPeerId, { conn, channel: null, state: 'connecting', lastSeen: Date.now() });
  }

  // ── Data channel protocol ─────────────────────────────────

  function _setupDataChannel(channel, peerId) {
    channel.binaryType = 'arraybuffer';

    channel.onopen = () => {
      const peer = _peers.get(peerId);
      if (peer) { peer.channel = channel; peer.state = 'connected'; peer.lastSeen = Date.now(); }
      _onPeer?.({ peerId, type: 'connected' });
      // Request sync on connect
      _sendMessage(peerId, { type: 'sync_request', collections: _getSyncCollections() });
    };

    channel.onmessage = (e) => _handleMessage(peerId, e.data);

    channel.onclose = () => {
      _peers.delete(peerId);
      _onPeer?.({ peerId, type: 'disconnected' });
    };

    channel.onerror = (e) => {
      console.warn('LAM LAN channel error:', e);
    };
  }

  async function _handleMessage(peerId, raw) {
    const peer = _peers.get(peerId);
    if (peer) peer.lastSeen = Date.now();

    let msg;
    try {
      if (raw instanceof ArrayBuffer) {
        // Binary chunk for large transfer
        msg = _handleChunk(raw, peerId);
        if (!msg) return;
      } else {
        msg = JSON.parse(raw);
      }
    } catch { return; }

    switch (msg.type) {

      case 'sync_request': {
        // Peer wants our data — send all requested collections
        const collections = msg.collections || [];
        for (const col of collections) {
          const records = await _getCollectionData(col);
          if (records.length) {
            await _sendLargeData(peerId, { type: 'sync_data', collection: col, records });
          }
        }
        break;
      }

      case 'sync_data': {
        // Received data from peer — merge with conflict resolution
        const { collection, records } = msg;
        await _mergeRecords(collection, records);
        _onSync?.({ peerId, collection, count: records.length, type: 'received' });
        break;
      }

      case 'write': {
        // A single record was written on the peer — apply locally
        const { collection, record } = msg;
        await _applyRemoteWrite(collection, record);
        _onData?.({ peerId, collection, record, type: 'write' });
        break;
      }

      case 'delete': {
        const { collection, id } = msg;
        await _applyRemoteDelete(collection, id);
        _onData?.({ peerId, collection, id, type: 'delete' });
        break;
      }

      case 'heartbeat': {
        _sendMessage(peerId, { type: 'heartbeat_ack', peerId: _getPeerId() });
        break;
      }

      case 'heartbeat_ack': break;

      case 'chunk_start': {
        _pendingChunks.set(msg.transferId, {
          chunks: new Array(msg.totalChunks),
          received: 0,
          total: msg.totalChunks,
          meta: msg.meta,
        });
        break;
      }
    }
  }

  // ── Chunked transfer for large datasets ──────────────────

  function _handleChunk(buffer, peerId) {
    const view       = new DataView(buffer);
    const transferId = view.getUint32(0).toString(16).padStart(8,'0');
    const chunkIdx   = view.getUint32(4);
    const payload    = buffer.slice(8);

    const transfer = _pendingChunks.get(transferId);
    if (!transfer) return null;

    transfer.chunks[chunkIdx] = payload;
    transfer.received++;

    if (transfer.received === transfer.total) {
      _pendingChunks.delete(transferId);
      // Reassemble
      const totalLen = transfer.chunks.reduce((s, c) => s + c.byteLength, 0);
      const full     = new Uint8Array(totalLen);
      let offset     = 0;
      transfer.chunks.forEach(c => { full.set(new Uint8Array(c), offset); offset += c.byteLength; });
      const text = new TextDecoder().decode(full);
      return JSON.parse(text);
    }
    return null;
  }

  async function _sendLargeData(peerId, data) {
    const peer = _peers.get(peerId);
    if (!peer?.channel || peer.channel.readyState !== 'open') return;

    const json  = JSON.stringify(data);
    const bytes = new TextEncoder().encode(json);

    if (bytes.length <= CHUNK_SIZE) {
      // Small enough to send directly
      peer.channel.send(json);
      return;
    }

    // Chunked transfer
    const transferId  = Math.floor(Math.random() * 0xFFFFFFFF);
    const totalChunks = Math.ceil(bytes.length / CHUNK_SIZE);

    peer.channel.send(JSON.stringify({
      type:       'chunk_start',
      transferId: transferId.toString(16).padStart(8,'0'),
      totalChunks,
      byteLength: bytes.length,
      meta:       { type: data.type, collection: data.collection },
    }));

    for (let i = 0; i < totalChunks; i++) {
      const chunk  = bytes.slice(i * CHUNK_SIZE, (i+1) * CHUNK_SIZE);
      const header = new ArrayBuffer(8);
      const view   = new DataView(header);
      view.setUint32(0, transferId);
      view.setUint32(4, i);

      const packet = new Uint8Array(8 + chunk.length);
      packet.set(new Uint8Array(header), 0);
      packet.set(chunk, 8);

      // Rate limit to avoid overwhelming the channel
      if (i > 0 && i % 10 === 0) await new Promise(r => setTimeout(r, 10));
      peer.channel.send(packet.buffer);
    }
  }

  function _sendMessage(peerId, msg) {
    const peer = _peers.get(peerId);
    if (!peer?.channel || peer.channel.readyState !== 'open') return;
    try { peer.channel.send(JSON.stringify(msg)); } catch {}
  }

  // ── Conflict resolution (Last Write Wins by updatedAt) ───

  async function _mergeRecords(collection, remoteRecords) {
    const db = window.LAMDB;
    if (!db) return;

    for (const remote of remoteRecords) {
      try {
        const local = await db.dbGet(collection, remote.id);

        if (!local) {
          // New record from peer — just write it
          await db.dbSet(collection, remote.id, remote);
        } else {
          // Both exist — use updatedAt to resolve conflict
          const localTs  = new Date(local.updatedAt  || 0).getTime();
          const remoteTs = new Date(remote.updatedAt || 0).getTime();
          if (remoteTs > localTs) {
            await db.dbSet(collection, remote.id, remote);
          }
          // If local is newer, keep local (do nothing)
        }
      } catch (e) {
        console.warn(`LAM LAN: merge error for ${collection}/${remote.id}:`, e);
      }
    }
  }

  async function _applyRemoteWrite(collection, record) {
    const db = window.LAMDB;
    if (!db || !record?.id) return;
    await db.dbSet(collection, record.id, record);
  }

  async function _applyRemoteDelete(collection, id) {
    const db = window.LAMDB;
    if (!db || !id) return;
    await db.dbDelete(collection, id);
  }

  // ── Data helpers ──────────────────────────────────────────

  function _getSyncCollections() {
    // Collections worth syncing over LAN — exclude huge/sensitive ones by default
    return [
      'trips','fleet','drivers','delivery_notes','grns','inventory',
      'products','customers','vendors','employees','attendance',
      'invoices','dispatch','warehouse',
    ];
  }

  async function _getCollectionData(col) {
    const db = window.LAMDB;
    if (!db) return [];
    try {
      return await db.dbGetAll(col);
    } catch { return []; }
  }

  function _getDeviceName() {
    const ua  = navigator.userAgent;
    if (/Android/i.test(ua)) return 'Android Device';
    if (/iPhone|iPad/i.test(ua)) return 'iOS Device';
    if (/Windows/i.test(ua)) return 'Windows PC';
    if (/Mac/i.test(ua)) return 'Mac';
    return 'Unknown Device';
  }

  // ── Public API ────────────────────────────────────────────

  /**
   * Start LAN sync — discover peers and listen for connections
   * @param {Object} opts
   * @param {Function} opts.onPeer   - callback({ peerId, type: 'discovered'|'connected'|'disconnected' })
   * @param {Function} opts.onData   - callback({ peerId, collection, record, type: 'write'|'delete' })
   * @param {Function} opts.onSync   - callback({ peerId, collection, count })
   */
  function start(opts = {}) {
    _onPeer = opts.onPeer;
    _onData = opts.onData;
    _onSync = opts.onSync;

    _getSignalChannel(); // Initialize

    // Discover peers
    _signal({ type: 'discover', deviceName: _getDeviceName() });

    // Heartbeat
    _heartbeatId = setInterval(() => {
      _peers.forEach((peer, peerId) => {
        if (Date.now() - peer.lastSeen > HEARTBEAT_MS * 3) {
          _peers.delete(peerId);
          opts.onPeer?.({ peerId, type: 'disconnected' });
        } else {
          _sendMessage(peerId, { type: 'heartbeat' });
        }
      });
      // Re-announce presence
      _signal({ type: 'announce', deviceName: _getDeviceName() });
    }, HEARTBEAT_MS);
  }

  function stop() {
    clearInterval(_heartbeatId);
    _peers.forEach((peer) => {
      try { peer.channel?.close(); peer.conn?.close(); } catch {}
    });
    _peers.clear();
    _signalCh?.close();
    _signalCh = null;
  }

  /**
   * Connect to a specific peer by ID
   * @param {string} targetPeerId
   */
  async function connectTo(targetPeerId) {
    if (_peers.has(targetPeerId)) return; // Already connected

    const conn   = await _createConnection(targetPeerId);
    const offer  = await conn.createOffer();
    await conn.setLocalDescription(offer);

    // Wait for ICE gathering
    await new Promise(resolve => {
      if (conn.iceGatheringState === 'complete') { resolve(); return; }
      conn.onicegatheringstatechange = () => {
        if (conn.iceGatheringState === 'complete') resolve();
      };
      setTimeout(resolve, 3000); // max 3s for ICE gathering
    });

    _signal({ type: 'offer', to: targetPeerId, sdp: conn.localDescription.sdp });
  }

  /**
   * Generate a connection QR code for cross-device pairing
   * (The QR encodes an offer SDP which the other device scans to connect)
   */
  async function generatePairingCode() {
    const tempConn = new RTCPeerConnection(ICE_CONFIG);
    tempConn.createDataChannel('pair');
    const offer = await tempConn.createOffer();
    await tempConn.setLocalDescription(offer);

    await new Promise(resolve => {
      if (tempConn.iceGatheringState === 'complete') { resolve(); return; }
      tempConn.onicegatheringstatechange = () => {
        if (tempConn.iceGatheringState === 'complete') resolve();
      };
      setTimeout(resolve, 4000);
    });

    const pairingData = JSON.stringify({
      peerId: _getPeerId(),
      sdp:    tempConn.localDescription.sdp,
      device: _getDeviceName(),
    });

    // Generate QR using LAMScanner if available
    if (window.LAMScanner?.generateQRSVG) {
      return {
        qrSvg: window.LAMScanner.generateQRSVG(pairingData, { size: 240 }),
        pairingData,
        conn: tempConn,
      };
    }
    return { pairingData, conn: tempConn };
  }

  /**
   * Broadcast a write to all connected peers immediately
   * Hook this into firebase.js write operations
   */
  function broadcastWrite(collection, record) {
    _peers.forEach((peer, peerId) => {
      if (peer.channel?.readyState === 'open') {
        _sendMessage(peerId, { type: 'write', collection, record });
      }
    });
  }

  function broadcastDelete(collection, id) {
    _peers.forEach((peer, peerId) => {
      if (peer.channel?.readyState === 'open') {
        _sendMessage(peerId, { type: 'delete', collection, id });
      }
    });
  }

  /**
   * Force full sync with all connected peers
   */
  async function syncAll() {
    const collections = _getSyncCollections();
    _peers.forEach((peer, peerId) => {
      if (peer.channel?.readyState === 'open') {
        _sendMessage(peerId, { type: 'sync_request', collections });
      }
    });
  }

  function getPeers() {
    const result = [];
    _peers.forEach((peer, peerId) => {
      result.push({
        peerId,
        state:    peer.state,
        lastSeen: peer.lastSeen,
      });
    });
    return result;
  }

  function getMyPeerId() { return _getPeerId(); }

  function isConnected() { return _peers.size > 0; }

  return {
    start,
    stop,
    connectTo,
    generatePairingCode,
    broadcastWrite,
    broadcastDelete,
    syncAll,
    getPeers,
    getMyPeerId,
    isConnected,
  };

})();

window.LAMLAN = LAMLAN;
