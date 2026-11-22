// Members-only activities.
//
// Only club members can join an activity. Someone who isn't signed in proves who they are
// with their WhatsApp number: it counts when it is in any of the club's linked WhatsApp
// groups, on the club's member list, or belongs to a club admin. A phone that has been
// checked once is remembered for that club, so next time joining is one tap.
// Anyone else sees a friendly "this one's for members" and can ask to join: the activity's
// Lead gets one WhatsApp from the club's own number (and a phone alert) with a link to add them.
import { randomUUID, randomBytes } from "node:crypto";
import { db, DomainError, getClubMembership } from "./db.js";
import { cleanName, cleanPhone, nameKey, addRosterPerson } from "./roster.js";
import { queuePush, clubOwnerIds } from "./push.js";
import { getConnection, clubGroups, memberGroups } from "./whatsapp/outbox.js";
import { queueGroupAdd } from "./whatsapp/group-adds.js";

const nowIso = () => new Date().toISOString();
const DAY_MS = 24 * 60 * 60 * 1000;
/** One alert per number per club per day, and at most this many alerts per club per day. */
export const CLUB_ALERTS_PER_DAY = 20;
const appUrl = () => (process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/$/, "");
export const prettyPhone = (p) => (p?.startsWith("91") && p.length === 12 ? `+91 ${p.slice(2, 7)} ${p.slice(7)}` : `+${p}`);

/** An error the activity page acts on (not_member, need_name, need_phone). */
const stepError = (status, message, step) => Object.assign(new DomainError(status, message), { extra: { step } });

const inGroup = (clubId, phone) => db.prepare("SELECT name FROM club_group_numbers WHERE club_id = ? AND phone = ?").get(clubId, phone)
  || db.prepare("SELECT COALESCE(saved_name, push_name) AS name FROM whatsapp_contacts WHERE club_id = ? AND phone = ? AND in_group = 1").get(clubId, phone)
  || null;

/**
 * Who this number is in the club, or null when it isn't a member.
 * { user_id, name } a club admin / signed-up member; { roster_id, name } on the member list;
 * { roster_id: null, wa_name } in a club group but not on the list yet.
 * People who added themselves while activities were open to everyone only count if they're in a group.
 */
export function memberByPhone(clubId, phone) {
  const user = db.prepare(`SELECT u.id, u.name FROM users u INNER JOIN club_memberships m ON m.user_id = u.id
    WHERE m.club_id = ? AND u.phone = ?`).get(clubId, phone);
  if (user) return { user_id: user.id, name: user.name };
  const group = inGroup(clubId, phone);
  const listed = db.prepare("SELECT id, name, self_added FROM club_roster WHERE club_id = ? AND phone = ?").get(clubId, phone);
  if (listed && (!listed.self_added || group)) return { roster_id: listed.id, name: listed.name };
  if (group) return { roster_id: null, wa_name: group.name || null };
  return null;
}

/** The person this phone was confirmed as in this club, if they still count as a member. */
export function rememberedPerson(clubId, deviceHash) {
  if (!deviceHash) return null;
  const seen = db.prepare("SELECT * FROM device_people WHERE device_hash = ? AND club_id = ?").get(deviceHash, clubId);
  if (!seen) return null;
  if (seen.user_id) {
    if (!getClubMembership(clubId, seen.user_id)) return null;
    return { user_id: seen.user_id, name: db.prepare("SELECT name FROM users WHERE id = ?").get(seen.user_id).name };
  }
  const row = seen.roster_id && db.prepare("SELECT id, name, phone FROM club_roster WHERE id = ? AND club_id = ?").get(seen.roster_id, clubId);
  if (!row) return null;
  const still = row.phone ? memberByPhone(clubId, row.phone) : null;
  return still?.roster_id === row.id ? { roster_id: row.id, name: row.name } : null;
}

function remember(clubId, deviceHash, person) {
  if (!deviceHash) return;
  db.prepare(`INSERT INTO device_people (device_hash, club_id, roster_id, user_id, updated_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (device_hash, club_id) DO UPDATE SET roster_id = excluded.roster_id, user_id = excluded.user_id, updated_at = excluded.updated_at`)
    .run(deviceHash, clubId, person.roster_id || null, person.user_id || null, nowIso());
}

/**
 * Works out who is joining for someone who isn't signed in. Runs inside the RSVP transaction.
 * phone given: check it; else use the person this phone was confirmed as before.
 * Returns { user_id, roster_id, name }. Throws a step error the page shows.
 */
export function resolveJoiner(clubId, { phone, name, deviceHash }) {
  if (phone == null || !String(phone).replace(/\D/g, "")) {
    const known = rememberedPerson(clubId, deviceHash);
    if (!known) throw stepError(400, "Enter your WhatsApp number.", "need_phone");
    return { user_id: known.user_id || null, roster_id: known.roster_id || null, name: known.name };
  }
  const mobile = cleanPhone(phone);
  if (!mobile) throw stepError(400, "That number doesn't look right. Try again with your WhatsApp number.", "need_phone");
  const person = memberByPhone(clubId, mobile);
  if (!person) throw stepError(403, "This one's for club members 🙂", "not_member");
  if (!person.user_id && !person.roster_id) {
    // In the club's WhatsApp group but not on the member list yet: add them under the name they give.
    const typed = cleanName(name || "");
    if (typed.length < 2) throw stepError(400, "Nice! And you are?", "need_name");
    if (typed.length > 60) throw new DomainError(400, "Enter your name (2 to 60 characters).");
    if (db.prepare("SELECT 1 FROM club_roster WHERE club_id = ? AND name_key = ?").get(clubId, nameKey(typed))) {
      throw stepError(409, `Someone called ${typed} is already on the club list. Add your surname so people can tell you apart.`, "need_name");
    }
    const now = nowIso();
    person.roster_id = randomUUID();
    person.name = typed;
    db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, phone, source, self_added, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'manual', 1, ?, ?)")
      .run(person.roster_id, clubId, typed, nameKey(typed), mobile, now, now);
  }
  remember(clubId, deviceHash, person);
  return { user_id: person.user_id || null, roster_id: person.roster_id || null, name: person.name };
}

// ---------------------------------------------------------------- asking to join

export function joinRequestText(req, ride) {
  return [
    `👋 *${req.name}* (${prettyPhone(req.phone)}) wants to join *${ride.title}* but isn't in the club yet.`,
    "",
    `Add them: ${appUrl()}/m/${req.code}`
  ].join("\n");
}

/**
 * Someone who isn't a member asks to join. The Lead (or, with no Lead, the club owner) gets a
 * WhatsApp from the club's own number plus a phone alert, at most once a day per number and
 * CLUB_ALERTS_PER_DAY times a day per club. The person always sees the same "Done!".
 */
export function askToJoin(ride, { phone, name }) {
  const mobile = cleanPhone(phone);
  if (!mobile) throw new DomainError(400, "That number doesn't look right. Try again with your WhatsApp number.");
  const clean = cleanName(name || "");
  if (clean.length < 2 || clean.length > 60) throw new DomainError(400, "Enter your name (2 to 60 characters).");
  return db.transaction(() => {
    if (memberByPhone(ride.club_id, mobile)) return { member: true };
    const now = Date.now();
    const since = new Date(now - DAY_MS).toISOString();
    const recent = db.prepare("SELECT 1 FROM join_requests WHERE club_id = ? AND phone = ? AND created_at > ?").get(ride.club_id, mobile, since);
    if (recent) return { sent: true };
    const alertsToday = db.prepare("SELECT COUNT(*) AS n FROM join_requests WHERE club_id = ? AND alerted = 1 AND created_at > ?").get(ride.club_id, since).n;
    const req = { id: randomUUID(), code: randomBytes(9).toString("base64url"), club_id: ride.club_id, ride_id: ride.id, phone: mobile, name: clean };
    const alert = alertsToday < CLUB_ALERTS_PER_DAY;
    db.prepare("INSERT INTO join_requests (id, code, club_id, ride_id, phone, name, alerted, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(req.id, req.code, req.club_id, req.ride_id, req.phone, req.name, alert ? 1 : 0, new Date(now).toISOString());
    if (!alert) return { sent: true };
    const leads = ride.organiser_id && getClubMembership(ride.club_id, ride.organiser_id) ? [ride.organiser_id] : clubOwnerIds(ride.club_id);
    queuePush(leads, { title: ride.title, body: `${clean} wants to join ${ride.title}.`, url: `/m/${req.code}` });
    // WhatsApp only ever goes out from the club's own linked number.
    const conn = db.prepare("SELECT 1 FROM whatsapp_connections WHERE club_id = ? AND desired = 'on' AND phone IS NOT NULL").get(ride.club_id);
    if (conn) {
      const text = joinRequestText(req, ride);
      for (const userId of leads) {
        const to = db.prepare("SELECT phone FROM users WHERE id = ?").get(userId)?.phone;
        if (!to) continue;
        db.prepare("INSERT INTO whatsapp_direct (id, club_id, to_phone, text, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
          .run(randomUUID(), ride.club_id, to, text, new Date(now + DAY_MS).toISOString(), new Date(now).toISOString());
      }
    }
    return { sent: true };
  }).immediate();
}

// ---------------------------------------------------------------- the admin side

function requestFor(code, userId) {
  const req = db.prepare("SELECT j.*, c.name AS club_name, r.title AS ride_title, r.share_code FROM join_requests j INNER JOIN clubs c ON c.id = j.club_id LEFT JOIN rides r ON r.id = j.ride_id WHERE j.code = ?").get(code);
  if (!req) throw new DomainError(404, "This link isn't valid any more.");
  const m = getClubMembership(req.club_id, userId);
  if (!m || !["owner", "admin"].includes(m.role)) throw new DomainError(403, "Only the club's admins can add people.");
  return req;
}

/** The WhatsApp group a new member is added to: the member-list group, if the number is linked. */
function addGroup(clubId) {
  const conn = getConnection(clubId);
  if (!conn || conn.status !== "connected") return null;
  const jid = memberGroups(conn).find((j) => clubGroups(conn).some((g) => g.jid === j));
  return jid ? { jid, name: clubGroups(conn).find((g) => g.jid === jid).name } : null;
}

export function joinRequestView(code, userId) {
  const req = requestFor(code, userId);
  const listed = db.prepare("SELECT name FROM club_roster WHERE club_id = ? AND phone = ?").get(req.club_id, req.phone);
  const group = addGroup(req.club_id);
  return {
    name: req.name, phone: prettyPhone(req.phone), status: listed ? "added" : req.status,
    club: { id: req.club_id, name: req.club_name }, activity: req.share_code ? { title: req.ride_title, code: req.share_code } : null,
    group: group ? { name: group.name } : null
  };
}

export function handleJoinRequest(code, userId, { action, toGroup = false }) {
  const req = requestFor(code, userId);
  const now = nowIso();
  if (action === "dismiss") {
    db.prepare("UPDATE join_requests SET status = 'dismissed', handled_by = ?, handled_at = ? WHERE id = ?").run(userId, now, req.id);
    return joinRequestView(code, userId);
  }
  const group = toGroup ? addGroup(req.club_id) : null;
  if (toGroup && !group) throw new DomainError(409, "Link the club's WhatsApp first to add people to a group.");
  const listed = db.prepare("SELECT id, name FROM club_roster WHERE club_id = ? AND phone = ?").get(req.club_id, req.phone);
  let name = listed?.name || req.name;
  if (!listed) {
    // The list already has this name with no number (e.g. someone WhatsApp shows only by a private id): that's them.
    const sameName = db.prepare("SELECT id, name FROM club_roster WHERE club_id = ? AND name_key = ? AND phone IS NULL").get(req.club_id, nameKey(req.name));
    if (sameName) {
      db.prepare("UPDATE club_roster SET phone = ?, self_added = 0, updated_at = ? WHERE id = ?").run(req.phone, now, sameName.id);
      name = sameName.name;
    } else try { name = addRosterPerson(req.club_id, req.name, req.phone).person.name; }
    catch (error) {
      if (!(error instanceof DomainError && error.existing)) throw error;
      // Same name, different number: keep both people apart with the last digits.
      name = addRosterPerson(req.club_id, `${req.name} ${req.phone.slice(-4)}`, req.phone).person.name;
    }
  } else if (db.prepare("SELECT self_added FROM club_roster WHERE id = ?").get(listed.id).self_added) {
    db.prepare("UPDATE club_roster SET self_added = 0, updated_at = ? WHERE id = ?").run(now, listed.id); // an admin vouched for them
  }
  if (group) queueGroupAdd(req.club_id, { phone: req.phone, name, groupJid: group.jid, userId });
  db.prepare("UPDATE join_requests SET status = 'added', handled_by = ?, handled_at = ? WHERE club_id = ? AND phone = ? AND status = 'open'").run(userId, now, req.club_id, req.phone);
  return { ...joinRequestView(code, userId), added_to_group: Boolean(group) };
}

// ---------------------------------------------------------------- the worker side

/**
 * Replaces the numbers in the club's WhatsApp groups. people: [{ phone, lid, name }] from every
 * linked club group. A private id (@lid) with no number is matched through what the club number
 * already learned about that person; the rest can't be checked and are counted as hidden.
 */
export function setGroupNumbers(clubId, people) {
  return db.transaction(() => {
    const byLid = db.prepare("SELECT phone FROM whatsapp_contacts WHERE club_id = ? AND lid = ? AND phone IS NOT NULL");
    const now = nowIso();
    const numbers = new Map();
    for (const p of people) {
      const phone = p.phone || (p.lid && byLid.get(clubId, p.lid)?.phone) || null;
      if (phone && !numbers.has(phone)) numbers.set(phone, p.name || null);
    }
    db.prepare("DELETE FROM club_group_numbers WHERE club_id = ?").run(clubId);
    const insert = db.prepare("INSERT INTO club_group_numbers (club_id, phone, name, updated_at) VALUES (?, ?, ?, ?)");
    for (const [phone, name] of numbers) insert.run(clubId, phone, name, now);
    db.prepare("UPDATE whatsapp_connections SET group_people = ?, group_numbers = ?, group_numbers_at = ? WHERE club_id = ?").run(people.length, numbers.size, now, clubId);
    return { people: people.length, numbers: numbers.size };
  }).immediate();
}

export function registerMembersOnlyRoutes(app) {
  const codeParams = { type: "object", properties: { code: { type: "string", pattern: "^[A-Za-z0-9_-]{8,20}$" } }, required: ["code"] };
  const domain = (reply, error) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message });
    throw error;
  };
  app.get("/api/join-requests/:code", { schema: { params: codeParams }, preHandler: [app.authenticate] }, async (req, reply) => {
    try { return { request: joinRequestView(req.params.code, req.user.sub) }; }
    catch (error) { return domain(reply, error); }
  });
  app.post("/api/join-requests/:code", {
    schema: { params: codeParams, body: { type: "object", properties: { action: { type: "string", enum: ["add", "dismiss"] }, to_group: { type: "boolean" } }, required: ["action"] } },
    preHandler: [app.authenticate]
  }, async (req, reply) => {
    try { return { request: handleJoinRequest(req.params.code, req.user.sub, { action: req.body.action, toGroup: Boolean(req.body.to_group) }) }; }
    catch (error) { return domain(reply, error); }
  });
}
