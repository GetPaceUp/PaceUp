// Applies pending database migrations and exits. The API also does this on start,
// so this is only needed to migrate ahead of a restart (e.g. during a deploy check).
import "dotenv/config";
const { db } = await import("./db.js");
const rows = db.prepare("SELECT id, name, applied_at FROM schema_migrations ORDER BY id").all();
for (const row of rows) console.log(`${row.id}\t${row.name}\t${row.applied_at}`);
db.close();
