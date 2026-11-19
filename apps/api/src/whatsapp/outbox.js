// WhatsApp outbox: activity events are written here in the same transaction as the
// change that caused them, and a separate worker process delivers them. Nothing
// in the request path ever talks to WhatsApp, so RSVPs work while it is down.
import { randomUUID } from "node:crypto";
import { db } from "../db.js";

export const LIST_INTERVAL_MS = 30 * 1000;       // at most one participant-list post per activity per 30 s
export const FIRST_LIST_DELAY_MS = 20 * 1000;    // let the first few taps of a burst gather
export const HOURLY_CAP = 20;                    // posts per club number per rolling hour
export const MAX_ATTEMPTS = 8;

const iso = (ms) => new Date(ms).toISOString();
const jitter = (min, max) => min + Math.floor(Math.random() * (max - min));

export function getConnection(clubId) {
  return db.prepare("SELECT * FROM whatsapp_connections WHERE club_id = ?").get(clubId);
}

/** Posting is set up when a club is connected (or meant to be) and has chosen a group. */
function postingConfigured(clubId) {
  const c = getConnection(clubId);
  return Boolean(c && c.desired === "on" && c.group_jid);
}

function insert(row) {
  db.prepare(`
    INSERT INTO outbox (id, club_id, ride_id, kind, status, not_before, created_at)
    VALUES (?, ?, ?, ?, 'pending', ?, ?)
  `).run(randomUUID(), row.clubId, row.rideId ?? null, row.kind, iso(row.notBefore), iso(Date.now()));
}

export function enqueueRideEvent(ride, kind) {
  if (!postingConfigured(ride.club_id)) return;
  if (kind === "ride_cancelled") {
    db.prepare("UPDATE outbox SET status = 'skipped', last_error = 'ride cancelled' WHERE ride_id = ? AND status = 'pending'").run(ride.id);
  }
  insert({ clubId: ride.club_id, rideId: ride.id, kind, notBefore: Date.now() + jitter(3000, 9000) });
}

/**
 * Called on every RSVP change. Coalesces: if a list post for this activity is already
 * waiting, it will pick up this change when it is sent; otherwise schedule one
 * no sooner than 30 seconds after the previous list post for the ride.
 */
export function enqueueRiderList(ride) {
  if (!postingConfigured(ride.club_id)) return;
  const waiting = db.prepare("SELECT 1 FROM outbox WHERE ride_id = ? AND kind = 'rider_list' AND status = 'pending'").get(ride.id);
  if (waiting) return;
  const last = db.prepare("SELECT MAX(sent_at) AS t FROM outbox WHERE ride_id = ? AND kind = 'rider_list' AND status = 'sent'").get(ride.id).t;
  const earliest = Math.max(Date.now() + FIRST_LIST_DELAY_MS, last ? new Date(last).getTime() + LIST_INTERVAL_MS : 0);
  insert({ clubId: ride.club_id, rideId: ride.id, kind: "rider_list", notBefore: earliest + jitter(0, 15000) });
}

export function enqueueTest(clubId) {
  insert({ clubId, kind: "test", notBefore: Date.now() });
}

export function outboxStats(clubId) {
  const since = iso(Date.now() - 24 * 60 * 60 * 1000);
  return {
    pending: db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE club_id = ? AND status = 'pending'").get(clubId).n,
    sent_24h: db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE club_id = ? AND status = 'sent' AND sent_at >= ?").get(clubId, since).n,
    failed_24h: db.prepare("SELECT COUNT(*) AS n FROM outbox WHERE club_id = ? AND status = 'failed' AND created_at >= ?").get(clubId, since).n,
    last_sent_at: db.prepare("SELECT MAX(sent_at) AS t FROM outbox WHERE club_id = ? AND status = 'sent'").get(clubId).t
  };
}
