// Message text for the club group. WhatsApp formatting: *bold*.
const appUrl = () => (process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/$/, "");
export const rideLink = (ride) => `${appUrl()}/r/${ride.share_code}`;

const TZ = () => process.env.PACEUP_TIMEZONE || "Asia/Kolkata";
export function whenText(iso, { short = false } = {}) {
  const d = new Date(iso);
  const day = d.toLocaleDateString("en-GB", { timeZone: TZ(), weekday: "short", ...(short ? {} : { day: "numeric", month: "short" }) });
  const time = d.toLocaleTimeString("en-US", { timeZone: TZ(), hour: "numeric", minute: "2-digit" });
  return short ? `${day} ${time}` : `${day} · ${time}`;
}

// Titles people save before a name ("Dr Ankit Bhartia" is "Ankit B.", not "Dr B.").
const TITLE = /^(dr|mr|mrs|ms|er|adv|advocate|prof|capt|col|maj|lt|gen|sh|shri|smt)\.?$/i;

/** "Priya Sharma" -> "Priya S." for public lists. */
export function shortName(name) {
  const parts = String(name || "").replace(/[,;]+/g, " ").trim().split(/\s+/);
  while (parts.length > 1 && TITLE.test(parts[0])) parts.shift();
  return parts.length > 1 ? `${parts[0]} ${parts.at(-1)[0].toUpperCase()}.` : parts[0];
}

const KIND = {
  cycling: ["🚴", "ride"], running: ["🏃", "run"], hiking: ["🥾", "hike"], swimming: ["🏊", "swim"],
  triathlon: ["🏅", "triathlon"], other: ["📍", "activity"]
};
export const emoji = (ride) => (KIND[ride.category] || KIND.other)[0];
export const noun = (ride) => (KIND[ride.category] || KIND.other)[1];
const cap = (s) => s[0].toUpperCase() + s.slice(1);

const PACE_UNIT = { cycling: "km/h", running: "min/km", hiking: "km/h", swimming: "min/100 m" };
/** "25-30" -> "25–30 km/h" for a ride; a pace with its own unit is kept as typed. */
export function paceText(pace, category) {
  if (!pace) return null;
  const p = String(pace).trim().replace(/\s*-\s*/g, "–");
  return /^[\d.:–\s]+$/.test(p) && PACE_UNIT[category] ? `${p} ${PACE_UNIT[category]}` : p;
}

const BIKE = { road: "Road bike", mtb: "MTB", hybrid: "Hybrid", gravel: "Gravel bike", ebike: "E-bike", any: "Any bike" };
const STYLE = { no_drop: "No-drop", drafting: "Drafting", racing: "Racing" };
/** "🚲 Road bike · No-drop": cycling only, either part may be missing. */
export function bikeLine(ride) {
  if (ride.category !== "cycling") return null;
  const parts = [BIKE[ride.bike_type], STYLE[ride.ride_style]].filter(Boolean);
  return parts.length ? `🚲 ${parts.join(" · ")}` : null;
}

function details(ride) {
  return [ride.distance_km ? `${ride.distance_km} km` : null, paceText(ride.pace, ride.category), ride.capacity ? `${ride.capacity} spots` : null].filter(Boolean).join(" · ");
}

/** The full activity details. Every post carries all of them: people don't scroll up. */
const dayText = (iso) => new Date(iso).toLocaleDateString("en-GB", { timeZone: TZ(), weekday: "short", day: "numeric", month: "short" });
const timeText = (iso) => new Date(iso).toLocaleTimeString("en-US", { timeZone: TZ(), hour: "numeric", minute: "2-digit" });
/** "Xavier's · 5:45 AM": a meeting point with its time, used when there is a midway point. */
export const pointLabel = (ride, n) => n === 2 ? `${ride.meeting_point_2} · ${timeText(ride.meeting_at_2)}` : `${ride.meeting_point} · ${timeText(ride.starts_at)}`;

function body(ride) {
  // With a midway point, each point carries its own time.
  const lines = ride.meeting_point_2
    ? [dayText(ride.starts_at), `📍 ${pointLabel(ride, 1)}`, ...(ride.map_url ? [`🗺️ ${ride.map_url}`] : []), `📍 ${pointLabel(ride, 2)}`, ...(ride.map_url_2 ? [`🗺️ ${ride.map_url_2}`] : [])]
    : [whenText(ride.starts_at), `📍 ${ride.meeting_point}`, ...(ride.map_url ? [`🗺️ ${ride.map_url}`] : [])];
  if (details(ride)) lines.push(details(ride));
  if (bikeLine(ride)) lines.push(bikeLine(ride));
  // The club organises; the admin who created it leads.
  if (ride.club_name) lines.push(`Organiser: ${ride.club_name}`);
  if (ride.organiser_name) lines.push(`Lead: ${shortName(ride.organiser_name)}`);
  if (ride.notes) lines.push("", ride.notes);
  return lines;
}

/**
 * Who's going. riders: [{id, name, user_id, join_point}] in RSVP order (id is the member's user id, or the
 * RSVP id for a guest); previous: the same shape from the last post, or null (no 🆕 marks).
 */
function going(ride, riders, previous) {
  const before = new Map((previous || []).map((r) => [r.id, r]));
  const now = new Set(riders.map((r) => r.id));
  const count = ride.capacity ? `${riders.length} / ${ride.capacity}` : `${riders.length}`;
  const full = Boolean(ride.capacity && riders.length >= ride.capacity);
  const lines = [`*${count} going*${full ? " · FULL" : ""}`];
  const line = (r, i) => {
    const tags = [r.user_id && r.user_id === ride.organiser_id ? "(lead)" : null, previous && !before.has(r.id) ? "🆕" : null].filter(Boolean).join(" ");
    return `${i}. ${shortName(r.name)}${tags ? ` ${tags}` : ""}`;
  };
  if (ride.meeting_point_2 && riders.length) {
    // Grouped by where people join, numbered straight through, so the lead knows who waits where.
    let n = 0;
    for (const point of [1, 2]) {
      const here = riders.filter((r) => (r.join_point === 2 ? 2 : 1) === point);
      lines.push(`*${pointLabel(ride, point)} (${here.length})*`);
      for (const r of here) lines.push(line(r, ++n));
    }
  } else riders.forEach((r, i) => lines.push(line(r, i + 1)));
  if (!riders.length) lines.push("No one yet.");
  const left = previous ? previous.filter((r) => !now.has(r.id)).map((r) => shortName(r.name)) : [];
  if (left.length) lines.push("", `Dropped out: ${left.join(", ")}`);
  return { lines, full };
}

function post(header, ride, riders, previous, cta) {
  const list = going(ride, riders, previous);
  // Join link before the list, so it stays near the top however long the list gets.
  return [header, ...body(ride), "", list.full ? "👇 *Full. Tap the link to grab a spot if someone drops out.*" : cta, rideLink(ride), ...list.lines,
    "", "No need to copy/paste this list, it updates itself."].join("\n");
}

export function ridePublishedText(ride, riders = []) {
  return post(`${emoji(ride)} *New ${noun(ride)}: ${ride.title}*`, ride, riders, null, "👇 *Tap the link to join.*");
}

/** After people join or drop out: the same full post, with the list marked 🆕 / Dropped out. */
export function riderListText(ride, riders, previous) {
  return post(`${emoji(ride)} *${ride.title}*`, ride, riders, previous, "👇 *Tap the link to join or drop out.*");
}

/** Time or place changed: the same full post, headed as a change. */
export function rideUpdatedText(ride, riders = []) {
  return post(`✏️ *${cap(noun(ride))} changed: ${ride.title}*`, ride, riders, null, "👇 *Tap the link to join or drop out.*");
}

export function rideCancelledText(ride) {
  const lines = [`❌ *Cancelled: ${ride.title}* (${whenText(ride.starts_at, { short: true })})`];
  if (ride.cancel_note) lines.push(ride.cancel_note);
  return lines.join("\n");
}

export const testText = (clubName) => `✅ PaceUp is connected. ${clubName} activities and participant lists will be posted in this group.`;
