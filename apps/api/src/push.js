/**
 * Phone alerts (web push) for club owners, club admins and the PaceUp Admin.
 * Members never get these: they don't sign in.
 *
 * Events call queuePush() inside their own transaction (API or WhatsApp worker). The API sends the
 * queue every few seconds. A phone that has gone away (404/410) is forgotten.
 */
import { randomUUID } from "node:crypto";
import webpush from "web-push";
import { db } from "./db.js";

const iso = () => new Date().toISOString();

function vapidKeys() {
  const row = db.prepare("SELECT value FROM app_settings WHERE key = 'vapid'").get();
  if (row) return JSON.parse(row.value);
  const keys = webpush.generateVAPIDKeys();
  db.prepare("INSERT OR IGNORE INTO app_settings (key, value) VALUES ('vapid', ?)").run(JSON.stringify(keys));
  return JSON.parse(db.prepare("SELECT value FROM app_settings WHERE key = 'vapid'").get().value);
}
export function publicKey() { return vapidKeys().publicKey; }

/** Owners/admins of any club, or the PaceUp Admin: the only people who can turn alerts on. */
export function canGetAlerts(userId) {
  return Boolean(db.prepare(`SELECT 1 FROM users WHERE id = ? AND platform_role = 'super_admin'
    UNION SELECT 1 FROM club_memberships WHERE user_id = ? AND role IN ('owner', 'admin') LIMIT 1`).get(userId, userId));
}

/** Queues one alert for each phone this person turned alerts on for. Cheap no-op when they have none. */
export function queuePush(userIds, { title, body, url = "/" }) {
  const ids = [...new Set((Array.isArray(userIds) ? userIds : [userIds]).filter(Boolean))];
  const has = db.prepare("SELECT 1 FROM push_subscriptions WHERE user_id = ? LIMIT 1");
  const add = db.prepare("INSERT INTO push_queue (id, user_id, title, body, url, created_at) VALUES (?, ?, ?, ?, ?, ?)");
  for (const id of ids) if (has.get(id)) add.run(randomUUID(), id, title.slice(0, 120), body.slice(0, 300), url, iso());
}
export function superAdminIds() { return db.prepare("SELECT id FROM users WHERE platform_role = 'super_admin'").all().map((r) => r.id); }
export function clubOwnerIds(clubId) { return db.prepare("SELECT user_id FROM club_memberships WHERE club_id = ? AND role = 'owner'").all(clubId).map((r) => r.user_id); }

let sending = false;
/** Sends everything queued. `send` is swappable for tests. */
export async function sendQueuedPushes({ send = null } = {}) {
  if (sending) return 0;
  sending = true;
  try {
    const items = db.prepare("SELECT * FROM push_queue ORDER BY created_at LIMIT 200").all();
    if (!items.length) return 0;
    const keys = vapidKeys();
    const options = { vapidDetails: { subject: process.env.APP_BASE_URL || "https://getpaceup.com", publicKey: keys.publicKey, privateKey: keys.privateKey }, TTL: 6 * 3600 };
    const deliver = send || ((sub, payload) => webpush.sendNotification(sub, payload, options));
    let sent = 0;
    for (const item of items) {
      db.prepare("DELETE FROM push_queue WHERE id = ?").run(item.id); // at most once: a failed alert is not retried
      const payload = JSON.stringify({ title: item.title, body: item.body, url: item.url });
      for (const s of db.prepare("SELECT * FROM push_subscriptions WHERE user_id = ?").all(item.user_id)) {
        try {
          await deliver({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload);
          sent++;
        } catch (error) {
          if ([404, 410].includes(error?.statusCode)) db.prepare("DELETE FROM push_subscriptions WHERE id = ?").run(s.id);
        }
      }
    }
    return sent;
  } finally { sending = false; }
}

const str = (max) => ({ type: "string", minLength: 1, maxLength: max });

export function registerPushRoutes(app) {
  app.get("/api/push/key", { preHandler: [app.authenticate] }, async (request) => ({
    publicKey: publicKey(),
    allowed: canGetAlerts(request.user.sub),
  }));

  app.post("/api/push/subscribe", {
    preHandler: [app.authenticate],
    schema: { body: { type: "object", required: ["endpoint", "keys"], properties: { endpoint: str(1000), keys: { type: "object", required: ["p256dh", "auth"], properties: { p256dh: str(200), auth: str(100) } } } } }
  }, async (request, reply) => {
    const userId = request.user.sub;
    if (!canGetAlerts(userId)) return reply.code(403).send({ error: "Alerts are for club owners and admins." });
    const { endpoint, keys } = request.body;
    if (!/^https:\/\//.test(endpoint)) return reply.code(400).send({ error: "That doesn't look like a phone alert address." });
    db.prepare(`INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`)
      .run(randomUUID(), userId, endpoint, keys.p256dh, keys.auth, iso());
    return { on: true };
  });

  app.post("/api/push/unsubscribe", {
    preHandler: [app.authenticate],
    schema: { body: { type: "object", required: ["endpoint"], properties: { endpoint: str(1000) } } }
  }, async (request) => {
    db.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").run(request.body.endpoint, request.user.sub);
    return { on: false };
  });
}
