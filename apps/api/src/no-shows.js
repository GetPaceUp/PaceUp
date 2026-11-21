// No-shows: after an activity, admins tap the names of people who said they were going
// but didn't turn up. Everyone else counts as present. Only admins ever see this:
// members are never told, and it never appears in group posts.
import { randomUUID } from "node:crypto";
import { db, DomainError } from "./db.js";

const HOUR = 60 * 60 * 1000;
/** Marking stays open this long after the start, then the list locks. */
export const ABSENT_LOCK_MS = 48 * HOUR;
/** The Lead's one reminder goes out this long after the start... */
export const NUDGE_AFTER_MS = 1 * HOUR;
/** ...unless the activity is older than this (e.g. the worker was down): then it's skipped. */
const NUDGE_GIVE_UP_MS = 24 * HOUR;
/** No-show counts cover this many days. */
export const NO_SHOW_WINDOW_DAYS = 90;
const QUIET_START = 22, QUIET_END = 7;

const iso = (ms) => new Date(ms).toISOString();
const appUrl = () => (process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/$/, "");

/** Whether no-shows can be marked for this activity now, and when the list locks. Null before the start. */
export function absentWindow(ride, now = Date.now()) {
  if (ride.status !== "published") return null;
  const start = new Date(ride.starts_at).getTime();
  if (start > now) return null;
  return { open: now < start + ABSENT_LOCK_MS, locks_at: iso(start + ABSENT_LOCK_MS) };
}

/** RSVP ids marked as no-shows on one activity. */
export function noShowIds(rideId) {
  return new Set(db.prepare("SELECT id FROM ride_rsvps WHERE ride_id = ? AND no_show = 1").all(rideId).map((r) => r.id));
}

/** No-shows per person in this club over the last 90 days, keyed by user id or roster id. */
export function noShowCounts(clubId, now = Date.now()) {
  const since = iso(now - NO_SHOW_WINDOW_DAYS * 24 * HOUR);
  const rows = db.prepare(`
    SELECT COALESCE(rs.user_id, rs.roster_id) AS who, COUNT(*) AS n
    FROM ride_rsvps rs INNER JOIN rides r ON r.id = rs.ride_id
    WHERE r.club_id = ? AND r.starts_at >= ? AND rs.no_show = 1 AND rs.status = 'going'
      AND COALESCE(rs.user_id, rs.roster_id) IS NOT NULL
    GROUP BY who
  `).all(clubId, since);
  return new Map(rows.map((r) => [r.who, r.n]));
}

/** Marks (or unmarks) one person on the going list as a no-show. Any club admin, until the list locks. */
export function setNoShow(clubId, rideId, rsvpId, noShow, actorId) {
  return db.transaction(() => {
    const ride = db.prepare("SELECT * FROM rides WHERE id = ? AND club_id = ?").get(rideId, clubId);
    if (!ride) throw new DomainError(404, "Activity not found.");
    const window = absentWindow(ride);
    if (!window) throw new DomainError(409, "No-shows can be marked once the activity has started.");
    if (!window.open) throw new DomainError(409, "This list is locked. No-shows can be marked for 48 hours after the start.");
    const row = db.prepare("SELECT * FROM ride_rsvps WHERE id = ? AND ride_id = ? AND status = 'going'").get(rsvpId, rideId);
    if (!row) throw new DomainError(404, "That person isn't on the going list.");
    if (Boolean(row.no_show) === noShow) return ride;
    const now = iso(Date.now());
    db.prepare("UPDATE ride_rsvps SET no_show = ?, no_show_by = ?, no_show_at = ? WHERE id = ?")
      .run(noShow ? 1 : 0, noShow ? actorId : null, noShow ? now : null, rsvpId);
    const name = db.prepare("SELECT COALESCE(u.name, ro.name, rs.participant_name) AS name FROM ride_rsvps rs LEFT JOIN users u ON u.id = rs.user_id LEFT JOIN club_roster ro ON ro.id = rs.roster_id WHERE rs.id = ?").get(rsvpId).name;
    db.prepare("INSERT INTO activity_audit_log (id, club_id, ride_id, actor_type, actor_id, action, metadata, created_at) VALUES (?, ?, ?, 'user', ?, ?, ?, ?)")
      .run(randomUUID(), clubId, rideId, actorId, noShow ? "marked_no_show" : "unmarked_no_show", JSON.stringify({ name }), now);
    return ride;
  }).immediate();
}

function localHour(ms) {
  return Number(new Date(ms).toLocaleString("en-GB", { timeZone: process.env.PACEUP_TIMEZONE || "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }));
}

export function nudgeText(ride) {
  return [
    `Hope *${ride.title}* went well 🙌`,
    "Anyone who didn't turn up? Tap their names 👇",
    `${appUrl()}/r/${ride.share_code}?absent`,
    "Takes 10 seconds. Everyone else counts as present."
  ].join("\n");
}

/**
 * Called by the WhatsApp worker. One hour after an activity starts, its Lead gets one private
 * message from the club number with the link to mark no-shows. Each activity is considered once:
 * it is marked as handled even when there is no one to message (no phone, number not linked, or
 * nobody but the Lead on the list). Nothing goes out at night; it waits for the morning.
 */
export function queueNoShowNudges(now = Date.now()) {
  const h = localHour(now);
  if (h >= QUIET_START || h < QUIET_END) return 0;
  const due = db.prepare(`
    SELECT r.*, u.phone AS lead_phone FROM rides r LEFT JOIN users u ON u.id = r.organiser_id
    WHERE r.status = 'published' AND r.absent_nudge_at IS NULL AND r.starts_at <= ?
  `).all(iso(now - NUDGE_AFTER_MS));
  let queued = 0;
  for (const ride of due) {
    db.transaction(() => {
      db.prepare("UPDATE rides SET absent_nudge_at = ? WHERE id = ?").run(iso(now), ride.id);
      if (new Date(ride.starts_at).getTime() < now - NUDGE_GIVE_UP_MS || !ride.lead_phone) return;
      const conn = db.prepare("SELECT 1 FROM whatsapp_connections WHERE club_id = ? AND desired = 'on' AND phone IS NOT NULL").get(ride.club_id);
      if (!conn) return;
      const others = db.prepare("SELECT COUNT(*) AS n FROM ride_rsvps WHERE ride_id = ? AND status = 'going' AND (user_id IS NULL OR user_id != ?)").get(ride.id, ride.organiser_id || "").n;
      if (!others) return;
      db.prepare("INSERT INTO whatsapp_direct (id, club_id, to_phone, text, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run(randomUUID(), ride.club_id, ride.lead_phone, nudgeText(ride), iso(Math.min(now + 6 * HOUR, new Date(ride.starts_at).getTime() + ABSENT_LOCK_MS)), iso(now));
      queued++;
    }).immediate();
  }
  return queued;
}
