import test from "node:test";
import assert from "node:assert/strict";
import { rmSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { useTempDatabase, makeClient } from "./helpers.js";

const { tempDir } = useTempDatabase();
process.env.APP_BASE_URL = "https://paceup.example";
const { buildApp } = await import("../src/server.js");
const { db } = await import("../src/db.js");
const { WhatsAppWorker } = await import("../src/whatsapp/worker.js");
const { fakeAdapter, fakeSessions } = await import("../src/whatsapp/fake-adapter.js");
const { messageText, pruneInbox } = await import("../src/whatsapp/inbox.js");
const app = await buildApp({ logger: false, authRateLimit: 1000 });
const { call, registerOwner } = makeClient(app);
const worker = new WhatsAppWorker({ adapter: fakeAdapter, dataDir: mkdtempSync(join(tmpdir(), "wa-")), log: {}, sendGapMs: [0, 1] });
const settle = () => new Promise((r) => setTimeout(r, 10));

const boss = await registerOwner("Amit Boss", "boss@example.com", "Pilot Club");
const other = await registerOwner("Other Owner", "other@example.com", "Other Club");
db.prepare("UPDATE users SET platform_role = 'super_admin' WHERE id = ?").run(boss.user.id);

async function link(club, phone) {
  assert.equal((await call("POST", `/api/clubs/${club.clubId}/whatsapp/connect`, { cookie: boss.cookie })).statusCode, 200);
  await worker.tick(); await settle();
  await fakeSessions.get(club.clubId).scan(phone); await settle();
  return fakeSessions.get(club.clubId);
}
const mcp = (link, body) => app.inject({ method: "POST", url: new URL(link).pathname, payload: body, headers: { "content-type": "application/json", accept: "application/json, text/event-stream" } });
const tool = async (link, name, args = {}) => (await mcp(link, { jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } })).json().result.content[0].text;

test.after(() => { worker.stop(); app.close(); rmSync(tempDir, { recursive: true, force: true }); });

test("only the PaceUp Admin can turn it on, and only for a linked number", async () => {
  const url = `/api/platform/clubs/${boss.clubId}/inbox`;
  assert.equal((await call("GET", url, { cookie: other.cookie })).statusCode, 403);
  assert.equal((await call("POST", url, { cookie: other.cookie })).statusCode, 403);
  assert.equal((await call("POST", url, { cookie: boss.cookie })).statusCode, 409);
  const off = (await call("GET", url, { cookie: boss.cookie })).json().inbox;
  assert.equal(off.on, false); assert.equal(off.link, null);
});

test("keeps messages only for the number it is on for, and the link reads them", async () => {
  const mine = await link(boss, "919811991191");
  const theirs = await link(other, "919800000002");
  // Before turning on: nothing is kept.
  mine.inbox({ chat_jid: "919000000001@s.whatsapp.net", sender_phone: "919000000001", sender_name: "Ravi", text: "before" });
  const on = (await call("POST", `/api/platform/clubs/${boss.clubId}/inbox`, { cookie: boss.cookie })).json().inbox;
  assert.equal(on.on, true);
  assert.match(on.link, /^https:\/\/paceup\.example\/api\/mcp\/[A-Za-z0-9_-]{30,}$/);
  mine.inbox({ chat_jid: "919000000001@s.whatsapp.net", sender_phone: "919000000001", sender_name: "Ravi Kumar", text: "Are we riding Sunday?" });
  mine.inbox({ chat_jid: "919000000001@s.whatsapp.net", from_me: true, text: "Yes, 6 AM" });
  db.prepare("UPDATE whatsapp_connections SET groups_json = ? WHERE club_id = ?").run(JSON.stringify([{ jid: "120363@g.us", name: "Sunday Squad", size: 9 }]), boss.clubId);
  mine.inbox({ chat_jid: "120363@g.us", is_group: true, sender_phone: "919000000003", sender_name: "Meera", text: "Puncture kit anyone?" });
  mine.inbox({ chat_jid: "77777@lid", chat_alt: "919000000004@s.whatsapp.net", sender_phone: "919000000004", sender_name: "Lid Person", text: "via lid" });
  theirs.inbox({ chat_jid: "919000000009@s.whatsapp.net", sender_name: "Not yours", text: "other club secret" });

  const rows = db.prepare("SELECT * FROM inbox_messages ORDER BY sent_at").all();
  assert.equal(rows.length, 4);
  assert.ok(rows.every((r) => r.club_id === boss.clubId));
  assert.ok(!rows.some((r) => r.text === "before"));
  assert.equal(rows.find((r) => r.text === "via lid").chat_jid, "919000000004@s.whatsapp.net");
  assert.equal(rows.find((r) => r.text === "Yes, 6 AM").chat_name, "Ravi Kumar");

  const init = (await mcp(on.link, { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } } })).json();
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal((await mcp(on.link, { jsonrpc: "2.0", method: "notifications/initialized" })).statusCode, 202);
  const tools = (await mcp(on.link, { jsonrpc: "2.0", id: 2, method: "tools/list" })).json().result.tools;
  assert.deepEqual(tools.map((t) => t.name), ["list_chats", "read_chat", "recent_messages", "search_messages"]);
  assert.ok(tools.every((t) => t.annotations.readOnlyHint));

  const chats = await tool(on.link, "list_chats");
  assert.match(chats, /Sunday Squad \(group\)/); assert.match(chats, /Ravi Kumar/);
  assert.doesNotMatch(chats, /other club/);
  const chat = await tool(on.link, "read_chat", { chat: "ravi" });
  assert.match(chat, /Ravi Kumar \(\+919000000001\): Are we riding Sunday\?/); assert.match(chat, /Me: Yes, 6 AM/);
  assert.match(await tool(on.link, "read_chat", { chat: "+91 90000 00001" }), /Yes, 6 AM/);
  const recent = await tool(on.link, "recent_messages");
  assert.doesNotMatch(recent, /Yes, 6 AM/); assert.match(recent, /Puncture kit/);
  assert.match(await tool(on.link, "recent_messages", { include_mine: true }), /Yes, 6 AM/);
  assert.match(await tool(on.link, "search_messages", { query: "PUNCTURE" }), /Meera/);
  assert.match(await tool(on.link, "search_messages", { query: "100%" }), /Nothing found/);
  const bad = (await mcp(on.link, { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "send_message", arguments: {} } })).json();
  assert.equal(bad.error.code, -32602);

  // A new link: the old one stops working at once, messages stay.
  const fresh = (await call("POST", `/api/platform/clubs/${boss.clubId}/inbox`, { cookie: boss.cookie })).json().inbox;
  assert.notEqual(fresh.link, on.link);
  assert.equal((await mcp(on.link, { jsonrpc: "2.0", id: 4, method: "tools/list" })).statusCode, 404);
  assert.equal(fresh.messages, 4);

  // Off: link dead and everything deleted.
  const off = (await call("DELETE", `/api/platform/clubs/${boss.clubId}/inbox`, { cookie: boss.cookie })).json().inbox;
  assert.equal(off.on, false);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM inbox_messages").get().n, 0);
  assert.equal((await mcp(fresh.link, { jsonrpc: "2.0", id: 5, method: "tools/list" })).statusCode, 404);
  assert.equal((await app.inject({ method: "POST", url: "/api/mcp/not-a-real-token-at-all-xyz", payload: {} })).statusCode, 404);
});

test("old messages are dropped after 30 days", () => {
  db.prepare("INSERT INTO inbox_messages (club_id, id, chat_jid, text, sent_at) VALUES (?, 'old', 'x@s.whatsapp.net', 'old', ?)").run(boss.clubId, new Date(Date.now() - 31 * 86400000).toISOString());
  db.prepare("INSERT INTO inbox_messages (club_id, id, chat_jid, text, sent_at) VALUES (?, 'new', 'x@s.whatsapp.net', 'new', ?)").run(boss.clubId, new Date().toISOString());
  assert.equal(pruneInbox(), 1);
  assert.deepEqual(db.prepare("SELECT id FROM inbox_messages").all().map((r) => r.id), ["new"]);
});

test("message text covers captions and media, and skips reactions", () => {
  assert.equal(messageText({ conversation: "hi" }), "hi");
  assert.equal(messageText({ ephemeralMessage: { message: { extendedTextMessage: { text: "wrapped" } } } }), "wrapped");
  assert.equal(messageText({ imageMessage: { caption: "route map" } }), "[photo] route map");
  assert.equal(messageText({ audioMessage: { ptt: true } }), "[voice note]");
  assert.equal(messageText({ reactionMessage: { text: "👍" } }), null);
  assert.equal(messageText({ protocolMessage: {} }), null);
});
