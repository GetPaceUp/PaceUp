// Clubs are created only by the platform owner (Super Admin), who names the
// club's first admin by mobile number. Club admins add more admins the same way.
// Nobody creates a club while signing up.
import { randomUUID } from "node:crypto";
import { db, DomainError, PHONE_EMAIL_DOMAIN, getUserById, getClubMembership } from "./db.js";
import { cleanName, cleanPhone } from "./roster.js";

const slugify = (name) => name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

function uniqueSlug(name) {
  const base = slugify(name) || "club";
  for (let i = 0; i < 50; i++) {
    const slug = i ? `${base}-${i + 1}` : base;
    if (!db.prepare("SELECT 1 FROM clubs WHERE slug = ?").get(slug)) return slug;
  }
  return `${base}-${randomUUID().slice(0, 6)}`;
}

/** The account that owns this number, created (phone-only, no password) if there is none. */
export function findOrCreatePhoneUser(phone, name) {
  const existing = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (existing) return existing.id;
  const clean = cleanName(name);
  if (clean.length < 2) throw new DomainError(400, "This number isn't on PaceUp yet. Enter the person's name too.");
  const id = randomUUID();
  db.prepare("INSERT INTO users (id, name, email, password_hash, phone) VALUES (?, ?, ?, '!', ?)").run(id, clean, `${phone}@${PHONE_EMAIL_DOMAIN}`, phone);
  return id;
}

function setRole(clubId, userId, role) {
  const current = getClubMembership(clubId, userId);
  if (!current) db.prepare("INSERT INTO club_memberships (id, club_id, user_id, role) VALUES (?, ?, ?, ?)").run(randomUUID(), clubId, userId, role);
  else if (current.role === "member" || (current.role === "admin" && role === "owner")) db.prepare("UPDATE club_memberships SET role = ? WHERE club_id = ? AND user_id = ?").run(role, clubId, userId);
}

export function createClub({ name, adminPhone, adminName, actorId }) {
  const clubName = String(name || "").trim().replace(/\s+/g, " ");
  if (clubName.length < 2 || clubName.length > 80) throw new DomainError(400, "Enter a club name (2 to 80 characters).");
  const phone = adminPhone ? cleanPhone(adminPhone) : null;
  if (adminPhone && !phone) throw new DomainError(400, "Enter the admin's mobile number with the country code, e.g. +91 98765 43210.");
  return db.transaction(() => {
    if (db.prepare("SELECT 1 FROM clubs WHERE name = ? COLLATE NOCASE").get(clubName)) throw new DomainError(409, `A club called ${clubName} already exists.`);
    const id = randomUUID();
    db.prepare("INSERT INTO clubs (id, name, slug) VALUES (?, ?, ?)").run(id, clubName, uniqueSlug(clubName));
    const ownerId = phone ? findOrCreatePhoneUser(phone, adminName) : actorId;
    setRole(id, ownerId, "owner");
    return { club: db.prepare("SELECT id, name, slug, created_at FROM clubs WHERE id = ?").get(id), owner: getUserById(ownerId) };
  }).immediate();
}

export function addClubAdmin(clubId, { phone: rawPhone, name }) {
  const phone = cleanPhone(rawPhone);
  if (!phone) throw new DomainError(400, "Enter the mobile number with the country code, e.g. +91 98765 43210.");
  return db.transaction(() => {
    const userId = findOrCreatePhoneUser(phone, name);
    setRole(clubId, userId, "admin");
    return getUserById(userId);
  }).immediate();
}

/** A new phone account joins, as a member, every club whose member list has its number. */
export function joinClubsByPhone(userId, phone) {
  const clubs = db.prepare("SELECT DISTINCT club_id FROM club_roster WHERE phone = ?").all(phone);
  for (const { club_id } of clubs) if (!getClubMembership(club_id, userId)) setRole(club_id, userId, "member");
  return clubs.length;
}

/** The name a club list already has for this number, to pre-fill sign-up. */
export const rosterNameFor = (phone) => db.prepare("SELECT name FROM club_roster WHERE phone = ? ORDER BY updated_at DESC LIMIT 1").get(phone)?.name || null;

export function registerClubAdminRoutes(app, { requireClubRole, requirePlatformAdmin }) {
  const fail = (reply, error) => { if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message }); throw error; };
  const str = (n) => ({ type: "string", maxLength: n });
  app.post("/api/platform/clubs", {
    preHandler: [app.authenticate, requirePlatformAdmin],
    schema: { body: { type: "object", properties: { name: str(200), adminPhone: str(30), adminName: str(200) }, required: ["name"] } }
  }, async (req, reply) => {
    try { return reply.code(201).send(createClub({ ...req.body, actorId: req.user.sub })); } catch (error) { return fail(reply, error); }
  });
  app.post("/api/clubs/:clubId/admins", {
    preHandler: [app.authenticate, requireClubRole(["owner", "admin"])],
    schema: { body: { type: "object", properties: { phone: str(30), name: str(200) }, required: ["phone"] } }
  }, async (req, reply) => {
    try { return reply.code(201).send({ admin: addClubAdmin(req.params.clubId, req.body) }); } catch (error) { return fail(reply, error); }
  });
}
