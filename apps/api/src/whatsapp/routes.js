// Club admin API for the club's WhatsApp link. The API only records what the
// club wants; the worker process does the connecting and sending.
import QRCode from "qrcode";
import { db } from "../db.js";
import { getConnection, enqueueTest, outboxStats, memberGroups, knownGroups, clubGroups, allowedGroupIds, isClubGroup, PAIRING_TIMEOUT_MS } from "./outbox.js";
import { audit, getPlatformRole } from "../db.js";
import { canManageNumber } from "../clubs-admin.js";
import { cleanPhone } from "../roster.js";

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

async function view(clubId, userId) {
  const isSuper = getPlatformRole(userId) === "super_admin";
  const manager = canManageNumber(clubId, userId);
  const owner = db.prepare("SELECT u.id, u.name FROM clubs c INNER JOIN users u ON u.id = c.number_owner_id WHERE c.id = ?").get(clubId);
  const c = getConnection(clubId) || { desired: "off", status: "disconnected" };
  const workerOnline = Boolean(c.last_seen_at && Date.now() - new Date(c.last_seen_at).getTime() < 60 * 1000);
  const qrFresh = c.status === "pairing" && c.qr && c.qr_updated_at && Date.now() - new Date(c.qr_updated_at).getTime() < 60 * 1000;
  return {
    whatsapp: {
      desired: c.desired, status: c.status, last_error: c.last_error || null,
      // The link code is only for whoever connects the number: the club's number owner or the Super Admin.
      qr: qrFresh && manager ? await QRCode.toDataURL(c.qr, { margin: 1, width: 280 }) : null,
      pairing_code: manager && c.status === "pairing" && c.pairing_code ? c.pairing_code : null,
      pairing_phone: manager && c.pairing_phone ? `+${c.pairing_phone}` : null,
      pairing_expires_at: manager && c.status === "pairing" && c.pairing_code && c.qr_updated_at
        ? new Date(new Date(c.qr_updated_at).getTime() + PAIRING_TIMEOUT_MS).toISOString() : null,
      can_manage_number: manager,
      number_owner: owner ? { name: owner.name, is_you: owner.id === userId } : null,
      phone: maskPhone(c.phone),
      group: isClubGroup(c, c.group_jid) ? { jid: c.group_jid, name: c.group_name } : null,
      // Only the groups the Super Admin linked to this club, never everything on the phone.
      groups: clubGroups(c),
      groups_linked: allowedGroupIds(c).length,
      member_groups: memberGroups(c).map((jid) => clubGroups(c).find((g) => g.jid === jid) || { jid, name: jid === c.group_jid ? c.group_name : "A group this number left", size: null }),
      groups_refreshing: Boolean(c.groups_wanted_at && (!c.groups_updated_at || c.groups_wanted_at > c.groups_updated_at)),
      settings: { post_new_ride: Boolean(c.post_new_ride ?? 1), post_rider_list: Boolean(c.post_rider_list ?? 1), post_changes: Boolean(c.post_changes ?? 1), quiet_hours: Boolean(c.quiet_hours) },
      worker_online: c.status === "connected" ? workerOnline : null,
      // Message counts are system information: Super Admin only (the API leaves them out for club admins).
      ...(isSuper ? { stats: outboxStats(clubId) } : {})
    }
  };
}

export function registerWhatsAppRoutes(app, { requireClubRole, requirePlatformAdmin }) {
  const params = { type: "object", properties: { clubId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } }, required: ["clubId"] };
  const pre = [app.authenticate, requireClubRole(ADMIN)];
  const base = "/api/clubs/:clubId/whatsapp";

  app.get(base, { schema: { params }, preHandler: pre }, async (req) => {
    const v = await view(req.params.clubId, req.user.sub);
    v.whatsapp.can_pick_groups = v.whatsapp.can_manage_number; // the number owner and the Super Admin choose the club's groups
    return v;
  });

  // Linking and unlinking the club number: the Super Admin, or the club admin who owns the number.
  async function requireNumberManager(req, reply) {
    if (!canManageNumber(req.params.clubId, req.user.sub)) return reply.code(403).send({ error: "Only the person who looks after the club's WhatsApp number can do this." });
  }
  const managerPre = [app.authenticate, requireNumberManager];
  app.post(`${base}/connect`, {
    schema: { params, body: { type: ["object", "null"], properties: { phone: { type: "string", maxLength: 30 } } } }, preHandler: managerPre
  }, async (req, reply) => {
    ensureRow(req.params.clubId);
    // With a phone number, WhatsApp gives a code to type on that phone ("Link with phone number instead"),
    // so the owner can link from the same phone. Without one, a QR code to scan.
    let pairing = null;
    if (req.body?.phone) {
      pairing = cleanPhone(req.body.phone);
      if (!pairing) return reply.code(400).send({ error: "Enter the club's WhatsApp number with the country code, e.g. +91 98765 43210." });
      const taken = db.prepare("SELECT 1 FROM whatsapp_connections WHERE phone = ? AND club_id != ? AND desired = 'on'").get(pairing, req.params.clubId);
      if (taken) return reply.code(409).send({ error: "This number is already linked to another club on PaceUp. Each club needs its own WhatsApp number." });
    }
    const c = getConnection(req.params.clubId);
    if (c.status === "connected" && c.desired === "on") return view(req.params.clubId, req.user.sub);
    // Switching between a code and a QR restarts pairing: the worker notices the changed pairing number.
    update(req.params.clubId, { desired: "on", status: c.status === "pairing" ? "pairing" : "disconnected", qr: null, last_error: null, pairing_phone: pairing, pairing_code: null });
    audit({ actorUserId: req.user.sub, action: "club.whatsapp_connect", newValue: pairing ? "pairing code" : "qr", ip: req.ip });
    return view(req.params.clubId, req.user.sub);
  });

  app.post(`${base}/disconnect`, { schema: { params }, preHandler: managerPre }, async (req) => {
    ensureRow(req.params.clubId);
    update(req.params.clubId, { desired: "logout" });
    db.prepare("UPDATE outbox SET status = 'skipped', last_error = 'club disconnected WhatsApp' WHERE club_id = ? AND status = 'pending'").run(req.params.clubId);
    return view(req.params.clubId, req.user.sub);
  });

  app.put(`${base}/group`, {
    schema: { params, body: { type: "object", properties: { jid: { type: "string", maxLength: 100 } }, required: ["jid"] } }, preHandler: pre
  }, async (req, reply) => {
    const c = getConnection(req.params.clubId);
    const group = clubGroups(c).find((g) => g.jid === req.body.jid);
    if (!group) return reply.code(400).send({ error: "Pick one of your club's WhatsApp groups." });
    update(req.params.clubId, { group_jid: group.jid, group_name: group.name, roster_sync_wanted_at: iso(Date.now()) });
    return view(req.params.clubId, req.user.sub);
  });

  // The member list is built from these groups, e.g. the master "Announcements" group that has everyone.
  app.put(`${base}/member-groups`, {
    schema: { params, body: { type: "object", properties: { jids: { type: "array", minItems: 1, maxItems: 20, items: { type: "string", maxLength: 100 } } }, required: ["jids"] } }, preHandler: pre
  }, async (req, reply) => {
    const c = getConnection(req.params.clubId);
    const known = new Set(clubGroups(c).map((g) => g.jid));
    const jids = [...new Set(req.body.jids)];
    if (!jids.every((j) => known.has(j))) return reply.code(400).send({ error: "Pick from your club's WhatsApp groups." });
    update(req.params.clubId, { member_groups_json: JSON.stringify(jids), roster_sync_wanted_at: iso(Date.now()) });
    return view(req.params.clubId, req.user.sub);
  });

  app.post(`${base}/groups/refresh`, { schema: { params }, preHandler: pre }, async (req, reply) => {
    const c = getConnection(req.params.clubId);
    if (!c || c.status !== "connected") return reply.code(409).send({ error: "Connect WhatsApp first." });
    update(req.params.clubId, { groups_wanted_at: iso(Date.now()) });
    return view(req.params.clubId, req.user.sub);
  });

  app.patch(`${base}/settings`, {
    schema: { params, body: { type: "object", properties: { post_new_ride: { type: "boolean" }, post_rider_list: { type: "boolean" }, post_changes: { type: "boolean" }, quiet_hours: { type: "boolean" } }, minProperties: 1 } }, preHandler: pre
  }, async (req) => {
    ensureRow(req.params.clubId);
    update(req.params.clubId, Object.fromEntries(Object.entries(req.body).map(([k, v]) => [k, v ? 1 : 0])));
    return view(req.params.clubId, req.user.sub);
  });

  app.post(`${base}/test`, { schema: { params }, preHandler: pre }, async (req, reply) => {
    const c = getConnection(req.params.clubId);
    if (!c || c.status !== "connected" || !isClubGroup(c, c.group_jid)) return reply.code(409).send({ error: "Connect WhatsApp and pick a group first." });
    enqueueTest(req.params.clubId);
    return view(req.params.clubId, req.user.sub);
  });

  // Super Admin: sees every group on the linked number and decides which ones belong to the club.
  const platformBase = "/api/platform/clubs/:clubId/whatsapp-groups";
  const platformPre = [app.authenticate, requirePlatformAdmin];
  const platformView = (clubId) => {
    const c = getConnection(clubId);
    const allowed = new Set(allowedGroupIds(c));
    const groups = knownGroups(c).map((g) => ({ ...g, linked: allowed.has(g.jid) }));
    const seen = new Set(groups.map((g) => g.jid));
    // Linked groups the number has since left stay listed so they can be unticked.
    for (const jid of allowed) if (!seen.has(jid)) groups.push({ jid, name: jid === c?.group_jid ? c.group_name : "A group this number left", size: null, linked: true });
    groups.sort((x, y) => Number(y.linked) - Number(x.linked) || String(x.name).localeCompare(String(y.name)));
    return { status: c?.status || "disconnected", phone: maskPhone(c?.phone), groups };
  };
  const putSchema = { params, body: { type: "object", properties: { jids: { type: "array", maxItems: 30, items: { type: "string", maxLength: 100 } } }, required: ["jids"] } };
  app.get(platformBase, { schema: { params }, preHandler: platformPre }, async (req) => platformView(req.params.clubId));
  app.put(platformBase, { schema: putSchema, preHandler: platformPre }, (req, reply) => saveGroups(req, reply));
  // The club's number owner picks the club's groups too: it's their phone.
  app.get(`${base}/all-groups`, { schema: { params }, preHandler: managerPre }, async (req) => platformView(req.params.clubId));
  app.put(`${base}/all-groups`, { schema: putSchema, preHandler: managerPre }, (req, reply) => saveGroups(req, reply));
  async function saveGroups(req, reply) {
    const c = getConnection(req.params.clubId);
    if (!c) return reply.code(409).send({ error: "This club hasn't connected WhatsApp yet." });
    const pickable = new Set([...knownGroups(c).map((g) => g.jid), ...allowedGroupIds(c)]);
    const jids = [...new Set(req.body.jids)];
    if (!jids.every((j) => pickable.has(j))) return reply.code(400).send({ error: "Pick from the groups this WhatsApp number is in." });
    const before = allowedGroupIds(c);
    const keep = new Set(jids);
    let members = [];
    try { members = JSON.parse(c.member_groups_json || "[]"); } catch {}
    members = Array.isArray(members) ? members.filter((j) => keep.has(j)) : [];
    update(req.params.clubId, {
      allowed_groups_json: JSON.stringify(jids),
      member_groups_json: members.length ? JSON.stringify(members) : null,
      ...(c.group_jid && !keep.has(c.group_jid) ? { group_jid: null, group_name: null } : {}),
      roster_sync_wanted_at: iso(Date.now())
    });
    // Anything waiting to go to a group that is no longer the club's is dropped.
    if (c.group_jid && !keep.has(c.group_jid)) db.prepare("UPDATE outbox SET status = 'skipped', last_error = 'group unlinked from the club' WHERE club_id = ? AND status = 'pending'").run(req.params.clubId);
    const name = (j) => knownGroups(c).find((g) => g.jid === j)?.name || j;
    audit({ actorUserId: req.user.sub, action: "club.whatsapp_groups", oldValue: before.map(name).join(", ").slice(0, 500), newValue: jids.map(name).join(", ").slice(0, 500), ip: req.ip });
    return platformView(req.params.clubId);
  }
}
