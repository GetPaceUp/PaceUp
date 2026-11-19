import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, readFileSync } from "node:fs";
import { useTempDatabase, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { readCsv, peopleFromRows } = await import("../src/roster.js");
const ph = (n) => "98" + String([...n.toLowerCase().replace(/\s+/g, " ").trim()].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1e8, 7)).padStart(8, "0");
const app = await buildApp({ logger: false, authRateLimit: 1000, publicRateLimit: 1000 });
const { call, registerOwner } = makeClient(app);

const owner = await registerOwner("Club Owner", "owner@example.com", "Sunrise Riders");
const other = await registerOwner("Other Owner", "other@example.com", "Other Club");
const fixture = (name) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url)).toString("base64");
const upload = (club, filename, data) => call("POST", `/api/clubs/${club.clubId}/roster/import`, { cookie: club.cookie, payload: { filename, data } });
const roster = (club, q = "") => call("GET", `/api/clubs/${club.clubId}/roster?q=${encodeURIComponent(q)}`, { cookie: club.cookie }).then((r) => r.json());
const inDays = (d) => new Date(Date.now() + d * 86400000).toISOString();

test("Excel upload: finds the name and phone columns, cleans names, skips blanks and duplicates", async () => {
  const res = await upload(owner, "Riders list.xlsx", fixture("roster.xlsx"));
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual({ added: res.json().added, read: res.json().read }, { added: 4, read: 5 });
  const people = (await roster(owner)).people;
  assert.deepEqual(people.map((p) => [p.name, p.phone]), [
    ["Amit Daga", "919876543210"], ["Amit Kumar", "919876543211"], ["Priya Sharma", null], ["Ravi O'Neil & Co <x>", null]
  ]);
});

test("re-uploading merges: same phone or same name updates, nothing is duplicated or removed", async () => {
  const res = (await upload(owner, "update.xlsx", fixture("roster-first-last.xlsx"))).json();
  assert.deepEqual({ added: res.added, unchanged: res.unchanged, total: res.total }, { added: 1, unchanged: 1, total: 5 });
  const again = (await upload(owner, "Riders list.xlsx", fixture("roster.xlsx"))).json();
  assert.equal(again.added, 0);
  assert.equal(again.total, 5);
  // CSV with a new phone for an existing name fills it in.
  const csv = Buffer.from("﻿Name;Phone\nPriya Sharma;098450 11122\n\"Lee, Ann\";\n").toString("base64");
  const merged = (await upload(owner, "list.csv", csv)).json();
  assert.deepEqual({ added: merged.added, updated: merged.updated }, { added: 1, updated: 1 });
  assert.equal((await roster(owner, "priya")).people[0].phone, "919845011122");
});

test("CSV and header-less sheets are read", () => {
  assert.deepEqual(readCsv("a,\"b \"\"q\"\"\",c\r\n1,2,3"), [["a", "b \"q\"", "c"], ["1", "2", "3"]]);
  assert.deepEqual(peopleFromRows([["rohan mehta", "9811122233"], ["Sita Rao", "9811122234"]]), [
    { name: "Rohan Mehta", phone: "919811122233" }, { name: "Sita Rao", phone: "919811122234" }
  ]);
});

test("bad files get a clear error; only admins of that club can manage the roster", async () => {
  const bad = await upload(owner, "x.xlsx", Buffer.from("not a zip").toString("base64"));
  assert.equal(bad.statusCode, 400);
  assert.match(bad.json().error, /Excel/);
  assert.equal((await upload(owner, "old.xls", Buffer.from("\xD0\xCF\x11\xE0junk", "binary").toString("base64"))).statusCode, 400);
  assert.equal((await upload(owner, "empty.csv", Buffer.from("Name\n\n").toString("base64"))).statusCode, 400);
  assert.equal((await call("GET", `/api/clubs/${owner.clubId}/roster`, { cookie: other.cookie })).statusCode, 404);
  assert.equal((await call("GET", `/api/clubs/${owner.clubId}/roster`)).statusCode, 401);
  assert.equal((await roster(other)).total, 0, "rosters are per club");
});

test("add and remove one person", async () => {
  const added = await call("POST", `/api/clubs/${owner.clubId}/roster`, { cookie: owner.cookie, payload: { name: "neha joshi", phone: "98111 00001" } });
  assert.equal(added.statusCode, 409, "already there from the upload");
  assert.equal((await call("POST", `/api/clubs/${owner.clubId}/roster`, { cookie: owner.cookie, payload: { name: "Kabir Singh" } })).statusCode, 400, "a mobile number is required");
  assert.equal((await call("POST", `/api/clubs/${owner.clubId}/roster`, { cookie: owner.cookie, payload: { name: "Kabir Singh", phone: "12" } })).statusCode, 400);
  const ok = await call("POST", `/api/clubs/${owner.clubId}/roster`, { cookie: owner.cookie, payload: { name: "Kabir Singh", phone: "98111 00077" } });
  assert.equal(ok.statusCode, 201);
  assert.deepEqual(ok.json().person, { name: "Kabir Singh", phone: "919811100077" });
  const dup = await call("POST", `/api/clubs/${owner.clubId}/roster`, { cookie: owner.cookie, payload: { name: "Kabir Two", phone: "+91 98111-00077" } });
  assert.equal(dup.statusCode, 409);
  assert.match(dup.json().error, /Already on the list as Kabir Singh/);
  assert.equal(dup.json().existing.name, "Kabir Singh", "the page can point at the entry that's already there");
  const sameName = await call("POST", `/api/clubs/${owner.clubId}/roster`, { cookie: owner.cookie, payload: { name: "kabir singh", phone: "98111 00078" } });
  assert.equal(sameName.statusCode, 409);
  assert.equal(sameName.json().existing.phone, "919811100077");
  const kabir = (await roster(owner, "kabir")).people[0];
  assert.equal((await call("DELETE", `/api/clubs/${owner.clubId}/roster/${kabir.id}`, { cookie: other.cookie })).statusCode, 404);
  assert.equal((await call("DELETE", `/api/clubs/${owner.clubId}/roster/${kabir.id}`, { cookie: owner.cookie })).statusCode, 200);
  assert.equal((await roster(owner, "kabir")).people.length, 0);
});

test("the rider flow: tap I'm in, type Amit, pick Amit Daga, done. No sign-in.", async () => {
  const ride = (await call("POST", `/api/clubs/${owner.clubId}/rides`, { cookie: owner.cookie, payload: { title: "Sunday ride", starts_at: inDays(2), meeting_point: "Tulip Chowk", status: "published" } })).json().ride;
  const names = async (q) => (await call("GET", `/api/r/${ride.code}/names?q=${q}`)).json().names;
  const amits = await names("Amit");
  assert.deepEqual(amits.map((n) => n.name), ["Amit Daga", "Amit Kumar"]);
  assert.ok(amits.every((n) => n.phone === undefined), "phone numbers are never public");
  assert.deepEqual((await names("dag")).map((n) => n.name), ["Amit Daga"], "surname matches too");
  assert.deepEqual(await names("a"), [], "two letters minimum");

  const res = await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", roster_id: amits[0].id } });
  assert.equal(res.statusCode, 200);
  const device = [].concat(res.headers["set-cookie"]).find((c) => c.startsWith("paceup_device=")).split(";")[0];
  assert.deepEqual(res.json().ride.participants.map((p) => [p.name, p.is_you]), [["Amit Daga", true]]);

  // Someone else can't pick Amit Daga again, or type the same name as a guest.
  assert.equal((await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", roster_id: amits[0].id } })).statusCode, 409);
  assert.equal((await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", name: "amit daga", phone: ph("amit daga") } })).statusCode, 409);
  // Another club's roster entry can't be used here.
  await call("POST", `/api/clubs/${other.clubId}/roster`, { cookie: other.cookie, payload: { name: "Outside Person", phone: "98222 00001" } });
  const outside = db.prepare("SELECT id FROM club_roster WHERE club_id = ?").get(other.clubId).id;
  assert.equal((await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", roster_id: outside } })).statusCode, 400);

  // Amit picked the wrong name: switch to Amit Kumar from the same phone, then cancel.
  const switched = await call("PUT", `/api/r/${ride.code}/rsvp`, { cookie: device, payload: { status: "going", roster_id: amits[1].id } });
  assert.deepEqual(switched.json().ride.participants.map((p) => p.name), ["Amit Kumar"]);
  const admin = (await call("GET", `/api/r/${ride.code}`, { cookie: owner.cookie })).json().ride;
  assert.equal(admin.participants[0].kind, "roster");
  const cancelled = await call("PUT", `/api/r/${ride.code}/rsvp`, { cookie: device, payload: { status: "cancelled" } });
  assert.equal(cancelled.json().ride.going_count, 0);
  // Renaming the roster entry shows up on the list.
  await call("PUT", `/api/r/${ride.code}/rsvp`, { cookie: device, payload: { status: "going", roster_id: amits[1].id } });
  db.prepare("UPDATE club_roster SET name = 'Amit K. Kumar' WHERE id = ?").run(amits[1].id);
  assert.equal((await call("GET", `/api/r/${ride.code}`)).json().ride.participants[0].name, "Amit K. Kumar");
});

test.after(async () => { await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });

test("someone new gives a mobile number: a number already on the list joins as that person", async () => {
  const ride = (await call("POST", `/api/clubs/${owner.clubId}/rides`, { cookie: owner.cookie, payload: { title: "Phone check", starts_at: inDays(3), meeting_point: "Gate 1", status: "published" } })).json().ride;
  await call("POST", `/api/clubs/${owner.clubId}/roster`, { cookie: owner.cookie, payload: { name: "Shrikant Joshi", phone: "98333 44455" } });
  assert.equal((await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", name: "Shrikant" } })).statusCode, 400, "number required for someone new");
  const res = await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", name: "Shrikant", phone: "+91 98333 44455" } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().ride.participants.map((p) => p.name), ["Shrikant Joshi"], "matched by number, no duplicate");
  const fresh = await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", name: "Meera Iyer", phone: "98333 99999" } });
  assert.equal(fresh.statusCode, 200);
  assert.equal(db.prepare("SELECT phone FROM club_roster WHERE club_id = ? AND name = 'Meera Iyer'").get(owner.clubId).phone, "919833399999");
});
