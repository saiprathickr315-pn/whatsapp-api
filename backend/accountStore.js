const fs = require('fs');
const path = require('path');

const DATA_FILE = path.join(__dirname, 'accounts.json');
const REDIS_KEY = 'wa:accounts:meta';

// Only these fields are safe/useful to persist — `sock` is a live connection
// object and can't be serialized, `qr` goes stale instantly.
const PERSIST_FIELDS = ['id', 'name', 'phone', 'apiKey', 'status', 'webhookUrl'];

function slim(accounts) {
  const out = {};
  for (const [id, acc] of Object.entries(accounts)) {
    out[id] = {};
    for (const f of PERSIST_FIELDS) out[id][f] = acc[f];
  }
  return out;
}

// ─── File backend (local dev / no REDIS_URL set) ────────────────────────────
function loadFromFile() {
  if (!fs.existsSync(DATA_FILE)) return {};
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')) || {};
  } catch (e) {
    console.error('[accountStore] failed to read accounts.json, starting fresh:', e.message);
    return {};
  }
}
function saveToFile(accounts) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(slim(accounts), null, 2));
  } catch (e) {
    console.error('[accountStore] failed to save accounts.json:', e.message);
  }
}

// ─── Redis backend (survives Render Free restarts/redeploys) ───────────────
// IMPORTANT: on Render Free, anything written only to local disk (the file
// backend above) is wiped whenever the instance restarts — including the
// automatic sleep/wake after ~15 min idle, not just a manual redeploy. That
// silent wipe is what makes accounts look like they "got deleted" on their
// own. Setting REDIS_URL (e.g. a free Upstash Redis instance) moves this
// data off the container entirely so it survives every restart.
function makeRedisStore(redis) {
  return {
    async load() {
      try {
        const raw = await redis.get(REDIS_KEY);
        return raw ? JSON.parse(raw) : {};
      } catch (e) {
        console.error('[accountStore] Redis load failed, starting fresh:', e.message);
        return {};
      }
    },
    async save(accounts) {
      try {
        await redis.set(REDIS_KEY, JSON.stringify(slim(accounts)));
      } catch (e) {
        console.error('[accountStore] Redis save failed:', e.message);
      }
    }
  };
}

// Public API. If a redis client is passed (REDIS_URL was set), use it;
// otherwise fall back to the local file so local dev with no Redis still works.
function createAccountStore(redis) {
  if (redis) {
    const store = makeRedisStore(redis);
    return {
      async loadAccountsMeta() {
        return store.load();
      },
      saveAccountsMeta(accounts) {
        // fire-and-forget, matches the old sync-looking call sites
        store.save(accounts).catch(() => {});
      },
      backend: 'redis'
    };
  }
  return {
    async loadAccountsMeta() {
      return loadFromFile();
    },
    saveAccountsMeta(accounts) {
      saveToFile(accounts);
    },
    backend: 'file'
  };
}

module.exports = { createAccountStore };
