import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { useTempDatabase } from "./helpers.js";
import { migrations } from "../src/migrations.js";

// The live database as PR 21 left it (migrations 1-21): clubs with several owners, a number owner
// who is an admin, a club with no owner, and the pilot club where the PaceUp Admin is a member.
const { tempDir, file } = useTempDatabase();
const live = new Database(file);
live.pragma("foreign_keys = ON");
live.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
for (const m of migrations.filter((m) => m.id <= 21)) { m.up(live); live.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(m.id, m.name, "2026-11-20"); }
live.exec(`
  INSERT INTO users (id, name, email, password_hash, platform_role) VALUES
    ('boss', 'Boss', 'boss@example.com', 'h', 'super_admin'), ('anu', 'Anurag', 'an@example.com', 'h', 'user'),
    ('nan', 'Nandini', 'na@example.com', 'h', 'user'), ('pri', 'Priya', 'pr@example.com', 'h', 'user'), ('ravi', 'Ravi', 'ra@example.com', 'h', 'user');
  INSERT INTO clubs (id, name, slug, number_owner_id) VALUES ('pilot', 'Pilot', 'pilot', NULL), ('own', 'Own Number Club', 'own', 'ravi'), ('none', 'No Owner', 'none', NULL);
  INSERT INTO club_memberships (id, club_id, user_id, role, created_at) VALUES
    ('m1', 'pilot', 'anu', 'owner', '2026-11-01'), ('m2', 'pilot', 'boss', 'admin', '2026-11-02'), ('m3', 'pilot', 'nan', 'admin', '2026-11-03'),
    ('m4', 'own', 'pri', 'owner', '2026-11-01'), ('m5', 'own', 'ravi', 'admin', '2026-11-02'),
    ('m6', 'none', 'nan', 'admin', '2026-11-01'), ('m7', 'none', 'pri', 'admin', '2026-11-02');
`);
live.close();

const { db } = await import("../src/db.js");

test("every club ends up with exactly one Club Owner", () => {
  const roles = (club) => Object.fromEntries(db.prepare("SELECT user_id, role FROM club_memberships WHERE club_id = ?").all(club).map((r) => [r.user_id, r.role]));
  assert.deepEqual(roles("pilot"), { anu: "admin", boss: "owner", nan: "admin" }, "the PaceUp Admin owns the pilot club");
  assert.deepEqual(roles("own"), { pri: "admin", ravi: "owner" }, "the number owner becomes the club owner");
  assert.deepEqual(roles("none"), { nan: "owner", pri: "admin" }, "no owner: the longest-serving admin");
  assert.throws(() => db.prepare("UPDATE club_memberships SET role = 'owner' WHERE id = 'm7'").run(), /UNIQUE/, "a second owner is refused");
});

test.after(() => { db.close(); rmSync(tempDir, { recursive: true, force: true }); });
