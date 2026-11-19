// Numbered, forward-only schema migrations.
//
// Rules:
// - Never edit or reorder a migration after it has shipped. Add a new one.
// - Each migration runs inside a transaction together with its bookkeeping row,
//   so a failed migration leaves the database exactly as it was.
// - Migrations must be safe on databases created by earlier releases that had no
//   migration table (the live database predates this mechanism), which is why the
//   baseline uses IF NOT EXISTS and column additions check the schema first.

function hasColumn(db, table, column) {
  return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
}

export const migrations = [
  {
    id: 1,
    name: "baseline_accounts_clubs_invitations",
    up(db) {
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
    }
  },
  {
    id: 2,
    name: "users_platform_role",
    up(db) {
      if (!hasColumn(db, "users", "platform_role")) {
        db.exec("ALTER TABLE users ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'user' CHECK (platform_role IN ('user', 'super_admin'))");
      }
    }
  },
  {
    id: 3,
    name: "sessions",
    up(db) {
      db.exec(`
        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at TEXT NOT NULL,
          expires_at TEXT NOT NULL,
          revoked_at TEXT
        );
        CREATE INDEX idx_sessions_user ON sessions(user_id);
      `);
    }
  },
  {
    id: 4,
    name: "platform_audit_log",
    up(db) {
      db.exec(`
        CREATE TABLE platform_audit_log (
          id TEXT PRIMARY KEY,
          actor_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          action TEXT NOT NULL,
          target_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          old_value TEXT,
          new_value TEXT,
          ip TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_platform_audit_created ON platform_audit_log(created_at);
      `);
    }
  },
  {
    id: 5,
    name: "invitations_accepted_by",
    up(db) {
      if (!hasColumn(db, "club_invitations", "accepted_by")) {
        db.exec("ALTER TABLE club_invitations ADD COLUMN accepted_by TEXT REFERENCES users(id) ON DELETE SET NULL");
      }
    }
  }
];

export function pendingMigrations(db) {
  const tracked = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'").get();
  const applied = new Set(tracked ? db.prepare("SELECT id FROM schema_migrations").all().map((row) => row.id) : []);
  return migrations.filter((m) => !applied.has(m.id));
}

/**
 * Applies pending migrations in order. When the database already holds data and
 * there is work to do, a consistent snapshot is written next to it first
 * (VACUUM INTO), so an upgrade can always be rolled back by restoring that file.
 */
export function runMigrations(db, { databasePath, log = () => {} } = {}) {
  const pending = pendingMigrations(db);
  if (!pending.length) return { applied: [], backupPath: null };

  let backupPath = null;
  const hasExistingData = db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'table' AND name = 'users'").get().n > 0;
  if (hasExistingData && databasePath && databasePath !== ":memory:") {
    backupPath = `${databasePath}.pre-migration-${new Date().toISOString().replace(/[:.]/g, "-")}.bak`;
    db.prepare("VACUUM INTO ?").run(backupPath);
    log(`Database backup written to ${backupPath} before migrating.`);
  }

  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL
  )`);
  const record = db.prepare("INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)");
  for (const migration of pending) {
    db.transaction(() => {
      migration.up(db);
      record.run(migration.id, migration.name, new Date().toISOString());
    }).immediate();
    log(`Applied migration ${migration.id} ${migration.name}.`);
  }
  return { applied: pending.map((m) => m.id), backupPath };
}
