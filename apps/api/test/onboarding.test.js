import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { useTempDatabase, sessionCookie, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { WhatsAppWorker } = await import("../src/whatsapp/worker.js");
const { fakeAdapter, fakeSessions } = await import("../src/whatsapp/fake-adapter.js");
const app = await buildApp({ logger: false, authRateLimit: 1000 });
const { call, registerOwner } = makeClient(app);
const worker = new WhatsAppWorker({ adapter: fakeAdapter, dataDir: mkdtempSync(join(tmpdir(), "wa-")), log: {}, sendGapMs: [0, 1] });
const settle = () => new Promise((r) => setTimeout(r, 10));

// The Super Admin's own club (like the pilot club).
const boss = await registerOwner("Boss Owner", "boss@example.com", "Pilot Club");
db.prepare("UPDATE users SET platform_role = 'super_admin' WHERE id = ?").run(boss.user.id);

const CSV = [
  "id,name,kind,city,state,sport_or_activity,social_links,club_phone,club_email,source_name",
  'a1,"Sunrise Striders",club,Pune,Maharashtra,Running,"instagram: https://www.instagram.com/sunrisestriders | facebook: https://www.facebook.com/ss",+919822012345,hello@striders.example,facebook.com',
  'a2,"Sunrise Striders Club",club,Pune,Maharashtra,Running,"website: https://striders.example",,,web',
  'a3,"KOLKATA HILL WALKERS",club,Calcutta,West Bengal,"Hiking,Trekking",,,,web',
  'a4,"",club,Pune,Maharashtra,Running,,,,web',
  'a5,"Pilot Club",club,Bengaluru,Karnataka,Running,,,,web'
].join("\n");

let striders, link;

test("directory import: everything kept, duplicates merged, names and cities tidied, stats reported", async () => {
  const res = await call("POST", "/api/platform/directory/import", { cookie: boss.cookie, payload: { csv: CSV } });
  assert.equal(res.statusCode, 200, res.body);
  const s = res.json().stats;
  assert.deepEqual([s.rows, s.added, s.merged_in_file, s.skipped_no_name, s.with_phone, s.with_email, s.linked_to_paceup], [5, 3, 1, 1, 1, 1, 1]);
  const list = (await call("GET", "/api/platform/directory?q=sunrise", { cookie: boss.cookie })).json();
  striders = list.items[0];
  assert.equal(list.total, 1);
  assert.equal(striders.instagram, "https://www.instagram.com/sunrisestriders");
  assert.equal(striders.website, "https://striders.example", "the duplicate's website was merged in");
  assert.equal(striders.phone, "919822012345");
  const kolkata = (await call("GET", "/api/platform/directory?q=hill", { cookie: boss.cookie })).json().items[0];
  assert.deepEqual([kolkata.name, kolkata.city, kolkata.activity], ["Kolkata Hill Walkers", "Kolkata", "Hiking, Trekking"]);
  const pilot = (await call("GET", "/api/platform/directory?q=pilot", { cookie: boss.cookie })).json().items[0];
  assert.equal(pilot.club_id, boss.clubId, "a club already on PaceUp is linked, not duplicated");
  // Importing the same file again changes nothing.
  const again = (await call("POST", "/api/platform/directory/import", { cookie: boss.cookie, payload: { csv: CSV } })).json().stats;
  assert.deepEqual([again.added, again.updated], [0, 3]);
});

test("autocomplete shows only name, city and activity; contacts and the directory are Super Admin only", async () => {
  const sug = (await call("GET", "/api/platform/directory/suggest?q=sunr", { cookie: boss.cookie })).json().clubs;
  assert.deepEqual(sug.map((c) => c.name), ["Sunrise Striders"]);
  assert.deepEqual(Object.keys(sug[0]).sort(), ["activity", "city", "club_id", "directory_id", "name", "on_paceup"]);
  const pilot = (await call("GET", "/api/platform/directory/suggest?q=pilot", { cookie: boss.cookie })).json().clubs;
  assert.equal(pilot[0].on_paceup, true);
  const other = await registerOwner("Other Owner", "other@example.com", "Other Club");
  for (const url of ["/api/platform/directory/suggest?q=sunr", "/api/platform/directory?q=sunrise"]) assert.equal((await call("GET", url, { cookie: other.cookie })).statusCode, 403);
  assert.equal((await call("PATCH", `/api/platform/directory/${striders.id}`, { cookie: other.cookie, payload: { status: "contacted" } })).statusCode, 403);
  const upd = await call("PATCH", `/api/platform/directory/${striders.id}`, { cookie: boss.cookie, payload: { status: "contacted", notes: "Spoke to Priya" } });
  assert.equal(upd.json().entry.status, "contacted");
});

test("Super Admin creates a club from the directory and gets the owner's one-time link", async () => {
  const res = await call("POST", "/api/platform/clubs", { cookie: boss.cookie, payload: { name: "Sunrise Striders", city: "Pune", activity: "Running", directoryId: striders.id, adminPhone: "+91 98220 11111", adminName: "Priya Kulkarni" } });
  assert.equal(res.statusCode, 201, res.body);
  const body = res.json();
  link = body.owner_link;
  assert.match(link.url, /\/start\/[\w-]{20,}$/);
  assert.match(link.text, /I've set up \*Sunrise Striders\* on \*PaceUp\*/);
  assert.ok(link.text.includes(link.url) && link.text.startsWith("Hi Priya 👋") && link.text.endsWith("– Boss, PaceUp"));
  assert.ok(new Date(link.expires_at).getTime() - Date.now() > 6.9 * 86400000, "valid 7 days");
  assert.equal(link.phone, "919822011111");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_direct").get().n, 0, "nothing is sent from any club's number");
  const entry = db.prepare("SELECT status, club_id FROM club_directory WHERE id = ?").get(striders.id);
  assert.deepEqual(entry, { status: "pilot", club_id: body.club.id });
  assert.equal((await call("POST", "/api/platform/clubs", { cookie: boss.cookie, payload: { name: "sunrise striders club" } })).statusCode, 409, "no second copy of a club");
});

test("the owner signs in once with the link and the last 4 digits", async () => {
  const token = link.url.split("/").at(-1);
  const check = await call("POST", "/api/start/check", { payload: { token } });
  assert.deepEqual(check.json(), { club_name: "Sunrise Striders", first_name: "Priya", phone: "+91 98220 •••••" });
  assert.equal((await call("POST", "/api/start", { payload: { token, last4: "0000" } })).statusCode, 400);
  const ok = await call("POST", "/api/start", { payload: { token, last4: "1111" } });
  assert.equal(ok.statusCode, 200, ok.body);
  assert.deepEqual(ok.json().clubs.map((c) => [c.name, c.role]), [["Sunrise Striders", "owner"]]);
  const cookie = sessionCookie(ok);
  assert.equal((await call("GET", "/api/auth/me", { cookie })).json().user.name, "Priya Kulkarni");
  assert.equal((await call("POST", "/api/start", { payload: { token, last4: "1111" } })).statusCode, 410, "works once");
  link.cookie = cookie;
  link.clubId = ok.json().club_id;
});

test("wrong digits five times burn the link; a new link replaces the old one", async () => {
  const fresh = (await call("POST", `/api/platform/clubs/${link.clubId}/owner-link`, { cookie: boss.cookie })).json().owner_link;
  const newer = (await call("POST", `/api/platform/clubs/${link.clubId}/owner-link`, { cookie: boss.cookie })).json().owner_link;
  assert.equal((await call("POST", "/api/start/check", { payload: { token: fresh.url.split("/").at(-1) } })).statusCode, 410, "the older link stops working");
  const token = newer.url.split("/").at(-1);
  for (let i = 0; i < 5; i++) await call("POST", "/api/start", { payload: { token, last4: "9999" } });
  assert.equal((await call("POST", "/api/start", { payload: { token, last4: "1111" } })).statusCode, 410);
});

test("the owner links the club's own number with a code; other admins can't; the club goes live", async () => {
  const wa = (cookie, method = "GET", suffix = "", payload) => call(method, `/api/clubs/${link.clubId}/whatsapp${suffix}`, { cookie, payload });
  // A second admin of the club, who doesn't own the number.
  await call("POST", `/api/clubs/${link.clubId}/people`, { cookie: link.cookie, payload: { phone: "+91 98220 22222", name: "Ravi Admin", role: "admin" } });
  const ravi = db.prepare("SELECT id FROM users WHERE phone = '919822022222'").get();
  const ownerView = (await wa(link.cookie)).json().whatsapp;
  assert.equal(ownerView.can_manage_number, true);
  assert.deepEqual(ownerView.club_owner, { name: "Priya Kulkarni", is_you: true });
  assert.ok(ownerView.stats, "the club owner sees message counts");

  assert.equal((await wa(link.cookie, "POST", "/connect", { phone: "+91 98220 12345" })).statusCode, 200);
  await worker.tick();
  const pairing = (await wa(link.cookie)).json().whatsapp;
  assert.equal(pairing.status, "pairing");
  assert.equal(pairing.pairing_code, "ABCD-1234");
  assert.equal(fakeSessions.get(link.clubId).pairingPhone, "919822012345");
  const left = new Date(pairing.pairing_expires_at).getTime() - Date.now();
  assert.ok(left > 4 * 60 * 1000 && left <= 5 * 60 * 1000, "the code shows about 5 minutes left");

  // "Get a new code": the same number again starts a fresh pairing session.
  const first = fakeSessions.get(link.clubId);
  await wa(link.cookie, "POST", "/connect", { phone: "+91 98220 12345" });
  assert.equal((await wa(link.cookie)).json().whatsapp.pairing_code, null, "the old code is withdrawn at once");
  await worker.tick();
  assert.notEqual(fakeSessions.get(link.clubId), first, "a new pairing session was started");
  assert.equal((await wa(link.cookie)).json().whatsapp.pairing_code, "ABCD-1234");

  // An unused code expires; the number is kept so the owner can get a new code in one tap.
  worker.sessions.get(link.clubId).codeAt -= 6 * 60 * 1000;
  await worker.tick();
  const expired = (await wa(link.cookie)).json().whatsapp;
  assert.equal(expired.desired, "off");
  assert.equal(expired.pairing_phone, "+919822012345");
  assert.match(expired.last_error, /expired/);
  await wa(link.cookie, "POST", "/connect", { phone: expired.pairing_phone });
  await worker.tick();
  assert.equal((await wa(link.cookie)).json().whatsapp.pairing_code, "ABCD-1234");
  await fakeSessions.get(link.clubId).scan("919822012345"); await settle();
  assert.equal((await wa(link.cookie)).json().whatsapp.status, "connected");
  assert.equal(db.prepare("SELECT status FROM club_directory WHERE club_id = ?").get(link.clubId).status, "live");

  // The owner picks the club's groups from their own phone.
  const all = (await wa(link.cookie, "GET", "/all-groups")).json();
  assert.equal(all.groups.length, 2);
  assert.equal((await wa(link.cookie, "PUT", "/all-groups", { jids: [all.groups[0].jid] })).statusCode, 200);
  assert.equal((await wa(link.cookie)).json().whatsapp.groups.length, 1);

  // Another admin of the club can't link, unlink or see the groups.
  const raviCookie = await signInByCode("919822022222", link.clubId);
  assert.equal((await wa(raviCookie)).json().whatsapp.can_manage_number, false);
  assert.equal((await wa(raviCookie, "POST", "/disconnect")).statusCode, 403);
  assert.equal((await wa(raviCookie, "GET", "/all-groups")).statusCode, 403);

  assert.equal((await wa(raviCookie)).json().whatsapp.stats, undefined, "club admins don't see message counts");

  // The PaceUp Admin (or the owner) can hand the club to another member; the old owner stays an admin.
  const moved = await call("PUT", `/api/clubs/${link.clubId}/owner`, { cookie: boss.cookie, payload: { userId: ravi.id } });
  assert.equal(moved.json().owner_id, ravi.id);
  assert.equal((await wa(raviCookie)).json().whatsapp.can_manage_number, true);
  assert.equal((await wa(link.cookie, "POST", "/disconnect")).statusCode, 403, "Priya no longer owns the club");
  assert.equal((await call("PUT", `/api/clubs/${link.clubId}/owner`, { cookie: boss.cookie, payload: { userId: boss.user.id } })).statusCode, 400, "the new owner must be in the club");
});

test("another club can't use a number already linked to a club", async () => {
  const res = await call("POST", `/api/clubs/${boss.clubId}/whatsapp/connect`, { cookie: boss.cookie, payload: { phone: "+91 98220 12345" } });
  assert.equal(res.statusCode, 409);
});

test("a name typed at the first RSVP replaces a WhatsApp nickname; an admin's name is kept", async () => {
  const t = new Date().toISOString();
  db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, phone, source, created_at, updated_at) VALUES ('nick', ?, 'Anu 🏃', 'anu', '919811100077', 'whatsapp', ?, ?)").run(link.clubId, t, t);
  db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, phone, source, created_at, updated_at) VALUES ('adm', ?, 'Vikram Rao', 'vikram rao', '919811100088', 'manual', ?, ?)").run(link.clubId, t, t);
  const ride = await call("POST", `/api/clubs/${link.clubId}/rides`, { cookie: link.cookie, payload: { title: "Sunday long run", starts_at: new Date(Date.now() + 2 * 86400000).toISOString(), meeting_point: "Park", status: "published" } });
  assert.equal(ride.statusCode, 201, ride.body);
  const code = ride.json().ride.code;
  const r1 = await call("PUT", `/api/r/${code}/rsvp`, { payload: { status: "going", name: "Anuradha Kale", phone: "98111 00077" } });
  assert.equal(r1.statusCode, 200, r1.body);
  assert.equal(db.prepare("SELECT name FROM club_roster WHERE id = 'nick'").get().name, "Anuradha Kale");
  await call("PUT", `/api/r/${code}/rsvp`, { payload: { status: "going", name: "Vicky", phone: "98111 00088" } });
  assert.equal(db.prepare("SELECT name FROM club_roster WHERE id = 'adm'").get().name, "Vikram Rao");
});

async function signInByCode(phone, clubId) {
  db.prepare("UPDATE login_codes SET created_at = ?").run(new Date(Date.now() - 20 * 60000).toISOString());
  const s = await call("POST", "/api/auth/otp/start", { payload: { phone } });
  assert.equal(s.statusCode, 200, s.body);
  const row = db.prepare("SELECT club_id, text FROM whatsapp_direct WHERE to_phone = ? ORDER BY created_at DESC, rowid DESC LIMIT 1").get(phone);
  assert.equal(row.club_id, clubId, "the code comes from the club's own number");
  const v = await call("POST", "/api/auth/otp/verify", { payload: { phone, code: row.text.match(/\*(\d{6})\*/)[1] } });
  return sessionCookie(v);
}

test.after(async () => { worker.stop(); await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
