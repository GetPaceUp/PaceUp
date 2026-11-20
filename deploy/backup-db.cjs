// Writes a consistent copy of the live database next to the other backups and prints its path.
// Keeps the newest 30 automatic ones. Run from the repo so better-sqlite3 resolves.
const Database = require("better-sqlite3");
const fs = require("node:fs");
const path = require("node:path");
const dbPath = process.env.PACEUP_DB || "/var/lib/paceup/paceup.sqlite";
const dir = process.env.PACEUP_BACKUPS || path.join(path.dirname(dbPath), "backups");
fs.mkdirSync(dir, { recursive: true });
const out = path.join(dir, `paceup-pre-auto-${new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}.sqlite`);
const db = new Database(dbPath, { readonly: true });
db.prepare("VACUUM INTO ?").run(out);
db.close();
if (!fs.existsSync(out) || fs.statSync(out).size === 0) { console.error("backup is empty"); process.exit(1); }
const old = fs.readdirSync(dir).filter((f) => f.startsWith("paceup-pre-auto-")).sort().slice(0, -30);
for (const f of old) fs.unlinkSync(path.join(dir, f));
console.log(out);
