// Named activity templates ("Pandala"): a club's regular routes saved once and
// reused. A template holds everything except the date and time; creating from
// it pre-fills the form (or a WhatsApp draft) and every field stays editable.
import { randomUUID } from "node:crypto";
import { db, DomainError } from "./db.js";
import { CATEGORIES, checkGroup } from "./rides.js";

const nowIso = () => new Date().toISOString();
export const templateKey = (name) => String(name || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();
// The midway point is saved with its time as minutes after the start (a template has no date or time).
const FIELDS = ["title", "category", "meeting_point", "map_url", "meeting_point_2", "map_url_2", "midway_offset_min", "distance_km", "pace", "notes", "capacity", "wa_group_jid"];
const NUMBERS = ["distance_km", "capacity", "midway_offset_min"];

function cleanFields(input = {}) {
  const out = {};
  for (const key of FIELDS) {
    let v = input[key];
    if (v === undefined || v === null || v === "") continue;
    if (typeof v === "string") v = v.trim();
    if (key === "category" && !CATEGORIES.includes(v)) continue;
    if ((key === "map_url" || key === "map_url_2") && !/^https:\/\//.test(v)) continue;
    if ((key === "distance_km" || key === "capacity") && !(Number(v) >= (key === "capacity" ? 1 : 0))) continue;
    if (key === "midway_offset_min" && !(Number(v) >= 0 && Number(v) <= 720)) continue;
    out[key] = NUMBERS.includes(key) ? Number(v) : v;
  }
  if (!out.meeting_point_2) { delete out.map_url_2; delete out.midway_offset_min; }
  return out;
}
const view = (row) => ({ id: row.id, name: row.name, ...JSON.parse(row.fields), updated_at: row.updated_at });

export const listTemplates = (clubId) =>
  db.prepare("SELECT * FROM activity_templates WHERE club_id = ? ORDER BY name_key").all(clubId).map(view);

/** Saves a template; saving under an existing name updates that template. */
export function saveTemplate(clubId, userId, { name, ...fields }) {
  const clean = String(name || "").trim().replace(/\s+/g, " ");
  if (clean.length < 2 || clean.length > 40) throw new DomainError(400, "Give the template a name (2 to 40 characters).");
  const data = cleanFields(fields);
  if (data.wa_group_jid) checkGroup(clubId, data.wa_group_jid);
  if (!data.title && !data.meeting_point) throw new DomainError(400, "Add at least a title or meeting point to save as a template.");
  const now = nowIso();
  const existing = db.prepare("SELECT id FROM activity_templates WHERE club_id = ? AND name_key = ?").get(clubId, templateKey(clean));
  if (existing) {
    db.prepare("UPDATE activity_templates SET name = ?, fields = ?, updated_at = ? WHERE id = ?").run(clean, JSON.stringify(data), now, existing.id);
    return { template: view(db.prepare("SELECT * FROM activity_templates WHERE id = ?").get(existing.id)), updated: true };
  }
  const id = randomUUID();
  db.prepare("INSERT INTO activity_templates (id, club_id, name, name_key, fields, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(id, clubId, clean, templateKey(clean), JSON.stringify(data), userId, now, now);
  return { template: view(db.prepare("SELECT * FROM activity_templates WHERE id = ?").get(id)), updated: false };
}

export function renameTemplate(clubId, id, name) {
  const clean = String(name || "").trim().replace(/\s+/g, " ");
  if (clean.length < 2 || clean.length > 40) throw new DomainError(400, "Give the template a name (2 to 40 characters).");
  const row = db.prepare("SELECT * FROM activity_templates WHERE club_id = ? AND id = ?").get(clubId, id);
  if (!row) throw new DomainError(404, "Template not found.");
  if (db.prepare("SELECT 1 FROM activity_templates WHERE club_id = ? AND name_key = ? AND id != ?").get(clubId, templateKey(clean), id)) throw new DomainError(409, `There's already a template called ${clean}.`);
  db.prepare("UPDATE activity_templates SET name = ?, name_key = ?, updated_at = ? WHERE id = ?").run(clean, templateKey(clean), nowIso(), id);
  return view(db.prepare("SELECT * FROM activity_templates WHERE id = ?").get(id));
}

export function deleteTemplate(clubId, id) {
  if (!db.prepare("DELETE FROM activity_templates WHERE club_id = ? AND id = ?").run(clubId, id).changes) throw new DomainError(404, "Template not found.");
}

/** The template named in a message ("Pandala Sunday 6am"), longest name first. */
export function templateInText(clubId, text) {
  const hay = ` ${templateKey(text).replace(/[^\p{L}\p{N}]+/gu, " ")} `;
  const rows = db.prepare("SELECT * FROM activity_templates WHERE club_id = ?").all(clubId)
    .sort((a, b) => b.name_key.length - a.name_key.length);
  for (const row of rows) {
    const needle = ` ${row.name_key.replace(/[^\p{L}\p{N}]+/gu, " ").trim()} `;
    if (needle.trim() && hay.includes(needle)) return view(row);
  }
  return null;
}

export function registerTemplateRoutes(app, { requireClubRole }) {
  const admin = [app.authenticate, requireClubRole(["owner", "admin"])];
  const fail = (reply, error) => { if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message }); throw error; };
  const body = { type: "object", properties: { name: { type: "string", maxLength: 100 }, title: { type: ["string", "null"], maxLength: 120 }, category: { type: ["string", "null"], maxLength: 20 }, meeting_point: { type: ["string", "null"], maxLength: 200 }, map_url: { type: ["string", "null"], maxLength: 500 }, meeting_point_2: { type: ["string", "null"], maxLength: 200 }, map_url_2: { type: ["string", "null"], maxLength: 500 }, midway_offset_min: { type: ["integer", "null"], minimum: 0, maximum: 720 }, distance_km: { type: ["number", "null"], minimum: 0, maximum: 1000 }, pace: { type: ["string", "null"], maxLength: 60 }, notes: { type: ["string", "null"], maxLength: 2000 }, capacity: { type: ["integer", "null"], minimum: 1, maximum: 10000 }, wa_group_jid: { type: ["string", "null"], maxLength: 100 } }, required: ["name"] };
  app.get("/api/clubs/:clubId/templates", { preHandler: admin }, async (req) => ({ templates: listTemplates(req.params.clubId) }));
  app.post("/api/clubs/:clubId/templates", { preHandler: admin, schema: { body } }, async (req, reply) => {
    try { const r = saveTemplate(req.params.clubId, req.user.sub, req.body); return reply.code(r.updated ? 200 : 201).send(r); } catch (e) { return fail(reply, e); }
  });
  app.patch("/api/clubs/:clubId/templates/:id", { preHandler: admin, schema: { body: { type: "object", properties: { name: { type: "string", maxLength: 100 } }, required: ["name"] } } }, async (req, reply) => {
    try { return { template: renameTemplate(req.params.clubId, req.params.id, req.body.name) }; } catch (e) { return fail(reply, e); }
  });
  app.delete("/api/clubs/:clubId/templates/:id", { preHandler: admin }, async (req, reply) => {
    try { deleteTemplate(req.params.clubId, req.params.id); return { ok: true }; } catch (e) { return fail(reply, e); }
  });
}
