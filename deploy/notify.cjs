// Queues a WhatsApp message from the club number to every Super Admin with a mobile number.
// The WhatsApp worker sends it as soon as it is connected. Usage: node deploy/notify.cjs "text"
const Database = require("better-sqlite3");
const { randomUUID } = require("node:crypto");
const text = process.argv[2];
if (!text) process.exit(1);
const db = new Database(process.env.PACEUP_DB || "/var/lib/paceup/paceup.sqlite");
const club = db.prepare("SELECT club_id FROM whatsapp_connections WHERE desired = 'on' ORDER BY (status = 'connected') DESC, last_seen_at DESC LIMIT 1").get();
const admins = db.prepare("SELECT phone FROM users WHERE platform_role = 'super_admin' AND phone IS NOT NULL").all();
if (!club || !admins.length) { console.error("no club number or Super Admin phone to notify"); process.exit(1); }
const now = Date.now();
const ins = db.prepare("INSERT INTO whatsapp_direct (id, club_id, to_phone, text, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)");
for (const a of admins) ins.run(randomUUID(), club.club_id, a.phone, text, new Date(now + 6 * 3600e3).toISOString(), new Date(now).toISOString());
db.close();
