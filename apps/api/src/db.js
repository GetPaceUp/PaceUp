import Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { runMigrations } from "./migrations.js";

const configuredPath = process.env.DATABASE_URL || "file:./data/paceup.sqlite";
const databasePath = configuredPath.startsWith("file:") ? configuredPath.slice(5) : configuredPath;
if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });

export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");
db.pragma("busy_timeout = 5000");

runMigrations(db, { databasePath, log: (message) => console.log(`[migrate] ${message}`) });

const nowIso = () => new Date().toISOString();

/** Domain error carrying an HTTP status, thrown from transactions. */
export class DomainError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

// ---------------------------------------------------------------- audit

const insertAudit = db.prepare(`
  INSERT INTO platform_audit_log (id, actor_user_id, action, target_user_id, old_value, new_value, ip, created_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`);
export function audit({ actorUserId = null, action, targetUserId = null, oldValue = null, newValue = null, ip = null }) {
  insertAudit.run(randomUUID(), actorUserId, action, targetUserId, oldValue, newValue, ip, nowIso());
}
export function listPlatformAudit(limit = 100) {
  return db.prepare(`
    SELECT a.id, a.action, a.old_value, a.new_value, a.created_at,
           actor.name AS actor_name, actor.email AS actor_email,
           target.name AS target_name, target.email AS target_email
    FROM platform_audit_log a
    LEFT JOIN users actor ON actor.id = a.actor_user_id
    LEFT JOIN users target ON target.id = a.target_user_id
    ORDER BY a.created_at DESC, a.rowid DESC LIMIT ?
  `).all(limit);
}

// ---------------------------------------------------------------- platform owner bootstrap

const ownerEmail = process.env.PACEUP_SUPERADMIN_EMAIL?.trim().toLowerCase();
/**
 * Grants Super Admin to the configured platform owner. Runs at startup and on each
 * sign-in/sign-up, so the owner gets access even if they register after the API started.
 */
export function applyOwnerBootstrap(email = ownerEmail) {
  if (!ownerEmail || email?.toLowerCase() !== ownerEmail) return;
  db.transaction(() => {
    const user = db.prepare("SELECT id, platform_role FROM users WHERE email = ? COLLATE NOCASE").get(ownerEmail);
    if (user && user.platform_role !== "super_admin") {
      db.prepare("UPDATE users SET platform_role = 'super_admin' WHERE id = ?").run(user.id);
      audit({ action: "platform_role.bootstrap", targetUserId: user.id, oldValue: user.platform_role, newValue: "super_admin" });
    }
  }).immediate();
}
applyOwnerBootstrap();

// ---------------------------------------------------------------- users and clubs

const insertUser = db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)");
export const PHONE_EMAIL_DOMAIN = "phone.paceup.invalid";
const SAFE_USER = `id, name, CASE WHEN email LIKE '%@${PHONE_EMAIL_DOMAIN}' THEN NULL ELSE email END AS email, phone`;
const selectSafeUser = db.prepare(`SELECT ${SAFE_USER} FROM users WHERE id = ?`);

const createAccountAndClub = db.transaction(({ user, club, membership }) => {
  insertUser.run(user.id, user.name, user.email, user.passwordHash);
  db.prepare("INSERT INTO clubs (id, name, slug) VALUES (?, ?, ?)").run(club.id, club.name, club.slug);
  db.prepare("INSERT INTO club_memberships (id, club_id, user_id, role) VALUES (?, ?, ?, 'owner')").run(membership.id, club.id, user.id);
  return {
    user: selectSafeUser.get(user.id),
    club: db.prepare("SELECT id, name, slug, created_at FROM clubs WHERE id = ?").get(club.id)
  };
});
export function registerAccount(data) { return createAccountAndClub.immediate(data); }
/** An account with no club yet: clubs are created by the platform owner, and people join by invitation or a club list. */
export function createUser(user) { insertUser.run(user.id, user.name, user.email, user.passwordHash); return selectSafeUser.get(user.id); }
export function findUserByEmail(email) { return db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email); }
export function getUserById(id) { return selectSafeUser.get(id); }
export function listClubsForUser(userId) {
  return db.prepare(`
    SELECT c.id, c.name, c.slug, cm.role, c.created_at
    FROM clubs c INNER JOIN club_memberships cm ON cm.club_id = c.id
    WHERE cm.user_id = ? ORDER BY c.created_at DESC
  `).all(userId);
}
export function getClubMembership(clubId, userId) {
  return db.prepare(`
    SELECT cm.role, c.id, c.name, c.slug FROM club_memberships cm
    INNER JOIN clubs c ON c.id = cm.club_id WHERE cm.club_id = ? AND cm.user_id = ?
  `).get(clubId, userId);
}
export function updateClub(clubId, name, slug) {
  db.prepare("UPDATE clubs SET name = ?, slug = ? WHERE id = ?").run(name, slug, clubId);
  return db.prepare("SELECT id, name, slug, created_at FROM clubs WHERE id = ?").get(clubId);
}
export function listClubMembers(clubId) {
  return db.prepare(`
    SELECT u.id, u.name, CASE WHEN u.email LIKE '%@${PHONE_EMAIL_DOMAIN}' THEN NULL ELSE u.email END AS email, u.phone, cm.role, cm.created_at AS joined_at
    FROM club_memberships cm INNER JOIN users u ON u.id = cm.user_id
    WHERE cm.club_id = ? ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name
  `).all(clubId);
}

// ---------------------------------------------------------------- invitations

export function listClubInvitations(clubId) {
  return db.prepare(`
    SELECT id, email, role, expires_at, accepted_at, created_at
    FROM club_invitations WHERE club_id = ? ORDER BY created_at DESC
  `).all(clubId);
}
export function createClubInvitation(invitation) {
  db.prepare(`
    INSERT INTO club_invitations (id, club_id, email, role, token_hash, invited_by, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(invitation.id, invitation.clubId, invitation.email, invitation.role, invitation.tokenHash, invitation.invitedBy, invitation.expiresAt);
}
export function findInvitation(tokenHash) {
  return db.prepare(`
    SELECT i.*, c.name AS club_name FROM club_invitations i
    INNER JOIN clubs c ON c.id = i.club_id WHERE i.token_hash = ?
  `).get(tokenHash);
}

const INVITE_GONE = "This invitation has expired or has already been used.";

/**
 * Claims an invitation and creates the membership in one write transaction.
 * The claim is a conditional UPDATE (unused and unexpired at the moment of the
 * write), so two simultaneous acceptances, even from separate processes, can
 * never both succeed: exactly one UPDATE changes a row.
 */
function claimInvitationAndJoin(tokenHash, userId) {
  const now = nowIso();
  const invitation = db.prepare("SELECT * FROM club_invitations WHERE token_hash = ?").get(tokenHash);
  if (!invitation) throw new DomainError(410, INVITE_GONE);
  const user = db.prepare("SELECT id, email FROM users WHERE id = ?").get(userId);
  // Invites without an email go to whoever holds the link; phone-only accounts have no email to match.
  const phoneOnly = user?.email.endsWith(`@${PHONE_EMAIL_DOMAIN}`);
  if (!user || (invitation.email && !phoneOnly && user.email.toLowerCase() !== invitation.email.toLowerCase())) {
    throw new DomainError(403, "Sign in with the email address this invitation was sent to.");
  }
  const claimed = db.prepare(`
    UPDATE club_invitations SET accepted_at = ?, accepted_by = ?
    WHERE id = ? AND accepted_at IS NULL AND expires_at > ?
  `).run(now, userId, invitation.id, now);
  if (claimed.changes !== 1) throw new DomainError(410, INVITE_GONE);
  if (db.prepare("SELECT 1 FROM club_memberships WHERE club_id = ? AND user_id = ?").get(invitation.club_id, userId)) {
    throw new DomainError(409, "You're already a member of this club.");
  }
  db.prepare("INSERT INTO club_memberships (id, club_id, user_id, role) VALUES (?, ?, ?, ?)")
    .run(randomUUID(), invitation.club_id, userId, invitation.role);
  return invitation;
}

const acceptInvitationTx = db.transaction(claimInvitationAndJoin);
export function acceptInvitation(tokenHash, userId) { return acceptInvitationTx.immediate(tokenHash, userId); }

const registerWithInvitationTx = db.transaction((tokenHash, user) => {
  insertUser.run(user.id, user.name, user.email, user.passwordHash);
  claimInvitationAndJoin(tokenHash, user.id);
  return selectSafeUser.get(user.id);
});
/** Creates the account and joins the inviting club atomically: both happen or neither does. */
export function registerWithInvitation(tokenHash, user) { return registerWithInvitationTx.immediate(tokenHash, user); }

// ---------------------------------------------------------------- sessions

export function createSession(userId, ttlMs) {
  const id = randomUUID();
  const created = new Date();
  const expiresAt = new Date(created.getTime() + ttlMs).toISOString();
  db.prepare("INSERT INTO sessions (id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(id, userId, created.toISOString(), expiresAt);
  return { id, expiresAt };
}
export function getActiveSession(sessionId, userId) {
  return db.prepare(`
    SELECT id, user_id, expires_at FROM sessions
    WHERE id = ? AND user_id = ? AND revoked_at IS NULL AND expires_at > ?
  `).get(sessionId, userId, nowIso());
}
export function revokeSession(sessionId) {
  db.prepare("UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(nowIso(), sessionId);
}
export function revokeAllSessions(userId) {
  return db.prepare("UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL").run(nowIso(), userId).changes;
}
export function purgeExpiredSessions() {
  // Keep a week of history after expiry/revocation, then drop the row.
  const cutoff = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare("DELETE FROM sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)").run(cutoff, cutoff).changes;
}

// ---------------------------------------------------------------- platform roles

export function getPlatformRole(userId) { return db.prepare("SELECT platform_role FROM users WHERE id = ?").get(userId)?.platform_role || "user"; }
export function getPlatformOverview() {
  return {
    counts: { clubs: db.prepare("SELECT COUNT(*) AS count FROM clubs").get().count, users: db.prepare("SELECT COUNT(*) AS count FROM users").get().count, memberships: db.prepare("SELECT COUNT(*) AS count FROM club_memberships").get().count },
    clubs: db.prepare(`SELECT c.id,c.name,c.slug,c.city,c.activity,c.created_at,
        (SELECT COUNT(*) FROM club_memberships cm WHERE cm.club_id=c.id) AS member_count,
        (SELECT u.name FROM club_memberships cm INNER JOIN users u ON u.id=cm.user_id WHERE cm.club_id=c.id AND cm.role='owner' ORDER BY cm.created_at LIMIT 1) AS owner_name,
        (SELECT u.name FROM users u WHERE u.id=c.number_owner_id) AS number_owner_name,
        wc.status AS wa_status, wc.desired AS wa_desired,
        (SELECT MAX(created_at) FROM owner_links ol WHERE ol.club_id=c.id) AS owner_link_at,
        (SELECT MAX(claimed_at) FROM owner_links ol WHERE ol.club_id=c.id) AS owner_signed_in_at
      FROM clubs c LEFT JOIN whatsapp_connections wc ON wc.club_id=c.id ORDER BY c.created_at DESC`).all(),
    users: db.prepare(`SELECT u.id,u.name,CASE WHEN u.email LIKE '%@${PHONE_EMAIL_DOMAIN}' THEN NULL ELSE u.email END AS email,u.phone,u.platform_role,u.created_at,COUNT(cm.club_id) AS club_count FROM users u LEFT JOIN club_memberships cm ON cm.user_id=u.id GROUP BY u.id ORDER BY u.created_at DESC`).all()
  };
}

const setPlatformRoleTx = db.transaction(({ actorUserId, targetUserId, role, ip }) => {
  // Re-check the actor inside the write lock: a Super Admin demoted a moment ago
  // must not be able to complete a change that was already in flight.
  const actor = db.prepare("SELECT platform_role FROM users WHERE id = ?").get(actorUserId);
  if (actor?.platform_role !== "super_admin") throw new DomainError(403, "Platform owner access required.");
  const target = db.prepare("SELECT id, platform_role FROM users WHERE id = ?").get(targetUserId);
  if (!target) throw new DomainError(404, "User not found.");
  if (target.platform_role !== role) {
    if (target.platform_role === "super_admin") {
      const remaining = db.prepare("SELECT COUNT(*) AS n FROM users WHERE platform_role = 'super_admin'").get().n;
      if (remaining <= 1) throw new DomainError(409, "PaceUp must always have at least one Super Admin. Promote someone else first.");
    }
    db.prepare("UPDATE users SET platform_role = ? WHERE id = ?").run(role, targetUserId);
    audit({ actorUserId, action: role === "super_admin" ? "platform_role.promote" : "platform_role.demote", targetUserId, oldValue: target.platform_role, newValue: role, ip });
  }
  return db.prepare(`SELECT ${SAFE_USER}, platform_role FROM users WHERE id = ?`).get(targetUserId);
});
export function changePlatformRole(input) { return setPlatformRoleTx.immediate(input); }
