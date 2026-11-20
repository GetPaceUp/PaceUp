// Club directory: clubs across India that may join PaceUp. Imported from the Super Admin's file.
// Only name, city and activity are ever shown to anyone else (to fill in club names while typing);
// the contacts and status are the Super Admin's own prospect record.
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { db, DomainError } from "./db.js";

const now = () => new Date().toISOString();
export const DIRECTORY_STATUSES = ["prospect", "contacted", "pilot", "live"];

/** RFC 4180 CSV: quoted fields, doubled quotes, newlines inside quotes, a BOM. */
export function parseCsv(text) {
  const rows = [];
  let row = [], field = "", quoted = false;
  const s = String(text).replace(/^﻿/, "");
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') { field += '"'; i++; }
      else if (ch === '"') quoted = false;
      else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") { row.push(field); field = ""; }
    else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && s[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((f) => f !== "")) rows.push(row);
      row = [];
    } else field += ch;
  }
  row.push(field);
  if (row.some((f) => f !== "")) rows.push(row);
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, ""));
  return rows.slice(1).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] ?? "").trim()])));
}

const CITY_ALIASES = {
  bangalore: "Bengaluru", bengaluru: "Bengaluru", gurgaon: "Gurugram", gurugram: "Gurugram", delhi: "New Delhi", "new delhi": "New Delhi",
  bombay: "Mumbai", calcutta: "Kolkata", madras: "Chennai", poona: "Pune", mysore: "Mysuru", trivandrum: "Thiruvananthapuram",
  baroda: "Vadodara", cochin: "Kochi", vizag: "Visakhapatnam", pondicherry: "Puducherry", "navi mumbai": "Navi Mumbai"
};
const EMOJI = /[\p{Extended_Pictographic}\u{FE0F}\u{200D}]/gu;
const titleCase = (s) => s.toLowerCase().replace(/(^|[\s\-/(])(\p{L})/gu, (m, a, b) => a + b.toUpperCase());

export function cleanClubName(raw) {
  let s = String(raw || "").replace(EMOJI, "").replace(/\s+/g, " ").trim();
  // ALL CAPS longer names read better in title case; short acronyms (CRC, CORSO) stay.
  if (s.length > 6 && s === s.toUpperCase() && /\p{L}{3}/u.test(s) && s.includes(" ")) s = titleCase(s);
  return s.slice(0, 120);
}
/** For matching: case, punctuation, "&"/"and" and a trailing "club" don't make a different club. */
export function clubKey(name) {
  return cleanClubName(name).toLowerCase().normalize("NFKD").replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ").replace(/[^a-z0-9]+/g, " ").replace(/\b(the)\b/g, " ").replace(/\s+club$/, "").replace(/\s+/g, " ").trim();
}
export function cleanCity(raw) {
  const s = String(raw || "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  return CITY_ALIASES[s.toLowerCase()] || (s === s.toLowerCase() || s === s.toUpperCase() ? titleCase(s) : s);
}
const cityKey = (c) => (c ? c.toLowerCase() : "");
function cleanPhone(raw) {
  const d = String(raw || "").replace(/[^\d]/g, "");
  if (!d) return null;
  if (d.length === 10) return `91${d}`;
  if (d.length === 11 && d.startsWith("0")) return `91${d.slice(1)}`;
  return d.length >= 11 && d.length <= 15 ? d : null;
}
const cleanEmail = (raw) => { const s = String(raw || "").trim().toLowerCase(); return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s) ? s : null; };
const cleanUrl = (raw) => { const s = String(raw || "").trim(); return /^https?:\/\/\S+$/i.test(s) ? s.slice(0, 300) : null; };

/** "instagram: url | facebook: url | website: url" → { instagram, facebook, website, other } */
function splitLinks(raw) {
  const out = { instagram: null, facebook: null, website: null, other: [] };
  for (const part of String(raw || "").split("|")) {
    const m = part.match(/^\s*([a-z ]+)\s*:\s*(\S+)\s*$/i);
    const url = cleanUrl(m ? m[2] : part.trim());
    if (!url) continue;
    const label = (m?.[1] || "").trim().toLowerCase();
    const host = (() => { try { return new URL(url).hostname; } catch { return ""; } })();
    const kind = label === "instagram" || /instagram\.com$/.test(host) ? "instagram" : label === "facebook" || /(facebook|fb)\.com$/.test(host) ? "facebook" : label === "website" ? "website" : null;
    if (kind && !out[kind]) out[kind] = url;
    else out.other.push(m ? `${label}: ${url}` : url);
  }
  return out;
}

const KNOWN = new Set(["id", "name", "club_name", "city", "state", "sport_or_activity", "activity", "kind", "social_links", "club_phone", "phone", "mobile",
  "club_email", "email", "instagram", "facebook", "website", "source_name", "public_page_link"]);

/** One file row → a directory record, or null when it has no name. */
export function recordFromRow(row) {
  const name = cleanClubName(row.name || row.club_name);
  if (name.length < 2) return null;
  const links = splitLinks(row.social_links);
  const city = cleanCity(row.city);
  const extra = Object.fromEntries(Object.entries(row).filter(([k, v]) => !KNOWN.has(k) && v));
  return {
    name, name_key: clubKey(name), city, city_key: cityKey(city), state: row.state || null,
    activity: (row.sport_or_activity || row.activity || "").replace(/\s*,\s*/g, ", ").trim() || null,
    kind: row.kind || null,
    website: cleanUrl(row.website) || links.website, instagram: cleanUrl(row.instagram) || links.instagram, facebook: cleanUrl(row.facebook) || links.facebook,
    other_links: links.other.join(" | ") || null,
    phone: cleanPhone(row.club_phone || row.phone || row.mobile), email: cleanEmail(row.club_email || row.email),
    source_name: row.source_name || null, source_id: row.id || null, public_page_link: cleanUrl(row.public_page_link),
    extra_json: Object.keys(extra).length ? JSON.stringify(extra) : null
  };
}

const IMPORTED = ["name", "city", "state", "activity", "kind", "website", "instagram", "facebook", "other_links", "phone", "email", "source_name", "source_id", "public_page_link", "extra_json"];

/**
 * Adds the file's clubs to the directory. The same club twice (in the file, or already in the
 * directory) is kept once with the details merged. Status, notes and hidden are never touched,
 * and a club already on PaceUp is linked to it.
 */
export function importDirectory(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new DomainError(400, "That file has no rows. Upload the CSV with a header row and a name column.");
  if (!("name" in rows[0]) && !("club_name" in rows[0])) throw new DomainError(400, "The file needs a \"name\" column.");
  const stats = { rows: rows.length, added: 0, updated: 0, merged_in_file: 0, skipped_no_name: 0, missing_city: 0, with_phone: 0, with_email: 0, with_instagram: 0, with_facebook: 0, linked_to_paceup: 0 };
  // Merge duplicates inside the file first.
  const byKey = new Map();
  for (const row of rows) {
    const rec = recordFromRow(row);
    if (!rec) { stats.skipped_no_name++; continue; }
    const key = `${rec.name_key}|${rec.city_key}`;
    const prev = byKey.get(key);
    if (prev) { stats.merged_in_file++; for (const f of IMPORTED) if (!prev[f] && rec[f]) prev[f] = rec[f]; }
    else byKey.set(key, rec);
  }
  const clubs = db.prepare("SELECT id, name FROM clubs").all().map((c) => ({ ...c, key: clubKey(c.name) }));
  const ts = now();
  db.transaction(() => {
    for (const rec of byKey.values()) {
      if (!rec.city) stats.missing_city++;
      if (rec.phone) stats.with_phone++;
      if (rec.email) stats.with_email++;
      if (rec.instagram) stats.with_instagram++;
      if (rec.facebook) stats.with_facebook++;
      const existing = (rec.source_id && db.prepare("SELECT * FROM club_directory WHERE source_id = ?").get(rec.source_id))
        || db.prepare("SELECT * FROM club_directory WHERE name_key = ? AND city_key = ?").get(rec.name_key, rec.city_key);
      let id;
      if (existing) {
        id = existing.id;
        // A club already on PaceUp keeps its own details; the file only fills gaps.
        const fields = IMPORTED.filter((f) => rec[f] && (!existing.club_id || !existing[f]));
        if (fields.length) {
          db.prepare(`UPDATE club_directory SET ${fields.map((f) => `${f} = @${f}`).join(", ")}, name_key = @name_key, city_key = @city_key, updated_at = @ts WHERE id = @id`)
            .run({ ...Object.fromEntries(fields.map((f) => [f, rec[f]])), name_key: existing.club_id ? existing.name_key : rec.name_key, city_key: existing.club_id ? existing.city_key : rec.city_key, ts, id });
        }
        stats.updated++;
      } else {
        id = rec.source_id && !db.prepare("SELECT 1 FROM club_directory WHERE id = ?").get(rec.source_id) ? rec.source_id : randomUUID();
        db.prepare(`INSERT INTO club_directory (id, name_key, city_key, ${IMPORTED.join(", ")}, created_at, updated_at)
          VALUES (@id, @name_key, @city_key, ${IMPORTED.map((f) => `@${f}`).join(", ")}, @ts, @ts)`).run({ ...rec, id, ts });
        stats.added++;
      }
      const club = clubs.find((c) => c.key === rec.name_key);
      if (club && !db.prepare("SELECT 1 FROM club_directory WHERE club_id = ?").get(club.id)) {
        db.prepare("UPDATE club_directory SET club_id = ?, status = CASE WHEN status = 'live' THEN status ELSE 'pilot' END WHERE id = ? AND club_id IS NULL").run(club.id, id);
        stats.linked_to_paceup++;
      }
    }
  }).immediate();
  return stats;
}

const PUBLIC = "d.id, d.name, d.city, d.activity";

/** Club names as someone types: clubs on PaceUp first, then the directory. Only public fields. */
export function suggestClubs(q, limit = 8) {
  const key = clubKey(q);
  if (key.length < 2) return [];
  const like = `%${key}%`, prefix = `${key}%`;
  const onPaceup = db.prepare(`SELECT c.id AS club_id, c.name, c.city, c.activity FROM clubs c ORDER BY c.name`).all()
    .filter((c) => clubKey(c.name).includes(key)).slice(0, 3).map((c) => ({ ...c, on_paceup: true }));
  const taken = new Set(onPaceup.map((c) => c.club_id));
  const dir = db.prepare(`SELECT ${PUBLIC}, d.club_id FROM club_directory d WHERE d.hidden = 0 AND d.name_key LIKE ?
    ORDER BY (d.name_key LIKE ?) DESC, length(d.name_key), d.name LIMIT ?`).all(like, prefix, limit)
    .filter((d) => !d.club_id || !taken.has(d.club_id))
    .map((d) => ({ directory_id: d.id, club_id: d.club_id || null, name: d.name, city: d.city, activity: d.activity, on_paceup: Boolean(d.club_id) }));
  return [...onPaceup, ...dir].slice(0, limit);
}

/** The Super Admin's view: every field, searchable, newest status changes first. */
export function listDirectory({ q = "", status = "", limit = 50, offset = 0 } = {}) {
  const key = clubKey(q);
  const where = ["1 = 1"], args = [];
  if (key) { where.push("(d.name_key LIKE ? OR lower(coalesce(d.city, '')) LIKE ? OR lower(coalesce(d.state, '')) LIKE ?)"); args.push(`%${key}%`, `%${q.trim().toLowerCase()}%`, `%${q.trim().toLowerCase()}%`); }
  if (DIRECTORY_STATUSES.includes(status)) { where.push("d.status = ?"); args.push(status); }
  const total = db.prepare(`SELECT COUNT(*) AS n FROM club_directory d WHERE ${where.join(" AND ")}`).get(...args).n;
  const items = db.prepare(`SELECT d.*, c.name AS club_name FROM club_directory d LEFT JOIN clubs c ON c.id = d.club_id WHERE ${where.join(" AND ")}
    ORDER BY d.hidden, d.name LIMIT ? OFFSET ?`).all(...args, Math.min(200, limit), offset);
  const counts = Object.fromEntries(db.prepare("SELECT status, COUNT(*) AS n FROM club_directory WHERE hidden = 0 GROUP BY status").all().map((r) => [r.status, r.n]));
  return { total, counts, items: items.map(({ name_key, city_key, ...d }) => d) };
}

export function updateDirectoryEntry(id, body) {
  const row = db.prepare("SELECT * FROM club_directory WHERE id = ?").get(id);
  if (!row) throw new DomainError(404, "That club isn't in the directory.");
  const fields = {};
  if (body.status !== undefined) { if (!DIRECTORY_STATUSES.includes(body.status)) throw new DomainError(400, "Pick a status."); fields.status = body.status; }
  if (body.notes !== undefined) fields.notes = String(body.notes).slice(0, 2000) || null;
  if (body.hidden !== undefined) fields.hidden = body.hidden ? 1 : 0;
  if (body.name !== undefined) {
    const name = cleanClubName(body.name);
    if (name.length < 2) throw new DomainError(400, "Enter the club's name.");
    fields.name = name; fields.name_key = clubKey(name);
  }
  if (body.city !== undefined) { fields.city = cleanCity(body.city); fields.city_key = cityKey(fields.city); }
  if (body.activity !== undefined) fields.activity = String(body.activity).trim().slice(0, 80) || null;
  for (const f of ["instagram", "facebook", "website"]) if (body[f] !== undefined) fields[f] = body[f] ? cleanUrl(body[f]) : null;
  if (body.phone !== undefined) fields.phone = body.phone ? cleanPhone(body.phone) : null;
  if (body.email !== undefined) fields.email = body.email ? cleanEmail(body.email) : null;
  if (!Object.keys(fields).length) return getEntry(id);
  try {
    db.prepare(`UPDATE club_directory SET ${Object.keys(fields).map((k) => `${k} = @${k}`).join(", ")}, updated_at = @ts WHERE id = @id`).run({ ...fields, ts: now(), id });
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") throw new DomainError(409, "Another club in the directory already has this name and city.");
    throw error;
  }
  return getEntry(id);
}
const getEntry = (id) => { const { name_key, city_key, ...d } = db.prepare("SELECT * FROM club_directory WHERE id = ?").get(id); return d; };

/** A club joined PaceUp: its directory entry points at it and its own details win from now on. */
export function linkDirectoryToClub(directoryId, club) {
  if (!directoryId) return;
  db.prepare("UPDATE club_directory SET club_id = ?, name = ?, name_key = ?, city = COALESCE(?, city), city_key = COALESCE(?, city_key), activity = COALESCE(?, activity), status = CASE WHEN status = 'live' THEN status ELSE 'pilot' END, updated_at = ? WHERE id = ? AND club_id IS NULL")
    .run(club.id, club.name, clubKey(club.name), club.city || null, club.city ? cityKey(club.city) : null, club.activity || null, now(), directoryId);
}
/** The club linked its own WhatsApp number: it is live. */
export function markClubLive(clubId) {
  db.prepare("UPDATE club_directory SET status = 'live', updated_at = ? WHERE club_id = ? AND status != 'live'").run(now(), clubId);
}

export function registerDirectoryRoutes(app, { requirePlatformAdmin }) {
  const fail = (reply, error) => { if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message }); throw error; };
  const pre = [app.authenticate, requirePlatformAdmin];
  app.get("/api/platform/directory/suggest", { preHandler: pre, schema: { querystring: { type: "object", properties: { q: { type: "string", maxLength: 80 } } } } },
    async (req) => ({ clubs: suggestClubs(req.query.q || "") }));
  app.get("/api/platform/directory", {
    preHandler: pre,
    schema: { querystring: { type: "object", properties: { q: { type: "string", maxLength: 80 }, status: { type: "string", maxLength: 20 }, offset: { type: "integer", minimum: 0, maximum: 100000 } } } }
  }, async (req) => listDirectory({ q: req.query.q || "", status: req.query.status || "", offset: req.query.offset || 0 }));
  const s = (n) => ({ type: ["string", "null"], maxLength: n });
  app.patch("/api/platform/directory/:id", {
    preHandler: pre,
    schema: { params: { type: "object", properties: { id: { type: "string", maxLength: 64 } }, required: ["id"] },
      body: { type: "object", properties: { status: { type: "string", maxLength: 20 }, notes: s(2000), hidden: { type: "boolean" }, name: s(120), city: s(80), activity: s(80), instagram: s(300), facebook: s(300), website: s(300), phone: s(30), email: s(254) }, minProperties: 1 } }
  }, async (req, reply) => { try { return { entry: updateDirectoryEntry(req.params.id, req.body) }; } catch (error) { return fail(reply, error); } });
  app.post("/api/platform/directory/import", {
    preHandler: pre, bodyLimit: 5 * 1024 * 1024,
    schema: { body: { type: "object", properties: { csv: { type: "string", maxLength: 4 * 1024 * 1024 } }, required: ["csv"] } }
  }, async (req, reply) => { try { return { stats: importDirectory(req.body.csv) }; } catch (error) { return fail(reply, error); } });
}

// Command line, for the first import on the server: node src/directory.js import <file.csv>
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [cmd, file] = process.argv.slice(2);
  if (cmd !== "import" || !file) { console.error("Usage: node src/directory.js import <file.csv>"); process.exit(1); }
  console.log(JSON.stringify(importDirectory(readFileSync(file, "utf8")), null, 2));
}
