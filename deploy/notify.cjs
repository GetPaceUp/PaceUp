// Queues a deploy note on WhatsApp to every Super Admin with a mobile number.
// It is sent ONLY from a number that belongs to the PaceUp Admin: their own number, or a club they own.
// Never from another club's number (that club's owner would see our note in their WhatsApp).
// If no such number is linked, nothing is sent. Usage: node deploy/notify.cjs "text"
const Database = require("better-sqlite3");
const { randomUUID } = require("node:crypto");
const text = process.argv[2];
if (!text) process.exit(1);
const db = new Database(process.env.PACEUP_DB || "/var/lib/paceup/paceup.sqlite");
const admins = db.prepare("SELECT id, phone FROM users WHERE platform_role = 'super_admin' AND phone IS NOT NULL").all();
const club = db.prepare(`
  SELECT wc.club_id FROM whatsapp_connections wc
  WHERE wc.desired = 'on' AND (
    wc.phone IN (SELECT phone FROM users WHERE platform_role = 'super_admin' AND phone IS NOT NULL)
    OR EXISTS (SELECT 1 FROM club_memberships cm INNER JOIN users u ON u.id = cm.user_id
               WHERE cm.club_id = wc.club_id AND cm.role = 'owner' AND u.platform_role = 'super_admin'))
  ORDER BY (wc.phone IN (SELECT phone FROM users WHERE platform_role = 'super_admin')) DESC,
           (wc.status = 'connected') DESC, wc.last_seen_at DESC
  LIMIT 1`).get();
if (!club || !admins.length) { console.error("no PaceUp Admin WhatsApp number or Super Admin phone to notify"); process.exit(1); }
const now = Date.now();
const ins = db.prepare("INSERT INTO whatsapp_direct (id, club_id, to_phone, text, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)");
for (const a of admins) ins.run(randomUUID(), club.club_id, a.phone, text, new Date(now + 6 * 3600e3).toISOString(), new Date(now).toISOString());
db.close();
