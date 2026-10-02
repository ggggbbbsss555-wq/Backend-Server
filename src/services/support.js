// Support chat service — bridges Web App ↔ admin ↔ Python telegram bot.
//
// Flow:
//   1. Web App user sends a message → POST /api/support/messages
//   2. We store it + try to forward it to the Python telegram bot so the
//      admin sees it in Telegram
//   3. Admin replies via Telegram (Python) → POST /internal/support/message
//      (webhook) → we store it + broadcast via WebSocket to the Web App
//   4. Later: admin dashboard (Firebase) will also read/write these convos

import dataStore from './dataStore.js';
import pythonBridge from './pythonBridge.js';
import logger from '../utils/logger.js';

let broadcastFn = null;
export function setBroadcaster(fn) { broadcastFn = fn; }

export const supportService = {
  // User sends a message from the Web App
  async userMessage(tgUser, { text, image }) {
    const convo = dataStore.getOrCreateConvo(tgUser.id, {
      name: [tgUser.firstName, tgUser.lastName].filter(Boolean).join(' '),
      email: '',
    });
    const msg = dataStore.addMessage(convo.id, {
      from: 'user',
      text: text || '',
      image: image || null,
    });

    // Forward to Python telegram bot so the admin sees it in Telegram
    try {
      await pythonBridge.sendTelegramMessage(0, `💬 New support message from ${convo.userName || tgUser.id}:\n\n${text || '(image)'}`);
    } catch (err) {
      logger.warn('failed to forward user message to telegram bot', { err: err.message });
    }

    // Broadcast to admin dashboard (WebSocket) — they'll see it in real-time
    if (broadcastFn) broadcastFn({ convoId: convo.id, msg, event: 'user_message' });

    return { convo, msg };
  },

  // Admin (via Python telegram bot webhook) replies to a user
  async adminMessage({ tgId, text }) {
    const convo = dataStore.getOrCreateConvo(tgId);
    const msg = dataStore.addMessage(convo.id, { from: 'admin', text });

    if (broadcastFn) broadcastFn({ convoId: convo.id, msg, event: 'admin_message' });

    return { convo, msg };
  },

  // Web App fetches its own conversation
  listMine(tgUser) {
    return dataStore.listConvos(tgUser.id);
  },

  // Admin dashboard fetches all convos
  listAll() {
    return dataStore.listConvos();
  },

  markRead(convoId) {
    return dataStore.markRead(convoId);
  },
};

export default supportService;
