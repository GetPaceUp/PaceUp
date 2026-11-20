import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { queueNoShowNudges } = await import("../src/no-shows.js");
const app = await buildApp({ logger: false, authRateLimit: 1000, publicRateLimit: 1000 });
const { call, registerOwner, invite } = makeClient(app);

const HOUR = 3600000;
const iso = (ms) => new Date(ms).toISOString();
async function joinAs(owner, clubId, name, email) {
  const token = await invite(owner.cookie, clubId, email);
  const res = await call("POST", "/api/auth/register", { payload: { name, email, password: "strong-password-123", inviteToken: token } });
  assert.equal(res.statusCode, 201);
  return { cookie: sessionCookie(res), user: res.json().user };
}

const owner = await registerOwner("Priya Sharma", "priya@example.com", "Sunrise Club");
const clubId = owner.clubId;
const admin = await joinAs(owner, clubId, "Kiran Das", "kiran@example.com");
db.prepare("UPDATE club_memberships SET role = 'admin' WHERE user_id = ?").run(admin.user.id);
const arjun = await joinAs(owner, clubId, "Arjun Rao", "arjun@example.com");
const meera = await joinAs(owner, clubId, "Meera Iyer", "meera@example.com");
const outsider = await registerOwner("Other Owner", "other@example.com", "Other Club");

/** A published activity with the lead, Arjun and Meera going, that started `hoursAgo` hours ago. */
async function pastActivity(hoursAgo, title = "Sunday long loop") {
  const ride = (await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { title, starts_at: iso(Date.now() + 86400000), meeting_point: "Hebbal flyover", status: "published" } })).json().ride;
  for (const m of [arjun, meera]) assert.equal((await call("PUT", `/api/r/${ride.code}/rsvp`, { cookie: m.cookie, payload: { status: "going" } })).statusCode, 200);
  db.prepare("UPDATE rides SET starts_at = ? WHERE id = ?").run(iso(Date.now() - hoursAgo * HOUR), ride.id);
  return ride;
}
const view = (code, who = owner) => call("GET", `/api/r/${code}`, { cookie: who.cookie }).then((r) => r.json().ride);
const mark = (ride, rsvpId, noShow, who = owner) => call("PUT", `/api/clubs/${clubId}/rides/${ride.id}/participants/${rsvpId}/no-show`, { cookie: who.cookie, payload: { no_show: noShow } });
const idOf = (v, name) => v.participants.find((p) => p.name === name).id;

test("admins tap who didn't turn up; tap again to undo; everyone else counts as present", async () => {
  const ride = await pastActivity(2);
  let v = await view(ride.code);
  assert.deepEqual(v.absent && { open: v.absent.open }, { open: true });
  assert.ok(v.participants.every((p) => p.no_show === false), "everyone is present by default");

  let res = await mark(ride, idOf(v, "Meera Iyer"), true, admin);
  assert.equal(res.statusCode, 200, "any admin can mark");
  v = res.json().ride;
  assert.equal(v.participants.find((p) => p.name === "Meera Iyer").no_show, true);
  assert.equal(v.participants.filter((p) => p.no_show).length, 1);
  assert.ok(v.history.some((h) => h.action === "marked_no_show" && h.metadata.name === "Meera Iyer"));

  v = (await mark(ride, idOf(v, "Meera Iyer"), false)).json().ride;
  assert.equal(v.participants.find((p) => p.name === "Meera Iyer").no_show, false, "undo");
  assert.equal((await mark(ride, idOf(v, "Meera Iyer"), false)).statusCode, 200, "repeat taps are harmless");
});

test("members never see no-shows; members and other clubs can't mark", async () => {
  const ride = await pastActivity(2, "Members can't see");
  const v = await view(ride.code);
  await mark(ride, idOf(v, "Arjun Rao"), true);
  const seen = await view(ride.code, meera);
  assert.equal(seen.absent, undefined);
  assert.ok(seen.participants.every((p) => !("no_show" in p) && !("no_shows" in p)));
  const anon = await call("GET", `/api/r/${ride.code}`).then((r) => r.json().ride);
  assert.ok(anon.participants.every((p) => !("no_show" in p)));
  assert.notEqual((await mark(ride, idOf(v, "Meera Iyer"), true, arjun)).statusCode, 200);
  assert.equal((await view(ride.code)).participants.find((p) => p.name === "Meera Iyer").no_show, false);
  assert.equal((await call("PUT", `/api/clubs/${outsider.clubId}/rides/${ride.id}/participants/${idOf(v, "Meera Iyer")}/no-show`, { cookie: outsider.cookie, payload: { no_show: true } })).statusCode, 404);
});

test("marking opens at the start and locks 48 hours later", async () => {
  const upcoming = (await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { title: "Not yet", starts_at: iso(Date.now() + 86400000), meeting_point: "Gate 2", status: "published" } })).json().ride;
  const u = await view(upcoming.code);
  assert.equal(u.absent, null);
  assert.equal((await mark(upcoming, u.participants[0].id, true)).statusCode, 409);

  const old = await pastActivity(49, "Locked");
  const o = await view(old.code);
  assert.equal(o.absent.open, false);
  assert.equal((await mark(old, idOf(o, "Arjun Rao"), true)).statusCode, 409);
});

test("each person's no-shows over 90 days show next to their name for admins", async () => {
  // Arjun: marked once in test 2. Add one more recent, and one older than 90 days that doesn't count.
  const recent = await pastActivity(5, "Recent");
  await mark(recent, idOf(await view(recent.code), "Arjun Rao"), true);
  const ancient = await pastActivity(5, "Ancient");
  await mark(ancient, idOf(await view(ancient.code), "Arjun Rao"), true);
  db.prepare("UPDATE rides SET starts_at = ? WHERE id = ?").run(iso(Date.now() - 100 * 86400000), ancient.id);

  const next = (await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { title: "Next one", starts_at: iso(Date.now() + 86400000), meeting_point: "Gate 2", status: "published" } })).json().ride;
  for (const m of [arjun, meera]) await call("PUT", `/api/r/${next.code}/rsvp`, { cookie: m.cookie, payload: { status: "going" } });
  const v = await view(next.code);
  assert.equal(v.participants.find((p) => p.name === "Arjun Rao").no_shows, 2);
  assert.equal(v.participants.find((p) => p.name === "Meera Iyer").no_shows, 0, "Meera's mark was undone");
});

test("past tab: admins see no-show counts and whether they can still mark", async () => {
  // Started under 12 hours ago, an activity still sits in the upcoming tab.
  const list = async (when, who = owner) => (await call("GET", `/api/clubs/${clubId}/rides?when=${when}`, { cookie: who.cookie })).json().rides;
  const past = [...await list("upcoming"), ...await list("past")];
  const recent = past.find((r) => r.title === "Recent");
  assert.equal(recent.no_show_count, 1);
  assert.equal(recent.can_mark, true);
  assert.equal(past.find((r) => r.title === "Locked").can_mark, false);
  assert.ok((await list("upcoming")).filter((r) => r.title === "Next one").every((r) => !("can_mark" in r)), "not before the start");
  const asMember = [...await list("upcoming", arjun), ...await list("past", arjun)];
  assert.ok(asMember.every((r) => !("no_show_count" in r) && !("can_mark" in r)));
});

test("the Lead gets one WhatsApp reminder 3 hours after the start, never at night", async () => {
  db.prepare("UPDATE users SET phone = '919811100000' WHERE id = ?").run(owner.user.id);
  db.prepare("INSERT INTO whatsapp_connections (club_id, desired, status, phone, updated_at) VALUES (?, 'on', 'connected', '919800000000', ?)").run(clubId, iso(Date.now()));
  db.prepare("UPDATE rides SET absent_nudge_at = ? WHERE club_id = ?").run(iso(Date.now()), clubId); // earlier tests' activities
  const directs = () => db.prepare("SELECT * FROM whatsapp_direct WHERE club_id = ?").all(clubId);

  const morning = Date.parse("2026-11-22T04:30:00Z"); // 10:00 in India
  const ride = await pastActivity(0, "Dawn loop");
  db.prepare("UPDATE rides SET starts_at = ? WHERE id = ?").run(iso(morning - 2 * HOUR), ride.id);
  assert.equal(queueNoShowNudges(morning), 0, "not yet: under 3 hours");
  db.prepare("UPDATE rides SET starts_at = ? WHERE id = ?").run(iso(morning - 4 * HOUR), ride.id);

  const night = Date.parse("2026-11-22T17:30:00Z"); // 23:00 in India
  assert.equal(queueNoShowNudges(night), 0, "quiet at night");

  assert.equal(queueNoShowNudges(morning), 1);
  const sent = directs();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].to_phone, "919811100000", "to the Lead");
  assert.match(sent[0].text, /Dawn loop/);
  assert.match(sent[0].text, new RegExp(`/r/${ride.code}\\?absent`));
  assert.doesNotMatch(sent[0].text, /\bride\b|cycling/i);
  assert.equal(queueNoShowNudges(morning + 60000), 0, "only once");

  // Nobody but the Lead on the list: nothing to mark, no message.
  const solo = (await call("POST", `/api/clubs/${clubId}/rides`, { cookie: owner.cookie, payload: { title: "Solo", starts_at: iso(Date.now() + 86400000), meeting_point: "Gate 2", status: "published" } })).json().ride;
  db.prepare("UPDATE rides SET starts_at = ? WHERE id = ?").run(iso(morning - 4 * HOUR), solo.id);
  assert.equal(queueNoShowNudges(morning), 0);
  assert.ok(db.prepare("SELECT absent_nudge_at FROM rides WHERE id = ?").get(solo.id).absent_nudge_at, "handled, never retried");
  assert.equal(directs().length, 1);
});

test.after(() => { app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
