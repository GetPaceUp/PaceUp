// Rides and RSVPs: club admins post rides, club members RSVP with one tap.
import { randomUUID, randomBytes } from "node:crypto";
import { db, DomainError, getClubMembership } from "./db.js";
import { enqueueRideEvent, enqueueRiderList } from "./whatsapp/outbox.js";

const nowIso = () => new Date().toISOString();
const ADMIN_ROLES = ["owner", "admin"];
const isAdmin = (membership) => Boolean(membership && ADMIN_ROLES.includes(membership.role));
const newShareCode = () => randomBytes(6).toString("base64url"); // 8 chars, 48 bits

const EDITABLE = ["title", "starts_at", "meeting_point", "map_url", "distance_km", "pace", "notes", "capacity"];

function goingCount(rideId) {
  return db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ? AND status = 'going'").get(rideId).n;
}

/** "Priya Sharma" -> "Priya S." for member-facing lists. */
function shortName(name) {
  const parts = String(name).trim().split(/\s+/);
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.` : parts[0];
}

function getRideRow(where, value) {
  return db.prepare(`
    SELECT r.*, c.name AS club_name, u.name AS organiser_name
    FROM rides r INNER JOIN clubs c ON c.id = r.club_id
    LEFT JOIN users u ON u.id = r.organiser_id WHERE r.${where} = ?
  `).get(value);
}

/**
 * The ride as a given viewer may see it. Non-members (or signed-out visitors)
 * get the basics only; members get details and the rider list; admins also see
 * full names. Drafts exist only for admins.
 */
export function rideView(ride, userId) {
  const membership = userId ? getClubMembership(ride.club_id, userId) : null;
  const admin = isAdmin(membership);
  if (ride.status === "draft" && !admin) return null;
  const going = goingCount(ride.id);
  const base = {
    code: ride.share_code, club: { id: ride.club_id, name: ride.club_name },
    title: ride.title, starts_at: ride.starts_at, meeting_point: ride.meeting_point,
    status: ride.status, capacity: ride.capacity, going_count: going,
    is_full: ride.capacity != null && going >= ride.capacity,
    viewer: { signed_in: Boolean(userId), member: Boolean(membership), admin }
  };
  if (!membership) return base;
  const riders = db.prepare(`
    SELECT u.id, u.name FROM ride_rsvps rs INNER JOIN users u ON u.id = rs.user_id
    WHERE rs.ride_id = ? AND rs.status = 'going' ORDER BY rs.updated_at
  `).all(ride.id);
  const mine = db.prepare("SELECT status FROM ride_rsvps WHERE ride_id = ? AND user_id = ?").get(ride.id, userId);
  return {
    ...base, id: ride.id, map_url: ride.map_url, distance_km: ride.distance_km, pace: ride.pace, notes: ride.notes,
    organiser: ride.organiser_id ? { id: ride.organiser_id, name: admin ? ride.organiser_name : shortName(ride.organiser_name) } : null,
    riders: riders.map((r) => ({ id: r.id, name: admin ? r.name : shortName(r.name), is_you: r.id === userId })),
    my_rsvp: mine?.status === "going" ? "going" : null
  };
}

export function listClubRides(clubId, userId, { includePast = false } = {}) {
  const membership = getClubMembership(clubId, userId);
  const admin = isAdmin(membership);
  const since = includePast ? "0000" : new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
  return db.prepare(`
    SELECT r.id, r.share_code AS code, r.title, r.starts_at, r.meeting_point, r.distance_km, r.status, r.capacity,
      (SELECT COUNT(*) FROM ride_rsvps rs WHERE rs.ride_id = r.id AND rs.status = 'going') AS going_count,
      (SELECT status FROM ride_rsvps rs WHERE rs.ride_id = r.id AND rs.user_id = ?) AS my_rsvp
    FROM rides r WHERE r.club_id = ? AND r.starts_at >= ? AND (r.status != 'draft' OR ?)
    ORDER BY r.starts_at
  `).all(userId, clubId, since, admin ? 1 : 0).map((r) => ({ ...r, my_rsvp: r.my_rsvp === "going" ? "going" : null }));
}

export function createRide(clubId, userId, input) {
  return db.transaction(() => insertRide(clubId, userId, input)).immediate();
}
function insertRide(clubId, userId, input) {
  const now = nowIso();
  const ride = {
    id: randomUUID(), club_id: clubId, share_code: newShareCode(), status: input.status === "published" ? "published" : "draft",
    organiser_id: userId, created_by: userId, created_at: now, updated_at: now
  };
  for (const key of EDITABLE) ride[key] = input[key] ?? null;
  db.prepare(`
    INSERT INTO rides (id, club_id, share_code, title, starts_at, meeting_point, map_url, distance_km, pace, notes, capacity, status, organiser_id, created_by, created_at, updated_at)
    VALUES (@id, @club_id, @share_code, @title, @starts_at, @meeting_point, @map_url, @distance_km, @pace, @notes, @capacity, @status, @organiser_id, @created_by, @created_at, @updated_at)
  `).run(ride);
  if (ride.status === "published") enqueueRideEvent(ride, "ride_published");
  return getRideRow("id", ride.id);
}

export function updateRide(clubId, rideId, input) {
  return db.transaction(() => {
    const ride = db.prepare("SELECT * FROM rides WHERE id = ? AND club_id = ?").get(rideId, clubId);
    if (!ride) throw new DomainError(404, "Ride not found.");
    if (ride.status === "cancelled") throw new DomainError(409, "This ride was cancelled and can't be changed.");
    const changes = {};
    for (const key of EDITABLE) if (key in input) changes[key] = input[key];
    if (input.status) {
      if (input.status === "draft" && ride.status === "published") throw new DomainError(409, "A published ride can't go back to draft. Cancel it instead.");
      changes.status = input.status;
    }
    if (changes.capacity != null && changes.capacity < goingCount(rideId)) {
      throw new DomainError(409, `${goingCount(rideId)} riders are already going. Set the spots to at least that.`);
    }
    const keys = Object.keys(changes);
    if (keys.length) {
      db.prepare(`UPDATE rides SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @updated_at WHERE id = @id`)
        .run({ ...changes, updated_at: nowIso(), id: rideId });
    }
    const updated = getRideRow("id", rideId);
    if (changes.status === "published" && ride.status === "draft") enqueueRideEvent(updated, "ride_published");
    else if (changes.status === "cancelled" && ride.status === "published") enqueueRideEvent(updated, "ride_cancelled");
    else if (ride.status === "published" && updated.status === "published") {
      if (("starts_at" in changes && changes.starts_at !== ride.starts_at) || ("meeting_point" in changes && changes.meeting_point !== ride.meeting_point)) {
        enqueueRideEvent(updated, "ride_updated");
      }
      if ("capacity" in changes && changes.capacity !== ride.capacity) enqueueRiderList(updated);
    }
    return updated;
  }).immediate();
}

export function getRideByCode(code) { return getRideRow("share_code", code); }

/**
 * Sets a member's RSVP. One row per member per ride (unique in the schema);
 * the capacity check and the write happen in one write transaction so two
 * riders can never take the last spot together.
 */
export function setRsvp(code, userId, status) {
  return db.transaction(() => {
    const ride = getRideRow("share_code", code);
    if (!ride) throw new DomainError(404, "Ride not found.");
    const membership = getClubMembership(ride.club_id, userId);
    if (!membership) throw new DomainError(403, `Only ${ride.club_name} members can RSVP. Ask a club admin for an invite.`);
    if (ride.status === "draft") throw new DomainError(404, "Ride not found.");
    if (ride.status === "cancelled") throw new DomainError(409, "This ride was cancelled.");
    if (new Date(ride.starts_at).getTime() <= Date.now()) throw new DomainError(409, "This ride has already started.");

    const existing = db.prepare("SELECT id, status FROM ride_rsvps WHERE ride_id = ? AND user_id = ?").get(ride.id, userId);
    const now = nowIso();
    if (status === "going" && existing?.status !== "going") {
      if (ride.capacity != null && goingCount(ride.id) >= ride.capacity) throw new DomainError(409, "This ride is full.");
    }
    let changed = false;
    if (existing) {
      if (existing.status !== status) { db.prepare("UPDATE ride_rsvps SET status = ?, updated_at = ? WHERE id = ?").run(status, now, existing.id); changed = true; }
    } else if (status === "going") {
      db.prepare("INSERT INTO ride_rsvps (id, ride_id, user_id, status, created_at, updated_at) VALUES (?, ?, ?, 'going', ?, ?)")
        .run(randomUUID(), ride.id, userId, now, now);
      changed = true;
    }
    if (changed) enqueueRiderList(ride);
    return rideView(ride, userId);
  }).immediate();
}

// ---------------------------------------------------------------- HTTP routes

const rideFields = {
  title: { type: "string", minLength: 2, maxLength: 120 },
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

export function registerRideRoutes(app, { requireClubRole, optionalUser }) {
  const id = { type: "string", pattern: "^[0-9a-fA-F-]{36}$" };
  const clubParams = { type: "object", properties: { clubId: id }, required: ["clubId"] };
  const domain = (reply, error) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message });
    throw error;
  };

  app.get("/api/clubs/:clubId/rides", {
    schema: { params: clubParams },
    preHandler: [app.authenticate, requireClubRole(["owner", "admin", "member"])]
  }, async (request) => ({ rides: listClubRides(request.params.clubId, request.user.sub) }));

  app.post("/api/clubs/:clubId/rides", {
    schema: { params: clubParams, body: { type: "object", properties: { ...rideFields, status: { type: "string", enum: ["draft", "published"] } }, required: ["title", "starts_at", "meeting_point"] } },
    preHandler: [app.authenticate, requireClubRole(ADMIN_ROLES)]
  }, async (request, reply) => {
    const ride = createRide(request.params.clubId, request.user.sub, blankToNull(request.body));
    return reply.code(201).send({ ride: rideView(ride, request.user.sub) });
  });

  app.patch("/api/clubs/:clubId/rides/:rideId", {
    schema: {
      params: { type: "object", properties: { clubId: id, rideId: id }, required: ["clubId", "rideId"] },
      body: { type: "object", properties: { ...rideFields, status: { type: "string", enum: ["draft", "published", "cancelled"] } }, minProperties: 1 }
    },
    preHandler: [app.authenticate, requireClubRole(ADMIN_ROLES)]
  }, async (request, reply) => {
    try {
      const ride = updateRide(request.params.clubId, request.params.rideId, blankToNull(request.body));
      return { ride: rideView(ride, request.user.sub) };
    } catch (error) { return domain(reply, error); }
  });

  const codeParams = { type: "object", properties: { code: { type: "string", pattern: "^[A-Za-z0-9_-]{6,16}$" } }, required: ["code"] };

  // Shareable ride page data. Works signed out: visitors see the basics only.
  app.get("/api/r/:code", { schema: { params: codeParams }, preHandler: [optionalUser] }, async (request, reply) => {
    const ride = getRideByCode(request.params.code);
    const view = ride && rideView(ride, request.userId);
    if (!view) return reply.code(404).send({ error: "Ride not found." });
    return { ride: view };
  });

  app.put("/api/r/:code/rsvp", {
    schema: { params: codeParams, body: { type: "object", properties: { status: { type: "string", enum: ["going", "cancelled"] } }, required: ["status"] } },
    preHandler: [app.authenticate]
  }, async (request, reply) => {
    try { return { ride: setRsvp(request.params.code, request.user.sub, request.body.status) }; }
    catch (error) { return domain(reply, error); }
  });
}
