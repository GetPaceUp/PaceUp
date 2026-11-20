import crypto from "node:crypto";
import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { useTempDatabase, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { WhatsAppWorker } = await import("../src/whatsapp/worker.js");
const { fakeAdapter, fakeSessions } = await import("../src/whatsapp/fake-adapter.js");
const { readVcf } = await import("../src/roster.js");
const ph = (n) => "98" + String([...n.toLowerCase().replace(/\s+/g, " ").trim()].reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 1e8, 7)).padStart(8, "0");
const app = await buildApp({ logger: false, authRateLimit: 1000, publicRateLimit: 1000 });
const { call, registerOwner } = makeClient(app);
const worker = new WhatsAppWorker({ adapter: fakeAdapter, dataDir: mkdtempSync(join(tmpdir(), "wa-")), log: {}, sendGapMs: [0, 1], groupAddLimits: { gapMs: 0 } });
const settle = () => new Promise((r) => setTimeout(r, 10));

const club = await registerOwner("Club Owner", "owner@example.com", "Sunrise Riders");
const roster = () => call("GET", `/api/clubs/${club.clubId}/roster`, { cookie: club.cookie }).then((r) => r.json());
const b64 = (s) => Buffer.from(s).toString("base64");

test("connecting and choosing the group pulls its members; WhatsApp names fill the roster", async () => {
  assert.equal((await call("POST", `/api/clubs/${club.clubId}/roster/sync`, { cookie: club.cookie })).statusCode, 409, "needs a connected group");
  // A phone book can't be matched before the group is known.
  assert.equal((await call("POST", `/api/clubs/${club.clubId}/roster/import`, { cookie: club.cookie, payload: { filename: "c.vcf", data: b64("BEGIN:VCARD\nFN:X Y\nTEL:9876500001\nEND:VCARD\n") } })).statusCode, 409);

  db.prepare("UPDATE users SET platform_role = 'super_admin' WHERE id = ?").run(club.user.id); // only the Super Admin links the number
  await call("POST", `/api/clubs/${club.clubId}/whatsapp/connect`, { cookie: club.cookie });
  db.prepare("UPDATE users SET platform_role = 'user' WHERE id = ?").run(club.user.id);
  await worker.tick();
  const session = fakeSessions.get(club.clubId);
  session.participants = [
    { phone: "919876500001" }, { phone: "919876500002" }, { phone: "919876500003" },
    { phone: "919876500004" }, { lid: "123456789@lid" }
  ];
  session.scan(); await settle();
  // WhatsApp shares (before PaceUp knows the group, so names wait in memory) a saved contact name and someone's own name from a group message.
  session.contacts([{ phone: "919876500001", saved_name: "Amit Daga" }, { lid: "123456789@lid", push_name: "🚴 Kavya" }, { phone: "919999999999", saved_name: "Not In Group" }]);
  // The Super Admin links the club's groups (here, all the number's groups).
  db.prepare("UPDATE whatsapp_connections SET allowed_groups_json = ? WHERE club_id = ?").run(JSON.stringify(session.groups.map((g) => g.jid)), club.clubId);
  const groups = (await call("GET", `/api/clubs/${club.clubId}/whatsapp`, { cookie: club.cookie })).json().whatsapp.groups;
  await call("PUT", `/api/clubs/${club.clubId}/whatsapp/group`, { cookie: club.cookie, payload: { jid: groups[0].jid } });
  await worker.tick();

  const r = await roster();
  assert.deepEqual(r.people.map((p) => [p.name, p.source]), [["Amit Daga", "whatsapp"], ["Kavya", "whatsapp"]]);
  assert.equal(r.whatsapp.group_members, 5);
  assert.equal(r.whatsapp.syncing, false);
  assert.deepEqual(r.unnamed.people.map((p) => p.phone), ["919876500002", "919876500003", "919876500004"]);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_contacts WHERE phone = '919999999999'").get().n, 0, "people outside the group are never stored");
});

test("a phone-book export names group members and discards everyone else", async () => {
  const vcf = [
    "BEGIN:VCARD", "VERSION:2.1", "N;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Kumar;Amit;;;", "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:Amit Kumar", "TEL;CELL:+91 98765 00002", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Amit D (cycling)", "TEL;TYPE=CELL:09876500001", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Plumber Raju", "TEL:+91 90000 00000", "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "N:Sharma;Priya;;;", "item1.TEL;type=CELL:98765-00003", "END:VCARD",
    "BEGIN:VCARD", "VERSION:2.1", "FN;CHARSET=UTF-8;ENCODING=QUOTED-PRINTABLE:=E0=A4=85=E0=A4=AE=E0=A4=BF=E0=A4=A4", "TEL:9876500004", "END:VCARD"
  ].join("\r\n");
  const res = await call("POST", `/api/clubs/${club.clubId}/roster/import`, { cookie: club.cookie, payload: { filename: "contacts.vcf", data: b64(vcf) } });
  assert.equal(res.statusCode, 200, res.body);
  const out = res.json();
  assert.equal(out.mode, "phonebook");
  assert.deepEqual({ contacts: out.contacts, matched: out.matched, added: out.added, renamed: out.renamed, named: out.named, unnamed: out.unnamed, group: out.group_members },
    { contacts: 5, matched: 4, added: 3, renamed: 1, named: 5, unnamed: 0, group: 5 });
  const names = (await roster()).people.map((p) => p.name);
  assert.deepEqual(names.sort(), ["Amit D", "Amit Kumar", "Kavya", "Priya Sharma", "अमित"].sort(), "phone-book name replaces the WhatsApp-only name");
  assert.ok(!names.includes("Plumber Raju"), "contacts outside the group are not stored");
  assert.equal(db.prepare("SELECT contact_name FROM club_roster WHERE name = 'Amit D'").get().contact_name, "Amit D (cycling)", "the phone-book name is kept, members see the tidy one");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM club_roster WHERE name LIKE '%Raju%'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_contacts WHERE phone = '919000000000'").get().n, 0);
});

test("names imported before the tidy-up get a preview, and only ticked ones change", async () => {
  const now = new Date().toISOString();
  const add = (name, phone) => db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, phone, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'upload', ?, ?)")
    .run(crypto.randomUUID(), club.clubId, name, name.toLowerCase(), phone, now, now);
  add("Aneesh Saraiya Cycling Sector 65", "919910678100");
  add("Ankit Manocha Cycling Nirvana", "918762544321");
  add("Kavya Cycling", "918762544999"); // tidies to "Kavya", which is already on the list
  const base = `/api/clubs/${club.clubId}/roster/cleanup`;
  const preview = (await call("GET", base, { cookie: club.cookie })).json().people;
  const byName = Object.fromEntries(preview.map((p) => [p.name, p]));
  assert.equal(byName["Aneesh Saraiya Cycling Sector 65"].suggested, "Aneesh Saraiya");
  assert.equal(byName["Ankit Manocha Cycling Nirvana"].suggested, "Ankit Manocha");
  assert.ok(!preview.some((p) => p.name === "Priya Sharma"), "clean names aren't listed");
  const res = (await call("POST", base, { cookie: club.cookie, payload: { ids: [byName["Aneesh Saraiya Cycling Sector 65"].id, byName["Kavya Cycling"].id] } })).json();
  assert.deepEqual(res, { applied: 1, skipped: ["Kavya"] });
  const row = db.prepare("SELECT name, contact_name FROM club_roster WHERE phone = '919910678100'").get();
  assert.deepEqual(row, { name: "Aneesh Saraiya", contact_name: "Aneesh Saraiya Cycling Sector 65" });
  assert.equal(db.prepare("SELECT name FROM club_roster WHERE phone = '918762544321'").get().name, "Ankit Manocha Cycling Nirvana", "unticked stays as it was");
  db.prepare("DELETE FROM club_roster WHERE phone IN ('919910678100', '918762544321', '918762544999')").run();
});

test("admins fix names; a later sync never overwrites them", async () => {
  const amit = (await roster()).people.find((p) => p.name === "Amit D");
  assert.equal((await call("PATCH", `/api/clubs/${club.clubId}/roster/${amit.id}`, { cookie: club.cookie, payload: { name: "Amit Kumar" } })).statusCode, 409, "names stay unique");
  assert.equal((await call("PATCH", `/api/clubs/${club.clubId}/roster/${amit.id}`, { cookie: club.cookie, payload: { name: "Amit Daga" } })).statusCode, 200);
  fakeSessions.get(club.clubId).contacts([{ phone: "919876500001", saved_name: "Someone Else" }]);
  await call("POST", `/api/clubs/${club.clubId}/roster/sync`, { cookie: club.cookie });
  await new Promise((r) => setTimeout(r, 5));
  await worker.tick();
  assert.ok((await roster()).people.some((p) => p.name === "Amit Daga"));

  // A new member joins the group without a name: the admin names them.
  fakeSessions.get(club.clubId).participants.push({ phone: "919876500009" });
  await call("POST", `/api/clubs/${club.clubId}/roster/sync`, { cookie: club.cookie });
  await new Promise((r) => setTimeout(r, 5));
  await worker.tick();
  const unnamed = (await roster()).unnamed.people;
  assert.equal(unnamed.length, 1);
  assert.equal((await call("POST", `/api/clubs/${club.clubId}/roster/from-group/${unnamed[0].id}`, { cookie: club.cookie, payload: { name: "neha joshi" } })).statusCode, 201);
  const after = await roster();
  assert.equal(after.unnamed.count, 0);
  assert.ok(after.people.some((p) => p.name === "Neha Joshi" && p.phone === "919876500009"));
});


test("the WhatsApp rider list is still right for roster picks and guests", async () => {
  const ride = (await call("POST", `/api/clubs/${club.clubId}/rides`, { cookie: club.cookie, payload: { title: "Sunday ride", starts_at: new Date(Date.now() + 86400000).toISOString(), meeting_point: "Tulip Chowk", status: "published" } })).json().ride;
  const kavya = (await call("GET", `/api/r/${ride.code}/names?q=kav`)).json().names[0];
  await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", roster_id: kavya.id } });
  await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", name: "Guest Rider", phone: ph("Guest Rider") } });
  db.prepare("UPDATE outbox SET not_before = ? WHERE status = 'pending'").run(new Date(Date.now() - 1000).toISOString());
  const { sent } = await import("../src/whatsapp/fake-adapter.js");
  await worker.tick(); await settle(); await worker.tick();
  const list = sent.find((m) => /going/.test(m.text));
  assert.ok(list, JSON.stringify(sent.map((m) => m.text)));
  assert.match(list.text, /1\. Kavya\n2\. Guest R\./);
});

test.after(async () => { worker.stop(); await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });

test("the member list can come from several groups, like a master group that has everyone", async () => {
  const session = fakeSessions.get(club.clubId);
  const groups = (await call("GET", `/api/clubs/${club.clubId}/whatsapp`, { cookie: club.cookie })).json().whatsapp.groups;
  const master = groups[1];
  session.groupMembers[master.jid] = [{ phone: "919876500001" }, { phone: "919876511111" }, { phone: "919876522222" }];
  assert.equal((await call("PUT", `/api/clubs/${club.clubId}/whatsapp/member-groups`, { cookie: club.cookie, payload: { jids: ["nope@g.us"] } })).statusCode, 400);
  const res = await call("PUT", `/api/clubs/${club.clubId}/whatsapp/member-groups`, { cookie: club.cookie, payload: { jids: [groups[0].jid, master.jid] } });
  assert.equal(res.statusCode, 200, res.body);
  assert.deepEqual(res.json().whatsapp.member_groups.map((g) => g.name), [groups[0].name, master.name]);
  await new Promise((r) => setTimeout(r, 5));
  await worker.tick();
  const before = (await roster()).whatsapp.group_members;
  // Phone book now matches people who are only in the master group; the shared person counts once.
  const out = (await call("POST", `/api/clubs/${club.clubId}/roster/phonebook`, { cookie: club.cookie, payload: { contacts: [{ name: "Explorer One Cycling Sector 9", phones: ["98765 11111"] }, { name: "Explorer Two", phones: ["9876522222"] }] } })).json();
  assert.equal(out.matched, 2);
  assert.ok(before >= 2 && out.group_members === before);
  const names = (await roster()).people.map((p) => p.name);
  assert.ok(names.includes("Explorer One") && names.includes("Explorer Two"));
  assert.match((await roster()).whatsapp.group, / \+ /, "both groups shown as the source");
});

test("adding someone can also add them to a club WhatsApp group, slowly, with an invite link when privacy blocks it", async () => {
  const session = fakeSessions.get(club.clubId);
  const r = await roster();
  assert.ok(r.whatsapp.groups.length >= 1, "the page gets the club's groups to pick from");
  assert.ok(r.whatsapp.add_group, "and suggests the member-list group");
  const jid = r.whatsapp.add_group;
  const add = (name, phone, wa_group_jid) => call("POST", `/api/clubs/${club.clubId}/roster`, { cookie: club.cookie, payload: { name, phone, wa_group_jid } });
  const status = (id) => call("GET", `/api/clubs/${club.clubId}/roster/group-adds/${id}`, { cookie: club.cookie }).then((x) => x.json().group_add);

  // A group outside the club's linked ones is refused, and nobody is added to the list.
  const bad = await add("Outsider Person", "9876511111", "personal@g.us");
  assert.equal(bad.statusCode, 400);
  assert.equal((await call("GET", `/api/clubs/${club.clubId}/roster?q=outsider`, { cookie: club.cookie })).json().people.length, 0);

  const ok = await add("Riya Kapoor", "9876511112", jid);
  assert.equal(ok.statusCode, 201, ok.body);
  assert.equal(ok.json().group_add.status, "pending");
  const sentBefore = session.added.length;
  await worker.tick();
  assert.equal((await status(ok.json().group_add.id)).status, "added");
  assert.deepEqual(session.added.at(-1), { groupJid: jid, phone: "919876511112" });
  assert.equal(session.added.length, sentBefore + 1);

  session.addResults["919876511113"] = "403";
  const priv = await add("Dev Malhotra", "9876511113", jid);
  await worker.tick();
  const pv = await status(priv.json().group_add.id);
  assert.equal(pv.status, "invited");
  const { sent } = await import("../src/whatsapp/fake-adapter.js");
  assert.match(sent.at(-1).text, /chat\.whatsapp\.com/);
  assert.equal(sent.at(-1).jid, "919876511113@s.whatsapp.net");

  session.addResults["919876511114"] = new Error("not-authorized");
  const noAdmin = await add("Isha Rao", "9876511114", jid);
  await worker.tick();
  assert.match((await status(noAdmin.json().group_add.id)).detail, /needs to be an admin/);

  // Without a gap override the worker waits between adds instead of doing them in a burst.
  const slow = new WhatsAppWorker({ adapter: fakeAdapter, dataDir: mkdtempSync(join(tmpdir(), "wa-")), log: {}, sendGapMs: [0, 1] });
  slow.sessions = worker.sessions;
  const later = await add("Kunal Shah", "9876511115", jid);
  await slow.tick();
  assert.equal((await status(later.json().group_add.id)).status, "pending", "45 seconds haven't passed since the last add");
});
