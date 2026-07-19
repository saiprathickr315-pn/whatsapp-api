const express = require('express');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const WhatsAppManager = require('./whatsapp');
const { loadAccountsMeta, saveAccountsMeta } = require('./accountStore');

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../frontend/public')));

// File upload setup (memory storage for RAM efficiency)
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 16 * 1024 * 1024 } // 16MB max
});

// In-memory store, backed by accounts.json on disk so a crash/restart within
// the SAME deployment doesn't lose your account list or force a re-scan.
// NOTE: on hosts with an ephemeral filesystem (e.g. Render's free tier), a
// full redeploy still wipes this file — that's a hosting-tier limit, not a
// code bug. Keeping the service alive (see /ping + an external uptime
// pinger) avoids most restarts that would otherwise trigger this.
const accounts = {}; // { accountId: { id, name, phone, apiKey, status, qr, messages, webhookUrl } }

let saveTimer = null;
function scheduleSave() {
  // Debounce so rapid successive events (e.g. reconnect storms) don't hammer the disk.
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => saveAccountsMeta(accounts), 500);
}

const manager = new WhatsAppManager(accounts, {
  onStateChange: () => scheduleSave(),
});

// ─── RESTORE ON BOOT ────────────────────────────────────────────────────────────
// If accounts.json survived (e.g. this was a crash/restart, not a fresh
// deploy), reload the account list and try to resume each session. Baileys
// will reuse its saved session files under ./sessions/<id> if those also
// survived — otherwise it'll fall back to needing a fresh QR scan.
(function restoreOnBoot() {
  const persisted = loadAccountsMeta();
  const ids = Object.keys(persisted);
  if (ids.length === 0) return;
  console.log(`Restoring ${ids.length} account(s) from accounts.json...`);
  for (const id of ids) {
    accounts[id] = {
      ...persisted[id],
      qr: null,
      sock: null,
      messages: [],
    };
    manager.connect(id);
  }
})();

// ─── HEALTH CHECK ──────────────────────────────────────────────────────────────
// Hit this from a free external uptime monitor (UptimeRobot, cron-job.org,
// etc.) every 5 minutes to keep the service from sleeping on free hosting
// tiers — that sleep/wake cycle is the single biggest cause of unexpected
// WhatsApp logouts on platforms like Render's free plan.
app.get('/ping', (req, res) => res.json({ ok: true, accounts: Object.keys(accounts).length }));

// ─── FRONTEND ROUTES ───────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, '../frontend/public/index.html'));
});

// ─── ACCOUNT MANAGEMENT ────────────────────────────────────────────────────────

// List all accounts
app.get('/api/accounts', (req, res) => {
  const list = Object.values(accounts).map(a => ({
    id: a.id,
    name: a.name,
    phone: a.phone,
    apiKey: a.apiKey,
    status: a.status,
    qr: a.status === 'qr_pending' ? a.qr : null,
    webhookUrl: a.webhookUrl || null,
    messageCount: a.messages ? a.messages.length : 0
  }));
  res.json(list);
});

// Add new account (max 5)
app.post('/api/accounts', (req, res) => {
  const count = Object.keys(accounts).length;
  if (count >= 5) {
    return res.status(400).json({ error: 'Maximum 5 accounts allowed' });
  }
  const { name, webhookUrl } = req.body;
  if (!name) return res.status(400).json({ error: 'Name is required' });

  const id = uuidv4();
  const apiKey = 'wag_' + uuidv4().replace(/-/g, '');

  accounts[id] = {
    id,
    name,
    phone: null,
    apiKey,
    status: 'initializing',
    qr: null,
    sock: null,
    messages: [],
    webhookUrl: webhookUrl || null
  };

  // Start WhatsApp connection
  manager.connect(id);
  scheduleSave();

  res.json({ id, name, apiKey, status: 'initializing' });
});

// Delete account
app.delete('/api/accounts/:id', (req, res) => {
  const { id } = req.params;
  if (!accounts[id]) return res.status(404).json({ error: 'Account not found' });
  manager.disconnect(id);
  delete accounts[id];
  scheduleSave();
  res.json({ ok: true });
});

// Get QR for account
app.get('/api/accounts/:id/qr', (req, res) => {
  const acc = accounts[req.params.id];
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  res.json({ status: acc.status, qr: acc.qr || null });
});

// Regenerate / reconnect
app.post('/api/accounts/:id/reconnect', (req, res) => {
  const { id } = req.params;
  if (!accounts[id]) return res.status(404).json({ error: 'Account not found' });
  manager.disconnect(id);
  accounts[id].status = 'initializing';
  accounts[id].qr = null;
  manager.connect(id);
  res.json({ ok: true });
});

// Set / update webhook URL for an account (leave blank in body to remove it)
app.post('/api/accounts/:id/webhook', (req, res) => {
  const acc = accounts[req.params.id];
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  const { webhookUrl } = req.body;
  acc.webhookUrl = webhookUrl || null;
  scheduleSave();
  res.json({ ok: true, webhookUrl: acc.webhookUrl });
});

// ─── SEND API (authenticated by API key) ───────────────────────────────────────

function resolveAccount(req, res) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  if (!apiKey) {
    res.status(401).json({ error: 'Missing API key. Send X-Api-Key header.' });
    return null;
  }
  const acc = Object.values(accounts).find(a => a.apiKey === apiKey);
  if (!acc) {
    res.status(401).json({ error: 'Invalid API key' });
    return null;
  }
  return acc;
}

function requireConnected(acc, res) {
  if (acc.status !== 'connected') {
    res.status(503).json({ error: `Account not connected. Status: ${acc.status}` });
    return false;
  }
  return true;
}

// ─── SEND THROTTLING (anti-ban) ─────────────────────────────────────────────
// Spaces out consecutive outgoing messages per account so the bot doesn't
// fire replies instantly one after another, which is a common signal
// WhatsApp uses to flag automated/bot accounts. Configurable via env var.
const SEND_DELAY_MS = Number(process.env.SEND_DELAY_MS || 7000);

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Chains sends per-account so they execute one at a time, each waiting
// SEND_DELAY_MS after the previous one finishes — never in parallel/instant.
function enqueueSend(acc, taskFn) {
  const run = () => delay(SEND_DELAY_MS).then(taskFn);
  acc.sendQueue = (acc.sendQueue || Promise.resolve()).then(run, run);
  return acc.sendQueue;
}

// ─── REAL NUMBER RESOLUTION ──────────────────────────────────────────────────
// Instead of guessing "number@s.whatsapp.net", ask WhatsApp directly whether
// this number exists and what its correct JID actually is. More reliable
// than string-guessing, especially for numbers WhatsApp may route
// differently (e.g. business accounts, some @lid-linked contacts).
async function resolveSendJid(sock, to) {
  // Already a full JID (e.g. replying to a specific "...@lid" or
  // "...@s.whatsapp.net" address from an incoming message) — trust it as-is,
  // except: a raw "@lid" is unreliable to send to directly. Safety net: try
  // resolving it to the real PN JID first (whatsapp.js's _parseMessage
  // already prefers senderPn for new incoming messages, so this mainly
  // covers older stored data or direct API calls with a raw @lid).
  if (typeof to === 'string' && to.includes('@')) {
    if (to.endsWith('@lid') && sock.signalRepository?.lidMapping?.getPNForLID) {
      try {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(to);
        if (pn) {
          console.log(`[resolve] ${to} -> resolved to real JID ${pn} before sending`);
          return pn;
        }
      } catch (e) {
        // no mapping available — fall through and send to the raw @lid as last resort
      }
    }
    return to;
  }
  const num = String(to).replace(/[^0-9]/g, '');
  try {
    const results = await sock.onWhatsApp(num);
    if (results && results[0] && results[0].exists && results[0].jid) {
      return results[0].jid;
    }
  } catch (e) {
    // WhatsApp lookup failed/unsupported — fall back to the naive guess below.
  }
  return `${num}@s.whatsapp.net`;
}

// Send text message
app.post('/api/send/text', async (req, res) => {
  const acc = resolveAccount(req, res);
  if (!acc) return;
  if (!requireConnected(acc, res)) return;

  const { to, message } = req.body;
  if (!to || !message) return res.status(400).json({ error: 'to and message are required' });

  try {
    const jid = await resolveSendJid(acc.sock, to);
    console.log(`[send/text] to=${to} -> resolved jid=${jid}`);
    const result = await enqueueSend(acc, () => acc.sock.sendMessage(jid, { text: message }));
    if (result?.key?.id) {
      if (!Array.isArray(acc.deliveries)) acc.deliveries = [];
      acc.deliveries.push({ id: result.key.id, to: jid, status: 'sent_to_server', updatedAt: Date.now() });
    }
    console.log(`[send/text] Baileys result:`, JSON.stringify(result?.key || result));
    res.json({ ok: true, to: jid, delayMs: SEND_DELAY_MS, messageId: result?.key?.id || null });
  } catch (err) {
    console.error(`[send/text] FAILED for to=${to}:`, err.message);
    res.status(500).json({ error: err.message });
  }
});

// Send image
app.post('/api/send/image', upload.single('image'), async (req, res) => {
  const acc = resolveAccount(req, res);
  if (!acc) return;
  if (!requireConnected(acc, res)) return;

  const { to, caption } = req.body;
  if (!to) return res.status(400).json({ error: 'to is required' });
  if (!req.file) return res.status(400).json({ error: 'image file is required' });

  try {
    const jid = await resolveSendJid(acc.sock, to);
    await enqueueSend(acc, () =>
      acc.sock.sendMessage(jid, {
        image: req.file.buffer,
        caption: caption || '',
        mimetype: req.file.mimetype
      })
    );
    res.json({ ok: true, to: jid, delayMs: SEND_DELAY_MS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send document
app.post('/api/send/document', upload.single('file'), async (req, res) => {
  const acc = resolveAccount(req, res);
  if (!acc) return;
  if (!requireConnected(acc, res)) return;

  const { to, filename, caption } = req.body;
  if (!to) return res.status(400).json({ error: 'to is required' });
  if (!req.file) return res.status(400).json({ error: 'file is required' });

  try {
    const jid = await resolveSendJid(acc.sock, to);
    await enqueueSend(acc, () =>
      acc.sock.sendMessage(jid, {
        document: req.file.buffer,
        mimetype: req.file.mimetype,
        fileName: filename || req.file.originalname,
        caption: caption || ''
      })
    );
    res.json({ ok: true, to: jid, delayMs: SEND_DELAY_MS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Send button message
app.post('/api/send/buttons', async (req, res) => {
  const acc = resolveAccount(req, res);
  if (!acc) return;
  if (!requireConnected(acc, res)) return;

  const { to, text, footer, buttons } = req.body;
  if (!to || !text || !buttons) return res.status(400).json({ error: 'to, text, and buttons are required' });

  try {
    const jid = await resolveSendJid(acc.sock, to);
    const buttonList = buttons.map((b, i) => ({
      buttonId: `btn_${i}`,
      buttonText: { displayText: b },
      type: 1
    }));
    await enqueueSend(acc, () =>
      acc.sock.sendMessage(jid, {
        text,
        footer: footer || '',
        buttons: buttonList,
        headerType: 1
      })
    );
    res.json({ ok: true, to: jid, delayMs: SEND_DELAY_MS });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delivery status for recently sent messages — shows the REAL WhatsApp ack
// (pending/server_ack/delivered/read), not just "the API accepted the request".
app.get('/api/accounts/:id/deliveries', (req, res) => {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  const acc = accounts[req.params.id];
  if (!acc) return res.status(404).json({ error: 'Account not found' });
  if (apiKey && apiKey !== acc.apiKey) return res.status(401).json({ error: 'Invalid API key' });
  const list = (acc.deliveries || []).slice(-30).reverse();
  res.json({ deliveries: list });
});

// ─── RECEIVE API (authenticated by API key) ────────────────────────────────────

// Get received messages. Supports ?since=<timestamp ms> and ?limit=<n>
app.get('/api/messages', (req, res) => {
  const acc = resolveAccount(req, res);
  if (!acc) return;

  let msgs = acc.messages || [];

  const since = req.query.since ? Number(req.query.since) : null;
  if (since) msgs = msgs.filter(m => m.timestamp > since);

  const limit = req.query.limit ? Number(req.query.limit) : null;
  if (limit) msgs = msgs.slice(-limit);

  res.json({ count: msgs.length, messages: msgs });
});

// Clear stored messages (e.g. after you've pulled/consumed them)
app.delete('/api/messages', (req, res) => {
  const acc = resolveAccount(req, res);
  if (!acc) return;

  acc.messages = [];
  res.json({ ok: true });
});

// ─── HELPERS ───────────────────────────────────────────────────────────────────
function formatJid(to) {
  // If a full JID was already passed in (e.g. "53103160258795@lid" for a
  // privacy-masked contact), use it exactly as-is — do NOT force it onto
  // @s.whatsapp.net, or the message silently goes nowhere.
  if (typeof to === 'string' && to.includes('@')) {
    return to;
  }
  // Otherwise treat it as a plain phone number.
  let num = to.replace(/[^0-9]/g, '');
  return `${num}@s.whatsapp.net`;
}

// ─── GRACEFUL SHUTDOWN ───────────────────────────────────────────────────────
// Ending sockets cleanly (instead of the process just being killed) reduces
// the chance WhatsApp treats the disconnect as a "conflict" and force-logs
// out the session on next boot.
function shutdown() {
  console.log('Shutting down gracefully...');
  saveAccountsMeta(accounts);
  for (const id of Object.keys(accounts)) {
    manager.disconnect(id);
  }
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// ─── START ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`✅ WhatsApp Gateway running on port ${PORT}`);
});