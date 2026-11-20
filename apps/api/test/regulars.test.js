import test from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { regulars, regularsText, monthKey, previousMonth } = await import("../src/regulars.js");
const app = await buildApp({ logger: false, authRateLimit: 1000, publicRateLimit: 1000 });
const { call, registerOwner, invite } = makeClient(app);

const owner = await registerOwner("Priya Sharma", "priya@example.com", "Sunrise Club");
const clubId = owner.clubId;
const token = await invite(owner.cookie, clubId, "arjun@example.com");
const arjunRes = await call("POST", "/api/auth/register", { payload: { name: "Arjun Rao", email: "arjun@example.com", password: "strong-password-123", inviteToken: token } });
const arjun = { cookie: sessionCookie(arjunRes), user: arjunRes.json().user };
const now = new Date().toISOString();
const roster = {};
for (const n of ["Anurag Mehta", "Kabir Singh", "Nandini Rao", "Meera Iyer"]) {
  roster[n] = randomUUID();
  db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, source, created_at, updated_at) VALUES (?, ?, ?, ?, 'manual', ?, ?)").run(roster[n], clubId, n, n.toLowerCase(), now, now);
}
/** An activity on a given day in November 2026 (India time), with these people going and these no-shows. */
function activity(startsAt, going, noShows = [], status = "published") {
  const id = randomUUID();
  db.prepare("INSERT INTO rides (id, club_id, share_code, title, starts_at, meeting_point, status, organiser_id, created_by, created_at, updated_at) VALUES (?, ?, ?, 'Loop', ?, 'Gate 2', ?, ?, ?, ?, ?)")
    .run(id, clubId, randomUUID().slice(0, 12), startsAt, status, owner.user.id, owner.user.id, now, now);
  for (const n of going) {
    db.prepare("INSERT INTO ride_rsvps (id, ride_id, roster_id, participant_name, status, no_show, created_at, updated_at) VALUES (?, ?, ?, ?, 'going', ?, ?, ?)")
      .run(randomUUID(), id, roster[n], n, noShows.includes(n) ? 1 : 0, now, now);
  }
}
const all = Object.keys(roster);
activity("2026-11-01T00:30:00Z", all);                          // 1 Nov, 6:00 AM in India
activity("2026-11-08T00:30:00Z", all, ["Kabir Singh"]);
activity("2026-11-15T00:30:00Z", ["Anurag Mehta", "Nandini Rao"]);
activity("2026-10-31T19:00:00Z", all);                          // 1 Nov 00:30 in India: counts for November
activity("2026-10-31T18:00:00Z", all);                          // 31 Oct 23:30 in India: October
activity("2026-11-20T00:30:00Z", all, [], "cancelled");         // cancelled: doesn't count
const nov = Date.parse("2026-11-30T12:00:00Z");

test("showed up = going minus no-shows; ties share a place; months follow India time", () => {
  const r = regulars(clubId, "2026-11", nov);
  assert.equal(r.activities, 4);
  assert.equal(r.month_name, "November");
  assert.deepEqual(r.people, [
    { name: "Anurag Mehta", count: 4, rank: 1 },
    { name: "Nandini Rao", count: 4, rank: 1 },
    { name: "Meera Iyer", count: 3, rank: 3 },
    { name: "Kabir Singh", count: 2, rank: 4 }
  ]);
  assert.equal(regulars(clubId, "2026-10", nov).activities, 1);
  assert.equal(monthKey(Date.parse("2026-10-31T19:00:00Z")), "2026-11");
  assert.equal(previousMonth("2026-01"), "2025-12");
});

test("activities that haven't happened yet don't count", () => {
  assert.equal(regulars(clubId, "2026-11", Date.parse("2026-11-10T00:00:00Z")).activities, 3);
});

test("the group post names only who showed up, with short names", () => {
  const text = regularsText(clubId, "2026-11");
  assert.match(text, /Most regular in November/);
  assert.match(text, /1\. Anurag M\. · 4\n1\. Nandini R\. · 4\n3\. Meera I\. · 3\n4\. Kabir S\. · 2/);
  assert.doesNotMatch(text, /no-show|\bride\b|cycling/i);
});

test("admins see it and post it once; members can't", async () => {
  const res = await call("GET", `/api/clubs/${clubId}/regulars?month=2026-11`, { cookie: owner.cookie });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().regulars.people.length, 4);
  assert.ok(res.json().current && res.json().previous);
  assert.notEqual((await call("GET", `/api/clubs/${clubId}/regulars`, { cookie: arjun.cookie })).statusCode, 200);

  const post = (who = owner) => call("POST", `/api/clubs/${clubId}/regulars/post`, { cookie: who.cookie, payload: { month: "2026-11" } });
  assert.equal((await post()).statusCode, 409, "needs the club number connected");
  db.prepare("INSERT INTO whatsapp_connections (club_id, desired, status, group_jid, allowed_groups_json, updated_at) VALUES (?, 'on', 'connected', 'g1@g.us', '[\"g1@g.us\"]', ?)").run(clubId, now);
  assert.notEqual((await post(arjun)).statusCode, 200);
  assert.equal((await post()).statusCode, 200);
  assert.equal((await post()).statusCode, 409, "a double tap doesn't post twice");
  const queued = db.prepare("SELECT * FROM outbox WHERE club_id = ? AND kind = 'regulars'").all(clubId);
  assert.equal(queued.length, 1);
  assert.equal(JSON.parse(queued[0].payload).month, "2026-11");
  assert.equal((await call("POST", `/api/clubs/${clubId}/regulars/post`, { cookie: owner.cookie, payload: { month: "2026-02" } })).statusCode, 409, "nothing to post for an empty month");
});

test.after(() => { app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
