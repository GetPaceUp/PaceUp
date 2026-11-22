// "Read with Claude": a private, read-only window onto one linked number's WhatsApp messages.
// The PaceUp Admin turns it on for a club's number; the worker then keeps that number's
// messages (chats and groups, text only) for 30 days, and a secret connector link lets
// the admin's own Claude chats list, read and search them. Nothing here can send.
import { randomBytes } from "node:crypto";
import { db } from "../db.js";
import { phoneFromJid } from "./contacts.js";

export const INBOX_KEEP_DAYS = 30;
const MAX_TEXT = 4000;
const iso = (ms) => new Date(ms).toISOString();

const onCache = new Map(); // clubId -> { on, at }
/** Is the inbox on for this club? Cached for 15 seconds: it's checked on every message. */
export function inboxOn(clubId) {
  const hit = onCache.get(clubId);
  if (hit && Date.now() - hit.at < 15000) return hit.on;
  const on = Boolean(db.prepare("SELECT inbox_on_at FROM whatsapp_connections WHERE club_id = ?").get(clubId)?.inbox_on_at);
  onCache.set(clubId, { on, at: Date.now() });
  return on;
}

/** The readable text of a WhatsApp message, or null for things that aren't messages (reactions, edits, receipts). */
export function messageText(message) {
  let m = message || {};
  for (let i = 0; i < 4; i++) {
    const inner = m.ephemeralMessage?.message || m.viewOnceMessage?.message || m.viewOnceMessageV2?.message || m.documentWithCaptionMessage?.message || m.editedMessage?.message;
    if (!inner) break;
    m = inner;
  }
  if (m.conversation) return m.conversation;
  if (m.extendedTextMessage?.text) return m.extendedTextMessage.text;
  const caption = (label, x) => (x?.caption ? `[${label}] ${x.caption}` : `[${label}]`);
  if (m.imageMessage) return caption("photo", m.imageMessage);
  if (m.videoMessage) return caption(m.videoMessage.gifPlayback ? "GIF" : "video", m.videoMessage);
  if (m.documentMessage) return `[document: ${m.documentMessage.fileName || "file"}]${m.documentMessage.caption ? ` ${m.documentMessage.caption}` : ""}`;
  if (m.audioMessage) return m.audioMessage.ptt ? "[voice note]" : "[audio]";
  if (m.stickerMessage) return "[sticker]";
  if (m.locationMessage || m.liveLocationMessage) {
    const l = m.locationMessage || m.liveLocationMessage;
    return `[location${l.name ? `: ${l.name}` : ""}] https://maps.google.com/?q=${l.degreesLatitude},${l.degreesLongitude}`;
  }
  if (m.contactMessage) return `[contact: ${m.contactMessage.displayName || "card"}]`;
  if (m.contactsArrayMessage) return `[contacts: ${m.contactsArrayMessage.displayName || "cards"}]`;
  if (m.pollCreationMessage || m.pollCreationMessageV3) {
    const p = m.pollCreationMessage || m.pollCreationMessageV3;
    return `[poll] ${p.name}${p.options?.length ? ` (${p.options.map((o) => o.optionName).join(" / ")})` : ""}`;
  }
  if (m.buttonsResponseMessage?.selectedDisplayText) return m.buttonsResponseMessage.selectedDisplayText;
  if (m.listResponseMessage?.title) return m.listResponseMessage.title;
  return null;
}

/** Saves one message (called by the worker for clubs with the inbox on). Duplicates are ignored. */
export function saveInboxMessage(clubId, msg) {
  if (!msg?.id || !msg.chat_jid || !msg.text) return false;
  const r = db.prepare(`INSERT OR IGNORE INTO inbox_messages (club_id, id, chat_jid, chat_name, is_group, sender_phone, sender_name, from_me, text, sent_at)
    VALUES (@club_id, @id, @chat_jid, @chat_name, @is_group, @sender_phone, @sender_name, @from_me, @text, @sent_at)`).run({
    club_id: clubId, id: String(msg.id), chat_jid: msg.chat_jid, chat_name: msg.chat_name || null, is_group: msg.is_group ? 1 : 0,
    sender_phone: msg.sender_phone || null, sender_name: msg.sender_name || null, from_me: msg.from_me ? 1 : 0,
    text: String(msg.text).slice(0, MAX_TEXT), sent_at: msg.sent_at || iso(Date.now())
  });
  return r.changes > 0;
}

/** Drops messages older than 30 days. */
export function pruneInbox(now = Date.now()) {
  return db.prepare("DELETE FROM inbox_messages WHERE sent_at < ?").run(iso(now - INBOX_KEEP_DAYS * 86400000)).changes;
}

// ---- Super Admin switch

export function inboxStatus(clubId, baseUrl) {
  const c = db.prepare("SELECT inbox_token, inbox_on_at FROM whatsapp_connections WHERE club_id = ?").get(clubId);
  const on = Boolean(c?.inbox_on_at);
  const n = on ? db.prepare("SELECT COUNT(*) AS n, MAX(sent_at) AS last FROM inbox_messages WHERE club_id = ?").get(clubId) : null;
  return { on, link: on && c.inbox_token ? `${baseUrl}/api/mcp/${c.inbox_token}` : null, messages: n?.n || 0, last_at: n?.last || null, keep_days: INBOX_KEEP_DAYS };
}

export function turnInboxOn(clubId) {
  const token = randomBytes(24).toString("base64url");
  db.prepare("UPDATE whatsapp_connections SET inbox_token = ?, inbox_on_at = COALESCE(inbox_on_at, ?) WHERE club_id = ?").run(token, iso(Date.now()), clubId);
  onCache.delete(clubId);
}

/** Off: the link stops working and every saved message is deleted. */
export function turnInboxOff(clubId) {
  db.transaction(() => {
    db.prepare("UPDATE whatsapp_connections SET inbox_token = NULL, inbox_on_at = NULL WHERE club_id = ?").run(clubId);
    db.prepare("DELETE FROM inbox_messages WHERE club_id = ?").run(clubId);
  })();
  onCache.delete(clubId);
}

// ---- What the connector can read

const local = (s) => new Date(s).toLocaleString("en-IN", { timeZone: process.env.PACEUP_TIMEZONE || "Asia/Kolkata", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const who = (m) => (m.from_me ? "Me" : m.sender_name ? `${m.sender_name}${m.sender_phone ? ` (+${m.sender_phone})` : ""}` : m.sender_phone ? `+${m.sender_phone}` : "Someone");
const chatLabel = (m) => m.chat_name || (m.is_group ? "Unnamed group" : `+${phoneFromJid(m.chat_jid) || m.chat_jid}`);
// Across chats, groups are named and a private chat is just its person ("Me → Ravi" for my own replies).
const line = (m, withChat = false) => `[${local(m.sent_at)}] ${!withChat ? "" : m.is_group ? `${chatLabel(m)} (group) · ` : ""}${withChat && m.from_me && !m.is_group ? `Me → ${chatLabel(m)}` : who(m)}: ${m.text}`;
const clamp = (v, lo, hi, d) => { const n = Number(v); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, Math.floor(n))) : d; };
const since = (hours) => iso(Date.now() - hours * 3600000);
const escapeLike = (s) => String(s).replace(/[\\%_]/g, (c) => `\\${c}`);

function findChat(clubId, chat) {
  const q = String(chat || "").trim();
  if (!q) return { error: "Say which chat: its name, a phone number, or the chat id from list_chats." };
  const digits = q.replace(/\D/g, "");
  const exact = db.prepare("SELECT chat_jid FROM inbox_messages WHERE club_id = ? AND (chat_jid = ? OR lower(chat_name) = lower(?)) ORDER BY sent_at DESC LIMIT 1").get(clubId, q, q);
  if (exact) return { jid: exact.chat_jid };
  if (digits.length >= 7) {
    const byPhone = db.prepare("SELECT chat_jid FROM inbox_messages WHERE club_id = ? AND is_group = 0 AND (chat_jid LIKE ? ESCAPE '\\' OR sender_phone LIKE ? ESCAPE '\\') ORDER BY sent_at DESC LIMIT 1")
      .get(clubId, `%${escapeLike(digits.slice(-10))}@%`, `%${escapeLike(digits.slice(-10))}`);
    if (byPhone) return { jid: byPhone.chat_jid };
  }
  const like = db.prepare(`SELECT chat_jid, chat_name, MAX(sent_at) AS last FROM inbox_messages WHERE club_id = ? AND lower(chat_name) LIKE lower(?) ESCAPE '\\'
    GROUP BY chat_jid ORDER BY last DESC LIMIT 6`).all(clubId, `%${escapeLike(q)}%`);
  if (like.length === 1) return { jid: like[0].chat_jid };
  if (like.length > 1) return { error: `More than one chat matches "${q}": ${like.map((c) => `${c.chat_name} (${c.chat_jid})`).join("; ")}. Use the chat id.` };
  return { error: `No chat matching "${q}" in the last ${INBOX_KEEP_DAYS} days.` };
}

export const INBOX_TOOLS = [
  {
    name: "list_chats",
    description: "List WhatsApp chats and groups on this number with recent messages, newest first, with each chat's last message. Read-only.",
    inputSchema: { type: "object", properties: {
      hours: { type: "number", description: "Only chats with messages in the last N hours (default 72, max 720)." },
      groups: { type: "string", enum: ["all", "only", "none"], description: "Include groups (default all)." },
      limit: { type: "number", description: "Max chats (default 30, max 100)." }
    } }
  },
  {
    name: "read_chat",
    description: "Read the messages of one WhatsApp chat or group, oldest to newest. 'Me' is the number's owner. Read-only.",
    inputSchema: { type: "object", required: ["chat"], properties: {
      chat: { type: "string", description: "Chat name, phone number, or chat id from list_chats." },
      limit: { type: "number", description: "How many of the latest messages (default 50, max 300)." },
      before: { type: "string", description: "Only messages before this ISO time, to page back." }
    } }
  },
  {
    name: "recent_messages",
    description: "All WhatsApp messages on this number in the last N hours, across chats, newest last. Good for 'what came in today?'. Read-only.",
    inputSchema: { type: "object", properties: {
      hours: { type: "number", description: "Look back N hours (default 24, max 720)." },
      groups: { type: "string", enum: ["all", "only", "none"], description: "Include group messages (default all)." },
      include_mine: { type: "boolean", description: "Include messages sent from this number (default false)." },
      limit: { type: "number", description: "Max messages (default 200, max 500)." }
    } }
  },
  {
    name: "search_messages",
    description: "Search this number's WhatsApp messages (last 30 days) for words or a phrase. Read-only.",
    inputSchema: { type: "object", required: ["query"], properties: {
      query: { type: "string", description: "Text to find (case-insensitive)." },
      chat: { type: "string", description: "Optional: only in this chat (name, number or id)." },
      limit: { type: "number", description: "Max results (default 50, max 200)." }
    } }
  }
];

const groupFilter = (g) => (g === "only" ? " AND is_group = 1" : g === "none" ? " AND is_group = 0" : "");

export function runInboxTool(clubId, name, args = {}) {
  if (name === "list_chats") {
    const hours = clamp(args.hours, 1, 720, 72), limit = clamp(args.limit, 1, 100, 30);
    const rows = db.prepare(`SELECT chat_jid, MAX(chat_name) AS chat_name, MAX(is_group) AS is_group, COUNT(*) AS n, SUM(from_me = 0) AS incoming, MAX(sent_at) AS last
      FROM inbox_messages WHERE club_id = ? AND sent_at >= ?${groupFilter(args.groups)} GROUP BY chat_jid ORDER BY last DESC LIMIT ?`).all(clubId, since(hours), limit);
    if (!rows.length) return `No messages in the last ${hours} hours.`;
    const lastOf = db.prepare("SELECT * FROM inbox_messages WHERE club_id = ? AND chat_jid = ? ORDER BY sent_at DESC LIMIT 1");
    return rows.map((c) => {
      const m = lastOf.get(clubId, c.chat_jid);
      const label = `${chatLabel(c)}${c.is_group ? " (group)" : ""}`;
      return `${label} · id ${c.chat_jid} · ${c.incoming} in, ${c.n - c.incoming} sent · last ${line(m)}`;
    }).join("\n");
  }
  if (name === "read_chat") {
    const found = findChat(clubId, args.chat);
    if (found.error) return found.error;
    const limit = clamp(args.limit, 1, 300, 50);
    const before = args.before && !Number.isNaN(Date.parse(args.before)) ? iso(Date.parse(args.before)) : "9999";
    const rows = db.prepare("SELECT * FROM inbox_messages WHERE club_id = ? AND chat_jid = ? AND sent_at < ? ORDER BY sent_at DESC LIMIT ?").all(clubId, found.jid, before, limit).reverse();
    if (!rows.length) return "No messages in that chat for that time.";
    const head = `${chatLabel(rows[0])}${rows[0].is_group ? " (group)" : ""} · ${rows.length} messages from ${local(rows[0].sent_at)} (to page back, pass before: "${rows[0].sent_at}")`;
    return [head, ...rows.map((m) => line(m))].join("\n");
  }
  if (name === "recent_messages") {
    const hours = clamp(args.hours, 1, 720, 24), limit = clamp(args.limit, 1, 500, 200);
    const rows = db.prepare(`SELECT * FROM inbox_messages WHERE club_id = ? AND sent_at >= ?${groupFilter(args.groups)}${args.include_mine ? "" : " AND from_me = 0"}
      ORDER BY sent_at DESC LIMIT ?`).all(clubId, since(hours), limit).reverse();
    if (!rows.length) return `No messages in the last ${hours} hours.`;
    return rows.map((m) => line(m, true)).join("\n");
  }
  if (name === "search_messages") {
    const q = String(args.query || "").trim();
    if (!q) return "Give some text to search for.";
    let chatSql = "", params = [clubId, `%${escapeLike(q)}%`];
    if (args.chat) {
      const found = findChat(clubId, args.chat);
      if (found.error) return found.error;
      chatSql = " AND chat_jid = ?"; params.push(found.jid);
    }
    const limit = clamp(args.limit, 1, 200, 50);
    const rows = db.prepare(`SELECT * FROM inbox_messages WHERE club_id = ? AND lower(text) LIKE lower(?) ESCAPE '\\'${chatSql} ORDER BY sent_at DESC LIMIT ?`).all(...params, limit);
    if (!rows.length) return `Nothing found for "${q}".`;
    return rows.map((m) => line(m, true)).join("\n");
  }
  return null;
}

// ---- Routes

const MCP_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];

export function registerInboxRoutes(app, { requirePlatformAdmin, baseUrl }) {
  const params = { type: "object", properties: { clubId: { type: "string", format: "uuid" } }, required: ["clubId"] };
  const pre = [app.authenticate, requirePlatformAdmin];
  const base = "/api/platform/clubs/:clubId/inbox";
  const connected = (clubId) => db.prepare("SELECT status FROM whatsapp_connections WHERE club_id = ? AND desired = 'on'").get(clubId);

  app.get(base, { schema: { params }, preHandler: pre }, async (req) => ({ inbox: inboxStatus(req.params.clubId, baseUrl) }));
  // On, or "New link" when already on: the old link stops working at once; saved messages stay.
  app.post(base, { schema: { params }, preHandler: pre }, async (req, reply) => {
    if (!connected(req.params.clubId)) return reply.code(409).send({ error: "Link this club's WhatsApp number first." });
    turnInboxOn(req.params.clubId);
    return { inbox: inboxStatus(req.params.clubId, baseUrl) };
  });
  app.delete(base, { schema: { params }, preHandler: pre }, async (req) => {
    turnInboxOff(req.params.clubId);
    return { inbox: inboxStatus(req.params.clubId, baseUrl) };
  });

  // The connector itself: Model Context Protocol over plain HTTP (JSON-RPC, no sessions, no streaming).
  // The secret in the path is the only key, so wrong ones get a bare 404.
  const tokenParams = { type: "object", properties: { token: { type: "string", minLength: 20, maxLength: 64, pattern: "^[A-Za-z0-9_-]+$" } }, required: ["token"] };
  const clubFor = (token) => db.prepare("SELECT club_id FROM whatsapp_connections WHERE inbox_token = ? AND inbox_on_at IS NOT NULL").get(token)?.club_id;
  const limit = { rateLimit: { max: 120, timeWindow: "1 minute" } };
  const notFound = (reply) => reply.code(404).send({ error: "Not found" });

  app.get("/api/mcp/:token", { schema: { params: tokenParams }, config: limit }, async (req, reply) => {
    if (!clubFor(req.params.token)) return notFound(reply);
    return reply.code(405).header("Allow", "POST").send({ error: "Use POST" });
  });
  app.delete("/api/mcp/:token", { schema: { params: tokenParams }, config: limit }, async (req, reply) => reply.code(clubFor(req.params.token) ? 204 : 404).send());
  app.post("/api/mcp/:token", { schema: { params: tokenParams }, config: limit }, async (req, reply) => {
    const clubId = clubFor(req.params.token);
    if (!clubId) return notFound(reply);
    reply.header("Cache-Control", "no-store");
    const handle = (msg) => {
      if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0" || typeof msg.method !== "string") {
        return { jsonrpc: "2.0", id: msg?.id ?? null, error: { code: -32600, message: "Invalid request" } };
      }
      if (msg.id === undefined || msg.id === null) return null; // a notification: nothing to answer
      const ok = (result) => ({ jsonrpc: "2.0", id: msg.id, result });
      switch (msg.method) {
        case "initialize": {
          const asked = msg.params?.protocolVersion;
          return ok({
            protocolVersion: MCP_VERSIONS.includes(asked) ? asked : MCP_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: "paceup-whatsapp-inbox", title: "WhatsApp inbox", version: "1.0.0" },
            instructions: `Read-only access to WhatsApp messages received on one number (last ${INBOX_KEEP_DAYS} days, text only). It cannot send messages. Times are India time.`
          });
        }
        case "ping": return ok({});
        case "tools/list": return ok({ tools: INBOX_TOOLS.map((t) => ({ ...t, annotations: { readOnlyHint: true, openWorldHint: false } })) });
        case "tools/call": {
          const name = msg.params?.name;
          if (!INBOX_TOOLS.some((t) => t.name === name)) return { jsonrpc: "2.0", id: msg.id, error: { code: -32602, message: `Unknown tool ${name}` } };
          try { return ok({ content: [{ type: "text", text: runInboxTool(clubId, name, msg.params?.arguments || {}) }] }); }
          catch (error) { req.log.error(error); return ok({ content: [{ type: "text", text: "Could not read messages just now. Try again." }], isError: true }); }
        }
        case "resources/list": return ok({ resources: [] });
        case "prompts/list": return ok({ prompts: [] });
        default: return { jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
      }
    };
    const body = req.body;
    if (Array.isArray(body)) {
      const out = body.map(handle).filter(Boolean);
      return out.length ? reply.send(out) : reply.code(202).send();
    }
    const out = handle(body);
    return out ? reply.send(out) : reply.code(202).send();
  });
}
