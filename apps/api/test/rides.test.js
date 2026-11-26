import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import crypto from "node:crypto";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const ph = (n) => "98" + String([...n.toLowerCase().replace(/\s+/g, " ").trim()].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1e8, 7)).padStart(8, "0");
const app = await buildApp({ logger: false, authRateLimit: 1000, publicRateLimit: 1000 });
const { call, registerOwner, invite } = makeClient(app);

const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();
async function joinAs(owner, clubId, name, email) {
  const token = await invite(owner.cookie, clubId, email);
  const res = await call("POST", "/api/auth/register", { payload: { name, email, password: "strong-password-123", inviteToken: token } });
  assert.equal(res.statusCode, 201);
  return { cookie: sessionCookie(res), user: res.json().user };
}

const owner = await registerOwner("Priya Sharma", "priya@example.com", "Sunrise Riders");
const clubId = owner.clubId;
const arjun = await joinAs(owner, clubId, "Arjun Rao", "arjun@example.com");
const meera = await joinAs(owner, clubId, "Meera Iyer", "meera@example.com");
const outsider = await registerOwner("Other Owner", "other@example.com", "Other Club");

const rideBody = { title: "Nandi Hills long ride", starts_at: inDays(3), meeting_point: "Hebbal flyover", distance_km: 62, pace: "24-26 km/h", capacity: 2, notes: "Lights mandatory" };

const ridesOf = (club, when) => call("GET", `/api/clubs/${club}/rides${when ? `?when=${when}` : ""}`, { cookie: owner.cookie });
const deviceCookie = (res) => {
  const set = [].concat(res.headers["set-cookie"] || []).find((c) => c.startsWith("paceup_device="));
  return set ? set.split(";")[0] : null;
};
/** A phone with no account: keeps whatever device cookie the server gives it. */
function phone() {
  let cookie;
  return {
    get cookie() { return cookie; },
    async rsvp(code, payload) {
      const res = await call("PUT", `/api/r/${code}/rsvp`, { cookie, payload });
      cookie = deviceCookie(res) || cookie;
      return res;
    },
    view: (code) => call("GET", `/api/r/${code}`, { cookie })
  };
}
// The lead joins their own activity by default (see "the lead is on the list"). The RSVP tests below are
// about everyone else, so they start from an activity whose lead has dropped out.
const { cleanPhone } = await import("../src/roster.js");
/** Puts someone on the club's member list (as an admin upload would) and returns their number as typed. */
function listed(name, num = ph(name), club = clubId) {
  const phoneNo = cleanPhone(num), now = new Date().toISOString();
  db.prepare("INSERT OR IGNORE INTO club_roster (id, club_id, name, name_key, phone, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'upload', ?, ?)")
    .run(crypto.randomUUID(), club, name, name.toLowerCase(), phoneNo, now, now);
  return num;
}
const dropLead = (id) => db.prepare("DELETE FROM ride_rsvps WHERE ride_id = ? AND user_id = (SELECT organiser_id FROM rides WHERE id = ?)").run(id, id);
const publish = async (extra = {}) => { const ride = (await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...rideBody, status: "published", ...extra } })).json().ride; dropLead(ride.id); return ride; };

test("activity lifecycle: draft, publish, edit, unpublish, cancel, with an audit trail", async () => {
  const created = await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...rideBody, category: "running" } });
  assert.equal(created.statusCode, 201);
  const { code, id } = created.json().ride;
  assert.equal(created.json().ride.status, "draft");
  assert.equal(created.json().ride.category, "running");
  assert.ok(code.length >= 12, "public token is long enough to be unguessable");

  assert.equal((await call("GET", `/api/r/${code}`, { cookie: arjun.cookie })).statusCode, 404, "members can't see drafts");
  assert.equal((await call("GET", `/api/r/${code}`)).statusCode, 404, "nor can visitors");
  assert.equal((await call("GET", `/api/clubs/${clubId}/rides`, { cookie: arjun.cookie })).json().rides.length, 0);
  assert.equal((await call("POST", `/api/clubs/${clubId}/rides`, { cookie: arjun.cookie, payload: rideBody })).statusCode, 404, "members can't create");

  const published = await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "published", title: "Nandi Hills sunrise run" } });
  assert.equal(published.statusCode, 200);
  assert.equal(published.json().ride.title, "Nandi Hills sunrise run");
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "draft" } })).json().ride.status, "draft", "unpublish while only the lead is on the list");
  await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "published" } });
  await phone().rsvp(code, { status: "going", phone: listed("Rahul Verma") });
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "draft" } })).statusCode, 409, "can't unpublish once people joined");

  const cancelled = await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { status: "cancelled" } });
  assert.equal(cancelled.json().ride.status, "cancelled");
  assert.equal((await phone().rsvp(code, { status: "going", phone: listed("Late Comer") })).statusCode, 409);
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { title: "Revived" } })).statusCode, 409);

  const history = cancelled.json().ride.history.map((h) => h.action).reverse();
  assert.deepEqual(history, ["created_draft", "published", "unpublished", "published", "cancelled"]);
  assert.equal(cancelled.json().ride.history[0].metadata.going, 2, "cancellation records how many were going (the lead and Rahul)");
  assert.equal(cancelled.json().ride.history[0].actor_name, "Priya Sharma");
});

test("the lead is on the list by default once published, counts toward spots, and can drop out", async () => {
  const draft = (await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...rideBody, capacity: 2 } })).json().ride;
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ?").get(draft.id).n, 0, "nobody on a draft");
  const live = (await call("PATCH", `/api/clubs/${clubId}/rides/${draft.id}`, { cookie: owner.cookie, payload: { status: "published" } })).json().ride;
  assert.deepEqual(live.participants.map((p) => p.name), ["Priya Sharma"]);
  assert.equal(live.going_count, 1);
  // Publishing again (after unpublishing) doesn't add the lead twice.
  await call("PATCH", `/api/clubs/${clubId}/rides/${draft.id}`, { cookie: owner.cookie, payload: { status: "draft" } });
  await call("PATCH", `/api/clubs/${clubId}/rides/${draft.id}`, { cookie: owner.cookie, payload: { status: "published" } });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ?").get(draft.id).n, 1);
  assert.equal((await call("PUT", `/api/r/${live.code}/rsvp`, { cookie: arjun.cookie, payload: { status: "going" } })).json().ride.is_full, true, "the lead takes a spot");
  const out = await call("PUT", `/api/r/${live.code}/rsvp`, { cookie: owner.cookie, payload: { status: "cancelled" } });
  assert.deepEqual(out.json().ride.participants.map((p) => p.name), ["Arjun Rao"], "the lead can drop out like anyone");
});

test("public page: anyone with the link sees details and who's going; admins also see who is listed", async () => {
  const ride = await publish({ capacity: null });
  await call("PUT", `/api/r/${ride.code}/rsvp`, { cookie: arjun.cookie, payload: { status: "going" } });
  await phone().rsvp(ride.code, { status: "going", phone: listed("Rahul Verma") });

  const visitor = (await call("GET", `/api/r/${ride.code}`)).json().ride;
  assert.equal(visitor.notes, "Lights mandatory");
  assert.deepEqual(visitor.participants.map((p) => p.name), ["Arjun Rao", "Rahul Verma"]);
  assert.equal(visitor.participants[0].id, undefined, "no ids for the public");
  assert.equal(visitor.history, undefined);
  assert.equal(visitor.organiser.name, "Priya S.");

  const admin = (await call("GET", `/api/r/${ride.code}`, { cookie: owner.cookie })).json().ride;
  assert.deepEqual(admin.participants.map((p) => [p.name, p.kind]), [["Arjun Rao", "member"], ["Rahul Verma", "roster"]]);
});

test("members RSVP with one tap: no duplicates, change of mind, capacity", async () => {
  const { code, id } = await publish();
  const rsvp = (who, status) => call("PUT", `/api/r/${code}/rsvp`, { cookie: who.cookie, payload: { status } });

  const first = await rsvp(arjun, "going");
  assert.equal(first.statusCode, 200);
  assert.equal(first.json().ride.my_rsvp.name, "Arjun Rao");
  assert.equal(deviceCookie(first), null, "members need no device cookie");
  assert.equal((await rsvp(arjun, "going")).json().ride.going_count, 1, "repeat tap does not double count");
  await Promise.all([rsvp(arjun, "going"), rsvp(arjun, "going")]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ?").get(id).n, 1);

  assert.equal((await rsvp(meera, "going")).json().ride.is_full, true);
  const full = await rsvp(owner, "going");
  assert.equal(full.statusCode, 409);
  assert.match(full.json().error, /full/);

  const changed = await rsvp(arjun, "cancelled");
  assert.equal(changed.json().ride.my_rsvp, null);
  assert.equal(changed.json().ride.going_count, 1);
  assert.equal((await rsvp(owner, "going")).statusCode, 200, "freed spot can be taken");
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { capacity: 1 } })).statusCode, 409);
});

test("members join with their WhatsApp number, and only their own phone can change it", async () => {
  const { code, id } = await publish({ capacity: 5 });
  const num = listed("Rahul Verma");
  const rahul = phone();
  const joined = await rahul.rsvp(code, { status: "going", phone: ` ${num} ` });
  assert.equal(joined.statusCode, 200, joined.body);
  assert.ok(rahul.cookie, "device cookie issued");
  assert.match([].concat(joined.headers["set-cookie"]).join(), /HttpOnly/i);
  assert.equal(joined.json().ride.my_rsvp.name, "Rahul Verma", "the name comes from the member list");
  assert.equal((await rahul.view(code)).json().ride.participants[0].is_you, true, "reopening the link shows you're in");

  // Another phone cannot cancel it, nor join as Rahul a second time.
  const stranger = phone();
  const cancelTry = await stranger.rsvp(code, { status: "cancelled" });
  assert.equal(cancelTry.json().ride.going_count, 1, "stranger's cancel did nothing");
  assert.equal((await stranger.rsvp(code, { status: "going", phone: num })).statusCode, 409, "the same person twice is refused");
  const noNumber = await stranger.rsvp(code, { status: "going" });
  assert.equal(noNumber.statusCode, 400);
  assert.equal(noNumber.json().step, "need_phone");
  assert.equal((await stranger.rsvp(code, { status: "going", phone: "12" })).json().step, "need_phone");
  const forged = await call("PUT", `/api/r/${code}/rsvp`, { cookie: "paceup_device=not-a-real-token", payload: { status: "cancelled" } });
  assert.equal(forged.json().ride.going_count, 1);

  const gone = await rahul.rsvp(code, { status: "cancelled" });
  assert.equal(gone.json().ride.going_count, 0);
  assert.equal(gone.json().ride.my_rsvp, null);
  // This phone is remembered: next time it's one tap, no number.
  assert.equal(gone.json().ride.viewer.known_as, "Rahul Verma");
  const again = await rahul.rsvp(code, { status: "going" });
  assert.equal(again.json().ride.going_count, 1, "can rejoin with one tap");
  const other = await publish({ capacity: null });
  assert.equal((await rahul.rsvp(other.code, { status: "going" })).json().ride.my_rsvp.name, "Rahul Verma", "remembered on the next activity too");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ?").get(id).n, 1);
});

test("someone who isn't in the club is turned away and nothing about them is stored", async () => {
  const { code } = await publish({ capacity: null });
  const before = db.prepare("SELECT COUNT(*) AS n FROM club_roster WHERE club_id = ?").get(clubId).n;
  const res = await phone().rsvp(code, { status: "going", name: "Zoya Khan", phone: "98000 11122" });
  assert.equal(res.statusCode, 403);
  assert.equal(res.json().step, "not_member");
  assert.match(res.json().error, /members/);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM club_roster WHERE club_id = ?").get(clubId).n, before, "no longer added to the club list");
  assert.equal((await call("GET", `/api/r/${code}/names?q=zo`)).statusCode, 404, "the public name search is gone");
});

test("typing a listed name with your own number never takes over that person", async () => {
  const { code } = await publish({ capacity: null });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, phone, source, created_at, updated_at) VALUES (?, ?, 'Kiran Bedi', 'kiran bedi', NULL, 'upload', ?, ?)").run(crypto.randomUUID(), clubId, now, now);
  const res = await phone().rsvp(code, { status: "going", name: "Kiran Bedi", phone: "98000 22233" });
  assert.equal(res.statusCode, 403);
  assert.equal(db.prepare("SELECT phone FROM club_roster WHERE club_id = ? AND name_key = 'kiran bedi'").get(clubId).phone, null, "the listed person keeps no number");
});

test("in the club's WhatsApp group but not on the list: the first join asks the name once", async () => {
  const { code } = await publish({ capacity: null });
  db.prepare("INSERT INTO club_group_numbers (club_id, phone, name, updated_at) VALUES (?, '919800033344', NULL, ?)").run(clubId, new Date().toISOString());
  const p = phone();
  const first = await p.rsvp(code, { status: "going", phone: "98000 33344" });
  assert.equal(first.statusCode, 400);
  assert.equal(first.json().step, "need_name");
  const named = await p.rsvp(code, { status: "going", phone: "98000 33344", name: "neha jain" });
  assert.equal(named.statusCode, 200, named.body);
  assert.equal(named.json().ride.my_rsvp.name, "Neha Jain");
  const row = db.prepare("SELECT * FROM club_roster WHERE club_id = ? AND phone = '919800033344'").get(clubId);
  assert.equal(row.self_added, 1, "admins see who added themselves");
  const other = await publish({ capacity: null });
  assert.equal((await phone().rsvp(other.code, { status: "going", phone: "98000 33344" })).json().ride.my_rsvp.name, "Neha Jain", "next time the number is enough");
});

test("people who added themselves while activities were open only count if they're in a group", async () => {
  const { code } = await publish({ capacity: null });
  const now = new Date().toISOString();
  db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, phone, source, self_added, created_at, updated_at) VALUES (?, ?, 'Walk In', 'walk in', '919800044455', 'manual', 1, ?, ?)").run(crypto.randomUUID(), clubId, now, now);
  assert.equal((await phone().rsvp(code, { status: "going", phone: "98000 44455" })).statusCode, 403);
  db.prepare("INSERT INTO club_group_numbers (club_id, phone, updated_at) VALUES (?, '919800044455', ?)").run(clubId, now);
  assert.equal((await phone().rsvp(code, { status: "going", phone: "98000 44455" })).json().ride.my_rsvp.name, "Walk In");
});

test("club admins and members join by number from any phone; another club's members can't", async () => {
  const { code } = await publish({ capacity: null });
  db.prepare("UPDATE users SET phone = '919800055566' WHERE id = ?").run(meera.user.id);
  db.prepare("UPDATE users SET phone = '919800066677' WHERE id = ?").run(outsider.user.id);
  const picked = await phone().rsvp(code, { status: "going", phone: "98000 55566" });
  assert.equal(picked.json().ride.my_rsvp.name, "Meera Iyer");
  assert.equal((await call("GET", `/api/r/${code}`, { cookie: meera.cookie })).json().ride.my_rsvp.name, "Meera Iyer", "signed in, she sees she's in");
  assert.equal((await phone().rsvp(code, { status: "going", phone: "98000 66677" })).statusCode, 403);
  assert.equal((await call("PUT", `/api/r/${code}/rsvp`, { cookie: meera.cookie, payload: { status: "cancelled" } })).json().ride.going_count, 0);
});

test("asking to join: the Lead hears once a day per number, from the club's own number, and can add them", async () => {
  const ride = await publish({ capacity: null, title: "Sunday Trail Loop" });
  db.prepare("UPDATE users SET phone = '919811100011' WHERE id = ?").run(owner.user.id);
  db.prepare("INSERT OR IGNORE INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES ('sub1', ?, 'https://push.example/1', 'k', 'a', ?)").run(owner.user.id, new Date().toISOString());
  db.prepare("INSERT OR REPLACE INTO whatsapp_connections (club_id, status, desired, phone, updated_at) VALUES (?, 'connected', 'on', '919811100099', ?)").run(clubId, new Date().toISOString());
  const ask = (payload) => call("POST", `/api/r/${ride.code}/ask`, { payload });
  assert.equal((await ask({ name: "R", phone: "98000 77788" })).statusCode, 400);
  const sent = await ask({ name: "Rahul Mehta", phone: "98000 77788" });
  assert.equal(sent.statusCode, 200, sent.body);
  assert.deepEqual(sent.json(), { sent: true });
  const msgs = db.prepare("SELECT * FROM whatsapp_direct WHERE club_id = ? AND text LIKE '%Rahul Mehta%'").all(clubId);
  assert.equal(msgs.length, 1);
  assert.equal(msgs[0].to_phone, "919811100011", "to the Lead");
  assert.match(msgs[0].text, /\*Rahul Mehta\* \(\+91 98000 77788\) wants to join \*Sunday Trail Loop\*/);
  const linkCode = msgs[0].text.match(/\/m\/([A-Za-z0-9_-]+)/)[1];
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM push_queue WHERE user_id = ? AND body LIKE '%Rahul Mehta%'").get(owner.user.id).n, 1, "and a phone alert");
  // Again the same day: same answer for them, no second alert.
  assert.deepEqual((await ask({ name: "Rahul Mehta", phone: "+91 98000 77788" })).json(), { sent: true });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_direct WHERE club_id = ? AND text LIKE '%Rahul Mehta%'").get(clubId).n, 1);

  // Only this club's admins can open the link.
  const url = `/api/join-requests/${linkCode}`;
  assert.equal((await call("GET", url)).statusCode, 401);
  assert.equal((await call("GET", url, { cookie: arjun.cookie })).statusCode, 403);
  assert.equal((await call("GET", url, { cookie: outsider.cookie })).statusCode, 403);
  const view = (await call("GET", url, { cookie: owner.cookie })).json().request;
  assert.deepEqual([view.name, view.phone, view.status, view.activity.title], ["Rahul Mehta", "+91 98000 77788", "open", "Sunday Trail Loop"]);
  const added = await call("POST", url, { cookie: owner.cookie, payload: { action: "add" } });
  assert.equal(added.json().request.status, "added");
  const row = db.prepare("SELECT * FROM club_roster WHERE club_id = ? AND phone = '919800077788'").get(clubId);
  assert.equal(row.name, "Rahul Mehta");
  assert.equal(row.self_added, 0);
  assert.equal((await phone().rsvp(ride.code, { status: "going", phone: "98000 77788" })).json().ride.my_rsvp.name, "Rahul Mehta", "now they're in");
  // A member who asks is simply told so.
  assert.deepEqual((await ask({ name: "Rahul Mehta", phone: "98000 77788" })).json(), { member: true });
  db.prepare("DELETE FROM whatsapp_connections WHERE club_id = ?").run(clubId);
});

test("a member's second number: the Lead links it to them, and they join from either number", async () => {
  const ride = await publish({ capacity: null, title: "Second Phone Loop" });
  db.prepare("DELETE FROM join_requests").run();
  db.prepare("UPDATE users SET phone = '919811100011' WHERE id = ?").run(owner.user.id);
  db.prepare("INSERT OR REPLACE INTO whatsapp_connections (club_id, status, desired, phone, updated_at) VALUES (?, 'connected', 'on', '919811100099', ?)").run(clubId, new Date().toISOString());
  listed("Kavya Menon", "98111 04410");
  listed("Kavya Reddy", "98111 05520");
  const p1 = phone();
  assert.equal((await p1.rsvp(ride.code, { status: "going", phone: "98111 04410" })).json().ride.my_rsvp.name, "Kavya Menon");
  // From her other phone she's refused and asks to join.
  assert.equal((await phone().rsvp(ride.code, { status: "going", phone: "99999 12345" })).statusCode, 403);
  await call("POST", `/api/r/${ride.code}/ask`, { payload: { name: "Kavya Menon", phone: "99999 12345" } });
  const code = db.prepare("SELECT code FROM join_requests WHERE phone = '919999912345'").get().code;
  const url = `/api/join-requests/${code}`;
  const view = (await call("GET", url, { cookie: owner.cookie })).json().request;
  assert.equal(view.same_person.name, "Kavya Menon", "PaceUp spots the same name");
  assert.equal(view.same_person.phone, "+91 98111 ·· 4410");
  // Search shows names with the last 4 digits only, admins only.
  assert.equal((await call("GET", `${url}/people?q=kav`, { cookie: arjun.cookie })).statusCode, 403);
  const found = (await call("GET", `${url}/people?q=kav`, { cookie: owner.cookie })).json().people;
  assert.deepEqual(found.map((p) => [p.name, p.tail]), [["Kavya Menon", "4410"], ["Kavya Reddy", "5520"]]);
  const linked = await call("POST", url, { cookie: owner.cookie, payload: { action: "link", roster_id: view.same_person.id } });
  assert.equal(linked.statusCode, 200, linked.body);
  assert.equal(linked.json().request.linked_to, "Kavya Menon");
  assert.equal(linked.json().request.status, "added");
  // One person, two numbers: no new entry, and the second phone joins as her.
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM club_roster WHERE club_id = ? AND name LIKE 'Kavya%'").get(clubId).n, 2);
  assert.equal((await p1.rsvp(ride.code, { status: "cancelled" })).statusCode, 200);
  const p2 = phone();
  assert.equal((await p2.rsvp(ride.code, { status: "going", phone: "99999 12345" })).json().ride.my_rsvp.name, "Kavya Menon");
  assert.equal(db.prepare("SELECT COUNT(DISTINCT roster_id) AS n FROM ride_rsvps WHERE ride_id = ? AND roster_id IS NOT NULL").get(ride.id).n, 1, "same person on the list");
  assert.equal((await p2.rsvp(ride.code, { status: "going" })).statusCode, 200, "remembered on that phone");
  // The member list shows the extra number, and finds her by it.
  const roster = (await call("GET", `/api/clubs/${clubId}/roster?q=12345`, { cookie: owner.cookie })).json().people;
  assert.deepEqual(roster.map((p) => [p.name, p.extra_numbers]), [["Kavya Menon", 1]]);
  // Adding that number again as someone new is refused.
  assert.equal((await call("POST", `/api/clubs/${clubId}/roster`, { cookie: owner.cookie, payload: { name: "Someone New", phone: "99999 12345" } })).statusCode, 409);
  // Asking again from that number: they're a member now.
  assert.deepEqual((await call("POST", `/api/r/${ride.code}/ask`, { payload: { name: "Kavya", phone: "99999 12345" } })).json(), { member: true });
  db.prepare("DELETE FROM whatsapp_connections WHERE club_id = ?").run(clubId);
});

test("same-person hint only for one clear match; picking someone else from the list works", async () => {
  const ride = await publish({ capacity: null });
  db.prepare("DELETE FROM join_requests").run();
  listed("Vikram Shah", "98222 00001");
  listed("Vikram Joshi", "98222 00002");
  listed("Deepa Nair", "98222 00003");
  const ask = async (name, num) => {
    await call("POST", `/api/r/${ride.code}/ask`, { payload: { name, phone: num } });
    return `/api/join-requests/${db.prepare("SELECT code FROM join_requests WHERE phone = ?").get(cleanPhone(num)).code}`;
  };
  const vik = await ask("Vikram", "98333 00001");
  assert.equal((await call("GET", vik, { cookie: owner.cookie })).json().request.same_person, null, "two Vikrams: no guess");
  const deepa = await ask("Deepa N", "98333 00002");
  assert.equal((await call("GET", deepa, { cookie: owner.cookie })).json().request.same_person.name, "Deepa Nair", "close name");
  const stranger = await ask("Zed Kumar", "98333 00003");
  assert.equal((await call("GET", stranger, { cookie: owner.cookie })).json().request.same_person, null);
  const shah = db.prepare("SELECT id FROM club_roster WHERE phone = ?").get(cleanPhone("98222 00001")).id;
  assert.equal((await call("POST", vik, { cookie: owner.cookie, payload: { action: "link", roster_id: shah } })).json().request.linked_to, "Vikram Shah");
  // A number already on the list as someone else can't be linked to another person.
  const joshi = db.prepare("SELECT id FROM club_roster WHERE phone = ?").get(cleanPhone("98222 00002")).id;
  db.prepare("UPDATE join_requests SET status = 'open' WHERE code = ?").run(vik.split("/").pop());
  assert.equal((await call("POST", vik, { cookie: owner.cookie, payload: { action: "link", roster_id: joshi } })).statusCode, 409);
});

test("at most 20 alerts a day per club", async () => {
  const ride = await publish({ capacity: null });
  db.prepare("DELETE FROM join_requests").run();
  for (let i = 0; i < 22; i++) assert.equal((await call("POST", `/api/r/${ride.code}/ask`, { payload: { name: `Person ${i}`, phone: `98100 000${String(i).padStart(2, "0")}` } })).statusCode, 200);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM join_requests WHERE club_id = ? AND alerted = 1").get(clubId).n, 20);
});

test("simultaneous RSVPs never exceed capacity or duplicate a person", async () => {
  const { code, id } = await publish({ capacity: 2 });
  const phones = Array.from({ length: 6 }, () => phone());
  // Give each phone its device cookie first.
  for (const [i, p] of phones.entries()) { await p.rsvp(code, { status: "going", phone: listed(`Warmup ${i}`) }); await p.rsvp(code, { status: "cancelled" }); }
  const results = await Promise.all(phones.map((p, i) => p.rsvp(code, { status: "going", phone: listed(`Rider ${i}`) })));
  assert.equal(results.filter((r) => r.statusCode === 200).length, 2);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ? AND status = 'going'").get(id).n, 2);
  const again = await Promise.all([1, 2, 3].map(() => phones[0].rsvp(code, { status: "going", phone: listed("Rider 0") })));
  assert.ok(again.every((r) => r.statusCode === 200 || r.statusCode === 409));
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ? AND device_hash IS NOT NULL").get(id).n, 6, "one row per phone");
});

test("admins manage participants; other clubs can't touch them", async () => {
  const { code, id } = await publish();
  await phone().rsvp(code, { status: "going", phone: listed("Spam Name") });
  const admin = (await call("GET", `/api/r/${code}`, { cookie: owner.cookie })).json().ride;
  const rsvpId = admin.participants[0].id;
  const url = `/api/clubs/${clubId}/rides/${id}/participants/${rsvpId}`;
  assert.equal((await call("DELETE", url, { cookie: arjun.cookie })).statusCode, 404, "members can't remove people");
  assert.equal((await call("DELETE", `/api/clubs/${outsider.clubId}/rides/${id}/participants/${rsvpId}`, { cookie: outsider.cookie })).statusCode, 404);
  const removed = await call("DELETE", url, { cookie: owner.cookie });
  assert.equal(removed.json().ride.going_count, 0);
  assert.equal(removed.json().ride.history[0].action, "participant_removed");
  assert.equal(removed.json().ride.history[0].metadata.name, "Spam Name");
});

test("club isolation: another club can't list, edit or see drafts", async () => {
  const draft = (await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: rideBody })).json().ride;
  assert.equal((await call("GET", `/api/clubs/${clubId}/rides`, { cookie: outsider.cookie })).statusCode, 404);
  assert.equal((await call("PATCH", `/api/clubs/${outsider.clubId}/rides/${draft.id}`, { cookie: outsider.cookie, payload: { title: "Hijack" } })).statusCode, 404);
  assert.equal((await call("PATCH", `/api/clubs/${clubId}/rides/${draft.id}`, { cookie: outsider.cookie, payload: { title: "Hijack" } })).statusCode, 404);
  assert.equal((await call("GET", `/api/r/${draft.code}`, { cookie: outsider.cookie })).statusCode, 404);
  assert.ok((await call("GET", `/api/clubs/${outsider.clubId}/rides`, { cookie: outsider.cookie })).json().rides.every((r) => r.id !== draft.id));
  assert.equal((await call("GET", "/api/r/doesnotexist")).statusCode, 404);
});

test("dashboard lists upcoming and past separately; joining stays open for an hour after the start", async () => {
  const past = await publish({ starts_at: inDays(-2), title: "Last week's ride" });
  const justStarted = await publish({ starts_at: inDays(-0.01), title: "Just started" }); // 14 min ago
  const hourGone = await publish({ starts_at: inDays(-0.05), title: "Started 72 min ago" });
  assert.ok((await ridesOf(clubId, "past")).json().rides.some((r) => r.id === past.id));
  assert.ok(!(await ridesOf(clubId)).json().rides.some((r) => r.id === past.id));
  assert.ok((await ridesOf(clubId)).json().rides.some((r) => r.id === justStarted.id), "still shown until 12 h after start");
  const late = phone();
  const joined = await late.rsvp(justStarted.code, { status: "going", phone: listed("Late Rider") });
  assert.equal(joined.statusCode, 200, "a latecomer can still join in the first hour");
  assert.equal(joined.json().ride.joining_open, true);
  assert.equal((await late.rsvp(justStarted.code, { status: "cancelled" })).statusCode, 200, "and drop out");
  const closed = await phone().rsvp(hourGone.code, { status: "going", phone: listed("Very Late") });
  assert.equal(closed.statusCode, 409);
  assert.match(closed.json().error || closed.json().message, /Joining is closed/);
  assert.equal((await call("GET", `/api/r/${hourGone.code}`)).json().ride.joining_open, false);
  assert.equal((await call("GET", `/api/r/${past.code}`)).json().ride.past, true);
});

test("bad input is rejected", async () => {
  for (const bad of [{ ...rideBody, starts_at: "next saturday" }, { ...rideBody, capacity: 0 }, { ...rideBody, map_url: "javascript:alert(1)" }, { ...rideBody, title: "" }, { ...rideBody, category: "chess" }]) {
    assert.equal((await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: bad })).statusCode, 400, JSON.stringify(bad));
  }
});

test.after(async () => { await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });

test("midway meeting point: place and time together, after the start; people say where they join", async () => {
  const at = (iso, min) => new Date(new Date(iso).getTime() + min * 60000).toISOString();
  const start = inDays(5);
  const base = { title: "Pathways ride", starts_at: start, meeting_point: "Xavier's", status: "published" };
  const post = (extra) => call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...base, ...extra } });
  assert.equal((await post({ meeting_point_2: "Tulip Chowk" })).statusCode, 400, "a midway point needs a time");
  assert.equal((await post({ meeting_point_2: "Tulip Chowk", meeting_at_2: at(start, -10) })).statusCode, 400, "not before the start");
  const ride = (await post({ meeting_point_2: "Tulip Chowk", meeting_at_2: at(start, 15), map_url_2: "https://maps.app.goo.gl/x" })).json().ride;
  assert.equal(ride.meeting_point_2, "Tulip Chowk");
  assert.equal(ride.participants[0].join_point, 1, "the lead starts at the first point");

  const guest = phone();
  const joined = await guest.rsvp(ride.code, { status: "going", phone: listed("Kabir Singh", "98333 12345"), join_point: 2 });
  assert.equal(joined.statusCode, 200, joined.body);
  assert.equal(joined.json().ride.my_rsvp.join_point, 2);
  // Switching point keeps your place on the list; no name needed.
  const second = phone();
  await second.rsvp(ride.code, { status: "going", phone: listed("Lata Rao", "98333 54321") });
  const moved = await guest.rsvp(ride.code, { status: "going", join_point: 1 });
  assert.deepEqual(moved.json().ride.participants.map((p) => [p.name, p.join_point]), [["Priya Sharma", 1], ["Kabir Singh", 1], ["Lata Rao", 1]]);
  await guest.rsvp(ride.code, { status: "going", join_point: 2 });

  // Removing the midway point puts everyone back at the start.
  const cleared = await call("PATCH", `/api/clubs/${clubId}/rides/${ride.id}`, { cookie: owner.cookie, payload: { meeting_point_2: null } });
  assert.equal(cleared.json().ride.meeting_point_2, null);
  assert.equal(cleared.json().ride.meeting_at_2, null);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ? AND join_point = 2").get(ride.id).n, 0);
  // Without a midway point, join_point 2 is ignored.
  assert.equal((await second.rsvp(ride.code, { status: "going", join_point: 2 })).json().ride.my_rsvp.join_point, 1);
});

test("bike type and ride style: cycling only, cleared when the type changes", async () => {
  const created = await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...rideBody, category: "cycling", bike_type: "road", ride_style: "no_drop" } });
  assert.equal(created.statusCode, 201);
  const { id, code } = created.json().ride;
  assert.equal(created.json().ride.bike_type, "road");
  assert.equal(created.json().ride.ride_style, "no_drop");
  const restyled = await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { ride_style: "racing", bike_type: null } });
  assert.equal(restyled.json().ride.ride_style, "racing");
  assert.equal(restyled.json().ride.bike_type, null);
  const run = await call("PATCH", `/api/clubs/${clubId}/rides/${id}`, { cookie: owner.cookie, payload: { category: "running" } });
  assert.equal(run.json().ride.ride_style, null, "a run has no ride style");
  const ignored = await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...rideBody, category: "running", bike_type: "mtb" } });
  assert.equal(ignored.json().ride.bike_type, null);
  assert.equal((await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { ...rideBody, category: "cycling", bike_type: "unicycle" } })).statusCode, 400);
  assert.ok(code);
});
