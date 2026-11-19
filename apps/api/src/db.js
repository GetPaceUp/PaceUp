import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const configuredPath = process.env.DATABASE_URL || "file:./data/paceup.sqlite";
const databasePath = configuredPath.startsWith("file:") ? configuredPath.slice(5) : configuredPath;
if (databasePath !== ":memory:") mkdirSync(dirname(resolve(databasePath)), { recursive: true });

export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS clubs (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS club_memberships (
    id TEXT PRIMARY KEY, club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (club_id, user_id)
  );
  CREATE INDEX IF NOT EXISTS idx_memberships_user ON club_memberships(user_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_club ON club_memberships(club_id);
  CREATE TABLE IF NOT EXISTS club_invitations (
    id TEXT PRIMARY KEY, club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL CHECK (role IN ('admin', 'member')),
    token_hash TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL REFERENCES users(id),
    expires_at TEXT NOT NULL, accepted_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_invitations_club ON club_invitations(club_id);
`);

const createAccountAndClub = db.transaction(({ user, club, membership }) => {
  db.prepare("INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)").run(user.id, user.name, user.email, user.passwordHash);
  db.prepare("INSERT INTO clubs (id, name, slug) VALUES (?, ?, ?)").run(club.id, club.name, club.slug);
  db.prepare("INSERT INTO club_memberships (id, club_id, user_id, role) VALUES (?, ?, ?, 'owner')").run(membership.id, club.id, user.id);
  return {
    user: db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(user.id),
    club: db.prepare("SELECT id, name, slug, created_at FROM clubs WHERE id = ?").get(club.id)
  };
});
export function registerAccount(data) { return createAccountAndClub(data); }
export function findUserByEmail(email) { return db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email); }
export function getUserById(id) { return db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(id); }
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
    SELECT u.id, u.name, u.email, cm.role, cm.created_at AS joined_at
    FROM club_memberships cm INNER JOIN users u ON u.id = cm.user_id
    WHERE cm.club_id = ? ORDER BY CASE cm.role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, u.name
  `).all(clubId);
}
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
const acceptInviteTransaction = db.transaction(({ invitation, userId }) => {
  db.prepare("INSERT INTO club_memberships (id, club_id, user_id, role) VALUES (?, ?, ?, ?)").run(crypto.randomUUID(), invitation.club_id, userId, invitation.role);
  db.prepare("UPDATE club_invitations SET accepted_at = datetime('now') WHERE id = ?").run(invitation.id);
});
export function acceptClubInvitation(invitation, userId) { acceptInviteTransaction({ invitation, userId }); }
