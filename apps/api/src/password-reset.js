// Password reset without email: a club admin (for members of their club) or a
// Super Admin (for anyone) creates a one-time link and shares it with the person,
// typically over WhatsApp. Links work once, expire after 24 hours, and using one
// ends every other session of that account.
import { randomUUID, randomBytes, createHash } from "node:crypto";
import bcrypt from "bcryptjs";
import { db, DomainError, audit, getClubMembership, getPlatformRole, revokeAllSessions, getUserById } from "./db.js";

const TTL_MS = 24 * 60 * 60 * 1000;
const hash = (token) => createHash("sha256").update(token).digest("hex");
const nowIso = () => new Date().toISOString();

/**
 * Who may reset whom. Club owners and admins may reset plain members of their own
 * club, but never someone who is an owner/admin of any club or a Super Admin:
 * otherwise an admin of one club could take over another club's owner account.
 * Those accounts are reset by a Super Admin.
 */
function assertMayReset(actorId, targetId, clubId) {
  if (actorId === targetId) throw new DomainError(400, "Use your own password settings instead.");
  const target = getUserById(targetId);
  if (!target) throw new DomainError(404, "Member not found.");
  if (getPlatformRole(actorId) === "super_admin") return target;
  if (!clubId) throw new DomainError(403, "Only the PaceUp Admin can do this.");
  const actor = getClubMembership(clubId, actorId);
  const member = getClubMembership(clubId, targetId);
  if (!actor || !["owner", "admin"].includes(actor.role) || !member) throw new DomainError(404, "Member not found.");
  const elevated = db.prepare("SELECT 1 FROM club_memberships WHERE user_id = ? AND role IN ('owner', 'admin')").get(targetId);
  if (elevated || getPlatformRole(targetId) === "super_admin") {
    throw new DomainError(403, "Club admins and owners can only have their password reset by the PaceUp platform owner.");
  }
  return target;
}

export function createPasswordReset({ actorId, targetId, clubId = null, ip = null }) {
  return db.transaction(() => {
    const target = assertMayReset(actorId, targetId, clubId);
    // Only the newest link works.
    db.prepare("UPDATE password_resets SET used_at = ? WHERE user_id = ? AND used_at IS NULL").run(nowIso(), targetId);
    const token = randomBytes(32).toString("base64url");
    const expiresAt = new Date(Date.now() + TTL_MS).toISOString();
    db.prepare("INSERT INTO password_resets (id, user_id, token_hash, created_by, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), targetId, hash(token), actorId, expiresAt, nowIso());
    audit({ actorUserId: actorId, action: "password_reset.created", targetUserId: targetId, ip });
    const base = (process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/$/, "");
    return { name: target.name, resetUrl: `${base}/reset/${token}`, expiresAt };
  }).immediate();
}

function findActive(token) {
  return db.prepare(`
    SELECT pr.id, pr.user_id, u.name, u.email FROM password_resets pr INNER JOIN users u ON u.id = pr.user_id
    WHERE pr.token_hash = ? AND pr.used_at IS NULL AND pr.expires_at > ?
  `).get(hash(token), nowIso());
}

export function checkPasswordReset(token) {
  const row = findActive(token);
  if (!row) throw new DomainError(410, "This reset link has expired or was already used. Ask your club admin for a new one.");
  const [local, domain] = row.email.split("@");
  return { name: row.name, email: `${local.slice(0, 2)}${"•".repeat(Math.max(1, local.length - 2))}@${domain}` };
}

export async function usePasswordReset(token, password, ip = null) {
  if (typeof password !== "string" || password.length < 10 || password.length > 128) throw new DomainError(400, "Use a password between 10 and 128 characters.");
  if (!findActive(token)) throw new DomainError(410, "This reset link has expired or was already used. Ask your club admin for a new one.");
  const passwordHash = await bcrypt.hash(password, 12);
  return db.transaction(() => {
    // Claim the link with a conditional write so it can only ever be used once.
    const now = nowIso();
    const row = db.prepare("SELECT id, user_id FROM password_resets WHERE token_hash = ?").get(hash(token));
    const claimed = row && db.prepare("UPDATE password_resets SET used_at = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?").run(now, row.id, now).changes === 1;
    if (!claimed) throw new DomainError(410, "This reset link has expired or was already used. Ask your club admin for a new one.");
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, row.user_id);
    revokeAllSessions(row.user_id);
    audit({ actorUserId: row.user_id, action: "password_reset.used", targetUserId: row.user_id, ip });
    return getUserById(row.user_id);
  }).immediate();
}
