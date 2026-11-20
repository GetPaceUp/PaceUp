// "Most regular": who showed up most in a month. Showed up = said they were going, minus
// no-shows an admin marked. Admins see the top 10 and can post it to the club group as a
// shout-out. Only names that showed up appear: no-shows are never named.
import { randomUUID } from "node:crypto";
import { db, DomainError } from "./db.js";
import { getConnection, isClubGroup } from "./whatsapp/outbox.js";
import { shortName } from "./whatsapp/messages.js";

const TZ = () => process.env.PACEUP_TIMEZONE || "Asia/Kolkata";
export const TOP = 10;

/** "2026-11" for an instant, in the club's time zone. */
export function monthKey(ms) {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: TZ(), year: "numeric", month: "2-digit" }).formatToParts(new Date(ms));
  return `${parts.find((p) => p.type === "year").value}-${parts.find((p) => p.type === "month").value}`;
}
export function previousMonth(key) {
  const [y, m] = key.split("-").map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, "0")}`;
}
export const monthName = (key) => new Date(`${key}-15T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });

/**
 * The month's most regular people: [{ name, count, rank }], best first. Ties share a rank.
 * The list stops at 10 names, plus anyone tied with the 10th.
 */
export function regulars(clubId, month, now = Date.now()) {
  const [y, m] = month.split("-").map(Number);
  // A day either side covers any time zone; each activity is then checked against the local month.
  const from = new Date(Date.UTC(y, m - 1, 1) - 86400000).toISOString();
  const to = new Date(Math.min(Date.UTC(y, m, 1) + 86400000, now)).toISOString();
  const rides = db.prepare("SELECT id, starts_at FROM rides WHERE club_id = ? AND status = 'published' AND starts_at >= ? AND starts_at <= ?")
    .all(clubId, from, to).filter((r) => monthKey(Date.parse(r.starts_at)) === month && Date.parse(r.starts_at) <= now);
  const counts = new Map();
  const stmt = db.prepare(`
    SELECT COALESCE(rs.user_id, rs.roster_id) AS who, COALESCE(u.name, ro.name, rs.participant_name) AS name
    FROM ride_rsvps rs LEFT JOIN users u ON u.id = rs.user_id LEFT JOIN club_roster ro ON ro.id = rs.roster_id
    WHERE rs.ride_id = ? AND rs.status = 'going' AND rs.no_show = 0 AND COALESCE(rs.user_id, rs.roster_id) IS NOT NULL
  `);
  for (const ride of rides) {
    for (const p of stmt.all(ride.id)) {
      const c = counts.get(p.who) || { name: p.name, count: 0 };
      c.count++;
      counts.set(p.who, c);
    }
  }
  const sorted = [...counts.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const cutoff = sorted[TOP - 1]?.count ?? 0;
  const people = [];
  sorted.forEach((p, i) => {
    if (i >= TOP && p.count < cutoff) return;
    const rank = i > 0 && p.count === sorted[i - 1].count ? people[i - 1].rank : i + 1;
    people.push({ name: p.name, count: p.count, rank });
  });
  return { month, month_name: monthName(month), activities: rides.length, people };
}

export function regularsText(clubId, month) {
  const { people, month_name } = regulars(clubId, month);
  return [`🏅 *Most regular in ${month_name}*`, ...people.map((p) => `${p.rank}. ${shortName(p.name)} · ${p.count}`), "", "Thanks for showing up, every time 💪"].join("\n");
}

/** Queues the shout-out for the club group, from the club's own number. */
export function postRegulars(clubId, month) {
  return db.transaction(() => {
    const conn = getConnection(clubId);
    if (!conn || conn.status !== "connected" || !isClubGroup(conn, conn.group_jid)) throw new DomainError(409, "Connect WhatsApp and pick a group first.");
    if (!regulars(clubId, month).people.length) throw new DomainError(409, "No one to list yet for this month.");
    const recent = db.prepare("SELECT 1 FROM outbox WHERE club_id = ? AND kind = 'regulars' AND payload = ? AND (status = 'pending' OR sent_at >= ?)")
      .get(clubId, JSON.stringify({ month }), new Date(Date.now() - 10 * 60 * 1000).toISOString());
    if (recent) throw new DomainError(409, "Already posted. It can take a minute to appear in the group.");
    const now = new Date().toISOString();
    db.prepare("INSERT INTO outbox (id, club_id, ride_id, kind, status, not_before, payload, created_at) VALUES (?, ?, NULL, 'regulars', 'pending', ?, ?, ?)")
      .run(randomUUID(), clubId, now, JSON.stringify({ month }), now);
    return { queued: true };
  }).immediate();
}

export function registerRegularsRoutes(app, { requireClubRole }) {
  const params = { type: "object", properties: { clubId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } }, required: ["clubId"] };
  const month = { type: "string", pattern: "^20[0-9]{2}-(0[1-9]|1[0-2])$" };
  const pre = [app.authenticate, requireClubRole(["owner", "admin"])];
  app.get("/api/clubs/:clubId/regulars", { schema: { params, querystring: { type: "object", properties: { month } } }, preHandler: pre }, async (req) => {
    const current = monthKey(Date.now());
    return { regulars: regulars(req.params.clubId, req.query.month || current), current, previous: previousMonth(current) };
  });
  app.post("/api/clubs/:clubId/regulars/post", { schema: { params, body: { type: "object", properties: { month }, required: ["month"] } }, preHandler: pre }, async (req, reply) => {
    try { return postRegulars(req.params.clubId, req.body.month); }
    catch (error) {
      if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message });
      throw error;
    }
  });
}
