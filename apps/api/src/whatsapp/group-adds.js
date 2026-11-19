// Adding a newly listed member to one of the club's WhatsApp groups.
//
// The admin asks for it when adding someone to the member list; the worker does it
// later, one person at a time with long gaps and hourly/daily caps, because mass
// adds are what gets a WhatsApp number banned. When the person's privacy settings
// don't allow being added, the club number sends them the group's invite link instead.
import { randomUUID } from "node:crypto";
import { db, DomainError } from "../db.js";
import { getConnection, clubGroups, isClubGroup } from "./outbox.js";

export const GROUP_ADD_GAP_MS = 45 * 1000;   // between two adds by the same number
export const GROUP_ADD_HOURLY = 10;
export const GROUP_ADD_DAILY = 40;
const EXPIRE_MS = 24 * 60 * 60 * 1000;
const iso = (ms = Date.now()) => new Date(ms).toISOString();

const groupName = (conn, jid) => clubGroups(conn).find((g) => g.jid === jid)?.name || "the club group";

/** Queues an add. Throws if the group isn't one of the club's linked groups. */
export function queueGroupAdd(clubId, { phone, name, groupJid, userId }) {
  const conn = getConnection(clubId);
  if (!conn || conn.status !== "connected") throw new DomainError(409, "Connect WhatsApp first to add people to a group.");
  if (!clubGroups(conn).some((g) => g.jid === groupJid)) throw new DomainError(400, "Pick one of the club's WhatsApp groups.");
  const id = randomUUID();
  db.prepare("INSERT INTO whatsapp_group_adds (id, club_id, phone, name, group_jid, requested_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(id, clubId, phone, name || null, groupJid, userId || null, iso());
  return groupAddView(clubId, id);
}

export function groupAddView(clubId, id) {
  const row = db.prepare("SELECT * FROM whatsapp_group_adds WHERE club_id = ? AND id = ?").get(clubId, id);
  if (!row) return null;
  const ahead = row.status === "pending" ? db.prepare("SELECT COUNT(*) AS n FROM whatsapp_group_adds WHERE club_id = ? AND status = 'pending' AND created_at < ?").get(clubId, row.created_at).n : 0;
  return { id: row.id, status: row.status, detail: row.detail, group: groupName(getConnection(clubId), row.group_jid), ahead };
}

function finish(id, status, detail) {
  db.prepare("UPDATE whatsapp_group_adds SET status = ?, detail = ?, done_at = ?, attempts = attempts + 1 WHERE id = ?").run(status, detail || null, iso(), id);
}

/** Worker: at most one add per club per call, within the gap and caps. */
export async function processGroupAdds(sessions, { gapMs = GROUP_ADD_GAP_MS, hourly = GROUP_ADD_HOURLY, daily = GROUP_ADD_DAILY, log = {} } = {}) {
  const now = Date.now();
  db.prepare("UPDATE whatsapp_group_adds SET status = 'failed', detail = 'WhatsApp was not connected for a day, so this was dropped.', done_at = ? WHERE status = 'pending' AND created_at <= ?").run(iso(now), iso(now - EXPIRE_MS));
  const clubs = db.prepare("SELECT DISTINCT club_id FROM whatsapp_group_adds WHERE status = 'pending'").all().map((r) => r.club_id);
  for (const clubId of clubs) {
    const entry = sessions.get(clubId);
    if (!entry?.open) continue; // waits for the number to reconnect
    const done = (since) => db.prepare("SELECT COUNT(*) AS n FROM whatsapp_group_adds WHERE club_id = ? AND done_at >= ? AND status != 'failed'").get(clubId, iso(since)).n;
    const last = db.prepare("SELECT MAX(done_at) AS t FROM whatsapp_group_adds WHERE club_id = ?").get(clubId).t;
    if (last && now - new Date(last).getTime() < gapMs) continue;
    if (done(now - 3600 * 1000) >= hourly || done(now - 24 * 3600 * 1000) >= daily) continue;
    const item = db.prepare("SELECT * FROM whatsapp_group_adds WHERE club_id = ? AND status = 'pending' ORDER BY created_at LIMIT 1").get(clubId);
    const conn = getConnection(clubId);
    if (!isClubGroup(conn, item.group_jid)) { finish(item.id, "failed", "That group is no longer linked to the club."); continue; }
    const gname = groupName(conn, item.group_jid);
    let status;
    try { ({ status } = await entry.session.addToGroup(item.group_jid, item.phone)); }
    catch (error) {
      const msg = String(error?.message || error);
      if (/not-authorized|forbidden|401|admin/i.test(msg)) { finish(item.id, "failed", `The club number needs to be an admin of ${gname} to add people.`); continue; }
      if (item.attempts + 1 >= 3) finish(item.id, "failed", `WhatsApp didn't accept it (${msg.slice(0, 120)}).`);
      else db.prepare("UPDATE whatsapp_group_adds SET attempts = attempts + 1, detail = ?, done_at = ? WHERE id = ?").run(msg.slice(0, 200), iso(), item.id);
      log.warn?.(`[whatsapp] group add failed for ${clubId}: ${msg}`);
      continue;
    }
    if (status === "200") { finish(item.id, "added", null); continue; }
    if (status === "409") { finish(item.id, "already", null); continue; }
    if (status === "401") { finish(item.id, "failed", `The club number needs to be an admin of ${gname} to add people.`); continue; }
    // 403 (privacy settings), 408 (left recently) and anything else WhatsApp refuses: send the invite link instead.
    try {
      const link = await entry.session.groupInviteLink(item.group_jid);
      const club = db.prepare("SELECT name FROM clubs WHERE id = ?").get(clubId)?.name || "Your club";
      const first = (item.name || "").split(" ")[0];
      await entry.session.sendText(`${item.phone}@s.whatsapp.net`, `Hi${first ? ` ${first}` : ""}! ${club} would like you in its WhatsApp group *${gname}*. Tap to join: ${link}`);
      finish(item.id, "invited", status === "408" ? "They left this group recently, so WhatsApp only allows an invite link." : "Their privacy settings don't allow being added directly.");
    } catch (error) {
      finish(item.id, "failed", `WhatsApp refused the add and the invite link couldn't be sent. The club number may need to be an admin of ${gname}.`);
    }
  }
}
