import test, { mock } from "node:test";
import assert from "node:assert/strict";
import { rmSync } from "node:fs";
import { useTempDatabase, makeClient } from "./helpers.js";

// Day words ("Saturday", "tomorrow") depend on today, so pin the clock to a Wednesday noon in India.
// Unpinned, these tests failed on Saturday mornings, when "Saturday 5:30 AM" was already past.
mock.timers.enable({ apis: ["Date"], now: new Date("2026-11-18T06:30:00Z") });
const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { handleIncoming } = await import("../src/whatsapp/conversation.js");
const app = await buildApp({ logger: false, authRateLimit: 1000, publicRateLimit: 1000 });
const { call, registerOwner, invite } = makeClient(app);

const club = await registerOwner("Club Owner", "owner@example.com", "Trail Crew");
db.prepare("UPDATE users SET phone = ? WHERE id = ?").run("919800000001", club.user.id);
const ADMIN = "919800000001@s.whatsapp.net";
let n = 0;
const say = (text, from = ADMIN, fromAlt = null) => (mock.timers.tick(1000), handleIncoming)(club.clubId, { id: `m${++n}`, from, fromAlt, text });

test.after(async () => { await app.close(); rmSync(tempDir, { recursive: true, force: true }); });

test("strangers and plain members get no reply", async () => {
  assert.equal(say("Create a ride tomorrow 6 AM from Tulip Chowk", "919811111111@s.whatsapp.net"), null);
  const token = await invite(club.cookie, club.clubId, "m@example.com");
  const res = await call("POST", "/api/auth/register", { payload: { name: "Plain Member", email: "m@example.com", password: "strong-password-123", inviteToken: token } });
  assert.equal(res.statusCode, 201, res.body);
  db.prepare("UPDATE users SET phone = ? WHERE id = ?").run("919811111112", res.json().user.id);
  assert.equal(say("Create a ride tomorrow 6 AM from Tulip Chowk", "919811111112@s.whatsapp.net"), null);
});

test("an admin is recognised by the number on their account and guided step by step", () => {
  const first = say("Create a new ride");
  assert.match(first, /Let's get your ride published/);
  assert.match(first, /called, and which day and time/);

  const second = say("Sunday Morning Ride, tomorrow, 6:30 AM");
  assert.match(second, /\*Sunday Morning Ride\*/);
  assert.match(second, /6:30 AM/);
  assert.match(second, /Where are we meeting/);

  const third = say("Tulip Chowk, 60 km");
  assert.match(third, /📍 Tulip Chowk/);
  assert.match(third, /📏 60 km/);
  assert.match(third, /Reply \*YES\* to publish/);

  const done = say("yes");
  assert.match(done, /✅ Ride created!/);
  assert.match(done, /RSVP link: http:\/\/localhost:5173\/r\/[\w-]+/);
  const ride = db.prepare("SELECT * FROM rides WHERE club_id = ? ORDER BY created_at DESC").get(club.clubId);
  assert.equal(ride.title, "Sunday Morning Ride");
  assert.equal(ride.meeting_point, "Tulip Chowk");
  assert.equal(ride.distance_km, 60);
  assert.equal(ride.category, "cycling");
  assert.equal(ride.status, "published");
});

test("WhatsApp's private id still works when the phone number comes as the alternate id", () => {
  const reply = say("Morning run tomorrow 6am from Cubbon Park 10km", "55555@lid", ADMIN);
  assert.match(reply, /📍 Cubbon Park/);
  assert.match(say("cancel", "55555@lid", ADMIN), /Discarded/);
});

test("the club number may be an admin's own phone: everyday chat is left alone", () => {
  assert.equal(say("hi, are you coming tonight?"), null, "no draft open: ordinary messages get no reply");
  assert.equal(say("see you tomorrow at 6"), null);
  assert.match(say("PaceUp"), /I can create Trail Crew activities/);
  assert.match(say("Plan a hike Saturday 5:30 AM from Nandi Hills base"), /Reply \*YES\* to publish/);
  assert.match(say("ok"), /didn't catch a change/, "'ok' never publishes");
  assert.match(say("✅"), /Hike created!/);
});

test("the same message is handled once, and an admin who is demoted is ignored", () => {
  assert.ok(handleIncoming(club.clubId, { id: "dup", from: ADMIN, text: "paceup" }));
  assert.equal(handleIncoming(club.clubId, { id: "dup", from: ADMIN, text: "paceup" }), null);
  db.prepare("UPDATE club_memberships SET role = 'member' WHERE user_id = ?").run(club.user.id);
  assert.equal(say("paceup"), null);
  db.prepare("UPDATE club_memberships SET role = 'owner' WHERE user_id = ?").run(club.user.id);
});

test("templates: saved on the web, reused by name on WhatsApp", async () => {
  const save = await call("POST", `/api/clubs/${club.clubId}/templates`, { cookie: club.cookie, payload: {
    name: "Pandala", title: "Pandala Loop", category: "cycling", meeting_point: "Tulip Chowk", map_url: "https://maps.app.goo.gl/abc", distance_km: 50, pace: "25-30", notes: "Lights on", capacity: null } });
  assert.equal(save.statusCode, 201, save.body);
  assert.equal((await call("POST", `/api/clubs/${club.clubId}/templates`, { cookie: club.cookie, payload: { name: "pandala", title: "Pandala Loop", meeting_point: "Tulip Chowk", distance_km: 55 } })).statusCode, 200, "same name updates");
  const list = (await call("GET", `/api/clubs/${club.clubId}/templates`, { cookie: club.cookie })).json().templates;
  assert.deepEqual(list.map((t) => [t.name, t.distance_km]), [["pandala", 55]]);
  const renamed = await call("PATCH", `/api/clubs/${club.clubId}/templates/${list[0].id}`, { cookie: club.cookie, payload: { name: "Pandala" } });
  assert.equal(renamed.json().template.name, "Pandala");
  await call("POST", `/api/clubs/${club.clubId}/templates`, { cookie: club.cookie, payload: { name: "Pandala", title: "Pandala Loop", category: "cycling", meeting_point: "Tulip Chowk", map_url: "https://maps.app.goo.gl/abc", distance_km: 50, pace: "25-30", notes: "Lights on" } });

  assert.equal(say("pandala is lovely"), null, "naming a template without a day or time isn't a request");
  assert.match(say("PaceUp"), /saved template: \*Pandala\*/);
  const reply = say("Pandala tomorrow 6am");
  assert.match(reply, /Using your \*Pandala\* template/);
  assert.match(reply, /\*Pandala Loop\*/);
  assert.match(reply, /📍 Tulip Chowk/);
  assert.match(reply, /📏 50 km/);
  assert.match(reply, /Reply \*YES\* to publish/, "only the date and time were needed");
  assert.match(say("change distance to 60"), /📏 60 km/);
  assert.match(say("yes"), /Ride created!/);
  const ride = db.prepare("SELECT * FROM rides WHERE club_id = ? ORDER BY created_at DESC").get(club.clubId);
  assert.deepEqual([ride.title, ride.meeting_point, ride.distance_km, ride.pace, ride.map_url, ride.notes], ["Pandala Loop", "Tulip Chowk", 60, "25-30", "https://maps.app.goo.gl/abc", "Lights on"]);

  // Only admins manage templates.
  const del = await call("DELETE", `/api/clubs/${club.clubId}/templates/${list[0].id}`, { cookie: club.cookie });
  assert.equal(del.statusCode, 200);
  assert.deepEqual((await call("GET", `/api/clubs/${club.clubId}/templates`, { cookie: club.cookie })).json().templates, []);
});

test("an AM/PM answer is never taken as the place, and 'meet' alone isn't a request", () => {
  assert.equal(say("Can we meet Sunday at 6?"), null);
  const r = say("Create a run tomorrow at 6");
  assert.match(r, /morning or evening/);
  const r2 = say("AM");
  assert.doesNotMatch(r2, /📍 AM/);
  assert.match(r2, /Where are we meeting/);
  say("cancel");
});

test("a midway point by WhatsApp: in the first message, asked for when its time is missing, or dropped", () => {
  const reply = say("Create a ride tomorrow 5:45am from Xavier's, midway Tulip Chowk 6am, 35 km");
  assert.match(reply, /📍 Xavier's\n📍 Midway: Tulip Chowk · 6:00 AM/);
  assert.match(say("yes"), /Ride created!/);
  let ride = db.prepare("SELECT * FROM rides WHERE club_id = ? ORDER BY created_at DESC").get(club.clubId);
  assert.equal(ride.meeting_point_2, "Tulip Chowk");
  assert.equal((new Date(ride.meeting_at_2) - new Date(ride.starts_at)) / 60000, 15);

  // "6:15" without AM/PM is read as the one after the start.
  assert.match(say("Create a ride tomorrow 5:45am from Xavier's, midway point: Tulip Chowk at 6:15"), /Midway: Tulip Chowk · 6:15 AM/);
  assert.match(say("cancel"), /Discarded/);
  // No time: asked for it.
  assert.match(say("Create a ride tomorrow 5:45am from Xavier's, midway Tulip Chowk"), /What time do you meet at Tulip Chowk/);
  assert.match(say("midway Tulip Chowk 6:20 am"), /Midway: Tulip Chowk · 6:20 AM[\s\S]*Reply \*YES\*/);
  const dropped = say("no midway");
  assert.doesNotMatch(dropped, /Midway/);
  assert.match(say("yes"), /Ride created!/);
  ride = db.prepare("SELECT * FROM rides WHERE club_id = ? ORDER BY created_at DESC").get(club.clubId);
  assert.equal(ride.meeting_point_2, null);
});

test("a template keeps its midway point, timed from the start", async () => {
  await call("POST", `/api/clubs/${club.clubId}/templates`, { cookie: club.cookie, payload: { name: "Pathways", title: "Pathways Loop", category: "cycling", meeting_point: "Xavier's", meeting_point_2: "Tulip Chowk", midway_offset_min: 15 } });
  assert.match(say("Pathways tomorrow 5:45 am"), /📍 Midway: Tulip Chowk · 6:00 AM/);
  assert.match(say("yes"), /Ride created!/);
  const ride = db.prepare("SELECT * FROM rides WHERE club_id = ? ORDER BY created_at DESC").get(club.clubId);
  assert.equal(ride.meeting_point_2, "Tulip Chowk");
});
