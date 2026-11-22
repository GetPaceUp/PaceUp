import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { useTempDatabase, makeClient } from "./helpers.js";

const { file } = useTempDatabase();
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const app = await buildApp({ logger: false, authRateLimit: 1000 });
const { registerOwner } = makeClient(app);
const script = fileURLToPath(new URL("../../../deploy/notify.cjs", import.meta.url));
const notify = (text) => { try { execFileSync("node", [script, text], { env: { ...process.env, PACEUP_DB: file }, stdio: "pipe" }); return true; } catch { return false; } };
const link = (clubId, phone, seen) => db.prepare("INSERT OR REPLACE INTO whatsapp_connections (club_id, desired, status, phone, last_seen_at, updated_at) VALUES (?, 'on', 'connected', ?, ?, ?)").run(clubId, phone, seen, seen);
const sentFrom = () => db.prepare("SELECT club_id, to_phone FROM whatsapp_direct ORDER BY created_at").all();

const boss = await registerOwner("Boss Owner", "boss@example.com", "House Club");
db.prepare("UPDATE users SET platform_role = 'super_admin', phone = '919811991181' WHERE id = ?").run(boss.user.id);
const other = await registerOwner("Raghu", "raghu@example.com", "Gurgaon Cyclists");

test("deploy notes never go out from another club's number", () => {
  link(other.clubId, "919910041077", new Date().toISOString());
  assert.equal(notify("✅ test"), false);
  assert.deepEqual(sentFrom(), []);
});

test("deploy notes go out from a club the PaceUp Admin owns, even if another club was seen more recently", () => {
  link(boss.clubId, "919800000000", new Date(Date.now() - 3600e3).toISOString());
  assert.equal(notify("✅ test"), true);
  assert.deepEqual(sentFrom(), [{ club_id: boss.clubId, to_phone: "919811991181" }]);
});
