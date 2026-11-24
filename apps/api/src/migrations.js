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
    name: "roster_guest_rsvps_and_categories",
    up(db) {
      if (!hasColumn(db, "rides", "category")) {
        db.exec("ALTER TABLE rides ADD COLUMN category TEXT NOT NULL DEFAULT 'other' CHECK (category IN ('cycling', 'running', 'hiking', 'swimming', 'triathlon', 'other'))");
        db.exec("UPDATE rides SET category = 'cycling'"); // everything before categories was a bike ride (pilot club)
      }
      // RSVPs no longer require an account: a row belongs either to a club member
      // (user_id) or to a guest who typed a name. device_hash identifies the phone
      // that made it, so only that phone (or the signed-in member) can change it.
      db.exec(`
        -- The club's list of people (uploaded from Excel/CSV), for picking your name when you RSVP.
        -- Riders are not accounts: they never sign in.
        CREATE TABLE club_roster (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          phone TEXT,
          wa_jid TEXT,
          source TEXT NOT NULL DEFAULT 'upload' CHECK (source IN ('upload', 'manual', 'whatsapp')),
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (club_id, name_key)
        );
        CREATE INDEX idx_roster_club_phone ON club_roster(club_id, phone);
        CREATE INDEX idx_roster_club_jid ON club_roster(club_id, wa_jid);
        CREATE TABLE ride_rsvps_v2 (
          id TEXT PRIMARY KEY,
          ride_id TEXT NOT NULL REFERENCES rides(id) ON DELETE CASCADE,
          user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
          roster_id TEXT REFERENCES club_roster(id) ON DELETE SET NULL,
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
        CREATE UNIQUE INDEX idx_rsvps_ride_roster ON ride_rsvps(ride_id, roster_id) WHERE roster_id IS NOT NULL;
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
        -- People the club's WhatsApp number knows: group participants and the names
        -- WhatsApp gives for them (saved contact name, or the name they set themselves).
        -- Used to fill the roster from the club group. phone and lid are both optional.
        CREATE TABLE whatsapp_contacts (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          phone TEXT,
          lid TEXT,
          saved_name TEXT,
          push_name TEXT,
          in_group INTEGER NOT NULL DEFAULT 0,
          updated_at TEXT NOT NULL
        );
        CREATE UNIQUE INDEX idx_wa_contacts_phone ON whatsapp_contacts(club_id, phone) WHERE phone IS NOT NULL;
        CREATE UNIQUE INDEX idx_wa_contacts_lid ON whatsapp_contacts(club_id, lid) WHERE lid IS NOT NULL;
        ALTER TABLE whatsapp_connections ADD COLUMN roster_sync_wanted_at TEXT;
        ALTER TABLE whatsapp_connections ADD COLUMN roster_synced_at TEXT;
        -- Incoming message ids already handled, so a redelivered message is never processed twice.
        CREATE TABLE whatsapp_inbound (
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (club_id, message_id)
        );
      `);
    }
  },
  {
    id: 13,
    name: "mobile_sign_in",
    up(db) {
      // Accounts can be phone-first. A phone-only account gets a placeholder email
      // (<phone>@phone.paceup.invalid) and an unusable password, so the users table
      // keeps its constraints; the API never shows the placeholder.
      if (!hasColumn(db, "users", "phone")) db.exec("ALTER TABLE users ADD COLUMN phone TEXT");
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone ON users(phone) WHERE phone IS NOT NULL;
        -- One-time sign-in codes sent on WhatsApp. Only a hash is stored.
        CREATE TABLE login_codes (
          id TEXT PRIMARY KEY,
          phone TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          purpose TEXT NOT NULL CHECK (purpose IN ('login', 'attach')),
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          attempts INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          ip TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_login_codes_phone ON login_codes(phone, created_at);
        -- Direct WhatsApp messages to one person (sign-in codes), sent by the worker
        -- from a connected club number. Separate from the club-group outbox.
        CREATE TABLE whatsapp_direct (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          to_phone TEXT NOT NULL,
          text TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed')),
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          expires_at TEXT NOT NULL,
          created_at TEXT NOT NULL,
          sent_at TEXT
        );
        CREATE INDEX idx_wa_direct_pending ON whatsapp_direct(status, created_at);
      `);
    }
  },
  {
    id: 14,
    name: "roster_self_added",
    up(db) {
      // New members can add themselves from the RSVP page; admins see them flagged for review.
      db.exec("ALTER TABLE club_roster ADD COLUMN self_added INTEGER NOT NULL DEFAULT 0");
    }
  },
  {
    id: 15,
    name: "activity_templates",
    up(db) {
      // Named, reusable activity details per club ("Pandala"): everything except the date and time.
      db.exec(`
        CREATE TABLE activity_templates (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          fields TEXT NOT NULL,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (club_id, name_key)
        );
      `);
    }
  },
  {
    id: 16,
    name: "roster_contact_name",
    up(db) {
      // The name exactly as it was in the admin's phone book ("Aneesh Saraiya Cycling Sector 65"),
      // kept when PaceUp tidies the name members see ("Aneesh Saraiya").
      db.exec("ALTER TABLE club_roster ADD COLUMN contact_name TEXT");
    }
  },
  {
    id: 17,
    name: "whatsapp_groups_per_activity",
    up(db) {
      // A club has several WhatsApp groups. The member list comes from the groups the admin ticks
      // (usually one master group with everyone), and each activity can post to its own group.
      db.exec(`
        ALTER TABLE whatsapp_connections ADD COLUMN member_groups_json TEXT;
        ALTER TABLE rides ADD COLUMN wa_group_jid TEXT;
      `);
    }
  },
  {
    id: 18,
    name: "whatsapp_club_groups",
    up(db) {
      // The linked number may be someone's personal phone with dozens of unrelated groups.
      // Only the Super Admin sees them all; club admins see only the groups listed here.
      if (!hasColumn(db, "whatsapp_connections", "allowed_groups_json")) db.exec("ALTER TABLE whatsapp_connections ADD COLUMN allowed_groups_json TEXT");
      // Keep what clubs already use working: the posting group, member-list groups, and groups activities or templates post to.
      for (const c of db.prepare("SELECT club_id, group_jid, member_groups_json FROM whatsapp_connections").all()) {
        const jids = new Set();
        if (c.group_jid) jids.add(c.group_jid);
        try { for (const j of JSON.parse(c.member_groups_json || "[]")) jids.add(j); } catch {}
        for (const r of db.prepare("SELECT DISTINCT wa_group_jid AS j FROM rides WHERE club_id = ? AND wa_group_jid IS NOT NULL").all(c.club_id)) jids.add(r.j);
        for (const r of db.prepare("SELECT fields FROM activity_templates WHERE club_id = ?").all(c.club_id)) {
          try { const j = JSON.parse(r.fields)?.wa_group_jid; if (j) jids.add(j); } catch {}
        }
        db.prepare("UPDATE whatsapp_connections SET allowed_groups_json = ? WHERE club_id = ?").run(JSON.stringify([...jids]), c.club_id);
      }
    }
  },
  {
    id: 19,
    name: "whatsapp_group_adds",
    up(db) {
      // An admin adding someone to the member list can also add them to one of the club's WhatsApp
      // groups. The worker does it slowly (to keep the number safe) and records what happened.
      db.exec(`
        CREATE TABLE whatsapp_group_adds (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          phone TEXT NOT NULL,
          name TEXT,
          group_jid TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'added', 'invited', 'already', 'failed')),
          detail TEXT,
          attempts INTEGER NOT NULL DEFAULT 0,
          requested_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          done_at TEXT
        );
        CREATE INDEX idx_group_adds_pending ON whatsapp_group_adds(status, created_at);
      `);
    }
  },
  {
    id: 20,
    name: "login_codes_reset_purpose",
    up(db) {
      // Self-serve password reset sends a WhatsApp code with its own purpose. The CHECK on
      // login_codes only allows login/attach, so the table is rebuilt (nothing references it).
      db.exec(`
        CREATE TABLE login_codes_v2 (
          id TEXT PRIMARY KEY,
          phone TEXT NOT NULL,
          code_hash TEXT NOT NULL,
          purpose TEXT NOT NULL CHECK (purpose IN ('login', 'attach', 'reset')),
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          attempts INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          ip TEXT,
          created_at TEXT NOT NULL
        );
        INSERT INTO login_codes_v2 SELECT id, phone, code_hash, purpose, user_id, attempts, expires_at, used_at, ip, created_at FROM login_codes;
        DROP TABLE login_codes;
        ALTER TABLE login_codes_v2 RENAME TO login_codes;
        CREATE INDEX idx_login_codes_phone ON login_codes(phone, created_at);
      `);
    }
  },
  {
    id: 21,
    name: "club_directory_and_own_numbers",
    up(db) {
      // Clubs on their own WhatsApp numbers: a directory of clubs across India (public part: name,
      // city, activity; the rest is the Super Admin's prospect record), one-time owner sign-in links,
      // the club admin who owns the club's number, and linking by a pairing code.
      db.exec(`
        CREATE TABLE club_directory (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          name_key TEXT NOT NULL,
          city TEXT,
          city_key TEXT NOT NULL DEFAULT '',
          state TEXT,
          activity TEXT,
          kind TEXT,
          website TEXT,
          instagram TEXT,
          facebook TEXT,
          other_links TEXT,
          phone TEXT,
          email TEXT,
          source_name TEXT,
          source_id TEXT,
          public_page_link TEXT,
          extra_json TEXT,
          status TEXT NOT NULL DEFAULT 'prospect' CHECK (status IN ('prospect', 'contacted', 'pilot', 'live')),
          notes TEXT,
          hidden INTEGER NOT NULL DEFAULT 0,
          club_id TEXT REFERENCES clubs(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL,
          UNIQUE (name_key, city_key)
        );
        CREATE INDEX idx_directory_name ON club_directory(name_key);
        CREATE INDEX idx_directory_club ON club_directory(club_id);
        ALTER TABLE clubs ADD COLUMN city TEXT;
        ALTER TABLE clubs ADD COLUMN activity TEXT;
        ALTER TABLE clubs ADD COLUMN number_owner_id TEXT REFERENCES users(id) ON DELETE SET NULL;
        CREATE TABLE owner_links (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          attempts INTEGER NOT NULL DEFAULT 0,
          expires_at TEXT NOT NULL,
          used_at TEXT,
          claimed_at TEXT,
          created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_owner_links_club ON owner_links(club_id, created_at);
        ALTER TABLE whatsapp_connections ADD COLUMN pairing_phone TEXT;
        ALTER TABLE whatsapp_connections ADD COLUMN pairing_code TEXT;
      `);
      // Existing clubs: the owner owns the number, except the pilot club whose number the Super Admin linked.
      for (const c of db.prepare("SELECT c.id, (SELECT user_id FROM club_memberships WHERE club_id = c.id AND role = 'owner' ORDER BY created_at LIMIT 1) AS owner FROM clubs c").all()) {
        const linked = db.prepare("SELECT 1 FROM whatsapp_connections WHERE club_id = ? AND phone IS NOT NULL").get(c.id);
        if (!linked && c.owner) db.prepare("UPDATE clubs SET number_owner_id = ? WHERE id = ?").run(c.owner, c.id);
      }
    }
  },
  {
    id: 22,
    name: "one_club_owner",
    up(db) {
      // Three roles: PaceUp Admin (platform), one Club Owner per club (the club's number, name, groups,
      // admins and stats), Club Admins (activities and members). The separate "number owner" folds into
      // the Club Owner. Who becomes owner: a PaceUp Admin who is in the club (the pilot club), else the
      // number owner, else the existing owner, else the longest-serving admin.
      const memberRole = db.prepare("SELECT role FROM club_memberships WHERE club_id = ? AND user_id = ?");
      for (const c of db.prepare("SELECT id, number_owner_id FROM clubs").all()) {
        const platform = db.prepare(`SELECT cm.user_id FROM club_memberships cm INNER JOIN users u ON u.id = cm.user_id
          WHERE cm.club_id = ? AND u.platform_role = 'super_admin' ORDER BY cm.created_at LIMIT 1`).get(c.id)?.user_id;
        const numberOwner = c.number_owner_id && ["owner", "admin"].includes(memberRole.get(c.id, c.number_owner_id)?.role) ? c.number_owner_id : null;
        const pick = (role) => db.prepare("SELECT user_id FROM club_memberships WHERE club_id = ? AND role = ? ORDER BY created_at LIMIT 1").get(c.id, role)?.user_id;
        const owner = platform || numberOwner || pick("owner") || pick("admin");
        if (!owner) continue;
        db.prepare("UPDATE club_memberships SET role = 'admin' WHERE club_id = ? AND role = 'owner' AND user_id != ?").run(c.id, owner);
        db.prepare("UPDATE club_memberships SET role = 'owner' WHERE club_id = ? AND user_id = ?").run(c.id, owner);
        db.prepare("UPDATE clubs SET number_owner_id = ? WHERE id = ?").run(owner, c.id);
      }
      db.exec("CREATE UNIQUE INDEX IF NOT EXISTS club_memberships_one_owner ON club_memberships(club_id) WHERE role = 'owner'");
    }
  },
  {
    id: 23,
    name: "service_status",
    up(db) {
      // Each background service (the WhatsApp worker) records the commit it runs, for /health and the deploy check.
      db.exec("CREATE TABLE service_status (name TEXT PRIMARY KEY, version TEXT NOT NULL, started_at TEXT NOT NULL, seen_at TEXT NOT NULL)");
    }
  },
  {
    id: 24,
    name: "midway_meeting_point",
    up(db) {
      // People often join on the way: an optional second meeting point with its own time.
      // Each RSVP says where that person joins (1 = the start, 2 = the midway point).
      db.exec(`
        ALTER TABLE rides ADD COLUMN meeting_point_2 TEXT;
        ALTER TABLE rides ADD COLUMN meeting_at_2 TEXT;
        ALTER TABLE rides ADD COLUMN map_url_2 TEXT;
        ALTER TABLE ride_rsvps ADD COLUMN join_point INTEGER NOT NULL DEFAULT 1;
      `);
    }
  },
  {
    id: 25,
    name: "no_shows",
    up(db) {
      // After an activity, admins tap who didn't turn up. Everyone else on the going list counts as present.
      // absent_nudge_at: when the Lead was sent the one WhatsApp reminder to mark no-shows.
      db.exec(`
        ALTER TABLE ride_rsvps ADD COLUMN no_show INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE ride_rsvps ADD COLUMN no_show_by TEXT REFERENCES users(id) ON DELETE SET NULL;
        ALTER TABLE ride_rsvps ADD COLUMN no_show_at TEXT;
        ALTER TABLE rides ADD COLUMN absent_nudge_at TEXT;
        CREATE INDEX idx_rsvps_no_show ON ride_rsvps(ride_id) WHERE no_show = 1;
      `);
      // Activities that already started don't get a reminder when this ships.
      const now = new Date().toISOString();
      db.prepare("UPDATE rides SET absent_nudge_at = ? WHERE starts_at <= ?").run(now, now);
    }
  },
  {
    id: 26,
    name: "outbox_regulars",
    up(db) {
      // A new kind of group post: the monthly "Most regular" shout-out. SQLite can't change a CHECK,
      // so the outbox is copied into a new table with the wider list.
      db.exec(`
        CREATE TABLE outbox_v2 (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          ride_id TEXT REFERENCES rides(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('ride_published', 'rider_list', 'ride_updated', 'ride_cancelled', 'test', 'regulars')),
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'skipped')),
          not_before TEXT NOT NULL,
          attempts INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          payload TEXT,
          created_at TEXT NOT NULL,
          sent_at TEXT
        );
        INSERT INTO outbox_v2 (id, club_id, ride_id, kind, status, not_before, attempts, last_error, payload, created_at, sent_at)
          SELECT id, club_id, ride_id, kind, status, not_before, attempts, last_error, payload, created_at, sent_at FROM outbox;
        DROP TABLE outbox;
        ALTER TABLE outbox_v2 RENAME TO outbox;
        CREATE INDEX idx_outbox_due ON outbox(status, not_before);
        CREATE INDEX idx_outbox_club_sent ON outbox(club_id, status, sent_at);
        CREATE UNIQUE INDEX idx_outbox_one_pending_list ON outbox(ride_id) WHERE kind = 'rider_list' AND status = 'pending';
      `);
    }
  },
  {
    id: 27,
    name: "roster_keep_both",
    up(db) {
      // An admin said two look-alike names ("Mahesh Giri Cycling Tulip Purple" and "Mahesh Giri")
      // are different people: stop offering to tidy or merge this one.
      db.exec("ALTER TABLE club_roster ADD COLUMN tidy_dismissed INTEGER NOT NULL DEFAULT 0");
    }
  },
  {
    id: 28,
    name: "self_serve_signup",
    up(db) {
      // Clubs that set themselves up at /start. 'pending' until the owner links the club's WhatsApp
      // number (released after 24 hours if they don't), then 'live'; 'removed' while the PaceUp Admin's
      // removal unlinks the number. NULL: created by the PaceUp Admin.
      // An account made at /start hasn't proved its mobile yet (signup_unverified = 1) until it signs in
      // with a WhatsApp code or links that same number.
      db.exec(`
        ALTER TABLE clubs ADD COLUMN signup_status TEXT CHECK (signup_status IN ('pending', 'live', 'removed'));
        ALTER TABLE clubs ADD COLUMN signup_at TEXT;
        ALTER TABLE clubs ADD COLUMN signup_live_at TEXT;
        ALTER TABLE clubs ADD COLUMN signup_dir_snapshot TEXT;
        ALTER TABLE users ADD COLUMN signup_unverified INTEGER NOT NULL DEFAULT 0;
        CREATE INDEX idx_clubs_signup ON clubs(signup_status, signup_at);
        CREATE TABLE club_access_requests (
          id TEXT PRIMARY KEY,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          phone TEXT NOT NULL,
          owner_told INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_access_requests_created ON club_access_requests(created_at);
      `);
    }
  },
  {
    id: 29,
    name: "push_alerts",
    up(db) {
      // Phone alerts for club owners, admins and the PaceUp Admin (web push from the installed app).
      // app_settings keeps this server's own push keys, made on first use. push_queue is filled inside
      // the same transaction as the event, by the API or the WhatsApp worker; the API sends it.
      db.exec(`
        CREATE TABLE app_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE push_subscriptions (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_push_subscriptions_user ON push_subscriptions(user_id);
        CREATE TABLE push_queue (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          url TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
      `);
    }
  },
  {
    id: 30,
    name: "members_only",
    up(db) {
      // Members-only activities. club_group_numbers: every number in any of the club's linked
      // WhatsApp groups (refreshed by the worker), the list a joiner's number is checked against.
      // device_people: who a phone was confirmed to be in a club, so next time it's one tap.
      // join_requests: someone who isn't in the club asked to join; the Lead is told once a day per number.
      db.exec(`
        CREATE TABLE club_group_numbers (
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          phone TEXT NOT NULL,
          name TEXT,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (club_id, phone)
        );
        CREATE TABLE device_people (
          device_hash TEXT NOT NULL,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          roster_id TEXT REFERENCES club_roster(id) ON DELETE CASCADE,
          user_id TEXT REFERENCES users(id) ON DELETE CASCADE,
          updated_at TEXT NOT NULL,
          PRIMARY KEY (device_hash, club_id)
        );
        CREATE TABLE join_requests (
          id TEXT PRIMARY KEY,
          code TEXT NOT NULL UNIQUE,
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          ride_id TEXT REFERENCES rides(id) ON DELETE SET NULL,
          phone TEXT NOT NULL,
          name TEXT NOT NULL,
          alerted INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'open',
          handled_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          handled_at TEXT,
          created_at TEXT NOT NULL
        );
        CREATE INDEX idx_join_requests_club_phone ON join_requests(club_id, phone, created_at);
        ALTER TABLE whatsapp_connections ADD COLUMN group_people INTEGER;
        ALTER TABLE whatsapp_connections ADD COLUMN group_numbers INTEGER;
        ALTER TABLE whatsapp_connections ADD COLUMN group_numbers_at TEXT;
      `);
    }
  },
  {
    id: 31,
    name: "roster_extra_numbers",
    up(db) {
      // One person, more than one WhatsApp number: an admin links a second number to someone
      // already on the member list, so they can join from either and their count stays in one place.
      db.exec(`
        CREATE TABLE club_roster_phones (
          club_id TEXT NOT NULL REFERENCES clubs(id) ON DELETE CASCADE,
          phone TEXT NOT NULL,
          roster_id TEXT NOT NULL REFERENCES club_roster(id) ON DELETE CASCADE,
          added_by TEXT REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL,
          PRIMARY KEY (club_id, phone)
        );
        CREATE INDEX idx_roster_phones_roster ON club_roster_phones(roster_id);
      `);
    }
  },
  {
    id: 32,
    name: "push_delivery_log",
    up(db) {
      // What the push service said the last time we sent to each phone, so a failed alert can be explained.
      db.exec(`
        ALTER TABLE push_subscriptions ADD COLUMN last_sent_at TEXT;
        ALTER TABLE push_subscriptions ADD COLUMN last_status INTEGER;
        ALTER TABLE push_subscriptions ADD COLUMN last_error TEXT;
      `);
    }
  },
  {
    id: 33,
    name: "signin_code_sender",
    up(db) {
      // Which number sent a sign-in code: the person's own club ('club') or the PaceUp Admin's number ('paceup'),
      // so the PaceUp Admin's number can be held to its own daily limits.
      db.exec("ALTER TABLE login_codes ADD COLUMN sent_via TEXT");
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
