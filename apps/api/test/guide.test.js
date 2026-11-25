import test from "node:test";
import assert from "node:assert/strict";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { queueGuideNudges, nudgeText } = await import("../src/guide.js");
const { cleanPhone } = await import("../src/roster.js");
const app = await buildApp({ logger: false, authRateLimit: 1000, publicRateLimit: 1000, sendPushes: false });
const { call, registerOwner, invite } = makeClient(app);

const DAY = 86400000;
const iso = (ms) => new Date(ms).toISOString();
const noon = () => { const d = new Date(); d.setUTCHours(6, 30, 0, 0); return d.getTime(); }; // 12:00 in India
async function joinAs(owner, clubId, name, email, role = "member") {
  const token = await invite(owner.cookie, clubId, email, role);
  const res = await call("POST", "/api/auth/register", { payload: { name, email, password: "strong-password-123", inviteToken: token } });
  return { cookie: sessionCookie(res), user: res.json().user };
}
const owner = await registerOwner("Priya Sharma", "priya@example.com", "Sunrise Club");
const clubId = owner.clubId;
const admin = await joinAs(owner, clubId, "Anurag Mehta", "anurag@example.com", "admin");
const guide = async (who) => (await call("GET", `/api/clubs/${clubId}/guide`, { cookie: who.cookie })).json().guide;
const queued = (userId) => db.prepare("SELECT title, body, url FROM push_queue WHERE user_id = ?").all(userId);
const deviceCookie = (res) => [].concat(res.headers["set-cookie"] || []).find((c) => c.startsWith("paceup_device="))?.split(";")[0];
function listed(name, num, club = clubId) {
  const now = iso(Date.now());
  db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, phone, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'upload', ?, ?)")
    .run(crypto.randomUUID(), club, name, name.toLowerCase(), cleanPhone(num), now, now);
  return num;
}
const rideBody = { title: "Sunday long run", starts_at: iso(Date.now() + 2 * DAY), meeting_point: "Galleria gate 2", status: "published" };

test("a new admin gets the guide until someone joins their first activity, then never again", async () => {
  let g = await guide(admin);
  assert.equal(g.show, true);
  assert.equal(g.first_name, "Anurag");
  assert.equal(g.published, false);
  assert.deepEqual(g.tips_seen, []);

  assert.equal((await call("POST", "/api/guide/tips", { cookie: admin.cookie, payload: { tip: "dash" } })).statusCode, 200);
  assert.equal((await call("POST", "/api/guide/tips", { cookie: admin.cookie, payload: { tip: "nope" } })).statusCode, 400);
  assert.deepEqual((await guide(admin)).tips_seen, ["dash"], "a dismissed tip stays dismissed");

  await call("POST", `/api/clubs/${clubId}/guide/step`, { cookie: admin.cookie, payload: { step: "form_opened" } });
  const ride = (await call("POST", `/api/clubs/${clubId}/rides`, { cookie: admin.cookie, payload: rideBody })).json().ride;
  g = await guide(admin);
  assert.equal(g.show, true);
  assert.equal(g.published, true);
  assert.equal(g.latest_code, ride.code);

  // First member in: one celebration alert for the Lead.
  db.prepare("INSERT INTO push_subscriptions (id, user_id, endpoint, p256dh, auth, created_at) VALUES (?, ?, 'https://push.example.com/a', 'k', 'a', ?)").run(crypto.randomUUID(), admin.user.id, iso(Date.now()));
  const res = await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", phone: listed("Rahul Verma", "98100 11111") } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(queued(admin.user.id), [{ title: "🎉 First one in!", body: "Rahul joined Sunday long run.", url: `/r/${ride.code}` }]);
  await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", phone: listed("Neha Gupta", "98100 22222") } });
  assert.equal(queued(admin.user.id).length, 1, "only the very first join is celebrated");

  assert.equal((await guide(admin)).show, false);
});

test("the PaceUp Admin looking at someone else's club never sees the guide", async () => {
  const boss = await registerOwner("Boss", "boss@example.com", "Boss Club");
  db.prepare("UPDATE users SET platform_role = 'super_admin' WHERE id = ?").run(boss.user.id);
  assert.equal((await call("GET", `/api/clubs/${clubId}/guide`, { cookie: boss.cookie })).json().guide.show, false);
  const member = await joinAs(owner, clubId, "Arjun Rao", "arjun@example.com");
  assert.equal((await call("GET", `/api/clubs/${clubId}/guide`, { cookie: member.cookie })).statusCode, 404, "members don't run the club");
});

test("one WhatsApp nudge, from the club's own number, to an admin with no activity after 3 days", async () => {
  const quiet = await joinAs(owner, clubId, "Nandini Rao", "nandini@example.com", "admin");
  db.prepare("UPDATE users SET phone = '919811100000' WHERE id = ?").run(quiet.user.id);
  db.prepare("UPDATE users SET phone = '919800000000' WHERE id = ?").run(owner.user.id);
  const at = noon();
  // Everyone else was in the club before this release (counted as nudged) or has published.
  db.prepare("UPDATE club_memberships SET guide_nudge_at = ? WHERE user_id != ?").run(iso(at), quiet.user.id);
  db.prepare("UPDATE club_memberships SET created_at = ? WHERE user_id = ?").run(iso(at - 2 * DAY), quiet.user.id);
  db.prepare("INSERT INTO whatsapp_connections (club_id, desired, status, phone, updated_at) VALUES (?, 'on', 'connected', '919800000000', ?)").run(clubId, iso(at));
  const sent = () => db.prepare("SELECT to_phone, text FROM whatsapp_direct").all();

  assert.equal(queueGuideNudges(at), 0, "not before 3 days");
  db.prepare("UPDATE club_memberships SET created_at = ? WHERE user_id = ?").run(iso(at - 4 * DAY), quiet.user.id);
  const night = at + 12 * 3600000; // 00:00 in India
  assert.equal(queueGuideNudges(night), 0, "nothing at night");
  assert.equal(queueGuideNudges(at), 1);
  assert.deepEqual(sent(), [{ to_phone: "919811100000", text: nudgeText("Nandini Rao", "Sunrise Club") }]);
  assert.match(sent()[0].text, /Hi Nandini! Ready to post your first activity for \*Sunrise Club\*/);
  assert.equal(queueGuideNudges(at + DAY), 0, "once ever");
});

test("no nudge when the club's WhatsApp isn't linked", async () => {
  const other = await registerOwner("Kabir Singh", "kabir@example.com", "Hill Walkers");
  const a = await joinAs(other, other.clubId, "Meera Iyer", "meera@example.com", "admin");
  db.prepare("UPDATE users SET phone = '919811100009' WHERE id = ?").run(a.user.id);
  db.prepare("UPDATE club_memberships SET created_at = ? WHERE club_id = ?").run(iso(noon() - 4 * DAY), other.clubId);
  db.prepare("DELETE FROM whatsapp_direct").run();
  assert.equal(queueGuideNudges(noon()), 0);
  assert.deepEqual(db.prepare("SELECT to_phone FROM whatsapp_direct").all(), []);
});

test("the PaceUp Admin's funnel counts each step, and lists who's stuck", async () => {
  // A member's phone: opens the link, taps I'M IN, joins.
  const ride = (await call("GET", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie })).json().rides[0];
  const open = await call("GET", `/api/r/${ride.code}`);
  const cookie = deviceCookie(open);
  assert.ok(cookie, "a phone opening a link gets its device token right away");
  await call("POST", `/api/r/${ride.code}/step`, { cookie, payload: { step: "m_tapped" } });
  await call("PUT", `/api/r/${ride.code}/rsvp`, { cookie, payload: { status: "going", phone: listed("Kiran Das", "98100 33333") } });
  await call("GET", `/api/r/${ride.code}`, { cookie });
  // Another phone only looks.
  await call("GET", `/api/r/${ride.code}`);

  const boss = (await call("POST", "/api/auth/login", { payload: { email: "boss@example.com", password: "strong-password-123" } }));
  const res = await call("GET", "/api/platform/getting-started", { cookie: sessionCookie(boss) });
  assert.equal(res.statusCode, 200);
  const f = res.json();
  assert.deepEqual(f.member.map((s) => s.n), [2, 1, 1]);
  const steps = Object.fromEntries(f.admin.map((s) => [s.step, s.n]));
  assert.ok(steps["Added to a club"] >= 4);
  assert.ok(steps["1st activity"] >= 1);
  assert.ok(steps["1st join"] >= 1);
  const nandini = f.stuck.find((s) => s.name === "Nandini Rao");
  assert.deepEqual([nandini.days, nandini.where, nandini.phone], [4, "no activity yet", "919811100000"]);
  assert.ok(!f.stuck.some((s) => s.name === "Anurag Mehta"), "published, so not stuck");

  assert.equal((await call("GET", "/api/platform/getting-started", { cookie: owner.cookie })).statusCode, 403);
});

test("a first activity cancelled before anyone joined sends them back to Create", async () => {
  const club = await registerOwner("Tara Nair", "tara@example.com", "Lake Swimmers");
  const ride = (await call("POST", `/api/clubs/${club.clubId}/rides`, { cookie: club.cookie, payload: rideBody })).json().ride;
  const g = async () => (await call("GET", `/api/clubs/${club.clubId}/guide`, { cookie: club.cookie })).json().guide;
  assert.equal((await g()).published, true);
  await call("PATCH", `/api/clubs/${club.clubId}/rides/${ride.id}`, { cookie: club.cookie, payload: { status: "cancelled" } });
  const after = await g();
  assert.deepEqual([after.show, after.published, after.latest_code], [true, false, null]);
});

test("once someone has joined, cancelling that activity doesn't bring the guide back", async () => {
  const club = await registerOwner("Dev Kapoor", "dev@example.com", "River Paddlers");
  const ride = (await call("POST", `/api/clubs/${club.clubId}/rides`, { cookie: club.cookie, payload: rideBody })).json().ride;
  assert.equal((await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", phone: listed("Sana Ali", "98100 44444", club.clubId) } })).statusCode, 200);
  await call("PATCH", `/api/clubs/${club.clubId}/rides/${ride.id}`, { cookie: club.cookie, payload: { status: "cancelled" } });
  assert.equal((await call("GET", `/api/clubs/${club.clubId}/guide`, { cookie: club.cookie })).json().guide.show, false);
});

test("opening a full activity isn't counted as a member drop-off", async () => {
  const club = await registerOwner("Isha Bose", "isha@example.com", "Peak Trekkers");
  const ride = (await call("POST", `/api/clubs/${club.clubId}/rides`, { cookie: club.cookie, payload: { ...rideBody, capacity: 1 } })).json().ride;
  const fill = await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", phone: listed("Om Jain", "98100 55555", club.clubId) } });
  assert.ok([200, 409].includes(fill.statusCode));
  const opens = () => db.prepare("SELECT COUNT(*) AS n FROM first_steps WHERE club_id = ? AND step = 'm_opened'").get(club.clubId).n;
  const before = opens();
  const view = (await call("GET", `/api/r/${ride.code}`)).json();
  assert.equal((view.ride || view).is_full, true);
  assert.equal(opens(), before);
});

test("a waiting nudge expires when quiet hours start, so it never goes out at night", async () => {
  const { msUntilQuiet } = await import("../src/guide.js");
  const at = noon(); // 12:00 India
  assert.equal(msUntilQuiet(at), 10 * 3600000);
  assert.equal(msUntilQuiet(at + 10 * 3600000), 0);
  db.prepare("DELETE FROM whatsapp_direct").run();
  const late = await joinAs(owner, clubId, "Vikram Shah", "vikram@example.com", "admin");
  db.prepare("UPDATE users SET phone = '919811100077' WHERE id = ?").run(late.user.id);
  db.prepare("UPDATE club_memberships SET created_at = ?, guide_nudge_at = NULL WHERE user_id = ?").run(iso(at - 4 * DAY), late.user.id);
  assert.equal(queueGuideNudges(at), 1);
  assert.equal(db.prepare("SELECT expires_at FROM whatsapp_direct").get().expires_at, iso(at + 10 * 3600000));
});

test("cookie-less reloads of a link can't flood the member funnel", async () => {
  const ride = (await call("GET", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie })).json().rides[0];
  const before = db.prepare("SELECT COUNT(*) AS n FROM first_steps WHERE step = 'm_opened'").get().n;
  for (let i = 0; i < 40; i++) assert.equal((await call("GET", `/api/r/${ride.code}`)).statusCode, 200, "the page is always served");
  const added = db.prepare("SELECT COUNT(*) AS n FROM first_steps WHERE step = 'm_opened'").get().n - before;
  assert.ok(added <= 30, `at most 30 new phones an hour from one address (got ${added})`);
});
