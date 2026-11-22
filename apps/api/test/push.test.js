import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { queueNoShowNudges } = await import("../src/no-shows.js");
const { sendQueuedPushes, setPushSender } = await import("../src/push.js");
const welcomed = [];
setPushSender(async (s, payload) => { welcomed.push([s.endpoint, JSON.parse(payload).title]); });
const { createSignupClub } = await import("../src/signup.js");
const app = await buildApp({ logger: false, authRateLimit: 1000, publicRateLimit: 1000, sendPushes: false });
const { call, registerOwner, invite } = makeClient(app);

const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();
async function joinAs(owner, clubId, name, email) {
  const token = await invite(owner.cookie, clubId, email);
  const res = await call("POST", "/api/auth/register", { payload: { name, email, password: "strong-password-123", inviteToken: token } });
  return { cookie: sessionCookie(res), user: res.json().user };
}
const owner = await registerOwner("Priya Sharma", "priya@example.com", "Sunrise Club");
const clubId = owner.clubId;
const member = await joinAs(owner, clubId, "Arjun Rao", "arjun@example.com");
const sub = (n) => ({ endpoint: `https://push.example.com/${n}`, keys: { p256dh: "BKey" + n, auth: "auth" + n } });
const queued = (userId) => db.prepare("SELECT title, body, url FROM push_queue WHERE user_id = ? ORDER BY created_at").all(userId);

test("only owners, admins and the PaceUp Admin can turn alerts on", async () => {
  const key = (await call("GET", "/api/push/key", { cookie: owner.cookie })).json();
  assert.ok(key.publicKey.length > 40); assert.equal(key.allowed, true);
  assert.equal((await call("GET", "/api/push/key", { cookie: owner.cookie })).json().publicKey, key.publicKey, "keys are made once and kept");
  assert.equal((await call("GET", "/api/push/key", { cookie: member.cookie })).json().allowed, false);
  assert.equal((await call("POST", "/api/push/subscribe", { cookie: member.cookie, payload: sub("m") })).statusCode, 403);
  assert.equal((await call("POST", "/api/push/subscribe", { payload: sub("x") })).statusCode, 401);
  assert.equal((await call("POST", "/api/push/subscribe", { cookie: owner.cookie, payload: sub(1) })).statusCode, 200);
  assert.equal((await call("POST", "/api/push/subscribe", { cookie: owner.cookie, payload: sub(1) })).statusCode, 200, "same phone again is fine");
  assert.equal((await call("POST", "/api/push/subscribe", { cookie: owner.cookie, payload: { endpoint: "https://", keys: { p256dh: "p", auth: "a" } } })).statusCode, 400, "broken address is refused");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n, 1);
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(welcomed, [["https://push.example.com/1", "PaceUp alerts are on ✅"]], "a new phone gets one 'alerts are on' ping; the same phone again doesn't");
});

test("the Lead hears when someone drops out, and gets the no-show check", async () => {
  const ride = (await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { title: "Sunday loop", starts_at: iso(Date.now() + 86400000), meeting_point: "Hebbal", status: "published" } })).json().ride;
  await call("PUT", `/api/r/${ride.code}/rsvp`, { cookie: member.cookie, payload: { status: "going" } });
  await call("PUT", `/api/r/${ride.code}/rsvp`, { cookie: member.cookie, payload: { status: "cancelled" } });
  assert.deepEqual(queued(owner.user.id), [{ title: "Sunday loop", body: "Arjun Rao dropped out.", url: `/r/${ride.code}` }]);
  assert.deepEqual(queued(member.user.id), [], "members never get alerts");

  db.prepare("DELETE FROM push_queue").run();
  await call("PUT", `/api/r/${ride.code}/rsvp`, { cookie: member.cookie, payload: { status: "going" } });
  const noon = new Date(); noon.setUTCHours(6, 30, 0, 0); // 12:00 in India, outside quiet hours
  db.prepare("UPDATE rides SET starts_at = ? WHERE id = ?").run(iso(noon.getTime() - 2 * HOUR), ride.id);
  queueNoShowNudges(noon.getTime());
  assert.deepEqual(queued(owner.user.id).map((q) => q.url), [`/r/${ride.code}?absent`], "works without the club's WhatsApp");
});

test("the PaceUp Admin hears about new club sign-ups", async () => {
  db.prepare("UPDATE users SET platform_role = 'super_admin' WHERE id = ?").run(owner.user.id);
  db.prepare("DELETE FROM push_queue").run();
  createSignupClub({ clubName: "Pune Pacers", city: "Pune", activity: "Running", name: "Ravi Kumar", phone: "98220 11111" });
  assert.deepEqual(queued(owner.user.id), [{ title: "New club sign-up", body: "Pune Pacers just joined PaceUp.", url: "/superadmin" }]);
});

test("queued alerts go to every phone once; a phone that's gone is forgotten", async () => {
  await call("POST", "/api/push/subscribe", { cookie: owner.cookie, payload: sub(2) });
  const seen = [];
  const sent = await sendQueuedPushes({ send: async (s, payload) => { seen.push([s.endpoint, JSON.parse(payload).title]); if (s.endpoint.endsWith("/2")) throw Object.assign(new Error("gone"), { statusCode: 410 }); } });
  assert.equal(sent, 1);
  assert.equal(seen.length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_queue").get().n, 0);
  assert.deepEqual(db.prepare("SELECT endpoint FROM push_subscriptions").all().map((r) => r.endpoint), ["https://push.example.com/1"]);
  assert.equal(await sendQueuedPushes({ send: async () => assert.fail("nothing left to send") }), 0);
});

test("PaceUp Admin can test-send to their own phones and see every phone's last result; nobody else can", async () => {
  setPushSender(async (sub) => { if (sub.endpoint.endsWith("/9")) throw Object.assign(new Error("Received unexpected response code"), { statusCode: 403, body: "BadJwtToken" }); return { statusCode: 201 }; });
  await call("POST", "/api/push/subscribe", { cookie: owner.cookie, payload: sub(9) });
  const st = (await call("GET", "/api/push/status?test=1", { cookie: owner.cookie })).json();
  assert.deepEqual(st.test.map((x) => [x.ok, x.status]).sort(), [[false, 403], [true, 201]]);
  assert.equal(st.test.find((x) => !x.ok).error, "BadJwtToken");
  assert.equal(st.phones.length, 2);
  assert.ok(st.phones.every((p) => p.service === "push.example.com" && p.last_sent_at && !("endpoint" in p)));
  assert.equal(st.phones.find((p) => p.last_status === 403).last_error, "BadJwtToken");
  assert.equal((await call("GET", "/api/push/status", { cookie: owner.cookie })).json().test, null, "no send without ?test=1");
  assert.equal((await call("GET", "/api/push/status?test=1", { cookie: member.cookie })).statusCode, 403);
  assert.equal((await call("POST", "/api/push/test", { cookie: owner.cookie })).statusCode, 404, "no test button endpoint");
  await call("POST", "/api/push/unsubscribe", { cookie: owner.cookie, payload: { endpoint: sub(9).endpoint } });
});

test("turning alerts off removes this phone", async () => {
  assert.equal((await call("POST", "/api/push/unsubscribe", { cookie: owner.cookie, payload: { endpoint: sub(1).endpoint } })).statusCode, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_subscriptions").get().n, 0);
});

test.after(async () => { await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
