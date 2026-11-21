import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { releaseStaleSignups } = await import("../src/signup.js");
const { WhatsAppWorker } = await import("../src/whatsapp/worker.js");
const { fakeAdapter, fakeSessions } = await import("../src/whatsapp/fake-adapter.js");
const app = await buildApp({ logger: false, authRateLimit: 1000 });
const { call, registerOwner } = makeClient(app);
const worker = new WhatsAppWorker({ adapter: fakeAdapter, dataDir: mkdtempSync(join(tmpdir(), "wa-")), log: {}, sendGapMs: [0, 1] });
const settle = () => new Promise((r) => setTimeout(r, 10));

// The PaceUp Admin and their own club, which shows up in the public search like any other club.
const boss = await registerOwner("Boss Owner", "boss@example.com", "House Club");
db.prepare("UPDATE users SET platform_role = 'super_admin' WHERE id = ?").run(boss.user.id);
const CSV = [
  "id,name,city,sport_or_activity,club_phone",
  'a1,"Sunrise Striders",Pune,Running,+919822012345',
  'a2,"Hill Walkers",Kolkata,"Hiking, Trekking",',
  'a3,"House Club",Delhi,Cycling,',
  'a4,"Ridge Runners",Shimla,Running,',
  'a5,"No City Club",,,'
].join("\n");
await call("POST", "/api/platform/directory/import", { cookie: boss.cookie, payload: { csv: CSV } });
const dirId = (name) => db.prepare("SELECT id FROM club_directory WHERE name = ?").get(name).id;

let priya;

test("anyone can search the directory: only name, city, activity; the PaceUp Admin's club shows as on PaceUp", async () => {
  const res = await call("GET", "/api/signup/clubs?q=sunrise");
  assert.equal(res.statusCode, 200);
  const [c] = res.json().clubs;
  assert.deepEqual(Object.keys(c).sort(), ["activity", "activity_type", "city", "directory_id", "name", "on_paceup"]);
  assert.deepEqual([c.name, c.city, c.on_paceup], ["Sunrise Striders", "Pune", false]);
  const house = (await call("GET", "/api/signup/clubs?q=house")).json().clubs;
  assert.deepEqual(house.map((c) => [c.name, c.on_paceup, c.pending]), [["House Club", true, false]], "shown once, as already on PaceUp");
  assert.deepEqual(Object.keys(house[0]).sort(), ["activity", "city", "club_id", "name", "on_paceup", "pending"], "no owner details");
  const one0 = (await call("GET", `/api/signup/clubs/${dirId("House Club")}`)).json().club;
  assert.equal(one0.on_paceup, true);
  const one = (await call("GET", `/api/signup/clubs/${dirId("Hill Walkers")}`)).json().club;
  assert.equal(one.activity_type, "Trekking");
});

test("a club owner signs up: club held as pending, they're its owner and signed in", async () => {
  const res = await call("POST", "/api/signup", { payload: { directoryId: dirId("Sunrise Striders"), name: "priya kulkarni", phone: "98220 12345" } });
  assert.equal(res.statusCode, 201, res.body);
  priya = { cookie: sessionCookie(res), clubId: res.json().club_id };
  assert.deepEqual(res.json().clubs.map((c) => [c.name, c.role]), [["Sunrise Striders", "owner"]]);
  const club = db.prepare("SELECT signup_status, activity, city FROM clubs WHERE id = ?").get(priya.clubId);
  assert.deepEqual(club, { signup_status: "pending", activity: "Running", city: "Pune" });
  assert.equal(db.prepare("SELECT signup_unverified FROM users WHERE phone = '919822012345'").get().signup_unverified, 1);
  const wa = (await call("GET", `/api/clubs/${priya.clubId}/whatsapp`, { cookie: priya.cookie })).json().whatsapp;
  assert.equal(wa.signup_pending, true);
  assert.equal(wa.owner_phone, "+919822012345");
  assert.equal(wa.can_manage_number, true);
  // Now it shows as on PaceUp, being set up, and can't be claimed twice.
  const sug = (await call("GET", "/api/signup/clubs?q=sunrise")).json().clubs;
  assert.deepEqual(sug.map((c) => [c.name, c.on_paceup, c.pending]), [["Sunrise Striders", true, true]]);
  const again = await call("POST", "/api/signup", { payload: { directoryId: dirId("Sunrise Striders"), name: "Someone Else", phone: "98220 99999" } });
  assert.equal(again.statusCode, 409);
  assert.equal(again.json().club.pending, true);
  const typed = await call("POST", "/api/signup", { payload: { clubName: "sunrise striders club", city: "Pune", activity: "Running", name: "Someone Else", phone: "98220 99999" } });
  assert.equal(typed.statusCode, 409, "typing the same name doesn't make a second copy");
});

test("a number already on PaceUp has to sign in first; signed-in people set up with their account", async () => {
  const res = await call("POST", "/api/signup", { payload: { clubName: "Night Owls", city: "Bangalore", activity: "Running", name: "Priya", phone: "+91 98220 12345" } });
  assert.equal(res.statusCode, 409);
  assert.equal(res.json().code, "has_account");
  const mine = await call("POST", "/api/signup", { cookie: boss.cookie, payload: { clubName: "Night Owls", city: "bangalore", activity: "Other: Skating" } });
  assert.equal(mine.statusCode, 201, mine.body);
  const c = db.prepare("SELECT name, city, activity, signup_status FROM clubs WHERE id = ?").get(mine.json().club_id);
  assert.deepEqual(c, { name: "Night Owls", city: "Bengaluru", activity: "Other: Skating", signup_status: "pending" });
  assert.equal((await call("POST", "/api/signup", { payload: { clubName: "X", city: "Pune", activity: "Running", name: "A B", phone: "98220 55555" } })).statusCode, 400);
  const dup = await call("POST", "/api/signup", { payload: { clubName: "House Club", city: "Delhi", activity: "Cycling", name: "A B", phone: "98220 55555" } });
  assert.equal(dup.statusCode, 409);
  assert.equal(dup.json().club.on_paceup, true, "told it's already on PaceUp, not asked to rename");
});

test("linking WhatsApp makes the club live and verifies an owner who linked their own number", async () => {
  const wa = (method, suffix = "", payload) => call(method, `/api/clubs/${priya.clubId}/whatsapp${suffix}`, { cookie: priya.cookie, payload });
  assert.equal((await wa("POST", "/connect", { phone: "+91 98220 12345" })).statusCode, 200);
  await worker.tick();
  await fakeSessions.get(priya.clubId).scan("919822012345"); await settle();
  assert.equal(db.prepare("SELECT signup_status FROM clubs WHERE id = ?").get(priya.clubId).signup_status, "live");
  assert.equal(db.prepare("SELECT signup_unverified FROM users WHERE phone = '919822012345'").get().signup_unverified, 0);
  assert.equal((await wa("GET")).json().whatsapp.signup_pending, undefined);
  // Released only if not linked: a live club stays even after 14 days.
  releaseStaleSignups(Date.now() + 15 * 24 * 3600 * 1000);
  assert.ok(db.prepare("SELECT 1 FROM clubs WHERE id = ?").get(priya.clubId));
});

test("asking to help run a club that's on PaceUp tells its owner from the club's own number", async () => {
  const res = await call("POST", "/api/signup/request-access", { payload: { clubId: priya.clubId, name: "Meera Iyer", phone: "98470 55555" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json(), { sent: true }, "nothing about the owner goes back to the public");
  const msg = db.prepare("SELECT club_id, to_phone, text FROM whatsapp_direct WHERE to_phone = '919822012345' ORDER BY created_at DESC LIMIT 1").get();
  assert.equal(msg.club_id, priya.clubId);
  assert.match(msg.text, /\*Meera Iyer\* \(\+91 98470 55555\) asked to help run \*Sunrise Striders\*/);
  await call("POST", "/api/signup/request-access", { payload: { clubId: priya.clubId, name: "Meera Iyer", phone: "98470 55555" } });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM club_access_requests").get().n, 1, "asking twice tells the owner once");
  assert.equal((await call("POST", "/api/signup/request-access", { payload: { clubId: boss.clubId, name: "X Y", phone: "98470 55556" } })).statusCode, 200, "the PaceUp Admin's own club takes requests like any other");
});

test("a directory club with no city or activity asks the owner for them", async () => {
  const id = dirId("No City Club");
  assert.equal((await call("POST", "/api/signup", { payload: { directoryId: id, name: "Asha Rao", phone: "98220 66666" } })).statusCode, 400);
  const res = await call("POST", "/api/signup", { payload: { directoryId: id, city: "Nagpur", activity: "Walking", name: "Asha Rao", phone: "98220 66666" } });
  assert.equal(res.statusCode, 201, res.body);
  assert.deepEqual(db.prepare("SELECT city, activity FROM clubs WHERE id = ?").get(res.json().club_id), { city: "Nagpur", activity: "Walking" });
});

test("an admin request made while the club's WhatsApp is offline reaches the owner when it reconnects", async () => {
  const { tellOwner } = await import("../src/signup.js");
  db.prepare("UPDATE whatsapp_connections SET status = 'reconnecting' WHERE club_id = ?").run(priya.clubId);
  await call("POST", "/api/signup/request-access", { payload: { clubId: priya.clubId, name: "Kiran Rao", phone: "98470 66666" } });
  const sent = () => db.prepare("SELECT COUNT(*) AS n FROM whatsapp_direct WHERE text LIKE '%Kiran Rao%'").get().n;
  assert.equal(sent(), 0);
  db.prepare("UPDATE whatsapp_connections SET status = 'connected' WHERE club_id = ?").run(priya.clubId);
  assert.equal(tellOwner(priya.clubId), 1);
  assert.equal(sent(), 1);
  assert.equal(tellOwner(priya.clubId), 0, "told once");
});

test("adding a club whose name is in the directory only for another city doesn't take that entry", async () => {
  const res = await call("POST", "/api/signup", { payload: { clubName: "Hill Walkers", city: "Mumbai", activity: "Walking", name: "Neha Joshi", phone: "98220 55511" } });
  assert.equal(res.statusCode, 201, res.body);
  assert.equal(db.prepare("SELECT club_id FROM club_directory WHERE name = 'Hill Walkers'").get().club_id, null, "the Kolkata entry is untouched");
});

test("a held club not linked within 14 days is released, with its directory entry and account", async () => {
  const res = await call("POST", "/api/signup", { payload: { directoryId: dirId("Ridge Runners"), name: "Anil Verma", phone: "98160 77777" } });
  assert.equal(res.statusCode, 201, res.body);
  const clubId = res.json().club_id;
  assert.equal(db.prepare("SELECT status FROM club_directory WHERE name = 'Ridge Runners'").get().status, "pilot");
  assert.equal(releaseStaleSignups(Date.now() + 25 * 3600 * 1000), 0, "still held the next day, so the owner can come back");
  assert.equal(releaseStaleSignups(Date.now() + 13 * 24 * 3600 * 1000), 0);
  releaseStaleSignups(Date.now() + 15 * 24 * 3600 * 1000);
  assert.equal(db.prepare("SELECT 1 FROM clubs WHERE id = ?").get(clubId), undefined);
  assert.deepEqual(db.prepare("SELECT status, club_id, city, activity FROM club_directory WHERE name = 'Ridge Runners'").get(), { status: "prospect", club_id: null, city: "Shimla", activity: "Running" }, "the directory entry is exactly as it was");
  assert.equal(db.prepare("SELECT 1 FROM users WHERE phone = '919160777777' OR phone = '919816077777'").get(), undefined);
  assert.equal((await call("GET", "/api/auth/me", { cookie: sessionCookie(res) })).statusCode, 401);
  assert.equal((await call("GET", "/api/signup/clubs?q=ridge")).json().clubs[0].on_paceup, false, "free to set up again");
});

test("someone who typed another person's number loses access once a club adds that number", async () => {
  const res = await call("POST", "/api/signup", { payload: { clubName: "Lake Swimmers", city: "Pune", activity: "Swimming", name: "Fake Name", phone: "98220 33333" } });
  const cookie = sessionCookie(res);
  assert.equal((await call("GET", "/api/auth/me", { cookie })).statusCode, 200);
  await call("POST", `/api/clubs/${priya.clubId}/people`, { cookie: priya.cookie, payload: { phone: "+91 98220 33333", name: "Real Person", role: "admin" } });
  assert.equal((await call("GET", "/api/auth/me", { cookie })).statusCode, 401);
});

test("when the number's real owner signs in with a WhatsApp code, the earlier sign-ins on it end", async () => {
  const res = await call("POST", "/api/signup", { payload: { clubName: "Dawn Patrol", city: "Pune", activity: "Cycling", name: "Typed By Someone", phone: "98220 44444" } });
  const typedCookie = sessionCookie(res);
  const u = db.prepare("SELECT id FROM users WHERE phone = '919822044444'").get();
  // The number is on a connected club's list (straight in the database, as the roster sync would).
  db.prepare("INSERT INTO club_memberships (id, club_id, user_id, role) VALUES ('m-dawn', ?, ?, 'member')").run(priya.clubId, u.id);
  db.prepare("UPDATE login_codes SET created_at = ?").run(new Date(Date.now() - 20 * 60000).toISOString());
  assert.equal((await call("POST", "/api/auth/otp/start", { payload: { phone: "98220 44444" } })).statusCode, 200);
  const text = db.prepare("SELECT text FROM whatsapp_direct WHERE to_phone = '919822044444' ORDER BY created_at DESC LIMIT 1").get().text;
  const v = await call("POST", "/api/auth/otp/verify", { payload: { phone: "98220 44444", code: text.match(/\*(\d{6})\*/)[1] } });
  assert.equal(v.statusCode, 200, v.body);
  assert.equal((await call("GET", "/api/auth/me", { cookie: typedCookie })).statusCode, 401, "whoever typed the number is signed out");
  assert.equal((await call("GET", "/api/auth/me", { cookie: sessionCookie(v) })).statusCode, 200, "the real owner stays signed in");
});

test("the PaceUp Admin sees every sign-up and can remove one; a linked number is unlinked first", async () => {
  const list = (await call("GET", "/api/platform/signups", { cookie: boss.cookie })).json();
  const striders = list.clubs.find((c) => c.name === "Sunrise Striders");
  assert.equal(striders.signup_status, "live");
  assert.equal(striders.number_matches_directory, true);
  assert.equal(list.clubs.find((c) => c.name === "Lake Swimmers").in_directory, false);
  const meera = list.requests.find((r) => r.name === "Meera Iyer");
  assert.equal(meera.owner_told, true);
  assert.equal((await call("GET", "/api/platform/signups", { cookie: priya.cookie })).statusCode, 403);
  assert.equal((await call("DELETE", `/api/platform/signups/${boss.clubId}`, { cookie: boss.cookie })).statusCode, 404, "only self-signed-up clubs");

  assert.equal((await call("DELETE", `/api/platform/signups/${priya.clubId}`, { cookie: boss.cookie })).statusCode, 200);
  assert.equal(db.prepare("SELECT signup_status FROM clubs WHERE id = ?").get(priya.clubId).signup_status, "removed");
  assert.equal((await call("GET", `/api/clubs/${priya.clubId}/whatsapp`, { cookie: priya.cookie })).statusCode, 404, "the owner can't use it any more");
  await worker.tick(); await settle();
  releaseStaleSignups();
  assert.equal(db.prepare("SELECT 1 FROM clubs WHERE id = ?").get(priya.clubId), undefined);
  assert.equal(db.prepare("SELECT status FROM club_directory WHERE name = 'Sunrise Striders'").get().status, "prospect");
});

test("removing a sign-up mid-pairing waits for the unlink, then clears its unverified account", async () => {
  const res = await call("POST", "/api/signup", { payload: { clubName: "Fog Riders", city: "Pune", activity: "Cycling", name: "Tara Shah", phone: "98220 77777" } });
  const clubId = res.json().club_id, cookie = sessionCookie(res);
  await call("POST", `/api/clubs/${clubId}/whatsapp/connect`, { cookie, payload: { phone: "+91 98220 88888" } });
  assert.equal((await call("DELETE", `/api/platform/signups/${clubId}`, { cookie: boss.cookie })).statusCode, 200);
  releaseStaleSignups(Date.now() + 25 * 3600 * 1000);
  assert.ok(db.prepare("SELECT 1 FROM clubs WHERE id = ?").get(clubId), "kept until the worker unlinks");
  await worker.tick(); await settle();
  releaseStaleSignups();
  assert.equal(db.prepare("SELECT 1 FROM clubs WHERE id = ?").get(clubId), undefined);
  assert.equal(db.prepare("SELECT 1 FROM users WHERE phone = '919822077777'").get(), undefined, "the number is free to sign up again");
});

test.after(async () => { worker.stop(); await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
