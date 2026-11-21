import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { readdirSync, rmSync } from "node:fs";
import { useTempDatabase } from "./helpers.js";

// Recreate the schema of the currently deployed release (b490530), which had no
// migration table and no platform_role column, and fill it with data.
const { tempDir, file } = useTempDatabase();
const legacy = new Database(file);
legacy.exec(`
  CREATE TABLE clubs (id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL COLLATE NOCASE UNIQUE, password_hash TEXT NOT NULL, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  CREATE TABLE club_memberships (id TEXT PRIMARY KEY, club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, role TEXT NOT NULL CHECK (role IN ('owner', 'admin', 'member')), created_at TEXT NOT NULL DEFAULT (datetime('now')), UNIQUE (club_id, user_id));
  CREATE TABLE club_invitations (id TEXT PRIMARY KEY, club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE, email TEXT NOT NULL COLLATE NOCASE, role TEXT NOT NULL CHECK (role IN ('admin', 'member')), token_hash TEXT NOT NULL UNIQUE, invited_by TEXT NOT NULL REFERENCES users(id), expires_at TEXT NOT NULL, accepted_at TEXT, created_at TEXT NOT NULL DEFAULT (datetime('now')));
  INSERT INTO users VALUES ('11111111-1111-1111-1111-111111111111', 'Existing Owner', 'existing@example.com', 'hash', '2026-01-01 00:00:00');
  INSERT INTO clubs VALUES ('22222222-2222-2222-2222-222222222222', 'Existing Club', 'existing-club', '2026-01-01 00:00:00');
  INSERT INTO club_memberships VALUES ('33333333-3333-3333-3333-333333333333', '22222222-2222-2222-2222-222222222222', '11111111-1111-1111-1111-111111111111', 'owner', '2026-01-01 00:00:00');
`);
legacy.close();
process.env.PACEUP_SUPERADMIN_EMAIL = "existing@example.com";

const { db } = await import("../src/db.js");

test("the live database upgrades in place, keeps its data and is backed up first", () => {
  assert.deepEqual(db.prepare("SELECT id FROM schema_migrations ORDER BY id").all().map((r) => r.id), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29]);
  const user = db.prepare("SELECT name, platform_role FROM users").get();
  assert.equal(user.name, "Existing Owner");
  assert.equal(user.platform_role, "super_admin", "owner bootstrap applied");
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM club_memberships").get().n, 1);
  assert.equal(db.prepare("SELECT action FROM platform_audit_log").get().action, "platform_role.bootstrap");

  const backups = readdirSync(tempDir).filter((name) => name.includes(".pre-migration-"));
  assert.equal(backups.length, 1);
  const snapshot = new Database(`${tempDir}/${backups[0]}`, { readonly: true });
  assert.equal(snapshot.prepare("SELECT name FROM clubs").get().name, "Existing Club");
  assert.equal(snapshot.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'schema_migrations'").get().n, 0, "backup is the pre-migration state");
  snapshot.close();
});

test("running migrations again is a no-op", async () => {
  const { runMigrations } = await import("../src/migrations.js");
  assert.deepEqual(runMigrations(db, { databasePath: file }).applied, []);
});

test.after(() => { db.close(); rmSync(tempDir, { recursive: true, force: true }); });
