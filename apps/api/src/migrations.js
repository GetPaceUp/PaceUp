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
  },
  {
    id: 6,
    name: "rides_and_rsvps",
    up(db) {
      db.exec(`
        CREATE TABLE rides (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          share_code TEXT NOT NULL UNIQUE,
          title TEXT NOT NULL,
          starts_at TEXT NOT NULL,
          meeting_point TEXT NOT NULL,
          map_url TEXT,
          distance_km REAL,
          pace TEXT,
          notes TEXT,
          capacity INTEGER CHECK (capacity IS NULL OR capacity > 0),
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'cancelled')),
          organiser_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX idx_rides_club_start ON rides(club_id, starts_at);
        CREATE TABLE ride_rsvps (
          id TEXT PRIMARY KEY,
          ride_id TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          status TEXT NOT NULL CHECK (status IN ('going', 'cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (ride_id, user_id)
        );
        CREATE INDEX idx_rsvps_ride_status ON ride_rsvps(ride_id, status);
      `);
    }
  },
  {
    id: 7,
    name: "whatsapp_connections_and_outbox",
    up(db) {
      db.exec(`
        CREATE TABLE whatsapp_connections (
          club_id TEXT PRIMARY KEY REFERENCES clubs(id) ON DELETE CASCADE,
          desired TEXT NOT NULL DEFAULT 'off' CHECK (desired IN ('off', 'on', 'logout')),
          status TEXT NOT NULL DEFAULT 'disconnected'
            CHECK (status IN ('disconnected', 'pairing', 'connected', 'reconnecting', 'logged_out', 'error')),
          qr TEXT,
          qr_updated_at TEXT,
          phone TEXT,
          group_jid TEXT,
          group_name TEXT,
          groups_json TEXT,
          post_new_ride INTEGER NOT NULL DEFAULT 1,
          post_rider_list INTEGER NOT NULL DEFAULT 1,
          post_changes INTEGER NOT NULL DEFAULT 1,
          quiet_hours INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          last_seen_at TEXT,
          updated_at TEXT NOT NULL
        );
        CREATE TABLE outbox (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          ride_id TEXT REFERENCES rides(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('ride_published', 'rider_list', 'ride_updated', 'ride_cancelled', 'test')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
          not_before TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          payload TEXT,
          created_at TEXT NOT NULL,
          sent_at TEXT
        );
        CREATE INDEX idx_outbox_due ON outbox(status, not_before);
        CREATE INDEX idx_outbox_club_sent ON outbox(club_id, status, sent_at);
        -- At most one pending rider-list post per ride: bursts of RSVPs coalesce into it.
        CREATE UNIQUE INDEX idx_outbox_one_pending_list ON outbox(ride_id) WHERE kind = 'rider_list' AND status = 'pending';
      `);
    }
  },
  {
    id: 8,
    name: "password_resets",
    up(db) {
      db.exec(`
        CREATE TABLE password_resets (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_password_resets_user ON password_resets(user_id);
      `);
    }
  },
  {
    id: 9,
    name: "whatsapp_groups_refresh",
    up(db) {
      // Set by the admin's "Refresh groups" button; the worker re-reads the
      // number's groups when this is newer than its last fetch.
      const cols = db.prepare("PRAGMA table_info(whatsapp_connections)").all().map((c) => c.name);
      if (!cols.includes("groups_wanted_at")) db.exec("ALTER TABLE whatsapp_connections ADD COLUMN groups_wanted_at TEXT");
      if (!cols.includes("groups_updated_at")) db.exec("ALTER TABLE whatsapp_connections ADD COLUMN groups_updated_at TEXT");
    }
  },
  {
    id: 10,
    name: "guest_rsvps_and_categories",
    up(db) {
      if (!hasColumn(db, "rides", "category")) {
        db.exec("ALTER TABLE rides ADD COLUMN category TEXT NOT NULL DEFAULT 'cycling' CHECK (category IN ('cycling', 'running', 'hiking', 'triathlon', 'other'))");
      }
      // RSVPs no longer require an account: a row belongs either to a club member
      // (user_id) or to a guest who typed a name. device_hash identifies the phone
      // that made it, so only that phone (or the signed-in member) can change it.
      db.exec(`
        CREATE TABLE ride_rsvps_v2 (
          id TEXT PRIMARY KEY,
          ride_id TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
          user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          participant_name TEXT NOT NULL,
          device_hash TEXT,
          status TEXT NOT NULL CHECK (status IN ('going', 'cancelled')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        INSERT INTO ride_rsvps_v2 (id, ride_id, user_id, participant_name, device_hash, status, created_at, updated_at)
          SELECT rs.id, rs.ride_id, rs.user_id, COALESCE(u.name, 'Member'), NULL, rs.status, rs.created_at, rs.updated_at
          FROM ride_rsvps rs LEFT JOIN users u ON u.id = rs.user_id;
        DROP TABLE ride_rsvps;
        ALTER TABLE ride_rsvps_v2 RENAME TO ride_rsvps;
        CREATE INDEX idx_rsvps_ride_status ON ride_rsvps(ride_id, status);
        CREATE UNIQUE INDEX idx_rsvps_ride_user ON ride_rsvps(ride_id, user_id) WHERE user_id IS NOT NULL;
        CREATE UNIQUE INDEX idx_rsvps_ride_device ON ride_rsvps(ride_id, device_hash) WHERE device_hash IS NOT NULL;
      `);
    }
  },
  {
    id: 11,
    name: "activity_audit_log",
    up(db) {
      db.exec(`
        CREATE TABLE activity_audit_log (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          ride_id TEXT REFERENCES rides(id) ON DELETE CASCADE,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('user', 'whatsapp', 'guest', 'system')),
          actor_id TEXT,
          action TEXT NOT NULL,
          metadata TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_activity_audit_ride ON activity_audit_log(ride_id, created_at);
        CREATE INDEX idx_activity_audit_club ON activity_audit_log(club_id, created_at);
      `);
    }
  },
  {
    id: 12,
    name: "whatsapp_admin_chat",
    up(db) {
      db.exec(`
        -- Club admins who may create activities by messaging the club's number.
        -- An admin links their own WhatsApp by sending a one-time code from it.
        CREATE TABLE whatsapp_admins (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          jid TEXT,
          jid_alt TEXT,
          code_hash TEXT,
          code_expires_at TEXT,
          linked_at TEXT,
          created_at TEXT NOT NULL,
          UNIQUE (club_id, user_id)
        );
        CREATE INDEX idx_wa_admins_jid ON whatsapp_admins(club_id, jid);
        CREATE INDEX idx_wa_admins_jid_alt ON whatsapp_admins(club_id, jid_alt);
        -- One in-progress activity draft per admin chat.
        CREATE TABLE whatsapp_drafts (
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          draft TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (club_id, user_id)
        );
        -- Incoming message ids already handled, so a redelivered message is never processed twice.
        CREATE TABLE whatsapp_inbound (
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (club_id, message_id)
        );
      `);
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
