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
const app = await buildApp({ logger: false, authRateLimit: 1000, publicRateLimit: 1000 });
const { call, registerOwner } = makeClient(app);
const worker = new WhatsAppWorker({ adapter: fakeAdapter, dataDir: mkdtempSync(join(tmpdir(), "wa-")), log: {}, sendGapMs: [0, 1] });
const settle = () => new Promise((r) => setTimeout(r, 10));

const club = await registerOwner("Club Owner", "owner@example.com", "Sunrise Riders");
const roster = () => call("GET", `/api/clubs/${club.clubId}/roster`, { cookie: club.cookie }).then((r) => r.json());
const b64 = (s) => Buffer.from(s).toString("base64");

test("connecting and choosing the group pulls its members; WhatsApp names fill the roster", async () => {
  assert.equal((await call("POST", `/api/clubs/${club.clubId}/roster/sync`, { cookie: club.cookie })).statusCode, 409, "needs a connected group");
  // A phone book can't be matched before the group is known.
  assert.equal((await call("POST", `/api/clubs/${club.clubId}/roster/import`, { cookie: club.cookie, payload: { filename: "c.vcf", data: b64("BEGIN:VCARD\nFN:X Y\nTEL:9876500001\nEND:VCARD\n") } })).statusCode, 409);

  await call("POST", `/api/clubs/${club.clubId}/whatsapp/connect`, { cookie: club.cookie });
  await worker.tick();
  const session = fakeSessions.get(club.clubId);
  session.participants = [
    { phone: "919876500001" }, { phone: "919876500002" }, { phone: "919876500003" },
    { phone: "919876500004" }, { lid: "123456789@lid" }
  ];
  session.scan(); await settle();
  // WhatsApp shares (before PaceUp knows the group, so names wait in memory) a saved contact name and someone's own name from a group message.
  session.contacts([{ phone: "919876500001", saved_name: "Amit Daga" }, { lid: "123456789@lid", push_name: "🚴 Kavya" }, { phone: "919999999999", saved_name: "Not In Group" }]);
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
  assert.deepEqual(names.sort(), ["Amit D (cycling)", "Amit Kumar", "Kavya", "Priya Sharma", "अमित"].sort(), "phone-book name replaces the WhatsApp-only name");
  assert.ok(!names.includes("Plumber Raju"), "contacts outside the group are not stored");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM club_roster WHERE name LIKE '%Raju%'").get().n, 0);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_contacts WHERE phone = '919000000000'").get().n, 0);
});

test("phone books read in the browser arrive as names and numbers only", async () => {
  const { readVcf: browserVcf } = await import("../../web/src/phonebook.js");
  const photo = "A".repeat(200000);
  const vcf = ["BEGIN:VCARD", "VERSION:3.0", "FN:Priya Sharma", "TEL:98765-00003", `PHOTO;ENCODING=b;TYPE=JPEG:${photo}`, "END:VCARD",
    "BEGIN:VCARD", "VERSION:3.0", "FN:Stranger Danger", "TEL:+91 90000 11111", "END:VCARD"].join("\r\n");
  const contacts = browserVcf(vcf);
  assert.deepEqual(contacts, [{ name: "Priya Sharma", phones: ["98765-00003"] }, { name: "Stranger Danger", phones: ["+91 90000 11111"] }]);
  assert.ok(JSON.stringify(contacts).length < 200, "the photo never leaves the phone");
  const res = await call("POST", `/api/clubs/${club.clubId}/roster/phonebook`, { cookie: club.cookie, payload: { contacts } });
  assert.equal(res.statusCode, 200, res.body);
  assert.equal(res.json().matched, 1);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM club_roster WHERE name = 'Stranger Danger'").get().n, 0, "non-members discarded");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM whatsapp_contacts WHERE phone = '919000011111'").get().n, 0);
});

test("admins fix names; a later sync never overwrites them", async () => {
  const amit = (await roster()).people.find((p) => p.name === "Amit D (cycling)");
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
  await call("PUT", `/api/r/${ride.code}/rsvp`, { payload: { status: "going", name: "Guest Rider" } });
  db.prepare("UPDATE outbox SET not_before = ? WHERE status = 'pending'").run(new Date(Date.now() - 1000).toISOString());
  const { sent } = await import("../src/whatsapp/fake-adapter.js");
  await worker.tick(); await settle(); await worker.tick();
  const list = sent.find((m) => /going/.test(m.text));
  assert.ok(list, JSON.stringify(sent.map((m) => m.text)));
  assert.match(list.text, /1\. Kavya\n2\. Guest R\./);
});

test.after(async () => { worker.stop(); await app.close(); db.close(); rmSync(tempDir, { recursive: true, force: true }); });
