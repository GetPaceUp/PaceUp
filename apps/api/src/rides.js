// Activities (stored as "rides") and RSVPs.
// Club admins create activities; only club members can join (members-only.js): a member
// who isn't signed in types their WhatsApp number once and is checked against the club's
// WhatsApp groups and member list. Members never sign in.
// A device cookie ties each RSVP to the phone that made it, so only that
// phone (or the signed-in member) can change or cancel it.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { db, DomainError, getClubMembership } from "./db.js";
import { enqueueRideEvent, enqueueRiderList, clubGroups } from "./whatsapp/outbox.js";
import { resolveJoiner, askToJoin, rememberedPerson } from "./members-only.js";
import { queuePush } from "./push.js";
import { celebrateFirstJoin, logStep } from "./guide.js";
import { shortName } from "./whatsapp/messages.js";
import { absentWindow, noShowIds, noShowCounts, setNoShow, ABSENT_LOCK_MS } from "./no-shows.js";

const nowIso = () => new Date().toISOString();
const ADMIN_ROLES = ["owner", "admin"];
const isAdmin = (membership) => Boolean(membership && ADMIN_ROLES.includes(membership.role));
const newShareCode = () => randomBytes(9).toString("base64url"); // 12 chars, 72 bits
export const CATEGORIES = ["cycling", "running", "hiking", "swimming", "triathlon", "other"];
/** An activity counts as past (the "completed" state) this long after it starts. */
const PAST_AFTER_MS = 12 * 60 * 60 * 1000;
/** People can still join or drop out until an hour after the start (latecomers, last-minute changes). */
export const JOIN_GRACE_MS = 60 * 60 * 1000;
export const joiningOpen = (ride, now = Date.now()) => now < new Date(ride.starts_at).getTime() + JOIN_GRACE_MS;

const EDITABLE = ["title", "starts_at", "meeting_point", "map_url", "meeting_point_2", "meeting_at_2", "map_url_2", "distance_km", "pace", "notes", "capacity", "category", "wa_group_jid"];

/**
 * The optional midway meeting point (people who join on the way): a place and a time, both or neither.
 * Its time is on or after the start and within 12 hours of it. Clearing the place clears the rest.
 */
function checkMidway(ride) {
  if (!ride.meeting_point_2) { ride.meeting_point_2 = null; ride.meeting_at_2 = null; ride.map_url_2 = null; return ride; }
  if (!ride.meeting_at_2) throw new DomainError(400, "Add a time for the midway meeting point.");
  const start = new Date(ride.starts_at).getTime(), mid = new Date(ride.meeting_at_2).getTime();
  if (!(mid >= start) || mid - start > 12 * 60 * 60 * 1000) throw new DomainError(400, "The midway time should be after the start time, on the same outing.");
  return ride;
}

/** An activity may post to any of the club's linked groups; null means the club's default group. */
export function checkGroup(clubId, jid) {
  if (!jid) return null;
  const conn = db.prepare("SELECT * FROM whatsapp_connections WHERE club_id = ?").get(clubId);
  if (!clubGroups(conn).some((g) => g.jid === jid)) throw new DomainError(400, "Pick one of the club's WhatsApp groups.");
  return jid;
}

export const hashDevice = (token) => createHash("sha256").update(`device:${token}`).digest("hex");

function goingCount(rideId) {
  return db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ? AND status = 'going'").get(rideId).n;
}

/** The lead is on the going list by default once the activity is published (they can still drop out). */
function addLead(ride) {
  if (!ride.organiser_id) return;
  if (db.prepare("SELECT 1 FROM ride_rsvps WHERE ride_id = ? AND user_id = ?").get(ride.id, ride.organiser_id)) return;
  const name = db.prepare("SELECT name FROM users WHERE id = ?").get(ride.organiser_id)?.name;
  if (!name) return;
  const now = nowIso();
  db.prepare("INSERT INTO ride_rsvps (id, ride_id, user_id, roster_id, participant_name, device_hash, status, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, NULL, 'going', ?, ?)")
    .run(randomUUID(), ride.id, ride.organiser_id, name, now, now);
}

export { shortName };
const normName = (name) => String(name || "").normalize("NFKC").trim().replace(/\s+/g, " ").toLowerCase();

// ---------------------------------------------------------------- audit

export function logActivity({ clubId, rideId = null, actorType = "user", actorId = null, action, metadata = null }) {
  db.prepare("INSERT INTO activity_audit_log (id, club_id, ride_id, actor_type, actor_id, action, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), clubId, rideId, actorType, actorId, action, metadata ? JSON.stringify(metadata) : null, nowIso());
}
function rideHistory(rideId) {
  return db.prepare(`
    SELECT a.action, a.actor_type, a.metadata, a.created_at, u.name AS actor_name
    FROM activity_audit_log a LEFT JOIN users u ON u.id = a.actor_id
    WHERE a.ride_id = ? ORDER BY a.created_at DESC, a.rowid DESC LIMIT 30
  `).all(rideId).map((h) => ({ ...h, metadata: h.metadata ? JSON.parse(h.metadata) : null }));
}

// ---------------------------------------------------------------- reads

function getRideRow(where, value) {
  return db.prepare(`
    SELECT r.*, c.name AS club_name, u.name AS organiser_name
    FROM rides r INNER JOIN clubs c ON c.id = r.club_id
    LEFT JOIN users u ON u.id = r.organiser_id WHERE r.${where} = ?
  `).get(value);
}

/** Who is going, in RSVP order. The current roster/account name wins over the name saved at RSVP time. */
export function participants(rideId) {
  return db.prepare(`
    SELECT rs.id, rs.user_id, rs.roster_id, COALESCE(u.name, ro.name, rs.participant_name) AS name, rs.join_point, rs.updated_at
    FROM ride_rsvps rs LEFT JOIN users u ON u.id = rs.user_id LEFT JOIN club_roster ro ON ro.id = rs.roster_id
    WHERE rs.ride_id = ? AND rs.status = 'going' ORDER BY rs.updated_at, rs.rowid
  `).all(rideId);
}

function findMyRsvp(ride, { userId, member, deviceHash }) {
  if (member) {
    const own = db.prepare("SELECT * FROM ride_rsvps WHERE ride_id = ? AND user_id = ?").get(ride.id, userId);
    if (own) return own;
  }
  return deviceHash ? db.prepare("SELECT * FROM ride_rsvps WHERE ride_id = ? AND device_hash = ?").get(ride.id, deviceHash) : null;
}

/**
 * The activity as a given viewer may see it. Everyone with the link sees the
 * details and who's going (the names the club knows them by). Admins also see
 * whether each person is on the roster, and the change history. Drafts exist only for admins.
 */
export function rideView(ride, { userId = null, deviceHash = null } = {}) {
  const membership = userId ? getClubMembership(ride.club_id, userId) : null;
  const admin = isAdmin(membership);
  if (ride.status === "draft" && !admin) return null;
  const list = participants(ride.id);
  const mine = findMyRsvp(ride, { userId, member: Boolean(membership), deviceHash });
  const started = new Date(ride.starts_at).getTime() <= Date.now();
  // Admins only: who was marked as a no-show here, and each person's no-shows over the last 90 days.
  const marked = admin ? noShowIds(ride.id) : null;
  const counts = admin ? noShowCounts(ride.club_id) : null;
  const view = {
    id: ride.id, code: ride.share_code, club: { id: ride.club_id, name: ride.club_name },
    title: ride.title, category: ride.category || "other", starts_at: ride.starts_at, meeting_point: ride.meeting_point,
    map_url: ride.map_url, meeting_point_2: ride.meeting_point_2 || null, meeting_at_2: ride.meeting_point_2 ? ride.meeting_at_2 : null,
    map_url_2: ride.meeting_point_2 ? ride.map_url_2 : null, distance_km: ride.distance_km, pace: ride.pace, notes: ride.notes,
    status: ride.status, capacity: ride.capacity, going_count: list.length,
    is_full: ride.capacity != null && list.length >= ride.capacity,
    started, joining_open: ride.status === "published" && joiningOpen(ride), past: new Date(ride.starts_at).getTime() < Date.now() - PAST_AFTER_MS,
    organiser: ride.organiser_id ? { name: admin ? ride.organiser_name : shortName(ride.organiser_name) } : null,
    participants: list.map((p) => ({
      ...(admin ? { id: p.id, kind: p.user_id ? "member" : p.roster_id ? "roster" : "guest", no_show: marked.has(p.id), no_shows: counts.get(p.user_id || p.roster_id) || 0 } : {}),
      name: p.name,
      join_point: ride.meeting_point_2 ? p.join_point : 1,
      is_you: Boolean(mine && mine.id === p.id)
    })),
    my_rsvp: mine?.status === "going" ? { id: mine.id, name: list.find((p) => p.id === mine.id)?.name || mine.participant_name, listed: Boolean(mine.user_id || mine.roster_id), join_point: ride.meeting_point_2 ? mine.join_point : 1 } : null,
    // known_as: this phone was checked as a club member before, so joining is one tap.
    viewer: { signed_in: Boolean(userId), member: Boolean(membership), admin, known_as: !membership && deviceHash ? (rememberedPerson(ride.club_id, deviceHash)?.name || null) : null },
    ...(admin ? { wa_group_jid: ride.wa_group_jid || null } : {})
  };
  if (admin) {
    view.history = rideHistory(ride.id);
    view.absent = absentWindow(ride);
  }
  return view;
}

export function listClubRides(clubId, userId, { when = "upcoming" } = {}) {
  const admin = isAdmin(getClubMembership(clubId, userId));
  const cutoff = new Date(Date.now() - PAST_AFTER_MS).toISOString();
  const past = when === "past";
  return db.prepare(`
    SELECT r.id, r.share_code AS code, r.title, r.category, r.starts_at, r.meeting_point, r.meeting_point_2, r.distance_km, r.status, r.capacity,
      (SELECT COUNT(*) FROM ride_rsvps rs WHERE rs.ride_id = r.id AND rs.status = 'going') AS going_count,
      (SELECT status FROM ride_rsvps rs WHERE rs.ride_id = r.id AND rs.user_id = ?) AS my_rsvp,
      (SELECT COUNT(*) FROM ride_rsvps rs WHERE rs.ride_id = r.id AND rs.status = 'going' AND rs.no_show = 1) AS no_show_count
    FROM rides r WHERE r.club_id = ? AND ${past ? "r.starts_at < ?" : "r.starts_at >= ?"} AND (r.status != 'draft' OR ?)
    ORDER BY r.starts_at ${past ? "DESC LIMIT 50" : ""}
  `).all(userId, clubId, cutoff, admin ? 1 : 0).map(({ no_show_count, ...r }) => ({
    ...r, my_rsvp: r.my_rsvp === "going" ? "going" : null,
    // Admins only: no-shows, and whether the list can still be marked.
    ...(admin && new Date(r.starts_at).getTime() <= Date.now() ? { no_show_count, can_mark: r.status === "published" && Date.now() < new Date(r.starts_at).getTime() + ABSENT_LOCK_MS } : {})
  }));
}

// ---------------------------------------------------------------- admin writes

export function createRide(clubId, userId, input, { actorType = "user" } = {}) {
  return db.transaction(() => {
    const now = nowIso();
    const ride = {
      id: randomUUID(), club_id: clubId, share_code: newShareCode(), status: input.status === "published" ? "published" : "draft",
      organiser_id: userId, created_by: userId, created_at: now, updated_at: now
    };
    for (const key of EDITABLE) ride[key] = input[key] ?? null;
    ride.wa_group_jid = checkGroup(clubId, input.wa_group_jid);
    ride.category = CATEGORIES.includes(input.category) ? input.category : "other";
    checkMidway(ride);
    db.prepare(`
      INSERT INTO rides (id, club_id, share_code, title, category, starts_at, meeting_point, map_url, meeting_point_2, meeting_at_2, map_url_2, distance_km, pace, notes, capacity, wa_group_jid, status, organiser_id, created_by, created_at, updated_at)
      VALUES (@id, @club_id, @share_code, @title, @category, @starts_at, @meeting_point, @map_url, @meeting_point_2, @meeting_at_2, @map_url_2, @distance_km, @pace, @notes, @capacity, @wa_group_jid, @status, @organiser_id, @created_by, @created_at, @updated_at)
    `).run(ride);
    logActivity({ clubId, rideId: ride.id, actorType, actorId: userId, action: ride.status === "published" ? "created_published" : "created_draft" });
    if (ride.status === "published") { addLead(ride); enqueueRideEvent(ride, "ride_published"); }
    return getRideRow("id", ride.id);
  }).immediate();
}

export function updateRide(clubId, rideId, input, actorId = null) {
  return db.transaction(() => {
    const ride = db.prepare("SELECT * FROM rides WHERE id = ? AND club_id = ?").get(rideId, clubId);
    if (!ride) throw new DomainError(404, "Activity not found.");
    if (ride.status === "cancelled") throw new DomainError(409, "This activity was cancelled and can't be changed.");
    const going = goingCount(rideId);
    // The lead alone on the list doesn't stop unpublishing.
    const joined = db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ? AND status = 'going' AND (user_id IS NULL OR user_id != ?)").get(rideId, ride.organiser_id || "").n;
    const changes = {};
    if ("wa_group_jid" in input) input = { ...input, wa_group_jid: checkGroup(clubId, input.wa_group_jid) };
    for (const key of EDITABLE) if (key in input && input[key] !== ride[key]) changes[key] = input[key];
    if (["starts_at", "meeting_point_2", "meeting_at_2", "map_url_2"].some((k) => k in changes)) {
      const merged = checkMidway({ ...ride, ...changes });
      for (const k of ["meeting_point_2", "meeting_at_2", "map_url_2"]) { if (merged[k] !== ride[k]) changes[k] = merged[k]; else delete changes[k]; }
    }
    if (input.status && input.status !== ride.status) {
      if (input.status === "draft" && joined > 0) {
        throw new DomainError(409, `${joined} ${joined === 1 ? "person has" : "people have"} already joined. Cancel the activity instead of unpublishing it.`);
      }
      changes.status = input.status;
    }
    if (changes.capacity != null && changes.capacity < going) {
      throw new DomainError(409, `${going} people are already going. Set the spots to at least that.`);
    }
    const keys = Object.keys(changes);
    if (!keys.length) return getRideRow("id", rideId);
    db.prepare(`UPDATE rides SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @updated_at WHERE id = @id`)
      .run({ ...changes, updated_at: nowIso(), id: rideId });
    // Midway point removed: everyone joins at the start.
    if ("meeting_point_2" in changes && !changes.meeting_point_2) db.prepare("UPDATE ride_rsvps SET join_point = 1 WHERE ride_id = ?").run(rideId);
    const updated = getRideRow("id", rideId);

    const fields = keys.filter((k) => k !== "status");
    const action = changes.status === "published" ? "published" : changes.status === "draft" ? "unpublished" : changes.status === "cancelled" ? "cancelled" : "edited";
    logActivity({ clubId, rideId, actorId, action, metadata: fields.length ? { fields, ...(action === "cancelled" ? { going } : {}) } : (action === "cancelled" ? { going } : null) });

    if (changes.status === "published") { addLead(updated); enqueueRideEvent(updated, "ride_published"); }
    else if (changes.status === "cancelled" && ride.status === "published") enqueueRideEvent(updated, "ride_cancelled");
    else if (ride.status === "published" && updated.status === "published") {
      if (["starts_at", "meeting_point", "meeting_point_2", "meeting_at_2"].some((k) => k in changes)) enqueueRideEvent(updated, "ride_updated");
      if ("capacity" in changes) enqueueRiderList(updated);
    }
    return updated;
  }).immediate();
}

export function removeParticipant(clubId, rideId, rsvpId, actorId) {
  return db.transaction(() => {
    const ride = getRideRow("id", rideId);
    if (!ride || ride.club_id !== clubId) throw new DomainError(404, "Activity not found.");
    const row = db.prepare("SELECT rs.*, COALESCE(u.name, ro.name, rs.participant_name) AS name FROM ride_rsvps rs LEFT JOIN users u ON u.id = rs.user_id LEFT JOIN club_roster ro ON ro.id = rs.roster_id WHERE rs.id = ? AND rs.ride_id = ?").get(rsvpId, rideId);
    if (!row) throw new DomainError(404, "Participant not found.");
    if (row.status === "going") {
      db.prepare("UPDATE ride_rsvps SET status = 'cancelled', updated_at = ? WHERE id = ?").run(nowIso(), rsvpId);
      logActivity({ clubId, rideId, actorId, action: "participant_removed", metadata: { name: row.name } });
      if (ride.status === "published") enqueueRiderList(ride);
    }
    return getRideRow("id", rideId);
  }).immediate();
}

export function getRideByCode(code) { return getRideRow("share_code", code); }

// ---------------------------------------------------------------- RSVP

/**
 * Sets an RSVP. Signed-in club members act as themselves. Everyone else acts
 * through their device token and is checked as a club member by their WhatsApp
 * number (members-only.js). Each person and
 * each device has at most one row per activity (unique indexes). Capacity,
 * duplicate checks and the write run in one write transaction, so simultaneous
 * taps can't overfill or double-book.
 */
export function setRsvp(code, { userId = null, deviceHash = null, status, name = null, phone = null, joinPoint = null }) {
  return db.transaction(() => {
    const ride = getRideRow("share_code", code);
    if (!ride || ride.status === "draft") throw new DomainError(404, "Activity not found.");
    if (ride.status === "cancelled") throw new DomainError(409, "This activity was cancelled.");
    if (!joiningOpen(ride)) throw new DomainError(409, "This one has started. Joining is closed.");

    const membership = userId ? getClubMembership(ride.club_id, userId) : null;
    if (!membership && !deviceHash && status === "going") throw new DomainError(400, "Your browser blocked cookies, so we can't save your RSVP. Allow cookies and try again.");
    let row = findMyRsvp(ride, { userId, member: Boolean(membership), deviceHash });
    if (membership && row && row.user_id !== userId) row = null; // this phone's row is someone else's
    const now = nowIso();
    const view = () => rideView(ride, { userId, deviceHash });

    if (status === "cancelled") {
      if (!row || row.status !== "going") return view();
      db.prepare("UPDATE ride_rsvps SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, row.id);
      enqueueRiderList(ride);
      // Phone alert for the Lead (if they turned alerts on), unless the Lead dropped out themselves.
      if (ride.organiser_id && row.user_id !== ride.organiser_id) {
        const who = db.prepare("SELECT COALESCE(u.name, ro.name, rs.participant_name) AS name FROM ride_rsvps rs LEFT JOIN users u ON u.id = rs.user_id LEFT JOIN club_roster ro ON ro.id = rs.roster_id WHERE rs.id = ?").get(row.id)?.name || "Someone";
        queuePush(ride.organiser_id, { title: ride.title, body: `${who} dropped out.`, url: `/r/${ride.share_code}` });
      }
      return view();
    }

    // Already in, only changing where they join (no name sent): keep everything else, including their place on the list.
    if (!membership && row?.status === "going" && !name && !phone && joinPoint) {
      const point = ride.meeting_point_2 && joinPoint === 2 ? 2 : 1;
      if (row.join_point !== point) { db.prepare("UPDATE ride_rsvps SET join_point = ? WHERE id = ?").run(point, row.id); enqueueRiderList(ride); }
      return view();
    }

    // Who is joining? Members only: signed-in club members act as themselves; everyone else
    // is checked by their WhatsApp number (or this phone, once it has been checked for this club).
    let who = { user_id: null, roster_id: null }, displayName;
    if (membership) {
      who.user_id = userId;
      displayName = db.prepare("SELECT name FROM users WHERE id = ?").get(userId).name;
    } else {
      const person = resolveJoiner(ride.club_id, { phone, name, deviceHash });
      who = { user_id: person.user_id, roster_id: person.roster_id };
      displayName = person.name;
    }

    // The same person must not appear twice.
    const taken = `${displayName} is already on the list. If that's you, open the link on the phone you used to join.`;
    let adopted = false; // their earlier (dropped-out) answer, given from another phone: it moves to this one
    for (const col of ["user_id", "roster_id"]) {
      if (!who[col]) continue;
      const other = db.prepare(`SELECT * FROM ride_rsvps WHERE ride_id = ? AND ${col} = ?`).get(ride.id, who[col]);
      if (other && other.id !== row?.id) {
        if (other.status === "going") throw new DomainError(409, taken);
        if (row) db.prepare("DELETE FROM ride_rsvps WHERE id = ?").run(other.id); // stale cancelled row
        else { row = other; adopted = true; }
      }
    }
    const going = participants(ride.id);
    if (going.some((p) => p.id !== row?.id && normName(p.name) === normName(displayName))) {
      throw new DomainError(409, who.user_id || who.roster_id ? taken : `Someone called ${displayName} is already on the list. Add your surname so people can tell you apart.`);
    }

    const wasGoing = row?.status === "going";
    // Where they join: the midway point only when there is one. Changing it keeps your place on the list.
    const point = ride.meeting_point_2 ? (joinPoint === 2 ? 2 : joinPoint === 1 ? 1 : (row?.join_point || 1)) : 1;
    if (!wasGoing && ride.capacity != null && going.length >= ride.capacity) throw new DomainError(409, "This activity is full.");

    if (row) {
      if (wasGoing && row.user_id === who.user_id && row.roster_id === who.roster_id && row.participant_name === displayName && row.join_point === point) return view();
      // Re-joining moves you to the end of the list; changing your name does not.
      db.prepare(`UPDATE ride_rsvps SET user_id = @user, roster_id = @roster, participant_name = @name, status = 'going', join_point = @point,
          device_hash = CASE WHEN @adopt THEN @device ELSE COALESCE(device_hash, @device) END, updated_at = CASE WHEN @rejoin THEN @now ELSE updated_at END WHERE id = @id`)
        .run({ user: who.user_id, roster: who.roster_id, name: displayName, point, device: membership ? null : deviceHash, adopt: adopted && !membership ? 1 : 0, rejoin: wasGoing ? 0 : 1, now, id: row.id });
    } else {
      db.prepare("INSERT INTO ride_rsvps (id, ride_id, user_id, roster_id, participant_name, device_hash, status, join_point, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'going', ?, ?, ?)")
        .run(randomUUID(), ride.id, who.user_id, who.roster_id, displayName, membership ? null : deviceHash, point, now, now);
    }
    if (!wasGoing) celebrateFirstJoin(ride, who.user_id, displayName);
    enqueueRiderList(ride);
    return view();
  }).immediate();
}

// ---------------------------------------------------------------- HTTP routes

const rideFields = {
  title: { type: "string", minLength: 2, maxLength: 120 },
  category: { type: "string", enum: CATEGORIES },
  starts_at: { type: "string", format: "date-time" },
  meeting_point: { type: "string", minLength: 2, maxLength: 200 },
  map_url: { type: ["string", "null"], maxLength: 500, pattern: "^(https://.*)?$" },
  meeting_point_2: { type: ["string", "null"], maxLength: 200 },
  meeting_at_2: { anyOf: [{ type: "string", format: "date-time" }, { type: "null" }] },
  map_url_2: { type: ["string", "null"], maxLength: 500, pattern: "^(https://.*)?$" },
  distance_km: { type: ["number", "null"], minimum: 0, maximum: 1000 },
  pace: { type: ["string", "null"], maxLength: 60 },
  notes: { type: ["string", "null"], maxLength: 2000 },
  capacity: { type: ["integer", "null"], minimum: 1, maximum: 10000 },
  wa_group_jid: { type: ["string", "null"], maxLength: 100 }
};
const blankToNull = (body) => {
  for (const key of ["map_url", "map_url_2", "meeting_point_2", "pace", "notes"]) if (typeof body[key] === "string" && !body[key].trim()) body[key] = null;
  for (const key of ["title", "meeting_point", "meeting_point_2", "pace", "notes"]) if (typeof body[key] === "string") body[key] = body[key].trim();
  return body;
};

const DEVICE_COOKIE = "paceup_device";
const DEVICE_MAX_AGE = 400 * 24 * 60 * 60; // browsers cap cookie lifetime at 400 days

export function registerRideRoutes(app, { requireClubRole, optionalUser, isProduction = false, publicRateLimit = 30 }) {
  const id = { type: "string", pattern: "^[0-9a-fA-F-]{36}$" };
  const clubParams = { type: "object", properties: { clubId: id }, required: ["clubId"] };
  const rideParams = { type: "object", properties: { clubId: id, rideId: id }, required: ["clubId", "rideId"] };
  const domain = (reply, error) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message, ...(error.extra || {}) });
    throw error;
  };
  const deviceHashOf = (request) => {
    const token = request.cookies?.[DEVICE_COOKIE];
    return token && /^[A-Za-z0-9_-]{43}$/.test(token) ? hashDevice(token) : null;
  };
  /** The device token for this browser, issuing one on first RSVP. */
  const ensureDevice = (request, reply) => {
    const existing = deviceHashOf(request);
    if (existing) return existing;
    const token = randomBytes(32).toString("base64url");
    reply.setCookie(DEVICE_COOKIE, token, { httpOnly: true, secure: isProduction, sameSite: "lax", path: "/", maxAge: DEVICE_MAX_AGE });
    return hashDevice(token);
  };
  // optionalUser sets request.userId (null for visitors and ended sessions); authenticated routes use request.user.
  const viewer = (request) => ({ userId: request.userId !== undefined ? request.userId : (request.user?.sub ?? null), deviceHash: deviceHashOf(request) });

  app.get("/api/clubs/:clubId/rides", {
    schema: { params: clubParams, querystring: { type: "object", properties: { when: { type: "string", enum: ["upcoming", "past"] } } } },
    preHandler: [app.authenticate, requireClubRole(["owner", "admin", "member"])]
  }, async (request) => ({ rides: listClubRides(request.params.clubId, request.user.sub, { when: request.query.when }) }));

  app.post("/api/clubs/:clubId/rides", {
    schema: { params: clubParams, body: { type: "object", properties: { ...rideFields, status: { type: "string", enum: ["draft", "published"] } }, required: ["title", "starts_at", "meeting_point"] } },
    preHandler: [app.authenticate, requireClubRole(ADMIN_ROLES)]
  }, async (request, reply) => {
    try {
      const ride = createRide(request.params.clubId, request.user.sub, blankToNull(request.body));
      return reply.code(201).send({ ride: rideView(ride, viewer(request)) });
    } catch (error) { return domain(reply, error); }
  });

  app.patch("/api/clubs/:clubId/rides/:rideId", {
    schema: { params: rideParams, body: { type: "object", properties: { ...rideFields, status: { type: "string", enum: ["draft", "published", "cancelled"] } }, minProperties: 1 } },
    preHandler: [app.authenticate, requireClubRole(ADMIN_ROLES)]
  }, async (request, reply) => {
    try {
      const ride = updateRide(request.params.clubId, request.params.rideId, blankToNull(request.body), request.user.sub);
      return { ride: rideView(ride, viewer(request)) };
    } catch (error) { return domain(reply, error); }
  });

  app.delete("/api/clubs/:clubId/rides/:rideId/participants/:rsvpId", {
    schema: { params: { type: "object", properties: { clubId: id, rideId: id, rsvpId: id }, required: ["clubId", "rideId", "rsvpId"] } },
    preHandler: [app.authenticate, requireClubRole(ADMIN_ROLES)]
  }, async (request, reply) => {
    try {
      const ride = removeParticipant(request.params.clubId, request.params.rideId, request.params.rsvpId, request.user.sub);
      return { ride: rideView(ride, viewer(request)) };
    } catch (error) { return domain(reply, error); }
  });

  app.put("/api/clubs/:clubId/rides/:rideId/participants/:rsvpId/no-show", {
    schema: {
      params: { type: "object", properties: { clubId: id, rideId: id, rsvpId: id }, required: ["clubId", "rideId", "rsvpId"] },
      body: { type: "object", properties: { no_show: { type: "boolean" } }, required: ["no_show"] }
    },
    preHandler: [app.authenticate, requireClubRole(ADMIN_ROLES)]
  }, async (request, reply) => {
    try {
      setNoShow(request.params.clubId, request.params.rideId, request.params.rsvpId, request.body.no_show, request.user.sub);
      return { ride: rideView(getRideRow("id", request.params.rideId), viewer(request)) };
    } catch (error) { return domain(reply, error); }
  });

  const codeParams = { type: "object", properties: { code: { type: "string", pattern: "^[A-Za-z0-9_-]{6,16}$" } }, required: ["code"] };

  // Public activity page data. Works signed out.
  app.get("/api/r/:code", { schema: { params: codeParams }, preHandler: [optionalUser] }, async (request, reply) => {
    const ride = getRideByCode(request.params.code);
    let view = ride && rideView(ride, viewer(request));
    if (!view) return reply.code(404).send({ error: "Activity not found." });
    // First-time funnel: a phone (or signed-in person) that isn't running the club opening a join link.
    if (ride.status === "published" && !view.viewer?.admin) {
      const subject = view.viewer.member ? `u:${request.userId}` : `d:${ensureDevice(request, reply)}`;
      logStep(subject, ride.club_id, "m_opened");
    }
    return { ride: view };
  });

  // First-time funnel: someone tapped I'M IN (before typing their number). Nothing else changes.
  app.post("/api/r/:code/step", {
    config: { rateLimit: { max: publicRateLimit, timeWindow: "10 minutes" } },
    schema: { params: codeParams, body: { type: "object", properties: { step: { type: "string", enum: ["m_tapped"] } }, required: ["step"] } },
    preHandler: [optionalUser]
  }, async (request) => {
    const ride = getRideByCode(request.params.code);
    const member = ride && request.userId && getClubMembership(ride.club_id, request.userId);
    const subject = member ? `u:${request.userId}` : (deviceHashOf(request) ? `d:${deviceHashOf(request)}` : null);
    if (ride && subject) logStep(subject, ride.club_id, request.body.step);
    return { ok: true };
  });

  app.put("/api/r/:code/rsvp", {
    config: { rateLimit: { max: publicRateLimit, timeWindow: "10 minutes" } },
    schema: {
      params: codeParams,
      body: { type: "object", properties: { status: { type: "string", enum: ["going", "cancelled"] }, name: { type: "string", maxLength: 80 }, phone: { type: "string", maxLength: 30 }, join_point: { type: "integer", enum: [1, 2] } }, required: ["status"] }
    },
    preHandler: [optionalUser]
  }, async (request, reply) => {
    try {
      const ride = getRideByCode(request.params.code);
      const membership = request.userId && ride ? getClubMembership(ride.club_id, request.userId) : null;
      // Members act as themselves; everyone else needs this browser's device token.
      const deviceHash = membership ? deviceHashOf(request) : (request.body.status === "going" ? ensureDevice(request, reply) : deviceHashOf(request));
      const result = setRsvp(request.params.code, { userId: request.userId, deviceHash, status: request.body.status, name: request.body.name, phone: request.body.phone, joinPoint: request.body.join_point });
      if (request.body.status === "going" && ride) {
        const subject = membership ? `u:${request.userId}` : deviceHash ? `d:${deviceHash}` : null;
        if (subject) logStep(subject, ride.club_id, "m_joined");
      }
      return { ride: result };
    } catch (error) { return domain(reply, error); }
  });

  // Not a member: ask to join. The Lead hears about it (once a day per number).
  app.post("/api/r/:code/ask", {
    config: { rateLimit: { max: publicRateLimit, timeWindow: "1 hour" } },
    schema: { params: codeParams, body: { type: "object", properties: { name: { type: "string", maxLength: 80 }, phone: { type: "string", maxLength: 30 } }, required: ["name", "phone"] } }
  }, async (request, reply) => {
    try {
      const ride = getRideByCode(request.params.code);
      if (!ride || ride.status !== "published") throw new DomainError(404, "Activity not found.");
      return askToJoin(ride, { phone: request.body.phone, name: request.body.name });
    } catch (error) { return domain(reply, error); }
  });
}
