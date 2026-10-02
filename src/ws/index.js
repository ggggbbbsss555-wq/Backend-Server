// WebSocket server setup.
// Two channels (multiplexed on one WS connection via a "channel" field):
//   - signals : new signal + signal resolved
//   - support : new support message (user or admin)
//
// Auth: client must send { type: 'auth', init_data: '...' } as the first
// message. We verify the Telegram initData and tag the connection with
// the user's tgId.

import { WebSocketServer } from 'ws';
import { verifyInitData } from '../utils/telegram.js';
import { setBroadcaster as setSignalsBroadcaster } from '../services/signals.js';
import { setBroadcaster as setSupportBroadcaster } from '../services/support.js';
import logger from '../utils/logger.js';

let wss = null;

// Map of tgId → Set<ws>  (a user may have multiple tabs open)
const userConnections = new Map();

function attachUser(tgId, ws) {
  if (!userConnections.has(tgId)) userConnections.set(tgId, new Set());
  userConnections.get(tgId).add(ws);
}
function detachUser(tgId, ws) {
  const set = userConnections.get(tgId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) userConnections.delete(tgId);
}

// Broadcast a signals event to ALL connected Web App clients
function broadcastSignal(signal) {
  if (!wss) return;
  const payload = JSON.stringify({ channel: 'signals', data: signal });
  for (const client of wss.clients) {
    if (client.readyState === 1 /* OPEN */ && client._authed) {
      client.send(payload);
    }
  }
}

// Broadcast a support event to the specific user + all admin connections
function broadcastSupport(evt) {
  if (!wss) return;
  const payload = JSON.stringify({ channel: 'support', data: evt });
  // Send to the user who owns this conversation
  const target = evt.convoId?.replace(/^c_/, '');
  if (target) {
    const set = userConnections.get(target);
    if (set) for (const ws of set) if (ws.readyState === 1) ws.send(payload);
  }
  // Also send to all admins (TODO: tag admin connections separately)
  for (const client of wss.clients) {
    if (client.readyState === 1 && client._authed && client._tgId !== target) {
      client.send(payload);
    }
  }
}

export function setupWebSocket(server) {
  wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws, req) => {
    logger.info('ws client connected', { ip: req.socket.remoteAddress });
    ws._authed = false;

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'auth') {
        const result = verifyInitData(msg.init_data);
        if (!result || !result.user) {
          ws.close(4001, 'invalid auth');
          return;
        }
        ws._authed = true;
        ws._tgId = String(result.user.id);
        attachUser(ws._tgId, ws);
        ws.send(JSON.stringify({ channel: 'system', data: { ok: true, message: 'authenticated' } }));
        return;
      }

      // Any other message type is rejected (we don't accept client pushes
      // over WS — they go through the REST API instead).
      if (!ws._authed) ws.close(4001, 'not authed');
    });

    ws.on('close', () => {
      if (ws._tgId) detachUser(ws._tgId, ws);
    });

    ws.on('error', (err) => logger.warn('ws error', { err: err.message }));
  });

  // Wire up the service broadcasters
  setSignalsBroadcaster(broadcastSignal);
  setSupportBroadcaster(broadcastSupport);

  logger.info('WebSocket server ready', { path: '/ws' });
  return wss;
}

export default setupWebSocket;
