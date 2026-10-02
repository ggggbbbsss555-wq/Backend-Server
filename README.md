# QuantVexa Backend Server 🌉 (Single File)

Node.js bridge server — **all logic in one `server.js` file** so a single edit covers everything.

Connects:
- **Telegram Web App** (4 quantvexa pages on GitHub Pages)
- **Python codebase** (single `main.py` — candle + telegram + signals services)
- **Firebase admin dashboard** (later — currently on localStorage)

## 📦 Single-file structure

```
backend-server/
├── server.js          ← ALL logic here (config, middleware, routes, services, webhooks, WebSocket)
├── package.json
├── railway.json
├── Dockerfile
├── .env.example
└── README.md
```

That's it. One file. No `src/` maze — if something breaks, edit `server.js` and redeploy.

## 🚀 Quick start

```bash
npm install
cp .env.example .env   # fill in TELEGRAM_BOT_TOKEN, INTERNAL_SECRET, etc.
npm start              # → http://localhost:8080
```

## 🌐 Railway deployment

1. Push to GitHub
2. [railway.com](https://railway.com) → **New Project** → **Deploy from GitHub repo** → select this repo
3. Set env vars (see `.env.example`):
   - `TELEGRAM_BOT_TOKEN`
   - `INTERNAL_SECRET` (same as Python's)
   - `ALLOWED_ORIGINS=https://ggggbbbsss555-wq.github.io`
   - `PYTHON_CANDLE_URL`, `PYTHON_TELEGRAM_URL`, `PYTHON_SIGNALS_URL`
4. Railway auto-detects `railway.json`, runs `node server.js`

## 📡 API

### Web App (require Telegram initData)
- `POST /api/auth/telegram`
- `GET /api/plans` · `GET /api/plans/:id` · `GET /api/payment-methods`
- `POST /api/subscriptions/request` · `GET /api/subscriptions/mine` · `GET /api/subscriptions/status`
- `GET /api/signals` · `GET /api/signals/:id` · `WS /ws`
- `GET /api/symbols` · `GET /api/candles/:symbol`
- `GET /api/support/convos` · `POST /api/support/messages`
- `GET /api/bots/strategies` · `GET /api/bots/platforms` · `GET /api/bots/status`

### Admin (Firebase dashboard later)
- `GET /api/admin/subscriptions` · `POST /api/admin/subscriptions/:id/approve|reject`
- `GET /api/admin/support/convos` · `POST /api/admin/support/:convoId/mark-read`
- `POST /api/admin/servers/:id/toggle` · `POST /api/admin/strategies/:id/toggle`
- `GET /api/admin/payments` · `PUT /api/admin/payments/:methodId`
- `GET /api/admin/users` · `GET /api/admin/strategies` · `GET /api/admin/platforms`

### Internal webhooks (Python → Node.js, require `X-Internal-Secret`)
- `POST /internal/signals/new`
- `POST /internal/signals/:id/resolve`
- `POST /internal/support/message`
- `POST /internal/bot/status`

## 🔌 WebSocket

Connect to `wss://<host>/ws` and send `{type:'auth', init_data:'...'}` to authenticate.

Events:
- `{channel:'signals', data:{...}}` — new signal + signal resolved
- `{channel:'support', data:{convoId, msg, event}}` — new support message

## 🔐 Security
- All Web App endpoints require valid Telegram initData (HMAC verified)
- All `/internal/*` endpoints require `X-Internal-Secret` header
- Helmet + compression + rate limiting
- CORS locked to `ALLOWED_ORIGINS`

## ✅ Compatibility with admin dashboard + Python backend
The data shapes mirror the admin dashboard's localStorage records:
- Plans: Basic $50 / Pro $75 / Elite $100
- Payment methods: Binance Pay / USDT TRC20 / USDT BEP20
- Strategies: Strong (55% / 1pt) / Medium (65% / 3pt) / Pro (78% / 6pt)
- Platforms: QUOTEX / BINOLLA
- User fields: tgId, tgUsername, platform, strategy, subscriptionStatus, signalsRemaining, etc.

The Python `main.py` pushes via `/internal/*` webhooks with the matching `X-Internal-Secret` header.

## 📝 License
MIT
