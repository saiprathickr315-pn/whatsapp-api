// Stores Baileys' auth state (login credentials + encryption session keys) in
// Redis instead of local disk files. This is what makes an account survive
// Render Free's sleep/wake + restarts — local files (backend/sessions/<id>/*)
// get wiped on every restart on that tier, which is why accounts used to come
// back asking for a fresh QR scan (or disappear entirely once accounts.json
// was also wiped). Redis (e.g. a free Upstash instance) lives outside the
// container, so it survives restarts/redeploys.
const { initAuthCreds, BufferJSON, proto } = require('@whiskeysockets/baileys');

async function useRedisAuthState(redis, sessionId) {
  const key = (k) => `wa:${sessionId}:${k}`;

  const writeData = async (data, k) => {
    await redis.set(key(k), JSON.stringify(data, BufferJSON.replacer));
  };
  const readData = async (k) => {
    const raw = await redis.get(key(k));
    if (!raw) return null;
    try {
      return JSON.parse(raw, BufferJSON.reviver);
    } catch {
      return null;
    }
  };
  const removeData = async (k) => {
    await redis.del(key(k));
  };

  const creds = (await readData('creds')) || initAuthCreds();

  return {
    state: {
      creds,
      keys: {
        get: async (type, ids) => {
          const data = {};
          await Promise.all(
            ids.map(async (id) => {
              let value = await readData(`${type}-${id}`);
              if (type === 'app-state-sync-key' && value) {
                value = proto.Message.AppStateSyncKeyData.fromObject(value);
              }
              data[id] = value;
            })
          );
          return data;
        },
        set: async (data) => {
          const tasks = [];
          for (const category of Object.keys(data)) {
            for (const id of Object.keys(data[category])) {
              const value = data[category][id];
              const k = `${category}-${id}`;
              tasks.push(value ? writeData(value, k) : removeData(k));
            }
          }
          await Promise.all(tasks);
        }
      }
    },
    saveCreds: () => writeData(creds, 'creds')
  };
}

// Wipes everything stored for one account's WhatsApp session (used on a real
// logout / unlink from the phone — NOT on a normal restart).
async function clearRedisAuthState(redis, sessionId) {
  const pattern = `wa:${sessionId}:*`;
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
}

module.exports = { useRedisAuthState, clearRedisAuthState };
