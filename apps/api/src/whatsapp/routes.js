// Club admin API for the club's WhatsApp link. The API only records what the
// club wants; the worker process does the connecting and sending.
import QRCode from "qrcode";
import { db } from "../db.js";
import { getConnection, enqueueTest, outboxStats, memberGroups, knownGroups } from "./outbox.js";

const ADMIN = ["owner", "admin"];
const iso = (ms) => new Date(ms).toISOString();

function ensureRow(clubId) {
  db.prepare("INSERT OR IGNORE INTO whatsapp_connections (club_id, updated_at) VALUES (?, ?)").run(clubId, iso(Date.now()));
  return getConnection(clubId);
}
function update(clubId, fields) {
  const keys = Object.keys(fields);
  db.prepare(`UPDATE whatsapp_connections SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @u WHERE club_id = @c`).run({ ...fields, u: iso(Date.now()), c: clubId });
}
const maskPhone = (p) => (p ? `+${p.slice(0, 2)} ${"x".repeat(Math.max(0, p.length - 6))}${p.slice(-4)}` : null);

async function view(clubId) {
  const c = getConnection(clubId) || { desired: "off", status: "disconnected" };
  const workerOnline = Boolean(c.last_seen_at && Date.now() - new Date(c.last_seen_at).getTime() < 60 * 1000);
  const qrFresh = c.status === "pairing" && c.qr && c.qr_updated_at && Date.now() - new Date(c.qr_updated_at).getTime() < 60 * 1000;
  return {
    whatsapp: {
      desired: c.desired, status: c.status, last_error: c.last_error || null,
      qr: qrFresh ? await QRCode.toDataURL(c.qr, { margin: 1, width: 280 }) : null,
      phone: maskPhone(c.phone),
      group: c.group_jid ? { jid: c.group_jid, name: c.group_name } : null,
      groups: knownGroups(c),
      member_groups: memberGroups(c).map((jid) => knownGroups(c).find((g) => g.jid === jid) || { jid, name: jid === c.group_jid ? c.group_name : "A group this number left", size: null }),
      groups_refreshing: Boolean(c.groups_wanted_at && (!c.groups_updated_at || c.groups_wanted_at > c.groups_updated_at)),
      settings: { post_new_ride: Boolean(c.post_new_ride ?? 1), post_rider_list: Boolean(c.post_rider_list ?? 1), post_changes: Boolean(c.post_changes ?? 1), quiet_hours: Boolean(c.quiet_hours) },
      worker_online: c.status === "connected" ? workerOnline : null,
      stats: outboxStats(clubId)
    }
  };
}

export function registerWhatsAppRoutes(app, { requireClubRole }) {
  const params = { type: "object", properties: { clubId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } }, required: ["clubId"] };
  const pre = [app.authenticate, requireClubRole(ADMIN)];
  const base = "/api/clubs/:clubId/whatsapp";

  app.get(base, { schema: { params }, preHandler: pre }, async (req) => view(req.params.clubId));

  app.post(`${base}/connect`, { schema: { params }, preHandler: pre }, async (req) => {
    ensureRow(req.params.clubId);
    update(req.params.clubId, { desired: "on", last_error: null, ...(getConnection(req.params.clubId).status === "connected" ? {} : { status: "disconnected", qr: null }) });
    return view(req.params.clubId);
  });

  app.post(`${base}/disconnect`, { schema: { params }, preHandler: pre }, async (req) => {
    ensureRow(req.params.clubId);
    update(req.params.clubId, { desired: "logout" });
    db.prepare("UPDATE outbox SET status = 'skipped', last_error = 'club disconnected WhatsApp' WHERE club_id = ? AND status = 'pending'").run(req.params.clubId);
    return view(req.params.clubId);
  });

  app.put(`${base}/group`, {
    schema: { params, body: { type: "object", properties: { jid: { type: "string", maxLength: 100 } }, required: ["jid"] } }, preHandler: pre
  }, async (req, reply) => {
    const c = getConnection(req.params.clubId);
    const group = c?.groups_json ? JSON.parse(c.groups_json).find((g) => g.jid === req.body.jid) : null;
    if (!group) return reply.code(400).send({ error: "Pick one of the groups this WhatsApp number is in." });
    update(req.params.clubId, { group_jid: group.jid, group_name: group.name, roster_sync_wanted_at: iso(Date.now()) });
    return view(req.params.clubId);
  });

  // The member list is built from these groups, e.g. the master "Announcements" group that has everyone.
  app.put(`${base}/member-groups`, {
    schema: { params, body: { type: "object", properties: { jids: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 100 } } }, required: ["jids"] } }, preHandler: pre
  }, async (req, reply) => {
    const c = getConnection(req.params.clubId);
    const known = new Set(knownGroups(c).map((g) => g.jid));
    const jids = [...new Set(req.body.jids)];
    if (!jids.every((j) => known.has(j))) return reply.code(400).send({ error: "Pick from the groups this WhatsApp number is in." });
    update(req.params.clubId, { member_groups_json: JSON.stringify(jids), roster_sync_wanted_at: iso(Date.now()) });
    return view(req.params.clubId);
  });

  app.post(`${base}/groups/refresh`, { schema: { params }, preHandler: pre }, async (req, reply) => {
    const c = getConnection(req.params.clubId);
    if (!c || c.status !== "connected") return reply.code(409).send({ error: "Connect WhatsApp first." });
    update(req.params.clubId, { groups_wanted_at: iso(Date.now()) });
    return view(req.params.clubId);
  });

  app.patch(`${base}/settings`, {
    schema: { params, body: { type: "object", properties: { post_new_ride: { type: "boolean" }, post_rider_list: { type: "boolean" }, post_changes: { type: "boolean" }, quiet_hours: { type: "boolean" } }, minProperties: 1 } }, preHandler: pre
  }, async (req) => {
    ensureRow(req.params.clubId);
    update(req.params.clubId, Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, v ? 1 : 0])));
    return view(req.params.clubId);
  });

  app.post(`${base}/test`, { schema: { params }, preHandler: pre }, async (req, reply) => {
    const c = getConnection(req.params.clubId);
    if (!c || c.status !== "connected" || !c.group_jid) return reply.code(409).send({ error: "Connect WhatsApp and pick a group first." });
    enqueueTest(req.params.clubId);
    return view(req.params.clubId);
  });
}
