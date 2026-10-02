# QuantVexa Backend Server 🌉

Node.js bridge server that connects:

- **Telegram Web App** (the 4 quantvexa pages — `bots` / `chart` / `plans` / `support`) hosted statically on GitHub Pages
- **Python codebase** (one repo, three services):
  - 🕯️ **Candle server** — OHLCV data for the chart page
  - 🤖 **Telegram bot** — receives support messages + sends subscription notifications
  - 📈 **Signals bots** — generate trading signals (Strong/Medium/Pro)
- **Firebase admin dashboard** (later — currently on localStorage)

## 🏗️ Architecture

```
┌──────────────────────────┐         ┌──────────────────────────┐
│  Telegram Web App        │         │  Firebase Admin Dashboard│
│  (4 quantvexa pages,     │         │  (later)                 │
│   static on GitHub Pages)│         │                          │
└────────────┬─────────────┘         └────────────┬─────────────┘
             │ HTTPS REST + WebSocket              │ HTTPS (later)
             ▼                                      ▼
┌─────────────────────────────────────────────────────────────────┐
│              Node.js Backend Server (this repo)                 │
│                                                                 │
│  • REST API for the Web App                                     │
│  • WebSocket for live signals + support chat                    │
│  • Receives webhooks from Python                                │
│  • Talks to Firebase later                                      │
└────────┬──────────────────────────────┬─────────────────────────┘
         │ HTTP internal                │ HTTP internal
         ▼                              ▼
┌─────────────────────────────────────────────────────────────────┐
│              Python Codebase (one repo, 3 services)             │
│                                                                 │
│  1. Candle Server  — /candles/:symbol                           │
│  2. Telegram Bot   — receives user msgs + sends notifications   │
│  3. Signals Bots   — generates signals + bot status             │
└─────────────────────────────────────────────────────────────────┘
```

## 📁 Project structure

```
src/
├── server.js              Entry point — Express + WebSocket
├── config/
│   └── env.js             Centralized env config
├── middleware/
│   ├── cors.js            CORS for Web App origins
│   ├── auth.js            Telegram initData validation
│   ├── internalAuth.js    X-Internal-Secret for Python webhooks
│   └── error.js           Error + 404 handlers
├── routes/                REST API for the Web App
│   ├── auth.js            POST /api/auth/telegram
│   ├── plans.js           GET /api/plans, /api/plans/:id
│   ├── subscriptions.js   POST /api/subscriptions/request, GET /mine, /status
│   ├── signals.js         GET /api/signals, /api/signals/:id
│   ├── candles.js         GET /api/candles/:symbol, /api/symbols
│   ├── support.js         GET /api/support/convos, POST /messages
│   ├── bots.js            GET /api/bots/strategies, /platforms, /status
│   └── admin.js           Admin dashboard endpoints (approve/reject, etc.)
├── services/
│   ├── pythonBridge.js    HTTP client to the 3 Python services
│   ├── dataStore.js       In-memory store (swap for Postgres/Firestore later)
│   ├── plans.js           Plan catalog (Basic/Pro/Elite, locked prices)
│   ├── subscriptions.js   Payment-request workflow
│   ├── signals.js         Signal buffer + WebSocket broadcast
│   ├── support.js         Support chat workflow
│   └── servers.js         Platform/strategy toggles
├── webhooks/
│   └── index.js           /internal/* endpoints called by Python
├── ws/
│   └── index.js           WebSocket server (signals + support channels)
└── utils/
    ├── logger.js          Tiny leveled logger
    ├── response.js        Standard JSON response helpers
    └── telegram.js        initData signature verification
```

## 🚀 Quick start (local dev)

```bash
# 1. Install deps
npm install

# 2. Copy env template and fill in real values
cp .env.example .env
# Edit .env — set TELEGRAM_BOT_TOKEN, INTERNAL_SECRET, ALLOWED_ORIGINS, etc.

# 3. Run (with auto-reload on file changes)
npm run dev

# 4. Health check
curl http://localhost:8080/health
# {"ok":true,"ts":...}
```

## 🌐 Deployment (Railway)

This repo is configured for one-click Railway deployment:

1. Push to GitHub (`git push origin main`)
2. Go to [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → select this repo
3. Set the following environment variables in Railway:
   - `TELEGRAM_BOT_TOKEN` — from @BotFather
   - `INTERNAL_SECRET` — long random string (same as Python's `INTERNAL_SECRET`)
   - `ALLOWED_ORIGINS` — `https://ggggbbbsss555-wq.github.io`
   - `PYTHON_CANDLE_URL`, `PYTHON_TELEGRAM_URL`, `PYTHON_SIGNALS_URL` — URLs of the Python services
4. Railway auto-detects `railway.json`, runs `npm install`, and starts `node src/server.js`
5. You get a public URL like `https://quantvexa-backend.up.railway.app`

## 📡 API reference

### Auth
- `POST /api/auth/telegram` — exchange `init_data` for a session token (the init_data itself)

### Plans
- `GET /api/plans` — list Basic/Pro/Elite (prices locked to $50/$75/$100)
- `GET /api/plans/:id` — single plan
- `GET /api/payment-methods` — enabled payment methods + wallet addresses

### Subscriptions
- `POST /api/subscriptions/request` — submit a payment receipt
- `GET /api/subscriptions/mine` — user's own payment history
- `GET /api/subscriptions/status` — current subscription state

### Signals
- `GET /api/signals?limit=50` — recent signals
- `GET /api/signals/:id` — single signal
- `WS /ws` — subscribe to `{channel: 'signals', data: ...}` for real-time

### Candles
- `GET /api/symbols` — available trading symbols (proxied to Python)
- `GET /api/candles/:symbol?timeframe=1m&limit=200` — OHLCV data (proxied)

### Support
- `GET /api/support/convos` — user's own conversations
- `POST /api/support/messages` — send a message (text or image)
- `POST /api/support/mark-read/:convoId` — mark a convo as read

### Bots
- `GET /api/bots/strategies` — Strong/Medium/Pro catalog
- `GET /api/bots/platforms` — QUOTEX/BINOLLA + running status
- `GET /api/bots/status` — live bot status (proxied to Python)

### Admin (called by Firebase dashboard later)
- `GET /api/admin/subscriptions` — all payment requests
- `POST /api/admin/subscriptions/:id/approve` — approve a payment
- `POST /api/admin/subscriptions/:id/reject` — reject a payment
- `GET /api/admin/support/convos` — all support convos
- `POST /api/admin/servers/:id/toggle` — start/stop a platform server
- `POST /api/admin/strategies/:id/toggle` — enable/disable a strategy
- `GET /api/admin/payments` — payment-method config
- `PUT /api/admin/payments/:methodId` — update wallet address / enable state

### Internal webhooks (Python → Node.js, require `X-Internal-Secret` header)
- `POST /internal/signals/new` — new signal generated
- `POST /internal/signals/:id/resolve` — trade closed (win/lose)
- `POST /internal/support/message` — admin replied via Telegram
- `POST /internal/bot/status` — periodic bot status update

## 🔌 WebSocket protocol

Connect to `wss://<host>/ws` and send an auth message first:

```js
ws.send(JSON.stringify({
  type: 'auth',
  init_data: 'user=%7B...%7D&hash=abc...'
}));
```

After auth, you receive events:

```js
// New signal generated
{ channel: 'signals', data: { id, symbol, type, entry, ... } }

// Signal resolved (win/lose)
{ channel: 'signals', data: { id, result: 'win', profit: 1.23, event: 'resolved' } }

// New support message (yours or admin's)
{ channel: 'support', data: { convoId, msg, event: 'user_message'|'admin_message' } }
```

## 🔐 Security

- All Web App endpoints require a valid Telegram `init_data` (HMAC-signed by Telegram, verified server-side)
- All `/internal/*` endpoints require `X-Internal-Secret` header matching `INTERNAL_SECRET` env var
- Helmet + compression + rate limiting enabled by default
- CORS locked to `ALLOWED_ORIGINS` (GitHub Pages + localhost dev)

## 🗺️ Roadmap

- [ ] **Firebase Auth** — replace `init_data` re-verification with minted Firebase custom tokens
- [ ] **Firestore** — replace in-memory `dataStore` with Firestore collections
- [ ] **Redis** — pub/sub between Node.js and Python (replace HTTP webhooks for higher throughput)
- [ ] **Tests** — Vitest + supertest
- [ ] **OpenAPI spec** — auto-generated from the route handlers

## 📝 License

MIT
