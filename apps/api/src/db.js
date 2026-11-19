import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const configuredPath = process.env.DATABASE_URL || "file:./data/paceup.sqlite";
const databasePath = configuredPath.startsWith("file:")
  ? configuredPath.slice(5)
  : configuredPath;

if (databasePath !== ":memory:") {
  mkdirSync(dirname(resolve(databasePath)), { recursive: true });
}

export const db = new Database(databasePath);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS clubs (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT NOT NULL COLLATE NOCASE UNIQUE,
    password_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS club_memberships (
    id TEXT PRIMARY KEY,
    club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE (club_id, user_id)
  );

  CREATE INDEX IF NOT EXISTS idx_memberships_user ON club_memberships(user_id);
  CREATE INDEX IF NOT EXISTS idx_memberships_club ON club_memberships(club_id);
`);

const createAccountAndClub = db.transaction(({ user, club, membership }) => {
  db.prepare(
    "INSERT INTO users (id, name, email, password_hash) VALUES (?, ?, ?, ?)"
  ).run(user.id, user.name, user.email, user.passwordHash);

  db.prepare(
    "INSERT INTO clubs (id, name, slug) VALUES (?, ?, ?)"
  ).run(club.id, club.name, club.slug);

  db.prepare(
    "INSERT INTO club_memberships (id, club_id, user_id, role) VALUES (?, ?, ?, 'owner')"
  ).run(membership.id, club.id, user.id);

  return {
    user: db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(user.id),
    club: db.prepare("SELECT id, name, slug, created_at FROM clubs WHERE id = ?").get(club.id)
  };
});

export function registerAccount(data) {
  return createAccountAndClub(data);
}

export function findUserByEmail(email) {
  return db.prepare("SELECT * FROM users WHERE email = ? COLLATE NOCASE").get(email);
}

export function getUserById(id) {
  return db.prepare("SELECT id, name, email FROM users WHERE id = ?").get(id);
}

export function listClubsForUser(userId) {
  return db.prepare(`
    SELECT c.id, c.name, c.slug, cm.role, c.created_at
    FROM clubs c
    INNER JOIN club_memberships cm ON cm.club_id = c.id
    WHERE cm.user_id = ?
    ORDER BY c.created_at DESC
  `).all(userId);
}
