# Aroha Gateway — WhatsApp API (v2)

Multi-account WhatsApp API gateway built with Baileys + Express.

## What's new in v2
- Account list persists to `backend/accounts.json` so a crash/restart (not a
  full redeploy) doesn't wipe your accounts
- Replies now correctly target `@lid`-masked contacts instead of silently failing
- 7-second send delay + serial queue per account (anti-ban)
- Real number resolution via `sock.onWhatsApp()` before sending
- New dashboard — shows Account ID clearly on every card, distinct look from v1
- Exponential-backoff reconnect, graceful shutdown

## Deploy on Render (Free)

### 1. Push this whole folder to a new GitHub repo
Easiest via GitHub's web UI: create a new repo → "uploading an existing file" →
drag in every file/folder here (`backend/`, `frontend/`, `.gitignore`, this README).

**Important:** if your local folder has its own hidden `.git` folder inside
`backend/` (e.g. left over from a template), remove it first, or GitHub will
treat `backend` as a broken submodule link instead of real files.

### 2. Create the Render Web Service
1. [render.com](https://render.com) → New → Web Service → connect your new repo
2. **Root Directory:** leave blank
3. **Build Command:** `cd backend && npm install`
4. **Start Command:** `node backend/server.js`
5. **Instance Type:** Free
6. Environment variable: `SEND_DELAY_MS=7000` (adjust if you want more/less spacing)
7. Deploy

### 3. Keep it alive (prevents session loss from sleep/wake)
Use a free monitor like [UptimeRobot](https://uptimerobot.com) or
[cron-job.org](https://cron-job.org) to hit `https://YOUR-APP.onrender.com/ping`
every 5 minutes.

### 4. Open the dashboard
Visit `https://YOUR-APP.onrender.com` — create an account, scan the QR, and
your Account ID + API Key are shown right on the card.

## API Usage

All send endpoints require the `X-Api-Key` header.

```bash
curl -X POST https://YOUR-APP.onrender.com/api/send/text \
  -H "Content-Type: application/json" \
  -H "X-Api-Key: wag_YOUR_KEY" \
  -d '{"to": "919876543210", "message": "Hello!"}'
```

Get received messages:
```bash
curl -H "X-Api-Key: wag_YOUR_KEY" "https://YOUR-APP.onrender.com/api/messages?since=0"
```

## Known limitation
Some contacts appear as `@lid` (WhatsApp's privacy-masked IDs) instead of a
real phone number. This is a known, currently-unresolved gap in the Baileys
library itself — not specific to this code. Replies still route correctly via
the full JID either way; only the *displayed* number may be unresolved for
some contacts.
