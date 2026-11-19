// Reads activity details out of an admin's WhatsApp message.
// Rules, not AI: predictable, free and offline. Anything it can't read with
// confidence is left out (or marked ambiguous) so the conversation asks for it,
// and nothing is ever published without the admin replying YES.
//
//   parseActivity("Create a cycling ride this Sunday at 6 AM from Tulip Chowk, 40 km", { now, tz })
//   -> { category: "cycling", date: "2026-11-22", time: "06:00", location: "Tulip Chowk", distance_km: 40 }

const DAYS = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
const DAY_RE = "(sun|mon|tue|tues|wed|thu|thur|thurs|fri|sat)(?:day|nesday|sday|urday|rsday)?";
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_RE = "(jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";

const CATEGORY_WORDS = [
  ["triathlon", /\b(triathlon|tri\b|brick|duathlon|aquathlon)/i],
  ["swimming", /\b(swim(?:s|ming)?|pool|open[ -]water|laps)\b/i],
  ["hiking", /\b(hik(?:e|ing)|trek(?:king)?)/i],
  ["running", /\b(run(?:s|ning)?|jog(?:ging)?|marathon|parkrun)\b/i],
  ["cycling", /\b(ride|rides|riding|cycl(?:e|ing)|bike|biking|spin|gravel|mtb)\b/i],
  ["other", /\b(walk(?:ing)?|yoga|meet-?up|workout)\b/i]
];
export const CATEGORY_LABEL = { cycling: "Ride", running: "Run", hiking: "Hike", swimming: "Swim", triathlon: "Triathlon", other: "Activity" };

// ---------------------------------------------------------------- time zone helpers

function zonedParts(ms, tz) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", weekday: "long"
  }).formatToParts(new Date(ms));
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  return { y: +p.year, m: +p.month, d: +p.day, h: +p.hour, mi: +p.minute, s: +p.second, dow: DAYS.indexOf(p.weekday.toLowerCase()) };
}
/** Local wall-clock date and time in tz -> UTC Date. */
export function zonedToUtc(date, time, tz) {
  const [y, m, d] = date.split("-").map(Number);
  const [h, mi] = time.split(":").map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const offset = (ms) => { const p = zonedParts(ms, tz); return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - ms; };
  let t = guess - offset(guess);
  const second = guess - offset(t);
  if (second !== t) t = second;
  return new Date(t);
}
const ymd = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
function addDays(date, n) {
  const [y, m, d] = date.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
function validDate(y, m, d) {
  const t = new Date(Date.UTC(y, m - 1, d));
  return t.getUTCFullYear() === y && t.getUTCMonth() === m - 1 && t.getUTCDate() === d;
}

// ---------------------------------------------------------------- parsing

function take(state, re, fn) {
  const match = state.text.match(re);
  if (!match) return false;
  const ok = fn(match);
  if (ok !== false) state.text = state.text.replace(match[0], " ");
  return ok !== false;
}

function parseDate(state, today, todayDow) {
  const [ty] = today.split("-").map(Number);
  const futureYear = (m, d, year) => {
    if (year) return year < 100 ? 2000 + year : year;
    return ymd(ty, m, d) < today ? ty + 1 : ty;
  };
  const set = (y, m, d) => { if (!validDate(y, m, d)) return false; state.out.date = ymd(y, m, d); };
  const on = "(?:\\bon\\s+)?";
  return (
    take(state, /\b(\d{4})-(\d{2})-(\d{2})\b/, (m) => set(+m[1], +m[2], +m[3])) ||
    take(state, new RegExp(`${on}\\b(\\d{1,2})(?:st|nd|rd|th)?\\s*(?:of\\s+)?${MONTH_RE}(?:\\s*,?\\s*(\\d{4}))?`, "i"),
      (m) => { const mon = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1; return set(futureYear(mon, +m[1], +m[3]), mon, +m[1]); }) ||
    take(state, new RegExp(`${on}\\b${MONTH_RE}\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:\\s*,?\\s*(\\d{4}))?`, "i"),
      (m) => { const mon = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; return set(futureYear(mon, +m[2], +m[3]), mon, +m[2]); }) ||
    take(state, new RegExp(`${on}\\b(\\d{1,2})[/-](\\d{1,2})(?:[/-](\\d{2,4}))?\\b`), (m) => set(futureYear(+m[2], +m[1], m[3] ? +m[3] : 0), +m[2], +m[1])) ||
    take(state, /\bday after (?:tomorrow|tmrw|tmr)\b/i, () => { state.out.date = addDays(today, 2); }) ||
    take(state, /\b(?:tomorrow|tmrw|tmr|tomo)\b/i, () => { state.out.date = addDays(today, 1); }) ||
    take(state, /\b(today|tonight|this evening|this morning)\b/i, (m) => {
      state.out.date = today;
      if (/evening|tonight/i.test(m[1])) state.hint = "pm";
      if (/morning/i.test(m[1])) state.hint = "am";
    }) ||
    take(state, new RegExp(`(?:\\b(this|next|coming|on)\\s+)?\\b${DAY_RE}\\b`, "i"), (m) => {
      const target = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"].indexOf(m[2].slice(0, 3).toLowerCase());
      let ahead = (target - todayDow + 7) % 7;
      if (ahead === 0 && /next/i.test(m[1] || "")) ahead = 7;
      state.out.date = addDays(today, ahead);
    })
  );
}

function parseTime(state) {
  const lead = "(?:\\b(?:at|by|from|time(?:\\s+is)?|start(?:s|ing)?(?:\\s+at)?)\\s*|@\\s*)?";
  const setTime = (h, mi) => { if (h > 23 || mi > 59) return false; state.out.time = `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`; delete state.out.time_ambiguous; };
  if (take(state, new RegExp(`${lead}\\b(\\d{1,2})(?:[:.](\\d{2}))?\\s*(a\\.?m\\.?|p\\.?m\\.?)(?=\\W|$)`, "i"), (m) => {
    let h = +m[1]; const mi = +(m[2] || 0);
    if (h < 1 || h > 12) return false;
    if (/p/i.test(m[3]) && h < 12) h += 12;
    if (/a/i.test(m[3]) && h === 12) h = 0;
    return setTime(h, mi);
  })) return;
  if (take(state, /\b(noon|midday)\b/i, () => setTime(12, 0))) return;
  if (take(state, new RegExp(`${lead}\\b(\\d{1,2})[:.](\\d{2})\\b`), (m) => {
    const h = +m[1], mi = +m[2];
    if (h > 23 || mi > 59) return false;
    if (h >= 13 || h === 0 || m[1].startsWith("0")) return setTime(h, mi);
    return ambiguous(state, h, mi);
  })) return;
  take(state, /(?:\b(?:at|by)\s+|@\s*)(\d{1,2})\b(?!\s*(?:km|k|kms|th|st|nd|rd|[/-]|\d))/i, (m) => {
    const h = +m[1];
    if (h > 23) return false;
    if (h >= 13 || h === 0) return setTime(h, 0);
    return ambiguous(state, h, 0);
  });
}
function ambiguous(state, h, mi) {
  const hint = state.hint || (/\b(morning|sunrise|dawn|early)\b/i.test(state.original) ? "am" : /\b(evening|night|sunset|after work)\b/i.test(state.original) ? "pm" : null);
  if (hint) {
    const hh = hint === "pm" ? (h === 12 ? 12 : h + 12) : (h === 12 ? 0 : h);
    state.out.time = `${String(hh).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
    delete state.out.time_ambiguous;
    return;
  }
  state.out.time_ambiguous = `${h}:${String(mi).padStart(2, "0")}`;
  delete state.out.time;
}

const LOCATION_FIELDS = "location|place|venue|start(?:ing)?\\s*point|start\\s*location|meeting\\s*point|meet(?:ing)?\\s*(?:at|point)?|start(?:s|ing)?\\s*(?:from|at)?";
const cleanLocation = (s) => s.replace(/\s+/g, " ").replace(/^(the\s+)?(?:at|from|is|to|:|-)\s+/i, "").replace(/\s+(?:for|and|with|on|please|pls)\s*$/i, "").replace(/[\s,.;:!-]+$/, "").trim();

/**
 * Returns the fields found in one message. A field is present only when the
 * message clearly states it; time_ambiguous holds "6:00" when AM/PM is unclear.
 */
export function parseActivity(text, { now = new Date(), tz = "Asia/Kolkata" } = {}) {
  const state = { text: ` ${String(text || "").replace(/[‘’]/g, "'").replace(/[“”]/g, "\"").replace(/\s+/g, " ")} `, original: String(text || ""), out: {}, hint: null };
  const p = zonedParts(now.getTime(), tz);
  const today = ymd(p.y, p.m, p.d);

  // "change X to Y" edits name the field outright.
  const edit = state.text.match(new RegExp(`\\b(?:change|set|update|make|move)\\s+(?:the\\s+)?(${LOCATION_FIELDS}|title|name|notes?|distance|time|date|day|spots|capacity)\\s+(?:to|as|=|:|is)?\\s*(.+)$`, "i"));
  if (edit) {
    const field = edit[1].toLowerCase();
    const value = edit[2].trim();
    if (/title|name/.test(field)) return { title: value.replace(/^["']|["']$/g, "").slice(0, 120) };
    if (/note/.test(field)) return { notes: value.slice(0, 2000) };
    if (new RegExp(`^(${LOCATION_FIELDS})$`, "i").test(field)) return { location: cleanLocation(value).slice(0, 200) };
    state.text = ` ${value} `; // time, date, distance, spots: parse the value below
  }

  take(state, /\btitle\s*[:=-]\s*([^,\n]+)/i, (m) => { state.out.title = m[1].trim().slice(0, 120); });
  take(state, /"([^"]{2,120})"/, (m) => { state.out.title = m[1].trim(); });
  take(state, /\bnotes?\s*[:=-]\s*(.+)$/i, (m) => { state.out.notes = m[1].trim().slice(0, 2000); });
  take(state, /\b(\d+(?:\.\d+)?)\s*(?:km|kms|kilomet(?:er|re)s?|k)\b/i, (m) => { state.out.distance_km = Math.min(1000, +m[1]); });
  take(state, /\b(?:max|limit|capacity|spots?)\s*(?:of\s*)?[:=-]?\s*(\d{1,4})\b|\b(\d{1,4})\s*(?:spots|slots|places|people|riders|runners)\b/i, (m) => { const n = +(m[1] || m[2]); if (n >= 1) state.out.capacity = n; else return false; });
  if (edit && /distance/i.test(edit[1]) && state.out.distance_km == null) {
    take(state, /\b(\d+(?:\.\d+)?)\b/, (m) => { state.out.distance_km = Math.min(1000, +m[1]); });
  }
  if (edit && /spots|capacity/i.test(edit[1]) && state.out.capacity == null) {
    take(state, /\b(\d{1,4})\b/, (m) => { if (+m[1] >= 1) state.out.capacity = +m[1]; else return false; });
  }
  parseDate(state, today, p.dow);
  parseTime(state);

  for (const [category, re] of CATEGORY_WORDS) if (re.test(state.original)) { state.out.category = category; break; }

  const loc = state.text.match(new RegExp(`(?:\\b(?:${LOCATION_FIELDS}|from|at|near)\\b|@)\\s*(?:is\\s*)?[:=-]?\\s*([^,;!?\\n]+)`, "i"));
  if (loc) {
    const value = cleanLocation(loc[1].replace(/\.(\s|$).*$/, ""));
    if (value.length >= 2 && /[a-z]/i.test(value)) state.out.location = value.slice(0, 200);
  }
  return state.out;
}

/** "am"/"pm" reply to an ambiguous time. */
export function resolveAmPm(text, ambiguousTime) {
  const m = String(text).match(/\b(a\.?m\.?|p\.?m\.?|morning|evening|night)\b/i);
  if (!m || !ambiguousTime) return null;
  let [h, mi] = ambiguousTime.split(":").map(Number);
  const pm = /p|evening|night/i.test(m[1]);
  if (pm && h < 12) h += 12;
  if (!pm && h === 12) h = 0;
  return `${String(h).padStart(2, "0")}:${String(mi).padStart(2, "0")}`;
}

export function defaultTitle(draft) {
  const label = CATEGORY_LABEL[draft.category || "other"];
  if (!draft.date) return label;
  const weekday = new Date(`${draft.date}T12:00:00Z`).toLocaleDateString("en-GB", { weekday: "long", timeZone: "UTC" });
  return `${weekday} ${label}`;
}
