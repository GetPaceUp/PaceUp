// The club roster: the names riders pick from when they tap "I'm in".
// Admins upload an Excel (.xlsx) or CSV file. Uploads merge: a person already on
// the roster (same phone, or same name) is updated, never duplicated, and nobody
// is removed by a re-upload. Riders never sign in; this list is only for picking.
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { db, DomainError } from "./db.js";
import { listUnnamed, groupCount, contactById } from "./whatsapp/contacts.js";
import { memberGroups, clubGroups } from "./whatsapp/outbox.js";
import { queueGroupAdd, groupAddView } from "./whatsapp/group-adds.js";

const nowIso = () => new Date().toISOString();
export const nameKey = (name) => String(name || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

export function cleanName(raw) {
  let name = String(raw ?? "").normalize("NFKC").replace(/[\u0000-\u001f]/g, " ").replace(/\s+/g, " ").trim();
  // "AMIT DAGA" or "amit daga" -> "Amit Daga"; mixed case is kept as typed.
  if (name && (name === name.toUpperCase() || name === name.toLowerCase())) {
    name = name.toLowerCase().replace(/(^|[\s'-])(\p{L})/gu, (m, sep, ch) => sep + ch.toUpperCase());
  }
  return name.slice(0, 80);
}
// Words people add after a contact's name to remember where they know them from
// ("Aneesh Saraiya Cycling Sector 65"). Everything from the first one onward is dropped.
const TAG_WORDS = new Set(("cycling cyclist cyclists cycle cycles bicycle bicycling ride rides rider riders riding run runs runner runners running " +
  "jog jogging walk walkers walking fof club clubs gym fitness bike bikes biker bikers biking mtb roadie trek trekking trekker hike hikes hiker hiking " +
  "swim swims swimmer swimming tri triathlon triathlete ironman marathon marathoner ultra strava group grp decathlon coach sports sport " +
  "sector sec society soc apartments apartment apts tower towers phase ph block colony enclave").split(" "));
const titleWord = (w) => (w.length > 1 && (w === w.toLowerCase() || (w === w.toUpperCase() && w.length > 3)) ? w[0].toUpperCase() + w.slice(1).toLowerCase() : w);

/** "aneesh saraiya Cycling Sector 65" -> "Aneesh Saraiya". Never drops the first word. */
export function tidyContactName(raw) {
  let name = cleanName(raw)
    .replace(/\p{Extended_Pictographic}|\uFE0F|\u200D/gu, " ")
    .replace(/[([{].*?([)\]}]|$)/g, " ")
    .split(/\s+[-–—|@,/:]\s*|\s*[|@/]\s*/)[0]
    .replace(/\s+/g, " ").trim();
  const words = name.split(" ").filter(Boolean);
  let end = words.findIndex((w, i) => i > 0 && (TAG_WORDS.has(w.toLowerCase().replace(/[^\p{L}]/gu, "")) || /\d/.test(w)));
  if (end === -1) end = words.length;
  const kept = words.slice(0, end).map((w) => w.split(/([-'])/).map(titleWord).join(""));
  const tidy = kept.join(" ").replace(/[.\-_'\s]+$/, "").trim();
  return tidy.length >= 2 ? tidy : cleanName(raw);
}

export function cleanPhone(raw) {
  let digits = String(raw ?? "").replace(/\.0+$/, "").replace(/\D/g, "");
  if (digits.length === 10) digits = `91${digits}`; // Indian mobile without country code
  if (digits.length === 11 && digits.startsWith("0")) digits = `91${digits.slice(1)}`;
  return digits.length >= 8 && digits.length <= 15 ? digits : null;
}

// ---------------------------------------------------------------- file reading

const MAX_UNZIPPED = 40 * 1024 * 1024;

/** Minimal .xlsx reader: first worksheet as rows of strings. No dependency. */
export function readXlsx(buffer) {
  const files = unzip(buffer, (name) => /^xl\/(sharedStrings\.xml|workbook\.xml|_rels\/workbook\.xml\.rels|worksheets\/[^/]+\.xml)$/.test(name));
  const shared = [];
  const sst = files.get("xl/sharedStrings.xml");
  if (sst) for (const si of sst.match(/<si>[\s\S]*?<\/si>/g) || []) shared.push(textOf(si));
  let sheetPath = "xl/worksheets/sheet1.xml";
  const wb = files.get("xl/workbook.xml"), rels = files.get("xl/_rels/workbook.xml.rels");
  const rid = wb?.match(/<sheet\b[^>]*\br:id="([^"]+)"/)?.[1];
  const target = rid && rels?.match(new RegExp(`<Relationship\\b[^>]*Id="${rid}"[^>]*Target="([^"]+)"`))?.[1]
    || rid && rels?.match(new RegExp(`<Relationship\\b[^>]*Target="([^"]+)"[^>]*Id="${rid}"`))?.[1];
  if (target) sheetPath = target.startsWith("/") ? target.slice(1) : `xl/${target.replace(/^\.\//, "")}`;
  const sheet = files.get(sheetPath) || [...files].find(([n]) => n.startsWith("xl/worksheets/"))?.[1];
  if (!sheet) throw new DomainError(400, "That Excel file has no worksheet we can read.");
  const rows = [];
  for (const row of sheet.match(/<row\b[\s\S]*?<\/row>/g) || []) {
    const cells = [];
    for (const c of row.match(/<c\b[^>]*?(?:\/>|>[\s\S]*?<\/c>)/g) || []) {
      const ref = c.match(/\br="([A-Z]+)\d+"/)?.[1];
      const type = c.match(/\bt="([^"]+)"/)?.[1];
      let value = "";
      if (type === "inlineStr") value = textOf(c);
      else {
        const v = c.match(/<v>([\s\S]*?)<\/v>/)?.[1];
        if (v != null) value = type === "s" ? (shared[Number(v)] ?? "") : decode(v);
      }
      const col = ref ? [...ref].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1 : cells.length;
      cells[col] = value;
    }
    rows.push(Array.from(cells, (v) => v ?? ""));
  }
  return rows;
}
const decode = (s) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, "\"").replace(/&apos;/g, "'")
  .replace(/&#x([0-9a-f]+);/gi, (m, h) => String.fromCodePoint(parseInt(h, 16))).replace(/&#(\d+);/g, (m, d) => String.fromCodePoint(+d)).replace(/&amp;/g, "&");
const textOf = (xml) => (xml.match(/<t\b[^>]*>[\s\S]*?<\/t>/g) || []).map((t) => decode(t.replace(/<[^>]+>/g, ""))).join("");

function unzip(buf, wanted) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new DomainError(400, "That doesn't look like an Excel (.xlsx) file.");
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const out = new Map();
  let total = 0;
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new DomainError(400, "That Excel file looks damaged.");
    const method = buf.readUInt16LE(p + 10), size = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), elen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), local = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nlen);
    p += 46 + nlen + elen + clen;
    if (!wanted(name)) continue;
    total += usize;
    if (total > MAX_UNZIPPED) throw new DomainError(400, "That Excel file is too large.");
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = buf.subarray(start, start + size);
    const raw = method === 0 ? data : method === 8 ? inflateRawSync(data, { maxOutputLength: MAX_UNZIPPED }) : null;
    if (raw) out.set(name, raw.toString("utf8"));
  }
  return out;
}

export function readCsv(text) {
  text = text.replace(/^﻿/, "");
  const firstLine = text.split(/\r?\n/, 1)[0];
  const delim = [",", ";", "\t"].sort((a, b) => firstLine.split(b).length - firstLine.split(a).length)[0];
  const rows = [];
  let row = [], field = "", quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === "\"" && text[i + 1] === "\"") { field += "\""; i++; }
      else if (ch === "\"") quoted = false;
      else field += ch;
    } else if (ch === "\"") quoted = true;
    else if (ch === delim) { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field); rows.push(row); row = []; field = "";
    } else field += ch;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Finds the name (or first + last name) and phone columns, with or without a header row. */
export function peopleFromRows(rows) {
  rows = rows.filter((r) => r.some((c) => String(c).trim()));
  if (!rows.length) return [];
  const header = rows[0].map((c) => String(c).trim().toLowerCase());
  const find = (re) => header.findIndex((h) => re.test(h));
  const hasHeader = header.some((h) => /name|phone|mobile|whatsapp|member|rider|participant/.test(h));
  let nameCol = -1, firstCol = -1, lastCol = -1, phoneCol = -1;
  if (hasHeader) {
    firstCol = find(/^first\s*name|^first$|^given/);
    lastCol = find(/^last\s*name|^surname|^last$|^family/);
    nameCol = find(/^(full\s*)?name$|full\s*name|^member|^rider|^participant|^name\b/);
    if (nameCol === firstCol) nameCol = -1;
    phoneCol = find(/phone|mobile|whats\s*app|contact|number|cell/);
    rows = rows.slice(1);
  }
  if (!hasHeader || (nameCol < 0 && firstCol < 0)) {
    const sample = rows.slice(0, 20);
    const width = Math.max(...sample.map((r) => r.length));
    const score = (i, re) => sample.filter((r) => re.test(String(r[i] ?? "").trim())).length;
    const cols = Array.from({ length: width }, (_, i) => i);
    nameCol = cols.sort((a, b) => score(b, /\p{L}{2}/u) - score(a, /\p{L}{2}/u))[0];
    if (phoneCol < 0) phoneCol = Array.from({ length: width }, (_, i) => i).find((i) => i !== nameCol && score(i, /^\+?[\d\s()-]{8,}$/) > sample.length / 2) ?? -1;
  }
  const people = [];
  for (const r of rows) {
    const name = cleanName(nameCol >= 0 ? r[nameCol] : [r[firstCol], r[lastCol]].filter(Boolean).join(" "));
    if (name.length < 2 || !/\p{L}/u.test(name)) continue;
    people.push({ name, phone: phoneCol >= 0 ? cleanPhone(r[phoneCol]) : null });
  }
  return people;
}

// ---------------------------------------------------------------- phone books

function decodeQuotedPrintable(value, charset = "utf-8") {
  const bytes = [];
  const text = value.replace(/=\r?\n/g, "");
  for (let i = 0; i < text.length; i++) {
    if (text[i] === "=" && /^[0-9A-F]{2}$/i.test(text.slice(i + 1, i + 3))) { bytes.push(parseInt(text.slice(i + 1, i + 3), 16)); i += 2; }
    else bytes.push(...Buffer.from(text[i], "utf8"));
  }
  return Buffer.from(bytes).toString(/utf-?8/i.test(charset) ? "utf8" : "latin1");
}
const unescapeVcf = (v) => v.replace(/\\n/gi, " ").replace(/\\([,;\\])/g, "$1");

/** Contacts from a .vcf phone-book export (Android, iPhone/iCloud, Google). [{ name, phones: [] }] */
export function readVcf(text) {
  // Unfold continuation lines (RFC 6350) and quoted-printable soft breaks.
  const lines = text.replace(/^\uFEFF/, "").replace(/=\r?\n(?=[^\r\n])/g, "=QPSOFT").replace(/\r?\n[ \t]/g, "").split(/\r?\n/).map((l) => l.replace(/=QPSOFT/g, "=\n"));
  const contacts = [];
  let cur = null;
  for (const line of lines) {
    if (/^BEGIN:VCARD/i.test(line)) { cur = { fn: "", n: "", phones: [] }; continue; }
    if (/^END:VCARD/i.test(line)) { if (cur) contacts.push(cur); cur = null; continue; }
    if (!cur) continue;
    const idx = line.indexOf(":");
    if (idx < 0) continue;
    const [prop, ...params] = line.slice(0, idx).split(";");
    let value = line.slice(idx + 1);
    const key = prop.replace(/^item\d+\./i, "").toUpperCase();
    if (params.some((p) => /QUOTED-PRINTABLE/i.test(p))) value = decodeQuotedPrintable(value, params.find((p) => /CHARSET=/i.test(p))?.split("=")[1]);
    if (key === "FN") cur.fn = unescapeVcf(value);
    else if (key === "N") { const [last = "", first = "", middle = ""] = value.split(";").map(unescapeVcf); cur.n = [first, middle, last].filter(Boolean).join(" "); }
    else if (key === "TEL") cur.phones.push(value.replace(/^tel:/i, ""));
  }
  return contacts.map((c) => ({ name: cleanName(c.fn || c.n), phones: c.phones.map(cleanPhone).filter(Boolean) }));
}

/** Google Contacts CSV (and similar exports): every phone column, values may hold "a ::: b". */
function readContactsCsvRows(rows) {
  const header = rows[0].map((h) => String(h).trim().toLowerCase());
  const col = (re) => header.findIndex((h) => re.test(h));
  const full = col(/^(name|full name|display name)$/), first = col(/^(first name|given name)$/), middle = col(/^(middle name|additional name)$/), last = col(/^(last name|family name|surname)$/);
  const phoneCols = header.map((h, i) => (/phone.*value|^phone|mobile/.test(h) && !/type|label/.test(h) ? i : -1)).filter((i) => i >= 0);
  return rows.slice(1).map((r) => ({
    name: cleanName((full >= 0 && r[full]) || [r[first], r[middle], r[last]].filter((x) => x && String(x).trim()).join(" ")),
    phones: phoneCols.flatMap((i) => String(r[i] || "").split(":::")).map(cleanPhone).filter(Boolean)
  }));
}

/** Is this file a phone book (match against the group) rather than a club list? */
export function readPhoneBook(filename, buffer) {
  const text = buffer.toString("utf8");
  if (/\.vcf$/i.test(filename) || /^\uFEFF?BEGIN:VCARD/i.test(text)) return readVcf(text);
  if (/\.csv$/i.test(filename)) {
    const rows = readCsv(text);
    const header = (rows[0] || []).join(",").toLowerCase();
    if (/phone 1 - value|given name|e-mail 1 - value|labels/.test(header)) return readContactsCsvRows(rows);
  }
  return null;
}

/**
 * Names group members from a phone book: only contacts whose number is in the
 * club's WhatsApp group are used; everything else is discarded, never stored.
 * The phone-book name replaces a name that only came from WhatsApp, but never
 * one an admin typed or uploaded.
 */
export function namesFromPhoneBook(clubId, contacts) {
  const group = db.prepare("SELECT id, phone, lid FROM whatsapp_contacts WHERE club_id = ? AND in_group = 1 AND phone IS NOT NULL").all(clubId);
  if (!group.length) throw new DomainError(409, "Connect WhatsApp and choose the club group first, so PaceUp knows whose numbers to keep.");
  const byPhone = new Map(group.map((g) => [g.phone, g]));
  const result = { contacts: contacts.length, matched: 0, added: 0, renamed: 0, unchanged: 0, clashes: [] };
  db.transaction(() => {
    const seen = new Set();
    for (const raw of contacts) {
      const c = { ...raw, contact_name: raw.name, name: tidyContactName(raw.name) };
      if (c.name.length < 2 || !/\p{L}/u.test(c.name)) continue;
      const member = c.phones.map((p) => byPhone.get(p)).find(Boolean);
      if (!member || seen.has(member.phone)) continue;
      seen.add(member.phone);
      result.matched++;
      const now = nowIso();
      const existing = db.prepare("SELECT * FROM club_roster WHERE club_id = ? AND (phone = ? OR (? IS NOT NULL AND wa_jid = ?))").get(clubId, member.phone, member.lid, member.lid);
      const clash = db.prepare("SELECT id FROM club_roster WHERE club_id = ? AND name_key = ? AND id != ?").get(clubId, nameKey(c.name), existing?.id || "");
      if (existing) {
        if (existing.source !== "whatsapp" || existing.name === c.name) { result.unchanged++; continue; }
        if (clash) { result.clashes.push(c.name); continue; }
        db.prepare("UPDATE club_roster SET name = ?, name_key = ?, contact_name = ?, source = 'upload', updated_at = ? WHERE id = ?").run(c.name, nameKey(c.name), c.contact_name, now, existing.id);
        result.renamed++;
      } else {
        if (clash) { result.clashes.push(c.name); continue; }
        db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, contact_name, phone, wa_jid, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'upload', ?, ?)")
          .run(randomUUID(), clubId, c.name, nameKey(c.name), c.contact_name, member.phone, member.lid, now, now);
        result.added++;
      }
    }
  }).immediate();
  result.group_members = groupCount(clubId);
  result.unnamed = listUnnamed(clubId).count;
  result.named = result.group_members - result.unnamed;
  result.total = db.prepare("SELECT COUNT(*) AS n FROM club_roster WHERE club_id = ?").get(clubId).n;
  return result;
}

export function parseRosterFile(filename, buffer) {
  const isXlsx = /\.xlsx$/i.test(filename) || buffer.subarray(0, 2).toString() === "PK";
  if (/\.xls$/i.test(filename) && !isXlsx) throw new DomainError(400, "Old .xls files aren't supported. In Excel, use Save As → Excel Workbook (.xlsx) or CSV.");
  return peopleFromRows(isXlsx ? readXlsx(buffer) : readCsv(buffer.toString("utf8")));
}

// ---------------------------------------------------------------- roster data

/**
 * The member-list entry a number belongs to: their main number, or an extra number an admin
 * linked to them (one person, two phones). { ...row, extra: true } for an extra number.
 */
export function rosterByPhone(clubId, phone) {
  if (!phone) return null;
  const main = db.prepare("SELECT * FROM club_roster WHERE club_id = ? AND phone = ?").get(clubId, phone);
  if (main) return main;
  const extra = db.prepare("SELECT ro.* FROM club_roster_phones x INNER JOIN club_roster ro ON ro.id = x.roster_id WHERE x.club_id = ? AND x.phone = ?").get(clubId, phone);
  return extra ? { ...extra, extra: true } : null;
}

/** Adds or updates people. Matches on phone first, then on name. Never deletes. */
export function mergeRoster(clubId, people, source = "upload") {
  return db.transaction(() => {
    const result = { added: 0, updated: 0, unchanged: 0 };
    const byPhone = db.prepare("SELECT * FROM club_roster WHERE club_id = ? AND phone = ?");
    const byName = db.prepare("SELECT * FROM club_roster WHERE club_id = ? AND name_key = ?");
    const seen = new Set();
    for (const person of people) {
      const key = nameKey(person.name);
      if (seen.has(key)) continue; // duplicate line inside the file
      seen.add(key);
      const extra = person.phone && !byPhone.get(clubId, person.phone) && rosterByPhone(clubId, person.phone);
      if (extra) { result.unchanged++; continue; } // a second number of someone already on the list
      const existing = (person.phone && byPhone.get(clubId, person.phone)) || byName.get(clubId, key);
      const now = nowIso();
      if (!existing) {
        db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, phone, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(randomUUID(), clubId, person.name, key, person.phone, source, now, now);
        result.added++;
        continue;
      }
      const name = existing.name_key === key || byName.get(clubId, key) ? existing.name : person.name; // rename only if free
      const phone = person.phone || existing.phone;
      if (name === existing.name && phone === existing.phone) { result.unchanged++; continue; }
      db.prepare("UPDATE club_roster SET name = ?, name_key = ?, phone = ?, updated_at = ? WHERE id = ?").run(name, nameKey(name), phone, now, existing.id);
      result.updated++;
    }
    result.total = db.prepare("SELECT COUNT(*) AS n FROM club_roster WHERE club_id = ?").get(clubId).n;
    return result;
  }).immediate();
}

export function listRoster(clubId, q = "") {
  const key = nameKey(q).replace(/[%_\\]/g, "");
  const where = key ? "AND (name_key LIKE ? OR name_key LIKE ? OR phone LIKE ? OR id IN (SELECT roster_id FROM club_roster_phones WHERE club_id = ro.club_id AND phone LIKE ?))" : "";
  const digits = `%${key.replace(/\D/g, "") || "-"}%`;
  const args = key ? [`${key}%`, `% ${key}%`, digits, digits] : [];
  return {
    total: db.prepare("SELECT COUNT(*) AS n FROM club_roster WHERE club_id = ?").get(clubId).n,
    people: db.prepare(`SELECT id, name, phone, source, self_added, created_at,
      (SELECT COUNT(*) FROM club_roster_phones x WHERE x.roster_id = ro.id) AS extra_numbers
      FROM club_roster ro WHERE club_id = ? ${where} ORDER BY name_key LIMIT 300`).all(clubId, ...args)
  };
}

export function addRosterPerson(clubId, name, phone) {
  const clean = cleanName(name);
  if (clean.length < 2) throw new DomainError(400, "Enter a name (at least 2 letters).");
  const mobile = cleanPhone(phone);
  if (!mobile) throw new DomainError(400, "Enter a valid mobile number.");
  const already = (row, message) => Object.assign(new DomainError(409, message), { existing: { id: row.id, name: row.name, phone: row.phone } });
  const sameNumber = rosterByPhone(clubId, mobile);
  if (sameNumber) throw already(sameNumber, `Already on the list as ${sameNumber.name}.`);
  const sameName = db.prepare("SELECT id, name, phone FROM club_roster WHERE club_id = ? AND name_key = ?").get(clubId, nameKey(clean));
  if (sameName) throw already(sameName, `${sameName.name} is already on the list with another number. If it's someone else, add a surname or initial.`);
  return { ...mergeRoster(clubId, [{ name: clean, phone: mobile }], "manual"), person: { name: clean, phone: mobile } };
}

export function renameRosterPerson(clubId, id, name) {
  const clean = cleanName(name);
  if (clean.length < 2) throw new DomainError(400, "Enter a name (at least 2 letters).");
  const row = db.prepare("SELECT * FROM club_roster WHERE club_id = ? AND id = ?").get(clubId, id);
  if (!row) throw new DomainError(404, "Not found.");
  const clash = db.prepare("SELECT id FROM club_roster WHERE club_id = ? AND name_key = ? AND id != ?").get(clubId, nameKey(clean), id);
  if (clash) throw new DomainError(409, `${clean} is already on the list. Add a surname or initial to tell them apart.`);
  db.prepare("UPDATE club_roster SET name = ?, name_key = ?, source = CASE WHEN source = 'whatsapp' THEN 'manual' ELSE source END, self_added = 0, updated_at = ? WHERE id = ?").run(clean, nameKey(clean), nowIso(), id);
}

/** An admin types the name of a group member WhatsApp gave no name for. */
export function nameGroupMember(clubId, contactId, name) {
  const contact = contactById(clubId, contactId);
  if (!contact) throw new DomainError(404, "That person isn't in the club group anymore.");
  const clean = cleanName(name);
  if (clean.length < 2) throw new DomainError(400, "Enter a name (at least 2 letters).");
  if (db.prepare("SELECT 1 FROM club_roster WHERE club_id = ? AND name_key = ?").get(clubId, nameKey(clean))) {
    throw new DomainError(409, `${clean} is already on the list. Add a surname or initial to tell them apart.`);
  }
  const now = nowIso();
  db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, phone, wa_jid, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'manual', ?, ?)")
    .run(randomUUID(), clubId, clean, nameKey(clean), contact.phone, contact.lid, now, now);
}

export function removeRosterPerson(clubId, id) {
  const changes = db.prepare("DELETE FROM club_roster WHERE club_id = ? AND id = ?").run(clubId, id).changes;
  if (!changes) throw new DomainError(404, "Not found.");
}

/**
 * Names from WhatsApp (or an old upload) that still carry tags ("Mahesh Giri Cycling Tulip Purple").
 * people: the tidy name is free, so it can be applied.
 * duplicates: the tidy name is already someone else's on the list. The admin either merges
 * them (same person) or keeps both (different people); either way the flag goes away for good.
 */
export function cleanupSuggestions(clubId) {
  const all = db.prepare("SELECT id, name, name_key, phone FROM club_roster WHERE club_id = ?").all(clubId);
  const byKey = new Map(all.map((r) => [r.name_key, r]));
  const candidates = db.prepare("SELECT id, name, phone FROM club_roster WHERE club_id = ? AND source IN ('upload', 'whatsapp') AND self_added = 0 AND tidy_dismissed = 0 ORDER BY name_key").all(clubId)
    .map((p) => ({ ...p, suggested: tidyContactName(p.name) }))
    .filter((p) => p.suggested !== p.name);
  const people = [];
  const duplicates = [];
  const claimed = new Set();
  for (const p of candidates) {
    const key = nameKey(p.suggested);
    const match = byKey.get(key);
    if (match && match.id !== p.id) duplicates.push({ ...p, match: { id: match.id, name: match.name, phone: match.phone } });
    else if (!claimed.has(key)) { claimed.add(key); people.push(p); }
    // A second name that tidies to the same one waits: once the first is tidied it shows as a duplicate.
  }
  return { people, duplicates };
}

/** Applies the tidy names the admin ticked. The original stays in contact_name. */
export function applyCleanup(clubId, ids) {
  const wanted = new Set(ids);
  const result = { applied: 0, skipped: [] };
  db.transaction(() => {
    for (const p of cleanupSuggestions(clubId).people) {
      if (!wanted.has(p.id)) continue;
      const clash = db.prepare("SELECT 1 FROM club_roster WHERE club_id = ? AND name_key = ? AND id != ?").get(clubId, nameKey(p.suggested), p.id);
      if (clash) { result.skipped.push(p.suggested); continue; }
      db.prepare("UPDATE club_roster SET contact_name = COALESCE(contact_name, name), name = ?, name_key = ?, updated_at = ? WHERE id = ?")
        .run(p.suggested, nameKey(p.suggested), nowIso(), p.id);
      result.applied++;
    }
  }).immediate();
  return result;
}

/**
 * Same person twice: keep the tidy name, give it the WhatsApp number of the tagged entry
 * (so the next group refresh recognises them and doesn't add them back), move their
 * RSVPs across, and remove the tagged entry.
 */
export function mergeDuplicate(clubId, id) {
  return db.transaction(() => {
    const dup = cleanupSuggestions(clubId).duplicates.find((d) => d.id === id);
    if (!dup) throw new DomainError(404, "Already sorted.");
    const from = db.prepare("SELECT * FROM club_roster WHERE id = ?").get(dup.id);
    const into = db.prepare("SELECT * FROM club_roster WHERE id = ?").get(dup.match.id);
    const phone = from.phone || into.phone;
    const jid = from.wa_jid || into.wa_jid;
    // Both entries answered the same activity: keep the "going" one.
    for (const r of db.prepare("SELECT ride_id, id, status FROM ride_rsvps WHERE roster_id = ?").all(from.id)) {
      const other = db.prepare("SELECT id, status FROM ride_rsvps WHERE ride_id = ? AND roster_id = ?").get(r.ride_id, into.id);
      if (!other) continue;
      db.prepare("DELETE FROM ride_rsvps WHERE id = ?").run(r.status === "going" && other.status !== "going" ? other.id : r.id);
    }
    db.prepare("UPDATE ride_rsvps SET roster_id = ? WHERE roster_id = ?").run(into.id, from.id);
    db.prepare("UPDATE club_roster_phones SET roster_id = ? WHERE roster_id = ?").run(into.id, from.id);
    db.prepare("DELETE FROM club_roster WHERE id = ?").run(from.id);
    // Both entries had a number: the one not kept as main stays linked as a second number.
    const spare = from.phone && into.phone && from.phone !== into.phone ? into.phone : null;
    if (spare) db.prepare("INSERT OR IGNORE INTO club_roster_phones (club_id, phone, roster_id, created_at) VALUES (?, ?, ?, ?)").run(clubId, spare, into.id, nowIso());
    db.prepare("UPDATE club_roster SET phone = ?, wa_jid = ?, contact_name = COALESCE(contact_name, ?), updated_at = ? WHERE id = ?")
      .run(phone, jid, from.contact_name || from.name, nowIso(), into.id);
    return { kept: into.name };
  }).immediate();
}

/** Different people who happen to share a name: stop flagging this one. */
export function keepBoth(clubId, id) {
  const changes = db.prepare("UPDATE club_roster SET tidy_dismissed = 1, updated_at = ? WHERE club_id = ? AND id = ?").run(nowIso(), clubId, id).changes;
  if (!changes) throw new DomainError(404, "Not found.");
  return { ok: true };
}

/**
 * Names for the RSVP box: everyone on the roster plus the club's signed-up
 * members, matched on the start of any word ("amit" -> Amit Daga, Amit Kumar;
 * "dag" -> Amit Daga). Full names, as the club knows them. Never phone numbers.
 */
export function suggestNames(clubId, query, limit = 8) {
  const key = nameKey(query).replace(/[%_\\]/g, "");
  if (key.length < 2) return [];
  const roster = db.prepare(`
    SELECT id, name, name_key FROM club_roster WHERE club_id = ? AND (name_key LIKE ? OR name_key LIKE ?)
    ORDER BY (name_key LIKE ?) DESC, name_key LIMIT ?
  `).all(clubId, `${key}%`, `% ${key}%`, `${key}%`, limit);
  const members = db.prepare(`
    SELECT u.id, u.name FROM club_memberships cm INNER JOIN users u ON u.id = cm.user_id
    WHERE cm.club_id = ? AND (lower(u.name) LIKE ? OR lower(u.name) LIKE ?) ORDER BY lower(u.name) LIMIT ?
  `).all(clubId, `${key}%`, `% ${key}%`, limit);
  const seen = new Set(roster.map((r) => r.name_key));
  const out = roster.map((r) => ({ id: r.id, kind: "roster", name: r.name }));
  for (const m of members) if (!seen.has(nameKey(m.name))) { seen.add(nameKey(m.name)); out.push({ id: m.id, kind: "member", name: m.name }); }
  return out.sort((a, b) => Number(nameKey(b.name).startsWith(key)) - Number(nameKey(a.name).startsWith(key)) || a.name.localeCompare(b.name)).slice(0, limit);
}

// ---------------------------------------------------------------- HTTP routes

export function registerRosterRoutes(app, { requireClubRole }) {
  const id = { type: "string", pattern: "^[0-9a-fA-F-]{36}$" };
  const params = { type: "object", properties: { clubId: id }, required: ["clubId"] };
  const pre = [app.authenticate, requireClubRole(["owner", "admin"])];
  const domain = (reply, error) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message });
    throw error;
  };
  const base = "/api/clubs/:clubId/roster";

  app.get(base, { schema: { params, querystring: { type: "object", properties: { q: { type: "string", maxLength: 60 } } } }, preHandler: pre },
    async (req) => {
      const conn = db.prepare("SELECT * FROM whatsapp_connections WHERE club_id = ?").get(req.params.clubId);
      const groups = memberGroups(conn).map((jid) => clubGroups(conn).find((g) => g.jid === jid)?.name || (jid === conn?.group_jid ? conn.group_name : null)).filter(Boolean);
      return {
        ...listRoster(req.params.clubId, req.query.q),
        unnamed: listUnnamed(req.params.clubId),
        whatsapp: {
          group: groups.length ? groups.join(" + ") : null, connected: conn?.status === "connected",
          // Groups a new person can be added to, and the one to suggest (the member-list group, which usually has everyone).
          groups: conn?.status === "connected" ? clubGroups(conn).map((g) => ({ jid: g.jid, name: g.name })) : [],
          add_group: conn?.status === "connected" ? (memberGroups(conn).find((j) => clubGroups(conn).some((g) => g.jid === j)) || null) : null,
          group_members: groupCount(req.params.clubId), synced_at: conn?.roster_synced_at || null,
          syncing: Boolean(conn?.roster_sync_wanted_at && (!conn.roster_synced_at || conn.roster_sync_wanted_at > conn.roster_synced_at))
        }
      };
    });

  app.post(`${base}/sync`, { schema: { params }, preHandler: pre }, async (req, reply) => {
    const conn = db.prepare("SELECT * FROM whatsapp_connections WHERE club_id = ?").get(req.params.clubId);
    if (!conn || conn.status !== "connected" || !memberGroups(conn).length) return reply.code(409).send({ error: "Connect WhatsApp and choose the club group first." });
    db.prepare("UPDATE whatsapp_connections SET roster_sync_wanted_at = ? WHERE club_id = ?").run(nowIso(), req.params.clubId);
    return { ok: true };
  });

  app.get(`${base}/cleanup`, { schema: { params }, preHandler: pre }, async (req) => cleanupSuggestions(req.params.clubId));
  const dupParams = { type: "object", properties: { clubId: id, rosterId: id }, required: ["clubId", "rosterId"] };
  app.post(`${base}/cleanup/:rosterId/merge`, { schema: { params: dupParams }, preHandler: pre }, async (req, reply) => {
    try { return mergeDuplicate(req.params.clubId, req.params.rosterId); } catch (error) { return domain(reply, error); }
  });
  app.post(`${base}/cleanup/:rosterId/keep`, { schema: { params: dupParams }, preHandler: pre }, async (req, reply) => {
    try { return keepBoth(req.params.clubId, req.params.rosterId); } catch (error) { return domain(reply, error); }
  });
  app.post(`${base}/cleanup`, {
    schema: { params, body: { type: "object", properties: { ids: { type: "array", maxItems: 5000, items: id } }, required: ["ids"] } }, preHandler: pre
  }, async (req) => applyCleanup(req.params.clubId, req.body.ids));

  app.post(`${base}/from-group/:contactId`, {
    schema: { params: { type: "object", properties: { clubId: id, contactId: id }, required: ["clubId", "contactId"] }, body: { type: "object", properties: { name: { type: "string", maxLength: 80 } }, required: ["name"] } },
    preHandler: pre
  }, async (req, reply) => {
    try { nameGroupMember(req.params.clubId, req.params.contactId, req.body.name); return reply.code(201).send({ ok: true }); }
    catch (error) { return domain(reply, error); }
  });

  app.patch(`${base}/:personId`, {
    schema: { params: { type: "object", properties: { clubId: id, personId: id }, required: ["clubId", "personId"] }, body: { type: "object", properties: { name: { type: "string", maxLength: 80 } }, required: ["name"] } },
    preHandler: pre
  }, async (req, reply) => {
    try { renameRosterPerson(req.params.clubId, req.params.personId, req.body.name); return { ok: true }; }
    catch (error) { return domain(reply, error); }
  });

  app.post(base, {
    schema: { params, body: { type: "object", properties: { name: { type: "string", maxLength: 80 }, phone: { type: "string", maxLength: 30 }, wa_group_jid: { type: ["string", "null"], maxLength: 100 } }, required: ["name", "phone"] } }, preHandler: pre
  }, async (req, reply) => {
    try {
      const jid = req.body.wa_group_jid || null;
      if (jid) { // check the group before adding anyone, so a bad pick changes nothing
        const conn = db.prepare("SELECT * FROM whatsapp_connections WHERE club_id = ?").get(req.params.clubId);
        if (!conn || conn.status !== "connected") throw new DomainError(409, "Connect WhatsApp first to add people to a group.");
        if (!clubGroups(conn).some((g) => g.jid === jid)) throw new DomainError(400, "Pick one of the club's WhatsApp groups.");
      }
      const result = addRosterPerson(req.params.clubId, req.body.name, req.body.phone);
      const group_add = jid ? queueGroupAdd(req.params.clubId, { phone: result.person.phone, name: result.person.name, groupJid: jid, userId: req.user.sub }) : null;
      return reply.code(201).send({ ...result, group_add });
    }
    catch (error) {
      if (error instanceof DomainError && error.existing) return reply.code(409).send({ error: error.message, existing: error.existing });
      return domain(reply, error);
    }
  });

  app.get(`${base}/group-adds/:addId`, { schema: { params: { type: "object", properties: { clubId: id, addId: id }, required: ["clubId", "addId"] } }, preHandler: pre }, async (req, reply) => {
    const v = groupAddView(req.params.clubId, req.params.addId);
    return v ? { group_add: v } : reply.code(404).send({ error: "Not found." });
  });

  // Phone books are read in the browser and arrive as name + numbers only (photos and
  // everything else in the file never leave the phone). Unmatched contacts are discarded.
  app.post(`${base}/phonebook`, {
    bodyLimit: 12 * 1024 * 1024,
    schema: { params, body: { type: "object", properties: { contacts: { type: "array", maxItems: 100000, items: { type: "object", properties: {
      name: { type: "string", maxLength: 200 }, phones: { type: "array", maxItems: 20, items: { type: "string", maxLength: 40 } } }, required: ["name", "phones"] } } }, required: ["contacts"] } },
    preHandler: pre
  }, async (req, reply) => {
    try {
      const contacts = req.body.contacts.map((c) => ({ name: cleanName(c.name), phones: c.phones.map(cleanPhone).filter(Boolean) })).filter((c) => c.phones.length);
      if (!contacts.length) return reply.code(400).send({ error: "No contacts with phone numbers found in that file." });
      return { mode: "phonebook", ...namesFromPhoneBook(req.params.clubId, contacts) };
    } catch (error) { return domain(reply, error); }
  });

  app.post(`${base}/import`, {
    bodyLimit: 48 * 1024 * 1024,
    schema: { params, body: { type: "object", properties: { filename: { type: "string", maxLength: 200 }, data: { type: "string", maxLength: 48 * 1024 * 1024 } }, required: ["filename", "data"] } },
    preHandler: pre
  }, async (req, reply) => {
    try {
      const buffer = Buffer.from(req.body.data, "base64");
      const phoneBook = readPhoneBook(req.body.filename, buffer);
      if (phoneBook) {
        if (!phoneBook.length) return reply.code(400).send({ error: "No contacts found in that file." });
        return { mode: "phonebook", ...namesFromPhoneBook(req.params.clubId, phoneBook) };
      }
      const people = parseRosterFile(req.body.filename, buffer);
      if (!people.length) return reply.code(400).send({ error: "No names found. Put names in a column headed \"Name\" (and phones under \"Phone\", optional)." });
      return { mode: "list", ...mergeRoster(req.params.clubId, people), read: people.length };
    } catch (error) {
      if (error instanceof DomainError) return domain(reply, error);
      req.log.warn(error);
      return reply.code(400).send({ error: "We couldn't read that file. Save it as .xlsx or .csv and try again." });
    }
  });

  app.delete(`${base}/:personId`, {
    schema: { params: { type: "object", properties: { clubId: id, personId: id }, required: ["clubId", "personId"] } }, preHandler: pre
  }, async (req, reply) => {
    try { removeRosterPerson(req.params.clubId, req.params.personId); return { ok: true }; }
    catch (error) { return domain(reply, error); }
  });
}
