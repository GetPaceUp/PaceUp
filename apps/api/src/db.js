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
  )
`);

export function listClubs() {
  return db.prepare(
    "SELECT id, name, slug, created_at FROM clubs ORDER BY created_at DESC"
  ).all();
}

export function createClub({ id, name, slug }) {
  db.prepare(
    "INSERT INTO clubs (id, name, slug) VALUES (?, ?, ?)"
  ).run(id, name, slug);

  return db.prepare(
    "SELECT id, name, slug, created_at FROM clubs WHERE id = ?"
  ).get(id);
}
