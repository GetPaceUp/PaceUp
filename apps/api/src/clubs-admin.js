// Clubs are created only by the platform owner (Super Admin), who names the
// club's first admin by mobile number. Club admins add more admins the same way.
// Nobody creates a club while signing up.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import { db, DomainError, PHONE_EMAIL_DOMAIN, getUserById, getClubMembership, getPlatformRole, revokeAllSessions, audit } from "./db.js";
import { cleanName, cleanPhone } from "./roster.js";
import { cleanCity, linkDirectoryToClub, clubKey } from "./directory.js";

const slugify = (name) => name.toLowerCase().normalize("NFKD").replace(/[^\w\s-]/g, "").trim().replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 60);

function uniqueSlug(name) {
  const base = slugify(name) || "club";
  for (let i = 0; i < 50; i++) {
    const slug = i ? `${base}-${i + 1}` : base;
    if (!db.prepare("SELECT 1 FROM clubs WHERE slug = ?").get(slug)) return slug;
  }
  return `${base}-${randomUUID().slice(0, 6)}`;
}

/**
 * A number someone typed at /start (not yet proved) is now being added to a club by its admin,
 * or the real owner of the number signed in: whoever typed it loses their sign-in, so they can't
 * see clubs meant for the number's owner.
 */
export function distrustUnverified(phone) {
  const u = db.prepare("SELECT id FROM users WHERE phone = ? AND signup_unverified = 1").get(phone);
  if (!u) return;
  revokeAllSessions(u.id);
  db.prepare("UPDATE users SET signup_unverified = 0 WHERE id = ?").run(u.id);
}

/** The account that owns this number, created (phone-only, no password) if there is none. */
export function findOrCreatePhoneUser(phone, name) {
  const existing = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  if (existing) { distrustUnverified(phone); return existing.id; }
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

export function createClub({ name, adminPhone, adminName, city, activity, directoryId, actorId }) {
  const clubName = String(name || "").trim().replace(/\s+/g, " ");
  if (clubName.length < 2 || clubName.length > 80) throw new DomainError(400, "Enter a club name (2 to 80 characters).");
  const phone = adminPhone ? cleanPhone(adminPhone) : null;
  if (adminPhone && !phone) throw new DomainError(400, "Enter the owner's mobile number with the country code, e.g. +91 98765 43210.");
  const cityName = cleanCity(city);
  const activityName = String(activity || "").trim().slice(0, 80) || null;
  return db.transaction(() => {
    const same = db.prepare("SELECT id, name FROM clubs").all().find((c) => c.name.toLowerCase() === clubName.toLowerCase() || clubKey(c.name) === clubKey(clubName));
    if (same) throw new DomainError(409, `${same.name} is already on PaceUp.`);
    const id = randomUUID();
    db.prepare("INSERT INTO clubs (id, name, slug, city, activity) VALUES (?, ?, ?, ?, ?)").run(id, clubName, uniqueSlug(clubName), cityName, activityName);
    const ownerId = phone ? findOrCreatePhoneUser(phone, adminName) : actorId;
    // The person the PaceUp Admin names is the Club Owner: they link the club's own WhatsApp number.
    setRole(id, ownerId, "owner");
    db.prepare("UPDATE clubs SET number_owner_id = ? WHERE id = ?").run(ownerId, id);
    const club = db.prepare("SELECT id, name, slug, city, activity, created_at FROM clubs WHERE id = ?").get(id);
    linkDirectoryToClub(directoryId, club);
    const ownerLink = phone ? createOwnerLink(id, ownerId, actorId) : null;
    return { club, owner: getUserById(ownerId), owner_link: ownerLink };
  }).immediate();
}

// ---------------------------------------------------------------- one-time owner sign-in links
// A new club has no WhatsApp number yet, so its owner can't get a code. The Super Admin shares
// this link by hand (never sent from any club's number). It signs the owner in once (valid 7 days), after they
// confirm the last 4 digits of their mobile.
const OWNER_LINK_TTL_MS = 7 * 24 * 3600 * 1000;
const OWNER_LINK_TRIES = 5;
const tokenHash = (t) => createHash("sha256").update(`owner-link:${t}`).digest("hex");
const maskPhone = (p) => (p ? `+${p.slice(0, 2)} ${p.slice(2, 7)} •••••` : null);

export function createOwnerLink(clubId, userId, actorId) {
  const user = db.prepare("SELECT id, name, phone FROM users WHERE id = ?").get(userId);
  if (!user?.phone) throw new DomainError(400, "The owner needs a mobile number on PaceUp.");
  const club = db.prepare("SELECT name FROM clubs WHERE id = ?").get(clubId);
  const now = Date.now();
  // A new link replaces any earlier one for this club.
  db.prepare("UPDATE owner_links SET used_at = ? WHERE club_id = ? AND used_at IS NULL").run(new Date(now).toISOString(), clubId);
  const token = randomBytes(24).toString("base64url");
  db.prepare("INSERT INTO owner_links (id, club_id, user_id, token_hash, expires_at, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .run(randomUUID(), clubId, userId, tokenHash(token), new Date(now + OWNER_LINK_TTL_MS).toISOString(), actorId || null, new Date(now).toISOString());
  audit({ actorUserId: actorId || null, action: "club.owner_link", targetUserId: userId, newValue: club.name });
  const url = `${appUrl()}/start/${token}`;
  const first = user.name.split(" ")[0];
  const sender = (actorId && db.prepare("SELECT name FROM users WHERE id = ?").get(actorId)?.name?.split(" ")[0]) || "the PaceUp team";
  // The wording the Super Admin approved for the owner invite (sent by hand from their own WhatsApp).
  const text = `Hi ${first} 👋\n\nI've set up *${club.name}* on *PaceUp*, a simple way to run your club's activities right from WhatsApp.\n\n✅ Post an activity to your group in seconds\n✅ Members tap "I'm in", no app or sign-up\n✅ Live "who's going" list, updated in your group automatically\n\nYour private setup link (works once, valid 7 days):\n${url}\n\nOpen it, confirm the last 4 digits of your mobile, then link your club's WhatsApp number. It takes about 2 minutes.\n\nQuestions? Just reply here.\n\n– ${sender}, PaceUp\n\n🔒 _Your club's data stays private. Never shared._`;
  return { url, text, phone: user.phone, name: user.name, expires_at: new Date(now + OWNER_LINK_TTL_MS).toISOString() };
}

function activeOwnerLink(token) {
  if (typeof token !== "string" || token.length < 20) return null;
  const row = db.prepare(`SELECT ol.*, c.name AS club_name, u.name AS user_name, u.phone FROM owner_links ol
    INNER JOIN clubs c ON c.id = ol.club_id INNER JOIN users u ON u.id = ol.user_id WHERE ol.token_hash = ?`).get(tokenHash(token));
  if (!row || row.used_at || new Date(row.expires_at).getTime() <= Date.now() || row.attempts >= OWNER_LINK_TRIES) return null;
  return row;
}
const LINK_GONE = "This link has already been used or has expired. Ask the PaceUp team for a new one.";

export function checkOwnerLink(token) {
  const row = activeOwnerLink(token);
  if (!row) throw new DomainError(410, LINK_GONE);
  return { club_name: row.club_name, first_name: row.user_name.split(" ")[0], phone: maskPhone(row.phone) };
}

/** Confirms the last 4 digits and uses the link up. Returns the owner, who is then signed in. */
export function useOwnerLink(token, last4) {
  const result = db.transaction(() => {
    const row = activeOwnerLink(token);
    if (!row) return { error: [410, LINK_GONE] };
    if (String(last4 || "").replace(/\D/g, "") !== row.phone.slice(-4)) {
      db.prepare("UPDATE owner_links SET attempts = attempts + 1 WHERE id = ?").run(row.id);
      return { error: row.attempts + 1 >= OWNER_LINK_TRIES ? [410, LINK_GONE] : [400, "Those digits don't match the mobile number for this link."] };
    }
    const claimed = db.prepare("UPDATE owner_links SET used_at = @t, claimed_at = @t WHERE id = @id AND used_at IS NULL").run({ t: new Date().toISOString(), id: row.id }).changes === 1;
    if (!claimed) return { error: [410, LINK_GONE] };
    audit({ actorUserId: row.user_id, action: "club.owner_link_used", targetUserId: row.user_id, newValue: row.club_name });
    return { userId: row.user_id, clubId: row.club_id };
  }).immediate();
  if (result.error) throw new DomainError(...result.error);
  return { user: getUserById(result.userId), clubId: result.clubId };
}

/** The PaceUp Admin, or the club's owner: the club's number, name, groups, admins and message stats. */
export function isClubOwner(clubId, userId) {
  if (getPlatformRole(userId) === "super_admin") return true;
  return getClubMembership(clubId, userId)?.role === "owner";
}
export const clubOwnerId = (clubId) => db.prepare("SELECT user_id FROM club_memberships WHERE club_id = ? AND role = 'owner'").get(clubId)?.user_id || null;

/** Hands the club to another member: they become owner, the old owner stays on as a club admin. */
export function transferOwnership(clubId, userId, actorId) {
  const m = getClubMembership(clubId, userId);
  if (!m) throw new DomainError(400, "The new owner must be a member of the club.");
  if (m.role !== "owner") db.transaction(() => {
    db.prepare("UPDATE club_memberships SET role = 'admin' WHERE club_id = ? AND role = 'owner'").run(clubId);
    db.prepare("UPDATE club_memberships SET role = 'owner' WHERE club_id = ? AND user_id = ?").run(clubId, userId);
    db.prepare("UPDATE clubs SET number_owner_id = ? WHERE id = ?").run(userId, clubId);
  }).immediate();
  audit({ actorUserId: actorId, action: "club.owner_transfer", targetUserId: userId });
  return clubAdmins(clubId);
}
export function clubAdmins(clubId) {
  return {
    owner_id: clubOwnerId(clubId),
    admins: db.prepare("SELECT u.id, u.name, cm.role FROM club_memberships cm INNER JOIN users u ON u.id = cm.user_id WHERE cm.club_id = ? AND cm.role IN ('owner', 'admin') ORDER BY cm.role DESC, u.name").all(clubId)
  };
}

export function addClubAdmin(clubId, { phone, name }) { return addClubPerson(clubId, { phone, name, role: "admin" }).person; }

const appUrl = () => (process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/$/, "");
const ROLE_TEXT = { owner: "the club owner", admin: "a club admin", member: "a member" };

function welcomeText(clubId, userId, inviterId) {
  const club = db.prepare("SELECT name FROM clubs WHERE id = ?").get(clubId);
  const person = getUserById(userId);
  const role = getClubMembership(clubId, userId)?.role || "member";
  const inviter = inviterId && inviterId !== userId ? db.prepare("SELECT name FROM users WHERE id = ?").get(inviterId)?.name : null;
  return `Hi ${person.name.split(" ")[0]}! ${inviter ? `${inviter} added you` : "You've been added"} to *${club.name}* on PaceUp as ${ROLE_TEXT[role]}.\n\nSign in with this mobile number, no password needed: ${appUrl()}/\nYou'll get a WhatsApp code to confirm it's you.`;
}

/**
 * Sends the welcome message on WhatsApp from the club's own number. Returns
 * { sent, text, phone } so the page can offer a share link when WhatsApp isn't connected.
 */
export function sendWelcome(clubId, userId, inviterId) {
  const person = db.prepare("SELECT phone FROM users WHERE id = ?").get(userId);
  if (!person?.phone) throw new DomainError(400, "This person has no mobile number on PaceUp.");
  const text = welcomeText(clubId, userId, inviterId);
  const conn = db.prepare("SELECT 1 FROM whatsapp_connections WHERE club_id = ? AND status = 'connected' AND desired = 'on'").get(clubId);
  if (conn) {
    const now = Date.now();
    db.prepare("INSERT INTO whatsapp_direct (id, club_id, to_phone, text, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), clubId, person.phone, text, new Date(now + 24 * 3600 * 1000).toISOString(), new Date(now).toISOString());
  }
  return { sent: Boolean(conn), text, phone: person.phone };
}

/** Adds someone by mobile number (making an account if needed) and WhatsApps them a sign-in message. */
export function addClubPerson(clubId, { phone: rawPhone, name, role = "member" }, inviterId = null) {
  const phone = cleanPhone(rawPhone);
  if (!phone) throw new DomainError(400, "Enter the mobile number with the country code, e.g. +91 98765 43210.");
  if (!["admin", "member"].includes(role)) throw new DomainError(400, "Choose member or club admin.");
  if (role === "admin" && inviterId && !isClubOwner(clubId, inviterId)) throw new DomainError(403, OWNER_ONLY);
  const userId = db.transaction(() => {
    const id = findOrCreatePhoneUser(phone, name);
    setRole(clubId, id, role);
    return id;
  }).immediate();
  return { person: getUserById(userId), whatsapp: sendWelcome(clubId, userId, inviterId) };
}

const OWNER_ONLY = "Only the club owner can add or remove club admins.";
export function removeClubPerson(clubId, userId, actorId) {
  const m = getClubMembership(clubId, userId);
  if (!m) throw new DomainError(404, "Not a member of this club.");
  if (m.role === "owner") throw new DomainError(409, "The club owner can't be removed. Hand the club to someone else first.");
  if (m.role === "admin" && !isClubOwner(clubId, actorId)) throw new DomainError(403, OWNER_ONLY);
  if (userId === actorId) throw new DomainError(409, "You can't remove yourself.");
  db.prepare("DELETE FROM club_memberships WHERE club_id = ? AND user_id = ?").run(clubId, userId);
}

/** Makes an existing member a club admin, or an admin a member again. */
export function changeClubRole(clubId, userId, role, actorId) {
  if (!["admin", "member"].includes(role)) throw new DomainError(400, "Choose member or club admin.");
  const m = getClubMembership(clubId, userId);
  if (!m) throw new DomainError(404, "Not a member of this club.");
  if (m.role === "owner") throw new DomainError(409, "The club owner's role can't be changed. Hand the club to someone else instead.");
  if (!isClubOwner(clubId, actorId)) throw new DomainError(403, OWNER_ONLY);
  if (userId === actorId) throw new DomainError(409, "You can't change your own role.");
  db.prepare("UPDATE club_memberships SET role = ? WHERE club_id = ? AND user_id = ?").run(role, clubId, userId);
  return { id: userId, role };
}

/** A new phone account joins, as a member, every club whose member list has its number. */
export function joinClubsByPhone(userId, phone) {
  const clubs = db.prepare("SELECT DISTINCT club_id FROM club_roster WHERE phone = ?").all(phone);
  for (const { club_id } of clubs) if (!getClubMembership(club_id, userId)) setRole(club_id, userId, "member");
  return clubs.length;
}

/** The name a club list already has for this number, to pre-fill sign-up. */
export const rosterNameFor = (phone) => db.prepare("SELECT name FROM club_roster WHERE phone = ? ORDER BY updated_at DESC LIMIT 1").get(phone)?.name || null;

export function registerClubAdminRoutes(app, { requireClubRole, requireClubOwner, requirePlatformAdmin }) {
  const fail = (reply, error) => { if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message }); throw error; };
  const str = (n) => ({ type: "string", maxLength: n });
  app.post("/api/platform/clubs", {
    preHandler: [app.authenticate, requirePlatformAdmin],
    schema: { body: { type: "object", properties: { name: str(200), adminPhone: str(30), adminName: str(200), city: str(80), activity: str(80), directoryId: str(64) }, required: ["name"] } }
  }, async (req, reply) => {
    try { return reply.code(201).send(createClub({ ...req.body, actorId: req.user.sub })); } catch (error) { return fail(reply, error); }
  });
  const clubParams = { type: "object", properties: { clubId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } }, required: ["clubId"] };
  // A fresh owner link (the old one stops working), e.g. when the first was lost or expired.
  app.post("/api/platform/clubs/:clubId/owner-link", { preHandler: [app.authenticate, requirePlatformAdmin], schema: { params: clubParams } }, async (req, reply) => {
    try {
      const owner = db.prepare("SELECT user_id FROM club_memberships WHERE club_id = ? AND role = 'owner' ORDER BY created_at LIMIT 1").get(req.params.clubId);
      if (!owner) throw new DomainError(404, "This club has no owner.");
      return reply.code(201).send({ owner_link: createOwnerLink(req.params.clubId, owner.user_id, req.user.sub) });
    } catch (error) { return fail(reply, error); }
  });
  app.get("/api/platform/clubs/:clubId/admins", { preHandler: [app.authenticate, requirePlatformAdmin], schema: { params: clubParams } }, async (req) => clubAdmins(req.params.clubId));
  // The owner, or the PaceUp Admin, hands the club to another member.
  app.put("/api/clubs/:clubId/owner", {
    preHandler: [app.authenticate, requireClubOwner],
    schema: { params: clubParams, body: { type: "object", properties: { userId: { type: "string", maxLength: 36 } }, required: ["userId"] } }
  }, async (req, reply) => { try { return transferOwnership(req.params.clubId, req.body.userId, req.user.sub); } catch (error) { return fail(reply, error); } });
  app.post("/api/clubs/:clubId/people", {
    preHandler: [app.authenticate, requireClubRole(["owner", "admin"])],
    schema: { body: { type: "object", properties: { phone: str(30), name: str(200), role: { type: "string", enum: ["member", "admin"] } }, required: ["phone"] } }
  }, async (req, reply) => {
    try { return reply.code(201).send(addClubPerson(req.params.clubId, req.body, req.user.sub)); } catch (error) { return fail(reply, error); }
  });
  app.post("/api/clubs/:clubId/members/:userId/welcome", { preHandler: [app.authenticate, requireClubRole(["owner", "admin"])] }, async (req, reply) => {
    try {
      if (!getClubMembership(req.params.clubId, req.params.userId)) throw new DomainError(404, "Not a member of this club.");
      return { whatsapp: sendWelcome(req.params.clubId, req.params.userId, req.user.sub) };
    } catch (error) { return fail(reply, error); }
  });
  app.delete("/api/clubs/:clubId/members/:userId", { preHandler: [app.authenticate, requireClubRole(["owner", "admin"])] }, async (req, reply) => {
    try { removeClubPerson(req.params.clubId, req.params.userId, req.user.sub); return { ok: true }; } catch (error) { return fail(reply, error); }
  });
  app.patch("/api/clubs/:clubId/members/:userId/role", {
    preHandler: [app.authenticate, requireClubRole(["owner", "admin"])],
    schema: { body: { type: "object", properties: { role: { type: "string", enum: ["member", "admin"] } }, required: ["role"] } }
  }, async (req, reply) => {
    try { return { member: changeClubRole(req.params.clubId, req.params.userId, req.body.role, req.user.sub) }; } catch (error) { return fail(reply, error); }
  });
  app.post("/api/clubs/:clubId/admins", {
    preHandler: [app.authenticate, requireClubOwner],
    schema: { body: { type: "object", properties: { phone: str(30), name: str(200) }, required: ["phone"] } }
  }, async (req, reply) => {
    try { return reply.code(201).send({ admin: addClubAdmin(req.params.clubId, req.body) }); } catch (error) { return fail(reply, error); }
  });
}
