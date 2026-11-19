// Mobile sign-in: a 6-digit code sent on WhatsApp from a connected club number.
// No email needed. Codes live 5 minutes, allow 5 tries, and only a hash is stored.
// Existing email accounts keep working and can attach a phone the same way.
import { randomUUID, randomInt, createHash, timingSafeEqual } from "node:crypto";
import { db, DomainError, PHONE_EMAIL_DOMAIN, registerWithInvitation, getUserById, listClubsForUser } from "./db.js";
import { cleanPhone } from "./roster.js";
import { joinClubsByPhone, rosterNameFor } from "./clubs-admin.js";

const CODE_TTL_MS = 5 * 60 * 1000;
const MAX_TRIES = 5;
const RESEND_GAP_MS = 30 * 1000;
const PER_PHONE_15_MIN = 3;
const PER_PHONE_DAY = 10;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const secret = () => process.env.APP_SECRET || "paceup-local-development-secret-change-before-deployment";
const codeHash = (phone, code) => createHash("sha256").update(`${secret()}:otp:${phone}:${code}`).digest();

export function normalizePhone(raw) {
  const phone = cleanPhone(raw);
  if (!phone) throw new DomainError(400, "Enter your mobile number with the country code, e.g. +91 98765 43210.");
  return phone;
}

/** The connected WhatsApp number to send from: one of the person's own clubs if possible. */
function senderClub(phone) {
  return db.prepare(`
    SELECT wc.club_id FROM whatsapp_connections wc
    WHERE wc.status = 'connected' AND wc.desired = 'on'
    ORDER BY EXISTS (SELECT 1 FROM club_memberships cm INNER JOIN users u ON u.id = cm.user_id WHERE cm.club_id = wc.club_id AND u.phone = ?) DESC,
             wc.last_seen_at DESC
    LIMIT 1
  `).get(phone)?.club_id;
}

export function startCode(phone, { purpose = "login", userId = null, ip = null } = {}) {
  return db.transaction(() => {
    const recent = db.prepare("SELECT created_at FROM login_codes WHERE phone = ? AND created_at > ? ORDER BY created_at DESC").all(phone, iso(Date.now() - 24 * 60 * 60 * 1000));
    if (recent[0] && Date.now() - new Date(recent[0].created_at).getTime() < RESEND_GAP_MS) throw new DomainError(429, "We just sent a code. Wait 30 seconds before asking for another.");
    if (recent.filter((r) => Date.now() - new Date(r.created_at).getTime() < 15 * 60 * 1000).length >= PER_PHONE_15_MIN || recent.length >= PER_PHONE_DAY) {
      throw new DomainError(429, "Too many codes for this number. Please wait 15 minutes and try again.");
    }
    const club = senderClub(phone);
    if (!club) throw new DomainError(503, "WhatsApp codes aren't available right now. Please try again shortly, or sign in with email.");
    const code = String(randomInt(0, 1000000)).padStart(6, "0");
    const now = Date.now();
    // A new code replaces any earlier one for this number.
    db.prepare("UPDATE login_codes SET used_at = ? WHERE phone = ? AND used_at IS NULL").run(iso(now), phone);
    db.prepare("INSERT INTO login_codes (id, phone, code_hash, purpose, user_id, expires_at, ip, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), phone, codeHash(phone, code).toString("hex"), purpose, userId, iso(now + CODE_TTL_MS), ip, iso(now));
    db.prepare("INSERT INTO whatsapp_direct (id, club_id, to_phone, text, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), club, phone, `*${code}* is your PaceUp code. It expires in 5 minutes. Never share it with anyone.`, iso(now + CODE_TTL_MS), iso(now));
    return { sent: true, expires_in: CODE_TTL_MS / 1000 };
  }).immediate();
}

/** Checks a code. consume=false leaves it usable (for the sign-up step that follows). */
function checkCode(phone, code, purpose, { consume = true, userId = null } = {}) {
  // The attempt is counted in a committed write before any error is thrown,
  // otherwise the rollback would hand out unlimited guesses.
  const result = db.transaction(() => {
    const row = db.prepare("SELECT * FROM login_codes WHERE phone = ? AND purpose = ? AND used_at IS NULL AND expires_at > ? ORDER BY created_at DESC LIMIT 1").get(phone, purpose, iso());
    if (!row || row.attempts >= MAX_TRIES || (userId && row.user_id !== userId)) return { error: "That code has expired. Ask for a new one." };
    db.prepare("UPDATE login_codes SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    const ok = /^\d{6}$/.test(code) && timingSafeEqual(Buffer.from(row.code_hash, "hex"), codeHash(phone, code));
    if (!ok) return { error: row.attempts + 1 >= MAX_TRIES ? "Wrong code. Ask for a new one." : "That code isn't right. Check WhatsApp and try again." };
    if (consume) db.prepare("UPDATE login_codes SET used_at = ? WHERE id = ?").run(iso(), row.id);
    return { row };
  }).immediate();
  if (result.error) throw new DomainError(400, result.error);
  return result.row;
}

const placeholderEmail = (phone) => `${phone}@${PHONE_EMAIL_DOMAIN}`;

/**
 * Signs in by phone, or signs up when the number is new and a name is given.
 * Returns { user } or { needs_signup: true } (the code stays valid for that step).
 */
export function verifyLogin({ phone, code, name, inviteToken, hashToken }) {
  const existing = db.prepare("SELECT id FROM users WHERE phone = ?").get(phone);
  const cleanName = typeof name === "string" ? name.trim().replace(/\s+/g, " ") : "";
  const signingUp = !existing && cleanName;
  // A sign-up uses the code up only once the account exists, so a taken club name can be fixed and retried.
  checkCode(phone, code, "login", { consume: Boolean(existing) });
  if (existing) return { user: getUserById(existing.id) };
  if (!signingUp) return { needs_signup: true, name_hint: rosterNameFor(phone) };
  if (cleanName.length < 2 || cleanName.length > 80) throw new DomainError(400, "Enter your name (2–80 characters).");
  const user = { id: randomUUID(), name: cleanName, email: placeholderEmail(phone), passwordHash: "!" };
  return db.transaction(() => createPhoneAccount({ phone, user, inviteToken, hashToken })).immediate();
}

// No club is created here: clubs come from the platform owner. A new account joins
// by invitation, or automatically joins the clubs whose member list has its number.
function createPhoneAccount({ phone, user, inviteToken, hashToken }) {
  if (db.prepare("SELECT 1 FROM users WHERE phone = ?").get(phone)) throw new DomainError(409, "This number already has an account. Sign in instead.");
  let created;
  if (inviteToken) created = registerWithInvitation(hashToken(inviteToken), user);
  else {
    db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)").run(user.id, user.name, user.email, user.passwordHash);
    created = getUserById(user.id);
  }
  db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone, created.id);
  joinClubsByPhone(created.id, phone);
  db.prepare("UPDATE login_codes SET used_at = ? WHERE phone = ? AND used_at IS NULL").run(iso(), phone);
  return { user: getUserById(created.id), created: true };
}

const RANK = { member: 1, admin: 2, owner: 3 };

/**
 * An admin may have invited this number before its owner added it to their email
 * account, which made a phone-only account for it. Proving the number with a code
 * folds that account into this one: clubs, RSVPs and activities move over.
 */
function absorbPhoneOnlyAccount(fromId, intoId) {
  for (const m of db.prepare("SELECT * FROM club_memberships WHERE user_id = ?").all(fromId)) {
    const mine = db.prepare("SELECT * FROM club_memberships WHERE club_id = ? AND user_id = ?").get(m.club_id, intoId);
    if (!mine) db.prepare("UPDATE club_memberships SET user_id = ? WHERE id = ?").run(intoId, m.id);
    else if (RANK[m.role] > RANK[mine.role]) db.prepare("UPDATE club_memberships SET role = ? WHERE id = ?").run(m.role, mine.id);
  }
  db.prepare("UPDATE OR IGNORE ride_rsvps SET user_id = ? WHERE user_id = ?").run(intoId, fromId);
  db.prepare("DELETE FROM ride_rsvps WHERE user_id = ?").run(fromId); // already going under the email account
  for (const [table, col] of [["rides", "organiser_id"], ["rides", "created_by"], ["club_invitations", "invited_by"], ["club_invitations", "accepted_by"], ["activity_templates", "created_by"]]) {
    db.prepare(`UPDATE ${table} SET ${col} = ? WHERE ${col} = ?`).run(intoId, fromId);
  }
  db.prepare("DELETE FROM users WHERE id = ?").run(fromId); // sessions and codes cascade
}

export function attachPhone(userId, phone, code) {
  checkCode(phone, code, "attach", { userId });
  db.transaction(() => {
    const taken = db.prepare("SELECT id, email, password_hash FROM users WHERE phone = ? AND id != ?").get(phone, userId);
    if (taken) {
      if (taken.password_hash !== "!" || !taken.email.endsWith(`@${PHONE_EMAIL_DOMAIN}`)) throw new DomainError(409, "This number is already used by another PaceUp account.");
      absorbPhoneOnlyAccount(taken.id, userId);
    }
    db.prepare("UPDATE users SET phone = ? WHERE id = ?").run(phone, userId);
  }).immediate();
  return getUserById(userId);
}

export function registerOtpRoutes(app, { setSession, makeSlug, hashToken, limit = (n) => ({}) }) {
  const domain = (reply, error) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message });
    throw error;
  };
  const phoneBody = { type: "object", properties: { phone: { type: "string", maxLength: 30 } }, required: ["phone"] };
  const code = { type: "string", maxLength: 10 };

  app.post("/api/auth/otp/start", { config: limit(10), schema: { body: phoneBody } }, async (req, reply) => {
    try { return startCode(normalizePhone(req.body.phone), { ip: req.ip }); } catch (error) { return domain(reply, error); }
  });

  app.post("/api/auth/otp/verify", {
    config: limit(30),
    schema: { body: { type: "object", properties: { phone: { type: "string", maxLength: 30 }, code, name: { type: "string", maxLength: 200 }, inviteToken: { type: "string", maxLength: 200 } }, required: ["phone", "code"] } }
  }, async (req, reply) => {
    try {
      const phone = normalizePhone(req.body.phone);
      const result = verifyLogin({ phone, code: String(req.body.code).trim(), name: req.body.name, inviteToken: req.body.inviteToken, hashToken });
      if (result.needs_signup) return { needs_signup: true, name_hint: result.name_hint };
      setSession(reply, result.user);
      return reply.code(result.created ? 201 : 200).send({ user: result.user, clubs: listClubsForUser(result.user.id) });
    } catch (error) { return domain(reply, error); }
  });

  // Signed-in (e.g. email) accounts add a mobile number so they can sign in with it.
  app.post("/api/auth/phone/start", { config: limit(10), schema: { body: phoneBody }, preHandler: [app.authenticate] }, async (req, reply) => {
    try {
      const phone = normalizePhone(req.body.phone);
      if (db.prepare("SELECT 1 FROM users WHERE phone = ? AND id != ?").get(phone, req.user.sub)) throw new DomainError(409, "This number is already used by another PaceUp account.");
      return startCode(phone, { purpose: "attach", userId: req.user.sub, ip: req.ip });
    } catch (error) { return domain(reply, error); }
  });
  app.post("/api/auth/phone/verify", {
    config: limit(30), schema: { body: { type: "object", properties: { phone: { type: "string", maxLength: 30 }, code }, required: ["phone", "code"] } }, preHandler: [app.authenticate]
  }, async (req, reply) => {
    try { return { user: attachPhone(req.user.sub, normalizePhone(req.body.phone), String(req.body.code).trim()) }; }
    catch (error) { return domain(reply, error); }
  });
}
