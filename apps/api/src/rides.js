// Activities (stored as "rides") and RSVPs.
// Club admins create activities; anyone with the link can RSVP by name, picking
// themselves from the club directory or joining as a guest. No login needed.
// A device cookie ties each guest RSVP to the phone that made it, so only that
// phone (or the signed-in member) can change or cancel it.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { db, DomainError, getClubMembership } from "./db.js";
import { enqueueRideEvent, enqueueRiderList } from "./whatsapp/outbox.js";

const nowIso = () => new Date().toISOString();
const ADMIN_ROLES = ["owner", "admin"];
const isAdmin = (membership) => Boolean(membership && ADMIN_ROLES.includes(membership.role));
const newShareCode = () => randomBytes(9).toString("base64url"); // 12 chars, 72 bits
export const CATEGORIES = ["cycling", "running", "hiking", "triathlon", "other"];
/** An activity counts as past (the "completed" state) this long after it starts. */
const PAST_AFTER_MS = 12 * 60 * 60 * 1000;

const EDITABLE = ["title", "starts_at", "meeting_point", "map_url", "distance_km", "pace", "notes", "capacity", "category"];

export const hashDevice = (token) => createHash("sha256").update(`device:${token}`).digest("hex");

function goingCount(rideId) {
  return db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ? AND status = 'going'").get(rideId).n;
}

/** "Priya Sharma" -> "Priya S." for public lists. */
export function shortName(name) {
  const parts = String(name || "").trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.` : parts[0];
}
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

/** Who is going, in RSVP order. A member's current account name wins over the name typed at RSVP time. */
export function participants(rideId) {
  return db.prepare(`
    SELECT rs.id, rs.user_id, COALESCE(u.name, rs.participant_name) AS name, rs.updated_at
    FROM ride_rsvps rs LEFT JOIN users u ON u.id = rs.user_id
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
 * details and the participant list (short names). Admins also see full names,
 * guest/member tags and the change history. Drafts exist only for admins.
 */
export function rideView(ride, { userId = null, deviceHash = null } = {}) {
  const membership = userId ? getClubMembership(ride.club_id, userId) : null;
  const admin = isAdmin(membership);
  if (ride.status === "draft" && !admin) return null;
  const list = participants(ride.id);
  const mine = findMyRsvp(ride, { userId, member: Boolean(membership), deviceHash });
  const started = new Date(ride.starts_at).getTime() <= Date.now();
  const view = {
    id: ride.id, code: ride.share_code, club: { id: ride.club_id, name: ride.club_name },
    title: ride.title, category: ride.category || "cycling", starts_at: ride.starts_at, meeting_point: ride.meeting_point,
    map_url: ride.map_url, distance_km: ride.distance_km, pace: ride.pace, notes: ride.notes,
    status: ride.status, capacity: ride.capacity, going_count: list.length,
    is_full: ride.capacity != null && list.length >= ride.capacity,
    started, past: new Date(ride.starts_at).getTime() < Date.now() - PAST_AFTER_MS,
    organiser: ride.organiser_id ? { name: admin ? ride.organiser_name : shortName(ride.organiser_name) } : null,
    participants: list.map((p) => ({
      ...(admin ? { id: p.id, member: Boolean(p.user_id) } : {}),
      name: admin ? p.name : shortName(p.name),
      is_you: Boolean(mine && mine.id === p.id)
    })),
    my_rsvp: mine?.status === "going" ? { id: mine.id, name: list.find((p) => p.id === mine.id)?.name || mine.participant_name, member: Boolean(mine.user_id) } : null,
    viewer: { signed_in: Boolean(userId), member: Boolean(membership), admin }
  };
  if (admin) view.history = rideHistory(ride.id);
  return view;
}

export function listClubRides(clubId, userId, { when = "upcoming" } = {}) {
  const admin = isAdmin(getClubMembership(clubId, userId));
  const cutoff = new Date(Date.now() - PAST_AFTER_MS).toISOString();
  const past = when === "past";
  return db.prepare(`
    SELECT r.id, r.share_code AS code, r.title, r.category, r.starts_at, r.meeting_point, r.distance_km, r.status, r.capacity,
      (SELECT COUNT(*) FROM ride_rsvps rs WHERE rs.ride_id = r.id AND rs.status = 'going') AS going_count,
      (SELECT status FROM ride_rsvps rs WHERE rs.ride_id = r.id AND rs.user_id = ?) AS my_rsvp
    FROM rides r WHERE r.club_id = ? AND ${past ? "r.starts_at < ?" : "r.starts_at >= ?"} AND (r.status != 'draft' OR ?)
    ORDER BY r.starts_at ${past ? "DESC LIMIT 50" : ""}
  `).all(userId, clubId, cutoff, admin ? 1 : 0).map((r) => ({ ...r, my_rsvp: r.my_rsvp === "going" ? "going" : null }));
}

/** Club directory suggestions for the RSVP name box. Public, so short names only. */
export function suggestMembers(code, query) {
  const ride = getRideRow("share_code", code);
  if (!ride || ride.status !== "published") throw new DomainError(404, "Activity not found.");
  const q = normName(query).replace(/[%_\\]/g, "");
  if (q.length < 2) return [];
  const rows = db.prepare(`
    SELECT u.id, u.name FROM club_memberships cm INNER JOIN users u ON u.id = cm.user_id
    WHERE cm.club_id = ? AND (lower(u.name) LIKE ? OR lower(u.name) LIKE ?)
    ORDER BY u.name LIMIT 6
  `).all(ride.club_id, `${q}%`, `% ${q}%`);
  const shorts = rows.map((r) => shortName(r.name));
  // Two "Priya S." in one list: show the full surname so people can tell them apart.
  return rows.map((r, i) => {
    const parts = r.name.trim().split(/\s+/);
    const clash = shorts.filter((s) => s === shorts[i]).length > 1;
    return { id: r.id, name: clash && parts.length > 1 ? `${parts[0]} ${parts.at(-1)}` : shorts[i] };
  });
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
    ride.category = CATEGORIES.includes(input.category) ? input.category : "cycling";
    db.prepare(`
      INSERT INTO rides (id, club_id, share_code, title, category, starts_at, meeting_point, map_url, distance_km, pace, notes, capacity, status, organiser_id, created_by, created_at, updated_at)
      VALUES (@id, @club_id, @share_code, @title, @category, @starts_at, @meeting_point, @map_url, @distance_km, @pace, @notes, @capacity, @status, @organiser_id, @created_by, @created_at, @updated_at)
    `).run(ride);
    logActivity({ clubId, rideId: ride.id, actorType, actorId: userId, action: ride.status === "published" ? "created_published" : "created_draft" });
    if (ride.status === "published") enqueueRideEvent(ride, "ride_published");
    return getRideRow("id", ride.id);
  }).immediate();
}

export function updateRide(clubId, rideId, input, actorId = null) {
  return db.transaction(() => {
    const ride = db.prepare("SELECT * FROM rides WHERE id = ? AND club_id = ?").get(rideId, clubId);
    if (!ride) throw new DomainError(404, "Activity not found.");
    if (ride.status === "cancelled") throw new DomainError(409, "This activity was cancelled and can't be changed.");
    const going = goingCount(rideId);
    const changes = {};
    for (const key of EDITABLE) if (key in input && input[key] !== ride[key]) changes[key] = input[key];
    if (input.status && input.status !== ride.status) {
      if (input.status === "draft" && going > 0) {
        throw new DomainError(409, `${going} ${going === 1 ? "person has" : "people have"} already joined. Cancel the activity instead of unpublishing it.`);
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
    const updated = getRideRow("id", rideId);

    const fields = keys.filter((k) => k !== "status");
    const action = changes.status === "published" ? "published" : changes.status === "draft" ? "unpublished" : changes.status === "cancelled" ? "cancelled" : "edited";
    logActivity({ clubId, rideId, actorId, action, metadata: fields.length ? { fields, ...(action === "cancelled" ? { going } : {}) } : (action === "cancelled" ? { going } : null) });

    if (changes.status === "published") enqueueRideEvent(updated, "ride_published");
    else if (changes.status === "cancelled" && ride.status === "published") enqueueRideEvent(updated, "ride_cancelled");
    else if (ride.status === "published" && updated.status === "published") {
      if ("starts_at" in changes || "meeting_point" in changes) enqueueRideEvent(updated, "ride_updated");
      if ("capacity" in changes) enqueueRiderList(updated);
    }
    return updated;
  }).immediate();
}

export function removeParticipant(clubId, rideId, rsvpId, actorId) {
  return db.transaction(() => {
    const ride = getRideRow("id", rideId);
    if (!ride || ride.club_id !== clubId) throw new DomainError(404, "Activity not found.");
    const row = db.prepare("SELECT rs.*, COALESCE(u.name, rs.participant_name) AS name FROM ride_rsvps rs LEFT JOIN users u ON u.id = rs.user_id WHERE rs.id = ? AND rs.ride_id = ?").get(rsvpId, rideId);
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
 * through their device token: they pick a member from the directory (memberId)
 * or type a name as a guest. Each member, and each device, has at most one row
 * per activity (unique indexes). Capacity, duplicate checks and the write run in
 * one write transaction, so simultaneous taps can't overfill or double-book.
 */
export function setRsvp(code, { userId = null, deviceHash = null, status, name = null, memberId = null }) {
  return db.transaction(() => {
    const ride = getRideRow("share_code", code);
    if (!ride || ride.status === "draft") throw new DomainError(404, "Activity not found.");
    if (ride.status === "cancelled") throw new DomainError(409, "This activity was cancelled.");
    if (new Date(ride.starts_at).getTime() <= Date.now()) throw new DomainError(409, "This activity has already started.");

    const membership = userId ? getClubMembership(ride.club_id, userId) : null;
    if (!membership && !deviceHash && status === "going") throw new DomainError(400, "Your browser blocked cookies, so we can't save your RSVP. Allow cookies and try again.");
    let row = findMyRsvp(ride, { userId, member: Boolean(membership), deviceHash });
    if (membership && row && row.user_id !== userId) row = null; // device row belongs to someone else's guest RSVP
    const now = nowIso();
    const view = () => rideView(ride, { userId, deviceHash });

    if (status === "cancelled") {
      if (!row || row.status !== "going") return view();
      db.prepare("UPDATE ride_rsvps SET status = 'cancelled', updated_at = ? WHERE id = ?").run(now, row.id);
      enqueueRiderList(ride);
      return view();
    }

    // Who is joining?
    let targetUser = null, displayName;
    if (membership) {
      targetUser = userId;
      displayName = db.prepare("SELECT name FROM users WHERE id = ?").get(userId).name;
    } else if (memberId) {
      const picked = getClubMembership(ride.club_id, memberId);
      if (!picked) throw new DomainError(400, "Pick a name from the list, or continue as a guest.");
      targetUser = memberId;
      displayName = db.prepare("SELECT name FROM users WHERE id = ?").get(memberId).name;
    } else {
      displayName = String(name || "").normalize("NFKC").trim().replace(/\s+/g, " ");
      if (displayName.length < 2 || displayName.length > 60) throw new DomainError(400, "Enter your name (2 to 60 characters).");
    }

    // The same person must not appear twice.
    const going = participants(ride.id);
    if (targetUser) {
      const other = db.prepare("SELECT * FROM ride_rsvps WHERE ride_id = ? AND user_id = ?").get(ride.id, targetUser);
      if (other && other.id !== row?.id) {
        if (other.status === "going") throw new DomainError(409, `${shortName(displayName)} is already on the list. If that's you, open the link on the phone you used to join.`);
        if (row) db.prepare("DELETE FROM ride_rsvps WHERE id = ?").run(other.id); // stale cancelled row
        else row = other;
      }
    } else if (going.some((p) => p.id !== row?.id && normName(p.name) === normName(displayName))) {
      throw new DomainError(409, `Someone called ${displayName} is already on the list. Add your surname so people can tell you apart.`);
    }

    const wasGoing = row?.status === "going";
    if (!wasGoing && ride.capacity != null && going.length >= ride.capacity) throw new DomainError(409, "This activity is full.");

    if (row) {
      const sameName = row.user_id === targetUser && row.participant_name === displayName;
      if (wasGoing && sameName) return view();
      // Re-joining moves you to the end of the list; renaming yourself does not.
      db.prepare(`UPDATE ride_rsvps SET user_id = @user, participant_name = @name, status = 'going',
          device_hash = COALESCE(device_hash, @device), updated_at = CASE WHEN @rejoin THEN @now ELSE updated_at END WHERE id = @id`)
        .run({ user: targetUser, name: displayName, device: membership ? null : deviceHash, rejoin: wasGoing ? 0 : 1, now, id: row.id });
    } else {
      db.prepare("INSERT INTO ride_rsvps (id, ride_id, user_id, participant_name, device_hash, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'going', ?, ?)")
        .run(randomUUID(), ride.id, targetUser, displayName, membership ? null : deviceHash, now, now);
    }
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
  distance_km: { type: ["number", "null"], minimum: 0, maximum: 1000 },
  pace: { type: ["string", "null"], maxLength: 60 },
  notes: { type: ["string", "null"], maxLength: 2000 },
  capacity: { type: ["integer", "null"], minimum: 1, maximum: 10000 }
};
const blankToNull = (body) => {
  for (const key of ["map_url", "pace", "notes"]) if (typeof body[key] === "string" && !body[key].trim()) body[key] = null;
  for (const key of ["title", "meeting_point", "pace", "notes"]) if (typeof body[key] === "string") body[key] = body[key].trim();
  return body;
};

const DEVICE_COOKIE = "paceup_device";
const DEVICE_MAX_AGE = 400 * 24 * 60 * 60; // browsers cap cookie lifetime at 400 days

export function registerRideRoutes(app, { requireClubRole, optionalUser, isProduction = false, publicRateLimit = 30 }) {
  const id = { type: "string", pattern: "^[0-9a-fA-F-]{36}$" };
  const clubParams = { type: "object", properties: { clubId: id }, required: ["clubId"] };
  const rideParams = { type: "object", properties: { clubId: id, rideId: id }, required: ["clubId", "rideId"] };
  const domain = (reply, error) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message });
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
    const ride = createRide(request.params.clubId, request.user.sub, blankToNull(request.body));
    return reply.code(201).send({ ride: rideView(ride, viewer(request)) });
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

  const codeParams = { type: "object", properties: { code: { type: "string", pattern: "^[A-Za-z0-9_-]{6,16}$" } }, required: ["code"] };

  // Public activity page data. Works signed out.
  app.get("/api/r/:code", { schema: { params: codeParams }, preHandler: [optionalUser] }, async (request, reply) => {
    const ride = getRideByCode(request.params.code);
    const view = ride && rideView(ride, viewer(request));
    if (!view) return reply.code(404).send({ error: "Activity not found." });
    return { ride: view };
  });

  app.get("/api/r/:code/members", {
    config: { rateLimit: { max: publicRateLimit * 4, timeWindow: "10 minutes" } },
    schema: { params: codeParams, querystring: { type: "object", properties: { q: { type: "string", maxLength: 60 } }, required: ["q"] } }
  }, async (request, reply) => {
    try { return { members: suggestMembers(request.params.code, request.query.q) }; }
    catch (error) { return domain(reply, error); }
  });

  app.put("/api/r/:code/rsvp", {
    config: { rateLimit: { max: publicRateLimit, timeWindow: "10 minutes" } },
    schema: {
      params: codeParams,
      body: { type: "object", properties: { status: { type: "string", enum: ["going", "cancelled"] }, name: { type: "string", maxLength: 80 }, member_id: id }, required: ["status"] }
    },
    preHandler: [optionalUser]
  }, async (request, reply) => {
    try {
      const ride = getRideByCode(request.params.code);
      const membership = request.userId && ride ? getClubMembership(ride.club_id, request.userId) : null;
      // Members act as themselves; everyone else needs this browser's device token.
      const deviceHash = membership ? deviceHashOf(request) : (request.body.status === "going" ? ensureDevice(request, reply) : deviceHashOf(request));
      return { ride: setRsvp(request.params.code, { userId: request.userId, deviceHash, status: request.body.status, name: request.body.name, memberId: request.body.member_id }) };
    } catch (error) { return domain(reply, error); }
  });
}
