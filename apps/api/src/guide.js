/**
 * First-time guide: helps a new club owner or admin get their first activity out, and shows the
 * PaceUp Admin where people drop off.
 *
 * - A "Getting started" card and one-line tips, until the person's first activity has someone joining.
 *   Anyone who has already published an activity with a joiner never sees them.
 * - One WhatsApp nudge, ever, from the club's own number, to an admin added 3+ days ago with no activity.
 * - One phone alert when the first person joins their first activity.
 * - A step log (first_steps) and a "Getting started" funnel for the PaceUp Admin.
 */
import { randomUUID } from "node:crypto";
import { db } from "./db.js";
import { queuePush } from "./push.js";

const DAY = 24 * 60 * 60 * 1000;
/** An admin with no activity this long after being added gets their one nudge... */
export const NUDGE_AFTER_MS = 3 * DAY;
/** ...unless it's been longer than this (e.g. the worker was down): then it's skipped for good. */
const NUDGE_GIVE_UP_MS = 14 * DAY;
const QUIET_START = 22, QUIET_END = 7;
export const TIPS = ["dash", "form"];
export const MEMBER_STEPS = ["m_opened", "m_tapped", "m_joined"];

const iso = (ms = Date.now()) => new Date(ms).toISOString();
const appUrl = () => (process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/$/, "");
// created_at is ISO from the app, or SQLite's "YYYY-MM-DD HH:MM:SS" (UTC) from a column default.
const toMs = (at) => new Date(String(at).includes("T") ? at : `${String(at).replace(" ", "T")}Z`).getTime();
const firstName = (name) => String(name || "").trim().split(/\s+/)[0] || "";

/** Records the first time a person (u:<id>) or phone (d:<hash>) reaches a step. Later repeats are ignored. */
export function logStep(subject, clubId, step, at = Date.now()) {
  if (!subject || !clubId) return false;
  return db.prepare("INSERT OR IGNORE INTO first_steps (subject, club_id, step, created_at) VALUES (?, ?, ?, ?)").run(subject, clubId, step, iso(at)).changes > 0;
}

// Activities the person leads in this club that people can see (published, or published then cancelled).
const LED = "SELECT id FROM rides WHERE club_id = ? AND organiser_id = ? AND status != 'draft'";

/** Where this owner/admin is: first activity out yet? Anyone else joined one yet? */
export function leaderProgress(clubId, userId) {
  const latest = db.prepare(`SELECT share_code FROM rides WHERE club_id = ? AND organiser_id = ? AND status = 'published' ORDER BY created_at DESC LIMIT 1`).get(clubId, userId);
  // A first activity that was cancelled before anyone joined doesn't count: they're back to "Create".
  const published = Boolean(latest);
  const joined = published && Boolean(db.prepare(`SELECT 1 FROM ride_rsvps WHERE ride_id IN (${LED}) AND (user_id IS NULL OR user_id != ?) LIMIT 1`).get(clubId, userId, userId));
  return { published, first_join: joined, latest_code: latest?.share_code || null };
}

/** What the dashboard needs to show the guide. `membership` comes from clubAccess (platform = the PaceUp Admin acting as owner). */
export function guideFor(clubId, userId, membership) {
  const leader = membership && ["owner", "admin"].includes(membership.role) && !membership.platform;
  if (!leader) return { show: false };
  const progress = leaderProgress(clubId, userId);
  if (progress.first_join) return { show: false };
  const user = db.prepare("SELECT name FROM users WHERE id = ?").get(userId);
  const tips = db.prepare("SELECT tip FROM user_tips WHERE user_id = ?").all(userId).map((r) => r.tip);
  return { show: true, first_name: firstName(user?.name), ...progress, tips_seen: tips };
}

export function dismissTip(userId, tip) {
  db.prepare("INSERT OR IGNORE INTO user_tips (user_id, tip, created_at) VALUES (?, ?, ?)").run(userId, tip, iso());
}

/**
 * Called from setRsvp (inside its transaction) after someone goes on the list. When it's the first
 * person other than the Lead to ever join one of the Lead's activities, the Lead gets one phone alert.
 */
export function celebrateFirstJoin(ride, joinerUserId, joinerName) {
  if (!ride.organiser_id || joinerUserId === ride.organiser_id) return false;
  const others = db.prepare(`SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id IN (${LED}) AND (user_id IS NULL OR user_id != ?)`).get(ride.club_id, ride.organiser_id, ride.organiser_id).n;
  if (others !== 1) return false;
  if (!logStep(`u:${ride.organiser_id}`, ride.club_id, "first_join_alert")) return false;
  queuePush(ride.organiser_id, { title: "🎉 First one in!", body: `${firstName(joinerName) || "Someone"} joined ${ride.title}.`, url: `/r/${ride.share_code}` });
  return true;
}

function localHour(ms) {
  return Number(new Date(ms).toLocaleString("en-GB", { timeZone: process.env.PACEUP_TIMEZONE || "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }));
}

export function nudgeText(name, clubName) {
  const first = firstName(name);
  return [`Hi${first ? ` ${first}` : ""}! Ready to post your first activity for *${clubName}*? Takes a minute 👇`, appUrl()].join("\n");
}

/**
 * Called by the WhatsApp worker. An owner or admin added 3+ days ago who hasn't published an activity
 * in that club gets one private message from the club's own number. Each person is considered once
 * per club, even when nothing can be sent (no phone, club number not linked, or it's their own number).
 * Nothing goes out at night.
 */
export function queueGuideNudges(now = Date.now()) {
  const h = localHour(now);
  if (h >= QUIET_START || h < QUIET_END) return 0;
  const due = db.prepare(`
    SELECT m.id, m.club_id, m.user_id, m.created_at, u.name, u.phone, c.name AS club_name
    FROM club_memberships m INNER JOIN users u ON u.id = m.user_id INNER JOIN clubs c ON c.id = m.club_id
    WHERE m.role IN ('owner', 'admin') AND m.guide_nudge_at IS NULL AND u.platform_role != 'super_admin'
      AND julianday(m.created_at) <= julianday(?)
  `).all(iso(now - NUDGE_AFTER_MS));
  let queued = 0;
  for (const m of due) {
    db.transaction(() => {
      db.prepare("UPDATE club_memberships SET guide_nudge_at = ? WHERE id = ?").run(iso(now), m.id);
      if (toMs(m.created_at) < now - NUDGE_GIVE_UP_MS) return;
      if (leaderProgress(m.club_id, m.user_id).published || !m.phone) return;
      const conn = db.prepare("SELECT phone FROM whatsapp_connections WHERE club_id = ? AND desired = 'on' AND phone IS NOT NULL").get(m.club_id);
      if (!conn || conn.phone === m.phone) return;
      db.prepare("INSERT INTO whatsapp_direct (id, club_id, to_phone, text, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), m.club_id, m.phone, nudgeText(m.name, m.club_name), iso(now + 12 * 60 * 60 * 1000), iso(now));
      queued++;
    }).immediate();
  }
  return queued;
}

// ---------------------------------------------------------------- PaceUp Admin funnel

const daysSince = (at, now) => Math.max(0, Math.floor((now - toMs(at)) / DAY));

/** Three funnels over the last `days` days, plus who's stuck where (newest first). */
export function gettingStarted(days = 30, now = Date.now()) {
  const since = iso(now - days * DAY);

  // New owners and admins (not the PaceUp Admin): added -> opened the form -> published -> first join.
  const leaders = db.prepare(`
    SELECT m.club_id, m.user_id, m.role, m.created_at, u.name, u.phone, c.name AS club_name,
      EXISTS (SELECT 1 FROM first_steps f WHERE f.subject = 'u:' || m.user_id AND f.club_id = m.club_id AND f.step = 'form_opened') AS opened
    FROM club_memberships m INNER JOIN users u ON u.id = m.user_id INNER JOIN clubs c ON c.id = m.club_id
    WHERE m.role IN ('owner', 'admin') AND u.platform_role != 'super_admin' AND julianday(m.created_at) >= julianday(?)
    ORDER BY m.created_at DESC
  `).all(since).map((r) => ({ ...r, ...leaderProgress(r.club_id, r.user_id) }));
  const admin = [
    { step: "Added to a club", n: leaders.length },
    { step: "Opened the form", n: leaders.filter((r) => r.opened || r.published).length },
    { step: "1st activity", n: leaders.filter((r) => r.published).length },
    { step: "1st join", n: leaders.filter((r) => r.first_join).length }
  ];

  // Clubs that signed up at /start: signed up -> WhatsApp linked -> group picked -> 1st activity -> 1st join.
  const clubs = db.prepare(`
    SELECT c.id, c.signup_live_at, w.status AS wa_status, w.group_jid,
      EXISTS (SELECT 1 FROM rides r WHERE r.club_id = c.id AND r.status != 'draft') AS activity,
      EXISTS (SELECT 1 FROM ride_rsvps rs INNER JOIN rides r ON r.id = rs.ride_id WHERE r.club_id = c.id AND r.status != 'draft' AND (rs.user_id IS NULL OR rs.user_id != r.organiser_id)) AS joined
    FROM clubs c LEFT JOIN whatsapp_connections w ON w.club_id = c.id
    WHERE c.signup_at IS NOT NULL AND c.signup_status != 'removed' AND julianday(c.signup_at) >= julianday(?)
  `).all(since);
  const linked = (c) => Boolean(c.signup_live_at) || c.wa_status === "connected";
  const owner = [
    { step: "Signed up", n: clubs.length },
    { step: "WhatsApp linked", n: clubs.filter(linked).length },
    { step: "Group picked", n: clubs.filter((c) => linked(c) && c.group_jid).length },
    { step: "1st activity", n: clubs.filter((c) => c.activity).length },
    { step: "1st join", n: clubs.filter((c) => c.joined).length }
  ];

  // Members' phones that opened a join link: opened -> tapped I'M IN -> joined.
  const member = db.prepare(`
    SELECT COUNT(*) AS opened,
      SUM(EXISTS (SELECT 1 FROM first_steps t WHERE t.subject = o.subject AND t.club_id = o.club_id AND t.step = 'm_tapped')) AS tapped,
      SUM(EXISTS (SELECT 1 FROM first_steps j WHERE j.subject = o.subject AND j.club_id = o.club_id AND j.step = 'm_joined')) AS joined
    FROM first_steps o WHERE o.step = 'm_opened' AND o.created_at >= ?
  `).get(since);
  const members = [
    { step: "Opened a link", n: member.opened || 0 },
    { step: "Tapped I'M IN", n: member.tapped || 0 },
    { step: "Joined", n: member.joined || 0 }
  ];

  // Stuck: owners/admins added over a day ago with no activity yet.
  const stuck = leaders.filter((r) => !r.published && daysSince(r.created_at, now) >= 1).slice(0, 30).map((r) => ({
    name: r.name, phone: r.phone, club_name: r.club_name, role: r.role,
    days: daysSince(r.created_at, now), where: r.opened ? "opened the form, didn't publish" : "no activity yet"
  }));

  return { days, admin, owner, member: members, stuck };
}

// ---------------------------------------------------------------- HTTP routes

export function registerGuideRoutes(app, { requireClubRole, requirePlatformAdmin }) {
  const id = { type: "string", pattern: "^[0-9a-fA-F-]{36}$" };
  const clubParams = { type: "object", properties: { clubId: id }, required: ["clubId"] };

  app.get("/api/clubs/:clubId/guide", {
    schema: { params: clubParams }, preHandler: [app.authenticate, requireClubRole(["owner", "admin"])]
  }, async (request) => ({ guide: guideFor(request.params.clubId, request.user.sub, request.clubMembership) }));

  app.post("/api/clubs/:clubId/guide/step", {
    schema: { params: clubParams, body: { type: "object", properties: { step: { type: "string", enum: ["form_opened"] } }, required: ["step"] } },
    preHandler: [app.authenticate, requireClubRole(["owner", "admin"])]
  }, async (request) => {
    if (!request.clubMembership.platform) logStep(`u:${request.user.sub}`, request.params.clubId, request.body.step);
    return { ok: true };
  });

  app.post("/api/guide/tips", {
    schema: { body: { type: "object", properties: { tip: { type: "string", enum: TIPS } }, required: ["tip"] } },
    preHandler: [app.authenticate]
  }, async (request) => { dismissTip(request.user.sub, request.body.tip); return { ok: true }; });

  app.get("/api/platform/getting-started", {
    schema: { querystring: { type: "object", properties: { days: { type: "integer", minimum: 1, maximum: 365 } } } },
    preHandler: [app.authenticate, requirePlatformAdmin]
  }, async (request) => gettingStarted(request.query.days || 30));
}
