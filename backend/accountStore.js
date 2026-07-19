const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'accounts.json');

// Only these fields are safe/useful to persist — `sock` is a live connection
// object and can't be serialized, `qr` goes stale instantly.
const PERSIST_FIELDS = ['id', 'name', 'phone', 'apiKey', 'status', 'webhookUrl'];

function loadAccountsMeta() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    const raw = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    return raw || {};
  } catch (e) {
    console.error('[accountStore] failed to read accounts.json, starting fresh:', e.message);
    return {};
  }
}

function saveAccountsMeta(accounts) {
  try {
    const slim = {};
    for (const [id, acc] of Object.entries(accounts)) {
      slim[id] = {};
      for (const f of PERSIST_FIELDS) slim[id][f] = acc[f];
    }
    fs.writeFileSync(DATA_FILE, JSON.stringify(slim, null, 2));
  } catch (e) {
    console.error('[accountStore] failed to save accounts.json:', e.message);
  }
}

module.exports = { loadAccountsMeta, saveAccountsMeta };
