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
// Here Priya and Bala are club admins of clubs with no owner, so only the PaceUp Admin links the number;
// owners linking their own number are in onboarding.test.js.
db.prepare("UPDATE club_memberships SET role = 'admin' WHERE role = 'owner'").run();
const riders = [await joinAs(a, "Arjun Rao", "arjun@example.com"), await joinAs(a, "Meera Iyer", "meera@example.com"), await joinAs(a, "Karthik Nair", "karthik@example.com")];
const asSuper = async (club, fn) => { // only the Super Admin links or unlinks the number
  db.prepare("UPDATE users SET platform_role = 'super_admin' WHERE id = ?").run(club.user.id);
  try { return await fn(); } finally { db.prepare("UPDATE users SET platform_role = 'user' WHERE id = ?").run(club.user.id); }
};
const wa = (club, method = "GET", suffix = "", payload) => call(method, `/api/clubs/${club.clubId}/whatsapp${suffix}`, { cookie: club.cookie, payload });
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
let rideCode, rideId;

test("pairing: connect shows a QR, scanning connects and lists the number's groups", async () => {
  assert.equal((await call("GET", `/api/clubs/${a.clubId}/whatsapp`, { cookie: riders[0].cookie })).statusCode, 404, "members can't see the club's WhatsApp");
  assert.equal((await asSuper(a, () => wa(a, "POST", "/connect"))).json().whatsapp.desired, "on");
  await worker.tick();
  assert.equal((await wa(a)).json().whatsapp.qr, null, "the link code is for the Super Admin, not club admins");
  const pairing = (await asSuper(a, () => wa(a))).json().whatsapp;
  assert.equal(pairing.status, "pairing");
  assert.match(pairing.qr, /^data:image\/png;base64,/);

  fakeSessions.get(a.clubId).scan();
  await settle();
  const connected = (await wa(a)).json().whatsapp;
  assert.equal(connected.status, "connected");
  assert.equal(connected.phone, "+91 xxxxxx4521");
  // The linked phone may be personal: the club admin sees none of its groups until the Super Admin links some.
  assert.equal(connected.groups.length, 0);
  assert.equal(connected.groups_linked, 0);
  assert.equal(connected.can_pick_groups, false, "a club admin gets no link to the Super Admin picker");
  const all = fakeSessions.get(a.clubId).groups;
  assert.equal((await wa(a, "PUT", "/group", { jid: all[0].jid })).statusCode, 400, "can't post to an unlinked group");
  const platform = (method = "GET", payload, who = a) => call(method, `/api/platform/clubs/${a.clubId}/whatsapp-groups`, { cookie: who.cookie, payload });
  assert.equal((await platform()).statusCode, 403, "club admins can't list the phone's groups");
  db.prepare("UPDATE users SET platform_role = 'super_admin' WHERE email = 'bala@example.com'").run();
  const pv = (await platform("GET", undefined, b)).json();
  assert.equal((await wa(b)).json().whatsapp.can_pick_groups, true);
  assert.equal((await call("GET", "/api/auth/me", { cookie: b.cookie })).json().user.super_admin, true);
  assert.equal((await call("GET", "/api/auth/me", { cookie: a.cookie })).json().user.super_admin, false);
  assert.equal(pv.groups.length, 2);
  assert.ok(pv.groups.every((g) => !g.linked));
  assert.equal((await platform("PUT", { jids: ["made-up@g.us"] }, b)).statusCode, 400);
  const linked = (await platform("PUT", { jids: all.map((g) => g.jid) }, b)).json();
  assert.ok(linked.groups.every((g) => g.linked));
  const connected2 = (await wa(a)).json().whatsapp;
  assert.equal(connected2.groups.length, 2);
  Object.assign(connected, connected2);

  assert.equal((await wa(a, "PUT", "/group", { jid: "made-up@g.us" })).statusCode, 400);
  assert.equal((await wa(a, "PUT", "/group", { jid: connected.groups[0].jid })).json().whatsapp.group.name, "Club group");
  // Club B cannot point its posting at club A's group.
  assert.equal((await wa(b, "PUT", "/group", { jid: connected.groups[0].jid })).statusCode, 400);
});

test("/health shows which code the WhatsApp worker runs, so a deploy can confirm the worker restarted", async () => {
  await worker.tick();
  const health = (await call("GET", "/health")).json();
  assert.equal(health.worker_version, health.version ?? "unknown");
  assert.ok(health.worker_seen_s >= 0 && health.worker_seen_s < 15);
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
  assert.match(msg.text, /\nOrganiser: [^\n]+\nLead: Priya S\./, "the club organises, the admin leads");
  assert.match(msg.text, /\*1 \/ 20 going\*\n1\. Priya S\. \(lead\)/, "the lead is on the list from the first post");
  assert.match(msg.text, new RegExp(`https://paceup.example/r/${rideCode}`));
});

test("the monthly Most regular shout-out goes to the club's default group from its own number", async () => {
  const month = new Date().toISOString().slice(0, 7);
  const ride = db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId);
  db.prepare("UPDATE rides SET starts_at = ? WHERE id = ?").run(new Date(Date.now() - 3600000).toISOString(), rideId);
  try {
    const res = await call("POST", `/api/clubs/${a.clubId}/regulars/post`, { cookie: a.cookie, payload: { month } });
    assert.equal(res.statusCode, 200, res.body);
    makeDue(); await worker.tick();
    const msg = sent.at(-1);
    assert.equal(msg.clubId, a.clubId);
    assert.equal(msg.jid, (await wa(a)).json().whatsapp.group.jid);
    assert.match(msg.text, /Most regular in \w+\*\n1\. Priya S\. · 1/);
  } finally { db.prepare("UPDATE rides SET starts_at = ? WHERE id = ?").run(ride.starts_at, rideId); }
});

test("an activity can post to a different group than the club default; only the club's groups are allowed", async () => {
  const info = (await wa(a)).json().whatsapp;
  const other = info.groups.find((g) => g.jid !== info.group.jid);
  const bad = await call("POST", `/api/clubs/${a.clubId}/rides`, { cookie: a.cookie, payload: { title: "Explorer loop", category: "cycling", starts_at: inDays(4), meeting_point: "Gate 2", wa_group_jid: "someone-else@g.us", status: "published" } });
  assert.equal(bad.statusCode, 400);
  const res = await call("POST", `/api/clubs/${a.clubId}/rides`, { cookie: a.cookie, payload: { title: "Explorer loop", category: "cycling", starts_at: inDays(4), meeting_point: "Gate 2", wa_group_jid: other.jid, status: "published" } });
  assert.equal(res.statusCode, 201, res.body);
  makeDue(); await worker.tick();
  assert.equal(sent.at(-1).jid, other.jid);
  assert.match(sent.at(-1).text, /Explorer loop/);
  // Its list updates go to the same group.
  assert.equal((await call("PUT", `/api/r/${res.json().ride.code}/rsvp`, { cookie: a.cookie, payload: { status: "going" } })).statusCode, 200);
  for (let i = 0; i < 3; i++) { makeDue(); await worker.tick(); }
  const list = sent.filter((m) => /Explorer loop/.test(m.text)).at(-1);
  assert.equal(list.jid, other.jid);
  await call("PATCH", `/api/clubs/${a.clubId}/rides/${res.json().ride.id}`, { cookie: a.cookie, payload: { status: "cancelled" } });
  for (let i = 0; i < 3; i++) { makeDue(); await worker.tick(); }
});

test("RSVPs never wait on WhatsApp, and a burst becomes one rider-list post", async () => {
  // The lead steps out first so we can see them come back as new further down.
  assert.equal((await call("PUT", `/api/r/${rideCode}/rsvp`, { cookie: a.cookie, payload: { status: "cancelled" } })).statusCode, 200);
  for (const r of riders) assert.equal((await call("PUT", `/api/r/${rideCode}/rsvp`, { cookie: r.cookie, payload: { status: "going" } })).statusCode, 200);
  const queued = pending(a.clubId);
  assert.equal(queued.length, 1, "four RSVP changes, one queued post");
  assert.ok(new Date(queued[0].not_before).getTime() > Date.now(), "waits for the burst to settle");
  makeDue(); const before = sent.length; await worker.tick();
  assert.equal(sent.length, before + 1);
  assert.match(sent.at(-1).text, /\*3 \/ 20 going\*/);
  assert.match(sent.at(-1).text, /1\. Arjun R\. 🆕\n2\. Meera I\. 🆕\n3\. Karthik N\. 🆕/);
  assert.match(sent.at(-1).text, /📍 Hebbal flyover\n62 km · 20 spots\nOrganiser: Club A\nLead: Priya S\./, "every list post carries the full details");
  assert.match(sent.at(-1).text, /Dropped out: Priya S\./);

  await call("PUT", `/api/r/${rideCode}/rsvp`, { cookie: riders[1].cookie, payload: { status: "cancelled" } });
  await call("PUT", `/api/r/${rideCode}/rsvp`, { cookie: a.cookie, payload: { status: "going" } });
  const next = pending(a.clubId)[0];
  const lastSent = db.prepare("SELECT MAX(sent_at) AS t FROM outbox WHERE ride_id = ? AND kind = 'rider_list' AND status = 'sent'").get(rideId).t;
  assert.ok(new Date(next.not_before) - new Date(lastSent) >= 30 * 1000, "at most one list post per ride every 30 seconds");
  makeDue(); await worker.tick();
  assert.match(sent.at(-1).text, /Priya S\. \(lead\) 🆕/);
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

test("a change post repeats everything: details, Organiser, Lead, notes, who's going and the link", async () => {
  await call("PATCH", `/api/clubs/${a.clubId}/rides/${rideId}`, { cookie: a.cookie, payload: { meeting_point: "Hebbal flyover, Gate 3", map_url: "https://maps.app.goo.gl/abc123", notes: "Bring lights." } });
  assert.deepEqual(pending(a.clubId).map((r) => r.kind), ["ride_updated"]);
  makeDue(); await worker.tick();
  const text = sent.at(-1).text;
  assert.match(text, /^✏️ \*Ride changed: Nandi Hills long ride\*\n/);
  assert.match(text, /📍 Hebbal flyover, Gate 3\n🗺️ https:\/\/maps\.app\.goo\.gl\/abc123\n62 km · 20 spots\nOrganiser: Club A\nLead: Priya S\.\n\nBring lights\.\n\n👇 \*Tap the link to join or drop out\.\*\nhttps:\/\/paceup\.example\/r\/[^\n]+\n\*4 \/ 20 going\*\n1\. Arjun R\.\n/, "join link above the list, list last");
  assert.match(text, /\(lead\)/);
  assert.match(text, new RegExp(`drop out\\.\\*\nhttps://paceup.example/r/${rideCode}\n[\\s\\S]*\n\nNo need to copy/paste this list, it updates itself\\.$`));
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
  assert.ok(!view.groups.some((g) => g.name === "New riders"), "a new group on the phone stays hidden from club admins");
  const platformGroups = async () => (await call("GET", `/api/platform/clubs/${a.clubId}/whatsapp-groups`, { cookie: b.cookie })).json().groups;
  assert.ok((await platformGroups()).some((g) => g.name === "New riders" && !g.linked), "event-driven refresh picked up the new group for the Super Admin");

  // A change WhatsApp didn't announce: the admin presses Refresh.
  session.groups = [...session.groups, { jid: `${a.clubId.slice(0, 8)}-quiet@g.us`, name: "Quiet group", size: 2 }];
  await new Promise((r) => setTimeout(r, 5));
  view = (await wa(a, "POST", "/groups/refresh")).json().whatsapp;
  assert.equal(view.groups_refreshing, true);
  await worker.tick();
  view = (await wa(a)).json().whatsapp;
  assert.equal(view.groups_refreshing, false);
  assert.ok(!view.groups.some((g) => g.name === "Quiet group"));
  const pg = await platformGroups();
  assert.ok(pg.some((g) => g.name === "Quiet group"));
  await call("PUT", `/api/platform/clubs/${a.clubId}/whatsapp-groups`, { cookie: b.cookie, payload: { jids: [...pg.filter((g) => g.linked).map((g) => g.jid), `${a.clubId.slice(0, 8)}-quiet@g.us`] } });
  assert.ok((await wa(a)).json().whatsapp.groups.some((g) => g.name === "Quiet group"));
  assert.equal((await wa(a, "PUT", "/group", { jid: `${a.clubId.slice(0, 8)}-quiet@g.us` })).json().whatsapp.group.name, "Quiet group");
  // Members can't trigger it, and an unconnected club gets a clear error.
  assert.equal((await call("POST", `/api/clubs/${a.clubId}/whatsapp/groups/refresh`, { cookie: riders[0].cookie })).statusCode, 404);
  assert.equal((await wa(b, "POST", "/groups/refresh")).statusCode, 409);
});

test("Super Admin unlinking a group takes it away from the club everywhere", async () => {
  const pre = (await wa(a)).json().whatsapp;
  assert.equal(pre.group.name, "Quiet group");
  const keep = pre.groups.filter((g) => g.name !== "Quiet group").map((g) => g.jid);
  const quiet = pre.groups.find((g) => g.name === "Quiet group").jid;
  // A template and an activity can't name a group outside the club's.
  assert.equal((await call("POST", `/api/clubs/${a.clubId}/templates`, { cookie: a.cookie, payload: { name: "Secret", title: "X", wa_group_jid: "personal@g.us" } })).statusCode, 400);
  const rideRes = await call("POST", `/api/clubs/${a.clubId}/rides`, { cookie: a.cookie, payload: { title: "Quiet loop", category: "cycling", starts_at: inDays(5), meeting_point: "Gate 3", status: "draft", wa_group_jid: quiet } });
  assert.equal(rideRes.statusCode, 201, rideRes.body);

  await call("PUT", `/api/platform/clubs/${a.clubId}/whatsapp-groups`, { cookie: b.cookie, payload: { jids: keep } });
  const after = (await wa(a)).json().whatsapp;
  assert.equal(after.group, null, "the default posting group was unlinked, so the club picks again");
  assert.ok(!after.groups.some((g) => g.jid === quiet));
  assert.ok(after.member_groups.every((g) => g.jid !== quiet));
  assert.equal((await wa(a, "POST", "/test")).statusCode, 409);
  assert.equal((await call("POST", `/api/clubs/${a.clubId}/rides`, { cookie: a.cookie, payload: { title: "Nope", category: "cycling", starts_at: inDays(5), meeting_point: "Gate 3", wa_group_jid: quiet } })).statusCode, 400);
  // The audit log records who changed it.
  assert.ok((await call("GET", "/api/platform/audit", { cookie: b.cookie })).json().entries.some((e) => e.action === "club.whatsapp_groups"));
  await wa(a, "PUT", "/group", { jid: keep[0] });
});

test("only the club owner makes and unmakes club admins; the owner can hand the club over", async () => {
  const members = (await call("GET", `/api/clubs/${a.clubId}/members`, { cookie: a.cookie })).json().members;
  const arjun = members.find((m) => m.name === "Arjun Rao");
  const set = (who, id, role) => call("PATCH", `/api/clubs/${a.clubId}/members/${id}/role`, { cookie: who.cookie, payload: { role } });
  assert.equal((await set(riders[1], arjun.id, "admin")).statusCode, 404, "members can't promote");
  assert.equal((await set(a, arjun.id, "admin")).statusCode, 403, "a club admin can't make admins");
  assert.equal((await call("POST", `/api/clubs/${a.clubId}/people`, { cookie: a.cookie, payload: { phone: "+91 90000 00001", name: "New Admin", role: "admin" } })).statusCode, 403);
  // Priya becomes the club's owner.
  db.prepare("UPDATE club_memberships SET role = 'owner' WHERE club_id = ? AND user_id = ?").run(a.clubId, a.user.id);
  assert.equal((await set(a, arjun.id, "admin")).json().member.role, "admin");
  assert.equal((await call("GET", `/api/clubs/${a.clubId}/whatsapp`, { cookie: riders[0].cookie })).statusCode, 200, "the new admin sees the club's WhatsApp");
  assert.equal((await call("GET", `/api/platform/clubs/${a.clubId}/whatsapp-groups`, { cookie: riders[0].cookie })).statusCode, 403, "but not every group on the phone");
  const arjunWa = (await call("GET", `/api/clubs/${a.clubId}/whatsapp`, { cookie: riders[0].cookie })).json().whatsapp;
  assert.equal(arjunWa.stats, undefined, "message counts are for the owner");
  assert.ok((await wa(a)).json().whatsapp.stats, "the owner sees message counts");
  assert.equal((await call("DELETE", `/api/clubs/${a.clubId}/members/${a.user.id}`, { cookie: riders[0].cookie })).statusCode, 409, "nobody removes the owner");
  assert.equal((await call("PATCH", `/api/clubs/${a.clubId}`, { cookie: riders[0].cookie, payload: { name: "Arjun's Club" } })).statusCode, 403, "admins can't rename");
  assert.equal((await call("PUT", `/api/clubs/${a.clubId}/owner`, { cookie: riders[0].cookie, payload: { userId: arjun.id } })).statusCode, 403, "admins can't take the club");

  // The owner hands the club to Arjun and stays on as an admin; there is only ever one owner.
  const handed = await call("PUT", `/api/clubs/${a.clubId}/owner`, { cookie: a.cookie, payload: { userId: arjun.id } });
  assert.equal(handed.json().owner_id, arjun.id);
  const roles = Object.fromEntries((await call("GET", `/api/clubs/${a.clubId}/members`, { cookie: riders[0].cookie })).json().members.map((m) => [m.name, m.role]));
  assert.equal(roles["Arjun Rao"], "owner");
  assert.equal(roles["Priya Sharma"], "admin");
  assert.throws(() => db.prepare("UPDATE club_memberships SET role = 'owner' WHERE club_id = ? AND user_id = ?").run(a.clubId, a.user.id), /UNIQUE/);
  // Back as it was for the tests below: Priya a plain admin, Arjun a member, no owner.
  db.prepare("UPDATE club_memberships SET role = 'member' WHERE club_id = ? AND user_id = ?").run(a.clubId, arjun.id);
  assert.equal((await call("GET", `/api/clubs/${a.clubId}/whatsapp`, { cookie: riders[0].cookie })).statusCode, 404);
});

test("unlinking from the phone or disconnecting in PaceUp stops posting cleanly", async () => {
  fakeSessions.get(a.clubId).drop(true);
  let s = (await wa(a)).json().whatsapp;
  assert.equal(s.status, "logged_out");
  assert.equal(s.desired, "off");
  await asSuper(a, () => wa(a, "POST", "/connect")); await worker.tick(); fakeSessions.get(a.clubId).scan(); await settle();
  await asSuper(a, () => wa(a, "POST", "/disconnect")); await worker.tick();
  s = (await wa(a)).json().whatsapp;
  assert.equal(s.status, "disconnected");
  assert.equal(s.group, null);
  assert.equal(fakeSessions.has(a.clubId), false);
});

test("message counts, the link code, connect and disconnect are Super Admin only", async () => {
  db.prepare("UPDATE users SET platform_role = 'user' WHERE id = ?").run(a.user.id);
  const club = (await wa(a)).json().whatsapp;
  assert.equal(club.stats, undefined, "a club admin's response has no stats at all");
  assert.equal((await wa(a, "POST", "/connect")).statusCode, 403, "club admins can't link the number");
  assert.equal((await wa(a, "POST", "/disconnect")).statusCode, 403, "or unlink it");
  assert.equal((await wa(a, "PATCH", "/settings", { quiet_hours: false })).json().whatsapp.stats, undefined, "action responses leave stats out too");
  db.prepare("UPDATE users SET platform_role = 'super_admin' WHERE id = ?").run(a.user.id);
  const sup = (await wa(a)).json().whatsapp;
  assert.deepEqual(Object.keys(sup.stats).sort(), ["failed_24h", "last_sent_at", "pending", "sent_24h"]);
  db.prepare("UPDATE users SET platform_role = 'user' WHERE id = ?").run(a.user.id);
});

test("one number serves one club: linking a number another club already uses is refused and unlinked", async () => {
  await asSuper(a, () => wa(a, "POST", "/connect")); await worker.tick(); await fakeSessions.get(a.clubId).scan("919811100001"); await settle();
  assert.equal((await wa(a)).json().whatsapp.status, "connected");
  await asSuper(b, () => wa(b, "POST", "/connect")); await worker.tick();
  await fakeSessions.get(b.clubId).scan("919811100001"); await settle();
  const refused = (await wa(b)).json().whatsapp;
  assert.equal(refused.status, "disconnected");
  assert.equal(refused.desired, "off");
  assert.match(refused.last_error, /already linked to another club/);
  assert.equal(fakeSessions.has(b.clubId), false, "the duplicate link was removed");
  assert.equal((await wa(a)).json().whatsapp.status, "connected", "the first club keeps its number");
  await asSuper(b, () => wa(b, "POST", "/connect")); await worker.tick(); await fakeSessions.get(b.clubId).scan("919811100002"); await settle();
  assert.equal((await wa(b)).json().whatsapp.status, "connected", "its own number links fine");
});

test.after(async () => { worker.stop(); await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
