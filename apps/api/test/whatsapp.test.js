import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
process.env.APP_BASE_URL = "https://paceup.example";
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { WhatsAppWorker } = await import("../src/whatsapp/worker.js");
const { fakeAdapter, sent, fakeSessions } = await import("../src/whatsapp/fake-adapter.js");
const app = await buildApp({ logger: false, authRateLimit: 1000 });
const { call, registerOwner, invite } = makeClient(app);
const worker = new WhatsAppWorker({ adapter: fakeAdapter, dataDir: mkdtempSync(join(tmpdir(), "wa-")), log: {}, sendGapMs: [0, 1] });
const settle = () => new Promise((r) => setTimeout(r, 10));
const makeDue = () => db.prepare("UPDATE outbox SET not_before = ? WHERE status = 'pending'").run(new Date(Date.now() - 1000).toISOString());
const pending = (clubId) => db.prepare("SELECT * FROM outbox WHERE club_id = ? AND status = 'pending'").all(clubId);

async function joinAs(owner, name, email) {
  const token = await invite(owner.cookie, owner.clubId, email);
  return { cookie: sessionCookie(await call("POST", "/api/auth/register", { payload: { name, email, password: "strong-password-123", inviteToken: token } })) };
}

const a = await registerOwner("Priya Sharma", "priya@example.com", "Club A");
const b = await registerOwner("Bala Owner", "bala@example.com", "Club B");
const riders = [await joinAs(a, "Arjun Rao", "arjun@example.com"), await joinAs(a, "Meera Iyer", "meera@example.com"), await joinAs(a, "Karthik Nair", "karthik@example.com")];
const wa = (club, method = "GET", suffix = "", payload) => call(method, `/api/clubs/${club.clubId}/whatsapp${suffix}`, { cookie: club.cookie, payload });
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
let rideCode, rideId;

test("pairing: connect shows a QR, scanning connects and lists the number's groups", async () => {
  assert.equal((await call("GET", `/api/clubs/${a.clubId}/whatsapp`, { cookie: riders[0].cookie })).statusCode, 404, "members can't see the club's WhatsApp");
  assert.equal((await wa(a, "POST", "/connect")).json().whatsapp.desired, "on");
  await worker.tick();
  const pairing = (await wa(a)).json().whatsapp;
  assert.equal(pairing.status, "pairing");
  assert.match(pairing.qr, /^data:image\/png;base64,/);

  fakeSessions.get(a.clubId).scan();
  await settle();
  const connected = (await wa(a)).json().whatsapp;
  assert.equal(connected.status, "connected");
  assert.equal(connected.phone, "+91 xxxxxx4521");
  assert.equal(connected.groups.length, 2);

  assert.equal((await wa(a, "PUT", "/group", { jid: "made-up@g.us" })).statusCode, 400);
  assert.equal((await wa(a, "PUT", "/group", { jid: connected.groups[0].jid })).json().whatsapp.group.name, "Club group");
  // Club B cannot point its posting at club A's group.
  assert.equal((await wa(b, "PUT", "/group", { jid: connected.groups[0].jid })).statusCode, 400);
});

test("a published ride is posted to the club's group, through the club's own session", async () => {
  const res = await call("POST", `/api/clubs/${a.clubId}/rides`, { cookie: a.cookie, payload: { title: "Nandi Hills long ride", category: "cycling", starts_at: inDays(3), meeting_point: "Hebbal flyover", distance_km: 62, capacity: 20, status: "published" } });
  ({ code: rideCode, id: rideId } = res.json().ride);
  assert.equal(pending(a.clubId).length, 1);
  makeDue(); await worker.tick();
  const msg = sent.at(-1);
  assert.equal(msg.clubId, a.clubId);
  assert.equal(msg.jid, (await wa(a)).json().whatsapp.group.jid);
  assert.match(msg.text, /New ride: Nandi Hills long ride/);
  assert.match(msg.text, new RegExp(`https://paceup.example/r/${rideCode}`));
});

test("RSVPs never wait on WhatsApp, and a burst becomes one rider-list post", async () => {
  for (const r of riders) assert.equal((await call("PUT", `/api/r/${rideCode}/rsvp`, { cookie: r.cookie, payload: { status: "going" } })).statusCode, 200);
  const queued = pending(a.clubId);
  assert.equal(queued.length, 1, "three RSVPs, one queued post");
  assert.ok(new Date(queued[0].not_before).getTime() > Date.now(), "waits for the burst to settle");
  makeDue(); const before = sent.length; await worker.tick();
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1).text, /\*3 \/ 20 going\*/);
  assert.match(sent.at(-1).text, /1\. Arjun R\.\n2\. Meera I\.\n3\. Karthik N\./);

  await call("PUT", `/api/r/${rideCode}/rsvp`, { cookie: riders[1].cookie, payload: { status: "cancelled" } });
  await call("PUT", `/api/r/${rideCode}/rsvp`, { cookie: a.cookie, payload: { status: "going" } });
  const next = pending(a.clubId)[0];
  const lastSent = db.prepare("SELECT MAX(sent_at) AS t FROM outbox WHERE ride_id = ? AND kind = 'rider_list' AND status = 'sent'").get(rideId).t;
  assert.ok(new Date(next.not_before) - new Date(lastSent) >= 2 * 60 * 1000, "at most one list post per ride every 2 minutes");
  makeDue(); await worker.tick();
  assert.match(sent.at(-1).text, /Priya S\. \(organiser\) 🆕/);
  assert.match(sent.at(-1).text, /Dropped out: Meera I\./);
});

test("when WhatsApp is down, posts wait; failures retry with backoff", async () => {
  fakeSessions.get(a.clubId).drop();
  assert.equal((await wa(a)).json().whatsapp.status, "reconnecting");
  await call("PUT", `/api/r/${rideCode}/rsvp`, { cookie: riders[1].cookie, payload: { status: "going" } });
  makeDue(); const before = sent.length; await worker.tick();
  assert.equal(sent.length, before, "nothing sent while disconnected");
  assert.equal(pending(a.clubId).length, 1, "still queued");

  // Reconnect (the worker retries after its backoff), then fail the first send.
  for (const [, e] of worker.sessions) e.retryAt = 0;
  await worker.tick(); fakeSessions.get(a.clubId).scan(); await settle();
  fakeSessions.get(a.clubId).failNext = 1;
  makeDue(); await worker.tick();
  const row = pending(a.clubId)[0];
  assert.equal(row.attempts, 1);
  assert.ok(new Date(row.not_before).getTime() > Date.now(), "retried later");
  makeDue(); await worker.tick();
  assert.equal(pending(a.clubId).length, 0);
  assert.match(sent.at(-1).text, /\*4 \/ 20 going\*/);
});

test("hourly cap holds posts back instead of dropping them", async () => {
  const insert = db.prepare("INSERT INTO outbox (id, club_id, kind, status, not_before, created_at, sent_at) VALUES (?, ?, 'test', 'sent', ?, ?, ?)");
  const t = new Date(Date.now() - 10 * 60 * 1000).toISOString();
  for (let i = 0; i < 20; i++) insert.run(`cap-${i}`, a.clubId, t, t, t);
  assert.equal((await wa(a, "POST", "/test")).statusCode, 200);
  const before = sent.length; await worker.tick();
  assert.equal(sent.length, before);
  assert.ok(new Date(pending(a.clubId)[0].not_before).getTime() > Date.now() + 40 * 60 * 1000);
  db.prepare("DELETE FROM outbox WHERE id LIKE 'cap-%'").run();
  db.prepare("UPDATE outbox SET status = 'skipped' WHERE status = 'pending'").run();
});

test("cancelling drops the queued list and posts the cancellation; turned-off kinds are skipped", async () => {
  await call("PUT", `/api/r/${rideCode}/rsvp`, { cookie: riders[2].cookie, payload: { status: "cancelled" } });
  assert.equal(pending(a.clubId).length, 1);
  await call("PATCH", `/api/clubs/${a.clubId}/rides/${rideId}`, { cookie: a.cookie, payload: { status: "cancelled" } });
  assert.deepEqual(pending(a.clubId).map((r) => r.kind), ["ride_cancelled"]);
  makeDue(); await worker.tick();
  assert.match(sent.at(-1).text, /Cancelled: Nandi Hills long ride/);

  await wa(a, "PATCH", "/settings", { post_new_ride: false });
  await call("POST", `/api/clubs/${a.clubId}/rides`, { cookie: a.cookie, payload: { title: "Quiet ride", starts_at: inDays(2), meeting_point: "Park", status: "published" } });
  makeDue(); const before = sent.length; await worker.tick();
  assert.equal(sent.length, before);
  assert.equal(db.prepare("SELECT status FROM outbox WHERE kind = 'ride_published' ORDER BY created_at DESC LIMIT 1").get().status, "skipped");
});

test("a club without WhatsApp queues nothing and never touches another club's session", async () => {
  await call("POST", `/api/clubs/${b.clubId}/rides`, { cookie: b.cookie, payload: { title: "B ride", starts_at: inDays(2), meeting_point: "B park", status: "published" } });
  assert.equal(pending(b.clubId).length, 0);
  assert.ok(sent.every((m) => m.clubId === a.clubId));
});

test("groups: a newly joined group shows up on its own, and Refresh re-reads the list", async () => {
  const session = fakeSessions.get(a.clubId);
  assert.ok(session?.open, "club A is connected");
  // WhatsApp reports the number joined a new group.
  session.joinGroup({ jid: `${a.clubId.slice(0, 8)}-new@g.us`, name: "New riders", size: 3 });
  await worker.tick();
  let view = (await wa(a)).json().whatsapp;
  assert.ok(view.groups.some((g) => g.name === "New riders"), "event-driven refresh picked up the new group");

  // A change WhatsApp didn't announce: the admin presses Refresh.
  session.groups = [...session.groups, { jid: `${a.clubId.slice(0, 8)}-quiet@g.us`, name: "Quiet group", size: 2 }];
  await new Promise((r) => setTimeout(r, 5));
  view = (await wa(a, "POST", "/groups/refresh")).json().whatsapp;
  assert.equal(view.groups_refreshing, true);
  await worker.tick();
  view = (await wa(a)).json().whatsapp;
  assert.equal(view.groups_refreshing, false);
  assert.ok(view.groups.some((g) => g.name === "Quiet group"));
  assert.equal((await wa(a, "PUT", "/group", { jid: `${a.clubId.slice(0, 8)}-quiet@g.us` })).json().whatsapp.group.name, "Quiet group");
  // Members can't trigger it, and an unconnected club gets a clear error.
  assert.equal((await call("POST", `/api/clubs/${a.clubId}/whatsapp/groups/refresh`, { cookie: riders[0].cookie })).statusCode, 404);
  assert.equal((await wa(b, "POST", "/groups/refresh")).statusCode, 409);
});

test("unlinking from the phone or disconnecting in PaceUp stops posting cleanly", async () => {
  fakeSessions.get(a.clubId).drop(true);
  let s = (await wa(a)).json().whatsapp;
  assert.equal(s.status, "logged_out");
  assert.equal(s.desired, "off");
  await wa(a, "POST", "/connect"); await worker.tick(); fakeSessions.get(a.clubId).scan(); await settle();
  await wa(a, "POST", "/disconnect"); await worker.tick();
  s = (await wa(a)).json().whatsapp;
  assert.equal(s.status, "disconnected");
  assert.equal(s.group, null);
  assert.equal(fakeSessions.has(a.clubId), false);
});

test.after(async () => { worker.stop(); await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
