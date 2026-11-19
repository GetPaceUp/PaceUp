// Creating activities by chatting with the club's WhatsApp number.
//
// Only club admins are answered: they are recognised by the mobile number on
// their PaceUp account (or, for accounts without one, by a one-time LINK code
// sent from their WhatsApp). Everyone else is ignored. Each admin has at most one
// draft. Every message is read for details and merged into the draft; PaceUp
// asks for whatever is missing and publishes only after an explicit YES.
import { randomUUID, createHash, randomInt } from "node:crypto";
import { db, getClubMembership } from "../db.js";
import { createRide } from "../rides.js";
import { parseActivity, resolveAmPm, defaultTitle, zonedToUtc, titleFrom, bareAnswer, CATEGORY_LABEL, ACTIVITY_NOUN } from "./compose.js";
import { phoneFromJid } from "./contacts.js";
import { templateInText, listTemplates } from "../templates.js";
import { rideLink } from "./messages.js";
import { getConnection, knownGroups } from "./outbox.js";

const TZ = () => process.env.PACEUP_TIMEZONE || "Asia/Kolkata";
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const DRAFT_TTL_MS = 30 * 60 * 1000; // a half-finished draft is dropped after 30 quiet minutes
const CODE_TTL_MS = 15 * 60 * 1000;
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
const hashCode = (code) => createHash("sha256").update(`wa-link:${code.toUpperCase()}`).digest("hex");

/** "Create a ride", or a message that names an activity with its day and time. */
const isRequest = (text) => ACTIVITY_NOUN.test(text) && (/\b(create|new|add|post|schedule|plan|organi[sz]e|set up|setup)\b/i.test(text)
  || (() => { const f = parseActivity(text, { tz: TZ() }); return Boolean(f.date && (f.time || f.time_ambiguous)); })());
const EXAMPLE = "Create a run this Sunday at 6 AM from Tulip Chowk, 10 km";
// The club number may be someone's own phone, so casual words ("ok", 👍) never publish.
const YES = /^\s*(yes|y|yep|yeah|yup|confirm|publish|publish it|✅)\s*[.!]*\s*$/i;
const NO = /^\s*(no|n|nope|cancel|stop|discard|delete|scrap it|forget it|❌)\s*[.!]*\s*$/i;
const HELP = /^\s*(help|\?|menu)\s*[.!]*\s*$/i;
const CALL = /^\s*paceup\b[\s,:!.-]*(help|menu|hi|hello)?\s*[.!?]*\s*$/i; // "PaceUp" on its own wakes the assistant
const NEW = /^\s*(new|start over|restart|reset)\s*[.!]*\s*$/i;

// ---------------------------------------------------------------- admin linking

/** Issues a one-time code the admin sends from their own WhatsApp to the club number. */
export function createLinkCode(clubId, userId) {
  const code = Array.from({ length: 6 }, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join("");
  const now = iso();
  db.prepare(`
    INSERT INTO whatsapp_admins (id, club_id, user_id, code_hash, code_expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (club_id, user_id) DO UPDATE SET code_hash = excluded.code_hash, code_expires_at = excluded.code_expires_at
  `).run(randomUUID(), clubId, userId, hashCode(code), iso(Date.now() + CODE_TTL_MS), now);
  return { code, expires_at: iso(Date.now() + CODE_TTL_MS) };
}

export function listLinkedAdmins(clubId) {
  return db.prepare(`
    SELECT wa.user_id, u.name, wa.linked_at FROM whatsapp_admins wa INNER JOIN users u ON u.id = wa.user_id
    INNER JOIN club_memberships cm ON cm.club_id = wa.club_id AND cm.user_id = wa.user_id AND cm.role IN ('owner', 'admin')
    WHERE wa.club_id = ? AND wa.linked_at IS NOT NULL ORDER BY u.name
  `).all(clubId);
}

export function unlinkAdmin(clubId, userId) {
  db.prepare("DELETE FROM whatsapp_admins WHERE club_id = ? AND user_id = ?").run(clubId, userId);
  db.prepare("DELETE FROM whatsapp_drafts WHERE club_id = ? AND user_id = ?").run(clubId, userId);
}

function linkSender(clubId, code, from, fromAlt) {
  const row = db.prepare("SELECT * FROM whatsapp_admins WHERE club_id = ? AND code_hash = ? AND code_expires_at > ?").get(clubId, hashCode(code), iso());
  if (!row) return null;
  return db.transaction(() => {
    // One WhatsApp account belongs to one admin per club.
    db.prepare("UPDATE whatsapp_admins SET jid = NULL, jid_alt = NULL, linked_at = NULL WHERE club_id = ? AND id != ? AND (jid IN (?, ?) OR jid_alt IN (?, ?))")
      .run(clubId, row.id, from, fromAlt || from, from, fromAlt || from);
    db.prepare("UPDATE whatsapp_admins SET jid = ?, jid_alt = ?, linked_at = ?, code_hash = NULL, code_expires_at = NULL WHERE id = ?").run(from, fromAlt || null, iso(), row.id);
    return row.user_id;
  }).immediate();
}

/** The linked admin who sent this message, if they are still an admin of the club. */
function senderAdmin(clubId, from, fromAlt) {
  const ids = [from, fromAlt].filter(Boolean);
  const linked = db.prepare(`SELECT user_id FROM whatsapp_admins WHERE club_id = ? AND linked_at IS NOT NULL AND (jid IN (${ids.map(() => "?").join(",")}) OR jid_alt IN (${ids.map(() => "?").join(",")}))`)
    .get(clubId, ...ids, ...ids);
  const candidates = linked ? [linked.user_id] : [];
  // No login needed: an admin is known by the mobile number on their PaceUp account.
  const phones = ids.map(phoneFromJid).filter(Boolean);
  if (phones.length) {
    for (const u of db.prepare(`SELECT id FROM users WHERE phone IN (${phones.map(() => "?").join(",")})`).all(...phones)) candidates.push(u.id);
  }
  for (const userId of candidates) {
    const membership = getClubMembership(clubId, userId);
    if (membership && ["owner", "admin"].includes(membership.role)) return { userId, clubName: membership.name };
  }
  return null;
}

// ---------------------------------------------------------------- drafts

function loadDraft(clubId, userId) {
  const row = db.prepare("SELECT draft, updated_at FROM whatsapp_drafts WHERE club_id = ? AND user_id = ?").get(clubId, userId);
  if (!row || Date.now() - new Date(row.updated_at).getTime() > DRAFT_TTL_MS) return null;
  return JSON.parse(row.draft);
}
function saveDraft(clubId, userId, draft) {
  db.prepare(`INSERT INTO whatsapp_drafts (club_id, user_id, draft, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT (club_id, user_id) DO UPDATE SET draft = excluded.draft, updated_at = excluded.updated_at`).run(clubId, userId, JSON.stringify(draft), iso());
}
const dropDraft = (clubId, userId) => db.prepare("DELETE FROM whatsapp_drafts WHERE club_id = ? AND user_id = ?").run(clubId, userId);

const startsAt = (draft) => (draft.date && draft.time ? zonedToUtc(draft.date, draft.time, TZ()) : null);
const timeText = (time) => new Date(`2000-01-01T${time}:00Z`).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", timeZone: "UTC" });
const dateText = (date) => new Date(`${date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short", timeZone: "UTC" });

function summary(draft) {
  const lines = [`*${draft.title || defaultTitle(draft)}*`];
  if (draft.date) lines.push(`📅 ${dateText(draft.date)}`);
  if (draft.time) lines.push(`⏰ ${timeText(draft.time)}`);
  if (draft.location) lines.push(`📍 ${draft.location}`);
  if (draft.map_url) lines.push(`🗺️ ${draft.map_url}`);
  if (draft.distance_km) lines.push(`📏 ${draft.distance_km} km`);
  if (draft.pace) lines.push(`⏱️ ${draft.pace}`);
  if (draft.capacity) lines.push(`👥 ${draft.capacity} spots`);
  if (draft.notes) lines.push(`📝 ${draft.notes}`);
  return lines.join("\n");
}

/** What to ask next, or null when the draft is complete and in the future. */
const isEmpty = (draft) => !Object.keys(draft).some((k) => k !== "category");
const noun = (draft) => CATEGORY_LABEL[draft.category || "other"].toLowerCase();

function nextQuestion(draft) {
  if (!draft.date && !draft.title) return `What's the ${noun(draft)} called, and which day and time? (e.g. "Sunday Morning ${CATEGORY_LABEL[draft.category || "other"]}, 22 Nov, 6:30 AM")`;
  if (!draft.date) return "Which day? (e.g. Sunday, tomorrow or 23 Nov)";
  if (draft.time_ambiguous && !draft.time) return `Is ${draft.time_ambiguous} in the morning or evening? Reply *AM* or *PM*.`;
  if (!draft.time) return "What time does it start? (e.g. 6 AM)";
  if (!draft.location) return "Where are we meeting? (e.g. Tulip Chowk, 60 km)";
  if (startsAt(draft).getTime() <= Date.now()) return "That date and time has already passed. Send a new day or time.";
  return null;
}

function draftReply(draft, lead) {
  const question = nextQuestion(draft);
  if (isEmpty(draft)) return `Great! Let's get your ${noun(draft)} published. ${question}\n\nReply *CANCEL* to stop.`;
  if (question) return `${lead}\n\n${summary(draft)}\n\n${question}\n\nReply *CANCEL* to discard.`;
  return `${lead.startsWith("Using") ? `${lead.replace(/:$/, ".")} ` : ""}I have the following activity ready:\n\n${summary(draft)}\n\nShould I publish it? Reply *YES* to publish, or send a change (e.g. "time 6:30 AM", "change location to Hebbal flyover"). Reply *CANCEL* to discard.`;
}

let currentClub = null; // set per message, so help can list this club's templates
const helpText = (clubName) => {
  const names = currentClub ? listTemplates(currentClub).map((t) => t.name).slice(0, 8) : [];
  const tpl = names.length ? `\n\nOr start from a saved template: *${names.join("*, *")}*. For example "${names[0]} Sunday 6 AM".` : "";
  return `Hi! I can create ${clubName} activities for you. Send the details in one message, for example:\n\n"${EXAMPLE}"${tpl}\n\nI'll ask for anything missing and check with you before publishing.`;
};

const groupStillThere = (clubId, jid) => (jid && knownGroups(getConnection(clubId)).some((g) => g.jid === jid) ? jid : null);

function publishDraft(clubId, userId, draft) {
  const ride = createRide(clubId, userId, {
    title: draft.title || defaultTitle(draft), category: draft.category || "other",
    starts_at: startsAt(draft).toISOString(), meeting_point: draft.location,
    distance_km: draft.distance_km ?? null, capacity: draft.capacity ?? null, notes: draft.notes ?? null,
    map_url: draft.map_url ?? null, pace: draft.pace ?? null, wa_group_jid: groupStillThere(clubId, draft.wa_group_jid), status: "published"
  }, { actorType: "whatsapp" });
  dropDraft(clubId, userId);
  const conn = getConnection(clubId);
  const autoPost = conn?.desired === "on" && conn.group_jid && conn.post_new_ride;
  return [
    `✅ ${CATEGORY_LABEL[ride.category] || "Activity"} created!`,
    "",
    summary({ ...draft, title: ride.title }),
    "",
    `RSVP link: ${rideLink(ride)}`,
    "",
    autoPost ? `I'll post it in ${knownGroups(conn).find((g) => g.jid === ride.wa_group_jid)?.name || conn.group_name || "the club group"} in a moment. You can also forward the link.` : "Forward this link to the group."
  ].join("\n");
}

// ---------------------------------------------------------------- entry point

/**
 * Handles one incoming direct message to a club's number. Returns the reply text,
 * or null to stay silent. Each message id is handled at most once.
 * msg: { id, from, fromAlt?, text }
 */
export function handleIncoming(clubId, msg) {
  currentClub = clubId;
  const text = String(msg.text || "").trim().slice(0, 1000);
  if (!text || !msg.from) return null;
  // Only messages meant for PaceUp are looked at further (the club phone may also be someone's own phone).
  const link = text.match(/^\s*link\s+([A-Za-z0-9]{6})\s*$/i);
  const admin = link ? null : senderAdmin(clubId, msg.from, msg.fromAlt);
  if (!link && !admin) return null; // members and strangers get no bot replies
  const template = admin ? templateInText(clubId, text) : null;
  const asks = (t) => isRequest(t) || (template && (/\b(create|new|add|post|schedule|plan)\b/i.test(t) || (() => { const f = parseActivity(t, { tz: TZ() }); return Boolean(f.date || f.time || f.time_ambiguous); })()));
  if (admin && !CALL.test(text) && !asks(text) && !loadDraft(clubId, admin.userId)) return null;
  if (msg.id) {
    const fresh = db.prepare("INSERT OR IGNORE INTO whatsapp_inbound (club_id, message_id, created_at) VALUES (?, ?, ?)").run(clubId, msg.id, iso()).changes;
    if (!fresh) return null;
  }

  if (link) {
    const userId = linkSender(clubId, link[1], msg.from, msg.fromAlt);
    if (!userId) return "That code didn't work. Codes expire after 15 minutes. Get a new one in PaceUp under WhatsApp, then send it again.";
    const club = db.prepare("SELECT name FROM clubs WHERE id = ?").get(clubId);
    return `✅ Linked. You can now create ${club.name} activities by messaging this number.\n\nTry: "${EXAMPLE}"`;
  }


  const { userId, clubName } = admin;
  let draft = loadDraft(clubId, userId);

  // With no draft open, only an obvious request starts a chat; anything else is the admin's own conversation.
  if (!draft && !CALL.test(text) && !asks(text)) return null;
  if (CALL.test(text) || HELP.test(text)) return draft ? draftReply(draft, "We're working on this activity:") : helpText(clubName);
  if (NO.test(text)) {
    if (!draft) return "Nothing to cancel. Send new activity details whenever you're ready.";
    dropDraft(clubId, userId);
    return "Discarded. Nothing was published.";
  }
  if (YES.test(text)) {
    if (!draft) return `There's nothing waiting to publish. ${helpText(clubName)}`;
    const question = nextQuestion(draft);
    if (question) return `Not yet, one detail is missing.\n\n${summary(draft)}\n\n${question}`;
    return publishDraft(clubId, userId, draft);
  }
  if (NEW.test(text)) { dropDraft(clubId, userId); return `Starting over. ${helpText(clubName)}`; }

  const tz = TZ();
  const found = parseActivity(text, { tz });
  // A saved template named in the message ("Pandala Sunday 6am") fills in everything but the date and time.
  if (template) {
    const from = { template: template.name, title: template.title, category: template.category, location: template.meeting_point, map_url: template.map_url,
      distance_km: template.distance_km, pace: template.pace, notes: template.notes, capacity: template.capacity, wa_group_jid: template.wa_group_jid };
    for (const [k, v] of Object.entries(from)) if (v != null && v !== "" && found[k] == null) found[k] = v;
    if (draft?.category) draft.category = found.category || draft.category;
  }
  const title = titleFrom(text);
  if (title && !found.title && (!draft || !draft.title)) found.title = title;
  // A bare reply to "Where are we meeting?" is the place.
  const merged = { ...(draft || {}), ...found };
  const amPmReply = Boolean(draft?.time_ambiguous && !draft.time && resolveAmPm(text, draft.time_ambiguous));
  if (!merged.location && merged.date && (merged.time || merged.time_ambiguous) && !amPmReply) {
    const place = bareAnswer(text, { tz });
    if (place && !(title && place === title)) found.location = place;
  }
  if (draft?.time_ambiguous && !draft.time && !found.time) {
    const resolved = resolveAmPm(text, draft.time_ambiguous);
    if (resolved) { found.time = resolved; delete draft.time_ambiguous; }
  }
  const learned = Object.keys(found).filter((k) => k !== "category" || !draft);
  if (!draft && !learned.some((k) => k !== "category") && !/\b(create|new|add|post|schedule|plan|organi[sz]e)\b/i.test(text)) {
    return helpText(clubName);
  }
  if (draft && !learned.length) {
    return `Sorry, I didn't catch a change there. Here's the activity so far:\n\n${summary(draft)}\n\n${nextQuestion(draft) || "Reply *YES* to publish, or *CANCEL* to discard."}`;
  }

  const isNew = !draft;
  if (draft?.category && !template) delete found.category; // the sport is set by the first message (or a template)
  draft = { ...(draft || {}), ...found };
  if (found.time) delete draft.time_ambiguous;
  if (found.time_ambiguous) delete draft.time;
  saveDraft(clubId, userId, draft);
  return draftReply(draft, template ? `Using your *${template.name}* template:` : isNew ? "Got it. Here's what I have so far:" : "Updated:");
}
