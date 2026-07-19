const {
  default: makeWASocket,
  DisconnectReason,
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode');
const pino = require('pino');
const fs = require('fs');
const path = require('path');

const AUTH_DIR = path.join(__dirname, 'sessions');
if (!fs.existsSync(AUTH_DIR)) fs.mkdirSync(AUTH_DIR, { recursive: true });

// Silent logger to save RAM
const silentLogger = pino({ level: 'silent' });

// Max number of incoming messages kept in memory per account
const MAX_MESSAGES = 200;

// Reconnect backoff: starts small, grows, caps out — avoids hammering
// WhatsApp's servers (which can itself trigger a conflict/logout) while
// still recovering quickly from a normal blip.
const RECONNECT_BASE_MS = 3000;
const RECONNECT_MAX_MS = 60000;

class WhatsAppManager {
  constructor(accounts, opts = {}) {
    this.accounts = accounts;
    this.onStateChange = opts.onStateChange || (() => {}); // called whenever status/phone changes, for persistence
    this.reconnectAttempts = {}; // { accountId: number }
    // How long to wait for a real "delivered" ack before assuming the
    // stale-session bug and attempting a repair + resend. Kept generous
    // (well above normal network latency) so we don't repair sessions
    // that are just waiting on a slow/offline recipient.
    this.DELIVERY_TIMEOUT_MS = Number(process.env.DELIVERY_REPAIR_TIMEOUT_MS || 20000);
  }

  async connect(id) {
    const acc = this.accounts[id];
    if (!acc) return;

    // Make sure the message buffer exists
    if (!Array.isArray(acc.messages)) acc.messages = [];

    const sessionDir = path.join(AUTH_DIR, id);
    if (!fs.existsSync(sessionDir)) fs.mkdirSync(sessionDir, { recursive: true });

    try {
      const { state, saveCreds } = await useMultiFileAuthState(sessionDir);
      const { version } = await fetchLatestBaileysVersion();

      // Keep a handle to the (cached) key store so we can surgically clear a
      // single contact's stale Signal session later — see _clearStaleSession.
      // Using this cached store (not the raw file store) matters: it's the
      // same object the live socket reads from, so a clear takes effect
      // immediately instead of leaving a stale copy sitting in memory.
      const keysStore = makeCacheableSignalKeyStore(state.keys, silentLogger);
      acc.keysStore = keysStore;

      const sock = makeWASocket({
        version,
        logger: silentLogger,
        auth: {
          creds: state.creds,
          keys: keysStore
        },
        printQRInTerminal: false,
        browser: ['WhatsApp Gateway', 'Chrome', '120.0.0'],
        generateHighQualityLinkPreview: false,
        syncFullHistory: false,
        markOnlineOnConnect: false // saves resources
      });

      acc.sock = sock;

      // QR Code event
      sock.ev.on('connection.update', async (update) => {
        const { connection, lastDisconnect, qr } = update;

        if (qr) {
          try {
            const qrDataUrl = await qrcode.toDataURL(qr);
            acc.qr = qrDataUrl;
            acc.status = 'qr_pending';
            console.log(`[${acc.name}] QR ready`);
            this.onStateChange(id, acc);
          } catch (e) {
            console.error('QR gen error:', e);
          }
        }

        if (connection === 'close') {
          const code = lastDisconnect?.error?.output?.statusCode;
          const reasonText = Object.keys(DisconnectReason).find(
            (k) => DisconnectReason[k] === code
          ) || `code ${code}`;
          const shouldReconnect = code !== DisconnectReason.loggedOut;

          acc.status = 'disconnected';
          acc.sock = null;
          console.log(`[${acc.name}] Disconnected. Reason: ${reasonText}. Reconnect: ${shouldReconnect}`);
          this.onStateChange(id, acc);

          if (shouldReconnect) {
            const attempt = (this.reconnectAttempts[id] || 0) + 1;
            this.reconnectAttempts[id] = attempt;
            const delay = Math.min(RECONNECT_BASE_MS * attempt, RECONNECT_MAX_MS);
            console.log(`[${acc.name}] Reconnecting in ${Math.round(delay / 1000)}s (attempt ${attempt})...`);
            setTimeout(() => this.connect(id), delay);
          } else {
            // Logged out (e.g. unlinked from phone, or a real conflict) — clear
            // session, this account needs a fresh QR scan.
            acc.status = 'logged_out';
            fs.rmSync(sessionDir, { recursive: true, force: true });
            this.onStateChange(id, acc);
          }
        }

        if (connection === 'open') {
          acc.status = 'connected';
          acc.qr = null;
          acc.phone = sock.user?.id?.split(':')[0] || null;
          this.reconnectAttempts[id] = 0; // reset backoff on a clean connect
          console.log(`[${acc.name}] Connected! Phone: ${acc.phone}`);
          this.onStateChange(id, acc);
        }
      });

      // Save credentials on update
      sock.ev.on('creds.update', saveCreds);

      // ─── OUTGOING MESSAGE DELIVERY STATUS ──────────────────────────────
      // sock.sendMessage() resolving just means Baileys handed the message
      // to WhatsApp's servers — it does NOT mean the recipient's phone
      // received it. WhatsApp reports real delivery via ack status updates:
      // 1 = pending, 2 = server received it, 3 = delivered to device,
      // 4 = read. Kept per-account so the dashboard/API can show it.
      if (!Array.isArray(acc.deliveries)) acc.deliveries = [];
      const ACK_NAMES = { 0: 'error', 1: 'pending', 2: 'server_ack', 3: 'delivered', 4: 'read' };
      sock.ev.on('messages.update', (updates) => {
        for (const u of updates) {
          if (u.key?.fromMe && u.update?.status !== undefined) {
            const name = ACK_NAMES[u.update.status] || `status_${u.update.status}`;
            console.log(`[${acc.name}] ACK for ${u.key.id} (to ${u.key.remoteJid}): ${name}`);
            const entry = acc.deliveries.find((d) => d.id === u.key.id);
            if (entry) {
              entry.status = name;
              entry.updatedAt = Date.now();
            } else {
              acc.deliveries.push({ id: u.key.id, to: u.key.remoteJid, status: name, updatedAt: Date.now() });
            }
            if (acc.deliveries.length > 100) acc.deliveries.splice(0, acc.deliveries.length - 100);
          }
        }
      });

      // ─── INCOMING MESSAGES ─────────────────────────────────────────────
      sock.ev.on('messages.upsert', async (m) => {
        // 'notify' = new messages arriving in real time (ignore history syncs / own reads)
        if (m.type !== 'notify') return;

        for (const msg of m.messages) {
          if (!msg.message) continue; // e.g. reactions/protocol messages with no content
          if (msg.key.fromMe) continue; // skip messages you sent yourself

          const parsed = await this._parseMessage(msg, sock);
          if (!parsed) continue;

          acc.messages.push(parsed);
          if (acc.messages.length > MAX_MESSAGES) {
            acc.messages.splice(0, acc.messages.length - MAX_MESSAGES);
          }

          console.log(`[${acc.name}] Message from ${parsed.from}${parsed.isLid ? ' (lid, unresolved)' : ''}: ${parsed.text || '(' + parsed.type + ')'}`);

          // Optional webhook forwarding, if the account was created with one
          if (acc.webhookUrl) {
            this._forwardToWebhook(acc.webhookUrl, { accountId: id, ...parsed }).catch((e) => {
              console.error(`[${acc.name}] Webhook forward failed:`, e.message);
            });
          }
        }
      });

    } catch (err) {
      console.error(`[${id}] Connection error:`, err.message);
      acc.status = 'error';
      this.onStateChange(id, acc);
      setTimeout(() => this.connect(id), 10000);
    }
  }

  // Best-effort: WhatsApp increasingly masks real phone numbers behind opaque
  // "@lid" IDs for privacy. Baileys can *sometimes* resolve the real number
  // via its internal LID<->phone-number mapping, depending on version and
  // whether it has seen that mapping yet. If it can't, we fall back to the
  // LID itself — replies still work fine via `jid`, they just won't display
  // a real phone number for that contact.
  async _resolveRealNumber(sock, jid) {
    if (!jid || !jid.endsWith('@lid')) {
      return jid ? jid.split('@')[0] : null;
    }
    try {
      if (sock.signalRepository?.lidMapping?.getPNForLID) {
        const pn = await sock.signalRepository.lidMapping.getPNForLID(jid);
        if (pn) return String(pn).split('@')[0];
      }
      if (typeof sock.getPNFromLID === 'function') {
        const pn = await sock.getPNFromLID(jid);
        if (pn) return String(pn).split('@')[0];
      }
    } catch (e) {
      // fall through to null below
    }
    return null; // could not resolve — caller falls back to the raw LID number
  }

  // Extracts a simple, uniform shape out of Baileys' many message types
  async _parseMessage(msg, sock) {
    const content = msg.message;
    if (!content) return null;

    // Unwrap ephemeral / viewOnce wrappers
    const inner = content.ephemeralMessage?.message
      || content.viewOnceMessage?.message
      || content.viewOnceMessageV2?.message
      || content;

    let type = Object.keys(inner)[0] || 'unknown';
    let text = null;

    if (inner.conversation) {
      text = inner.conversation;
      type = 'text';
    } else if (inner.extendedTextMessage) {
      text = inner.extendedTextMessage.text;
      type = 'text';
    } else if (inner.imageMessage) {
      text = inner.imageMessage.caption || null;
      type = 'image';
    } else if (inner.videoMessage) {
      text = inner.videoMessage.caption || null;
      type = 'video';
    } else if (inner.documentMessage) {
      text = inner.documentMessage.caption || inner.documentMessage.fileName || null;
      type = 'document';
    } else if (inner.audioMessage) {
      type = 'audio';
    } else if (inner.buttonsResponseMessage) {
      text = inner.buttonsResponseMessage.selectedDisplayText || null;
      type = 'button_reply';
    } else if (inner.listResponseMessage) {
      text = inner.listResponseMessage.title || null;
      type = 'list_reply';
    } else if (inner.stickerMessage) {
      type = 'sticker';
    } else if (inner.reactionMessage) {
      // Reactions arrive as their own message; skip storing these as "messages"
      return null;
    }

    const jid = msg.key.remoteJid || '';
    const isLid = jid.endsWith('@lid');

    // ── The actual @lid delivery fix ──────────────────────────────────
    // WhatsApp attaches the real phone-number JID directly on the message
    // key as `senderPn` for LID-addressed direct chats (Baileys v7+) — no
    // async lookup needed. This is far more reliable than
    // signalRepository.lidMapping, which is best-effort. Sending replies
    // straight to a raw "@lid" JID can return success from Baileys with no
    // thrown error, yet the message never actually reaches the recipient's
    // phone — a known Baileys behavior. Preferring senderPn fixes that.
    let replyJid = jid;
    let resolvedNumber = null;
    if (isLid) {
      if (msg.key.senderPn) {
        replyJid = msg.key.senderPn;
        resolvedNumber = replyJid.split('@')[0];
      } else {
        resolvedNumber = await this._resolveRealNumber(sock, jid);
        if (resolvedNumber) replyJid = `${resolvedNumber}@s.whatsapp.net`;
        // else: no senderPn AND no mapping available — replyJid stays as
        // the raw @lid, which is the last-resort fallback (may not deliver).
      }
    } else {
      resolvedNumber = jid.split('@')[0];
    }

    return {
      id: msg.key.id,
      from: resolvedNumber || jid.split('@')[0], // best real number we have, or the raw lid number as fallback
      jid: replyJid, // ALWAYS use this (not `from`) when replying — real PN JID when resolved, else raw @lid
      isLid,
      pushName: msg.pushName || null,
      type,
      text,
      timestamp: msg.messageTimestamp
        ? Number(msg.messageTimestamp) * 1000
        : Date.now()
    };
  }

  // ─── STALE SESSION REPAIR ────────────────────────────────────────────
  // Known Baileys/WhatsApp issue (still open upstream, happens on the
  // latest version too — this is NOT fixed by upgrading the library):
  // occasionally the local encrypted "session" for one specific contact
  // goes stale. Baileys still reports the send as successful (no error,
  // no bad ack), but the recipient's phone can't decrypt it and just
  // shows "Waiting for this message. This may take a while." forever.
  // The fix is to clear ONLY that contact's session so WhatsApp
  // re-does the encryption handshake on the next send. This never
  // touches auth/login state or any other contact's session.
  async _clearStaleSession(id, jid) {
    const acc = this.accounts[id];
    if (!acc || !acc.keysStore) return false;
    try {
      const sessionDir = path.join(AUTH_DIR, id);
      if (!fs.existsSync(sessionDir)) return false;
      const num = String(jid).split('@')[0].split(':')[0];
      if (!num) return false;

      const files = fs
        .readdirSync(sessionDir)
        .filter((f) => f === `session-${num}.json` || f.startsWith(`session-${num}.`));
      if (files.length === 0) return false;

      const toClear = {};
      for (const f of files) {
        const key = f.replace(/^session-/, '').replace(/\.json$/, '');
        toClear[key] = null; // null = delete this entry, through the same store the live socket uses
      }
      await acc.keysStore.set({ session: toClear });
      console.log(`[repair] cleared ${files.length} stale session entr${files.length === 1 ? 'y' : 'ies'} for ${jid} (${acc.name})`);
      return true;
    } catch (e) {
      console.error(`[repair] failed to clear session for ${jid}:`, e.message);
      return false;
    }
  }

  // Watches a just-sent message in the background. If it's still stuck at
  // "sent"/"server_ack" (never reached "delivered") after the timeout, that's
  // the signature of the stale-session bug — repair and resend once.
  async _watchAndRepair(id, jid, messageId, content) {
    await new Promise((resolve) => setTimeout(resolve, this.DELIVERY_TIMEOUT_MS));
    const acc = this.accounts[id];
    if (!acc || !acc.sock) return;

    const entry = (acc.deliveries || []).find((d) => d.id === messageId);
    const stuck = !entry || entry.status === 'sent_to_server' || entry.status === 'pending' || entry.status === 'server_ack';
    if (!stuck) return; // already delivered/read — all good, nothing to do

    const repaired = await this._clearStaleSession(id, jid);
    if (!repaired) return; // no session file to clear — likely just slow network, not this bug; leave it alone

    console.log(`[repair] resending to ${jid} after session reset (was stuck as "${entry?.status || 'unknown'}")`);
    try {
      const retry = await acc.sock.sendMessage(jid, content);
      if (retry?.key?.id) {
        if (!Array.isArray(acc.deliveries)) acc.deliveries = [];
        acc.deliveries.push({ id: retry.key.id, to: jid, status: 'sent_to_server', updatedAt: Date.now(), resentAfter: messageId });
        if (acc.deliveries.length > 100) acc.deliveries.splice(0, acc.deliveries.length - 100);
      }
    } catch (e) {
      console.error(`[repair] resend to ${jid} failed:`, e.message);
    }
  }

  // Drop-in replacement for acc.sock.sendMessage(jid, content) that adds the
  // stuck-delivery watchdog above. Same return shape (Baileys' send result),
  // so callers don't need to change how they read the response.
  async reliableSend(id, jid, content) {
    const acc = this.accounts[id];
    if (!acc || !acc.sock) throw new Error('Account not connected');

    const result = await acc.sock.sendMessage(jid, content);
    const messageId = result?.key?.id;
    if (messageId) {
      if (!Array.isArray(acc.deliveries)) acc.deliveries = [];
      acc.deliveries.push({ id: messageId, to: jid, status: 'sent_to_server', updatedAt: Date.now() });
      if (acc.deliveries.length > 100) acc.deliveries.splice(0, acc.deliveries.length - 100);

      // Fire-and-forget: doesn't block or slow down the reply flow.
      this._watchAndRepair(id, jid, messageId, content).catch(() => {});
    }
    return result;
  }

  async _forwardToWebhook(url, payload) {
    // Uses global fetch (Node 18+)
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
  }

  disconnect(id) {
    const acc = this.accounts[id];
    if (acc?.sock) {
      try {
        acc.sock.end();
      } catch (e) {}
      acc.sock = null;
    }
    if (acc) acc.status = 'disconnected';
  }
}

module.exports = WhatsAppManager;
