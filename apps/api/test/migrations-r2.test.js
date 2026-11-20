import test from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { useTempDatabase } from "./helpers.js";
import { migrations } from "../src/migrations.js";

// The live database as Release 1 left it (migrations 1-9), with real RSVPs.
const { tempDir, file } = useTempDatabase();
const live = new Database(file);
live.pragma("foreign_keys = ON");
live.exec("CREATE TABLE schema_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
for (const m of migrations.filter((m) => m.id <= 9)) { m.up(live); live.prepare("INSERT INTO schema_migrations VALUES (?, ?, ?)").run(m.id, m.name, "2026-11-19"); }
live.exec(`
  INSERT INTO users (id, name, email, password_hash) VALUES ('u1', 'Priya Sharma', 'p@example.com', 'h'), ('u2', 'Arjun Rao', 'a@example.com', 'h');
  INSERT INTO clubs (id, name, slug) VALUES ('c1', 'Club', 'club');
  INSERT INTO rides (id, club_id, share_code, title, starts_at, meeting_point, status, created_at, updated_at)
    VALUES ('r1', 'c1', 'abcdefgh', 'Sunday ride', '2030-01-01T00:30:00.000Z', 'Gate', 'published', '2026-11-19', '2026-11-19');
  INSERT INTO ride_rsvps (id, ride_id, user_id, status, created_at, updated_at) VALUES
    ('s1', 'r1', 'u1', 'going', '2026-11-19T01:00:00Z', '2026-11-19T01:00:00Z'),
    ('s2', 'r1', 'u2', 'cancelled', '2026-11-19T02:00:00Z', '2026-11-19T02:00:00Z');
`);
live.close();

const { db } = await import("../src/db.js");

test("Release 1 RSVPs survive the guest-RSVP table rebuild", () => {
  assert.deepEqual(db.prepare("SELECT id FROM schema_migrations WHERE id > 9 ORDER BY id").all().map((r) => r.id), [10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27]);
  const rows = db.prepare("SELECT id, user_id, participant_name, device_hash, status FROM ride_rsvps ORDER BY id").all();
  assert.deepEqual(rows, [
    { id: "s1", user_id: "u1", participant_name: "Priya Sharma", device_hash: null, status: "going" },
    { id: "s2", user_id: "u2", participant_name: "Arjun Rao", device_hash: null, status: "cancelled" }
  ]);
  assert.equal(db.prepare("SELECT category FROM rides WHERE id = 'r1'").get().category, "cycling");
  assert.equal(db.pragma("foreign_key_check").length, 0);
  // One row per member per activity is still enforced.
  assert.throws(() => db.prepare("INSERT INTO ride_rsvps (id, ride_id, user_id, participant_name, status, created_at, updated_at) VALUES ('s3', 'r1', 'u1', 'x', 'going', 'n', 'n')").run(), /UNIQUE/);
});

test.after(() => { db.close(); rmSync(tempDir, { recursive: true, force: true }); });
