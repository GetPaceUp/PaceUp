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

export function shortName(name) {
  const parts = String(name || "").trim().split(/\s+/);
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

function details(ride) {
  return [ride.distance_km ? `${ride.distance_km} km` : null, paceText(ride.pace, ride.category), ride.capacity ? `${ride.capacity} spots` : null].filter(Boolean).join(" · ");
}

export function ridePublishedText(ride) {
  const lines = [`${emoji(ride)} *New ${noun(ride)}: ${ride.title}*`, whenText(ride.starts_at), `📍 ${ride.meeting_point}`];
  if (details(ride)) lines.push(details(ride));
  // The club organises; the admin who created it leads.
  if (ride.club_name) lines.push(`Organiser: ${ride.club_name}`);
  if (ride.organiser_name) lines.push(`Lead: ${shortName(ride.organiser_name)}`);
  if (ride.notes) lines.push("", ride.notes);
  lines.push("", "Tap to say you're in 👇", rideLink(ride));
  return lines.join("\n");
}

/**
 * riders: [{id, name, user_id}] in RSVP order (id is the member's user id, or the
 * RSVP id for a guest); previous: the same shape from the last list post, or null.
 */
export function riderListText(ride, riders, previous) {
  const before = new Map((previous || []).map((r) => [r.id, r]));
  const now = new Set(riders.map((r) => r.id));
  const count = ride.capacity ? `${riders.length} / ${ride.capacity}` : `${riders.length}`;
  const full = ride.capacity && riders.length >= ride.capacity;
  const lines = [`${emoji(ride)} *${ride.title}* · ${whenText(ride.starts_at, { short: true })}`, `*${count} going*${full ? " · FULL" : ""}`, ""];
  riders.forEach((r, i) => {
    const tags = [r.user_id && r.user_id === ride.organiser_id ? "(lead)" : null, previous && !before.has(r.id) ? "🆕" : null].filter(Boolean).join(" ");
    lines.push(`${i + 1}. ${shortName(r.name)}${tags ? ` ${tags}` : ""}`);
  });
  if (!riders.length) lines.push("No one yet.");
  const left = previous ? previous.filter((r) => !now.has(r.id)).map((r) => shortName(r.name)) : [];
  if (left.length) lines.push("", `Dropped out: ${left.join(", ")}`);
  lines.push("", full ? "Spots open up if someone drops out 👇" : "Join or drop out 👇", rideLink(ride));
  return lines.join("\n");
}

export function rideUpdatedText(ride) {
  return [`✏️ *${cap(noun(ride))} updated: ${ride.title}*`, whenText(ride.starts_at), `📍 ${ride.meeting_point}`, "", rideLink(ride)].join("\n");
}

export function rideCancelledText(ride) {
  const lines = [`❌ *Cancelled: ${ride.title}* (${whenText(ride.starts_at, { short: true })})`];
  if (ride.cancel_note) lines.push(ride.cancel_note);
  return lines.join("\n");
}

export const testText = (clubName) => `✅ PaceUp is connected. ${clubName} activities and participant lists will be posted in this group.`;
