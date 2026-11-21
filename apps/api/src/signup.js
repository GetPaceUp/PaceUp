// Self-serve club sign-up at /start: a club owner finds their club in the directory (or adds it),
// gives their name and mobile, and links the club's own WhatsApp number. Nobody can send them a
// code first (a new club has no number yet, and no club's number ever sends for another club), so
// linking the number is what makes the club real. Until then the club is held for 14 days, so an owner
// who gets stuck at the WhatsApp step can come back (or be helped) without losing the club.
import { randomUUID } from "node:crypto";
import { db, DomainError, PHONE_EMAIL_DOMAIN, getUserById, listClubsForUser, revokeAllSessions, audit } from "./db.js";
import { cleanName, cleanPhone } from "./roster.js";
import { createClub } from "./clubs-admin.js";
import { cleanClubName, cleanCity, clubKey, activityType, ACTIVITY_TYPES } from "./directory.js";

export const HOLD_MS = 14 * 24 * 3600 * 1000;
const DAY_MS = 24 * 3600 * 1000;
const MAX_PENDING_PER_USER = 3;
const MAX_PENDING_TOTAL = 200;
const iso = (ms = Date.now()) => new Date(ms).toISOString();
const appUrl = () => (process.env.APP_BASE_URL || "http://localhost:5173").replace(/\/$/, "");
const prettyPhone = (p) => (p?.startsWith("91") && p.length === 12 ? `+91 ${p.slice(2, 7)} ${p.slice(7)}` : `+${p}`);

// Every club on PaceUp, the PaceUp Admin's own included, shows up the same way: name, city, activity.
// Hiding one made it look missing, and its owner got "Add it" instead of "already here".

function clubState(clubId) {
  const c = db.prepare("SELECT c.id, c.name, c.city, c.activity, c.signup_status FROM clubs c WHERE c.id = ?").get(clubId);
  if (!c || c.signup_status === "removed") return null;
  return {
    club_id: c.id, name: c.name, city: c.city, activity: c.activity, on_paceup: true,
    // Someone started setting it up and hasn't linked WhatsApp yet.
    pending: c.signup_status === "pending"
  };
}

/** The public search: directory clubs and clubs on PaceUp, by name. Only name, city and activity. */
export function publicSearch(q, limit = 8) {
  const key = clubKey(q);
  if (key.length < 2) return [];
  const onPaceup = db.prepare(`SELECT c.id FROM clubs c WHERE COALESCE(c.signup_status, '') != 'removed'`).all()
    .map((r) => clubState(r.id)).filter((c) => c && clubKey(c.name).includes(key))
    .sort((a, b) => Number(!clubKey(a.name).startsWith(key)) - Number(!clubKey(b.name).startsWith(key)) || a.name.localeCompare(b.name));
  const onPaceupKeys = new Set(onPaceup.map((c) => clubKey(c.name)));
  const dir = db.prepare(`SELECT d.id, d.name, d.city, d.activity, d.club_id FROM club_directory d
      WHERE d.hidden = 0 AND d.club_id IS NULL AND d.name_key LIKE ?
      ORDER BY (d.name_key LIKE ?) DESC, length(d.name_key), d.name LIMIT ?`).all(`%${key}%`, `${key}%`, limit + onPaceupKeys.size)
    .map((d) => ({ directory_id: d.id, name: d.name, city: d.city, activity: d.activity, activity_type: activityType(d.activity), on_paceup: false }))
    // A directory copy of a club that's already on PaceUp can't be set up again (same name), so don't offer it.
    .filter((d) => !onPaceupKeys.has(clubKey(d.name))).slice(0, limit);
  return [...onPaceup.slice(0, 3), ...dir].slice(0, limit);
}

/** One directory club, for the claim campaign's "Set up PaceUp" link (/start?club=<id>). */
export function publicClub(directoryId) {
  const d = db.prepare("SELECT id, name, city, activity, club_id FROM club_directory WHERE id = ? AND hidden = 0").get(directoryId);
  if (!d) throw new DomainError(404, "We couldn't find that club. Search for it by name.");
  if (d.club_id) {
    const state = clubState(d.club_id);
    if (state) return state;
  }
  return { directory_id: d.id, name: d.name, city: d.city, activity: d.activity, activity_type: activityType(d.activity), on_paceup: false };
}

function taken(clubId) {
  const state = clubState(clubId);
  return Object.assign(new DomainError(409, state?.pending
    ? `Someone started setting up ${state.name} a short while ago. If it isn't finished, the PaceUp team can free it up.`
    : `${state?.name || "This club"} is already on PaceUp.`), { club: state });
}

/**
 * Makes the club (held as 'pending') with this person as its Club Owner. Signed-in people set up
 * with their own account. Others give a name and a mobile that isn't on PaceUp yet; that account
 * stays unverified until it links that number or signs in with a WhatsApp code.
 */
export function createSignupClub({ directoryId, clubName, city, activity, name, phone: rawPhone, userId = null, ip = null }) {
  releaseStaleSignups();
  let club;
  if (directoryId) {
    const d = db.prepare("SELECT * FROM club_directory WHERE id = ? AND hidden = 0").get(directoryId);
    if (!d) throw new DomainError(404, "We couldn't find that club. Search for it again, or add it as a new club.");
    if (d.club_id) throw taken(d.club_id);
    // A directory entry without a city or activity: the owner fills it in.
    const c = d.city || cleanCity(city);
    if (!c) throw new DomainError(400, "Enter your club's city.");
    const a = activityType(d.activity) || d.activity || String(activity || "").trim().slice(0, 80);
    if (!a) throw new DomainError(400, "Pick what your club does.");
    club = { name: d.name, city: c, activity: a, directoryId: d.id, dir: d };
  } else {
    let n = cleanClubName(clubName);
    if (n === n.toLowerCase()) n = cleanName(n); // "monsoon trekkers" -> "Monsoon Trekkers"
    if (n.length < 2 || n.length > 80) throw new DomainError(400, "Enter your club's name (2 to 80 characters).");
    const c = cleanCity(city);
    if (!c) throw new DomainError(400, "Enter your club's city.");
    const a = String(activity || "").trim().slice(0, 80);
    if (!a) throw new DomainError(400, "Pick what your club does.");
    // The same name in the directory: claim that entry instead of making a second copy.
    // Only the same name in the same city is this club; elsewhere it's a different club with the same name.
    const d = db.prepare("SELECT * FROM club_directory WHERE name_key = ? AND city_key = ? AND hidden = 0 LIMIT 1").get(clubKey(n), c.toLowerCase());
    if (d?.club_id) throw taken(d.club_id);
    club = { name: n, city: c, activity: a, directoryId: d?.id || null, dir: d || null };
  }
  const same = db.prepare("SELECT id, name FROM clubs WHERE COALESCE(signup_status, '') != 'removed'").all().find((c) => clubKey(c.name) === clubKey(club.name));
  if (same) throw taken(same.id);

  return db.transaction(() => {
    if (db.prepare("SELECT COUNT(*) AS n FROM clubs WHERE signup_status = 'pending'").get().n >= MAX_PENDING_TOTAL) {
      throw new DomainError(503, "Lots of clubs are setting up right now. Please try again in an hour.");
    }
    let ownerId = userId, created = false;
    if (ownerId) {
      const mine = db.prepare("SELECT COUNT(*) AS n FROM clubs c INNER JOIN club_memberships cm ON cm.club_id = c.id AND cm.role = 'owner' WHERE cm.user_id = ? AND c.signup_status = 'pending'").get(ownerId).n;
      if (mine >= MAX_PENDING_PER_USER) throw new DomainError(429, "Finish linking WhatsApp for the clubs you've started before adding another.");
    } else {
      const person = cleanName(name);
      if (person.length < 2) throw new DomainError(400, "Enter your name.");
      const phone = cleanPhone(rawPhone);
      if (!phone) throw new DomainError(400, "Enter your mobile number with the country code, e.g. +91 98765 43210.");
      if (db.prepare("SELECT 1 FROM users WHERE phone = ?").get(phone)) {
        throw Object.assign(new DomainError(409, "This number is already on PaceUp. Sign in first, then come back to this page."), { code: "has_account" });
      }
      ownerId = randomUUID();
      db.prepare("INSERT INTO users (id, name, email, password_hash, phone, signup_unverified) VALUES (?, ?, ?, '!', ?, 1)").run(ownerId, person, `${phone}@${PHONE_EMAIL_DOMAIN}`, phone);
      created = true;
    }
    const made = createClub({ name: club.name, city: club.city, activity: club.activity, directoryId: club.directoryId, actorId: ownerId });
    // Linking a directory entry overwrites its name, city and activity: keep how it was, to put back on release.
    const snap = club.dir && (({ status, name, name_key, city, city_key, activity }) => JSON.stringify({ status, name, name_key, city, city_key, activity }))(club.dir);
    db.prepare("UPDATE clubs SET signup_status = 'pending', signup_at = ?, signup_dir_snapshot = ? WHERE id = ?").run(iso(), snap, made.club.id);
    audit({ actorUserId: ownerId, action: "club.self_signup", targetUserId: ownerId, newValue: made.club.name, ip });
    return { user: getUserById(ownerId), club: made.club, created };
  }).immediate();
}

/** The club linked its WhatsApp number (worker): it's live, and an owner who linked their own number is verified. */
export function signupLinked(clubId) {
  const t = iso();
  db.prepare("UPDATE clubs SET signup_status = 'live', signup_live_at = ? WHERE id = ? AND signup_status = 'pending'").run(t, clubId);
  db.prepare(`UPDATE users SET signup_unverified = 0 WHERE signup_unverified = 1 AND phone = (SELECT phone FROM whatsapp_connections WHERE club_id = ?)
    AND id IN (SELECT user_id FROM club_memberships WHERE club_id = ? AND role = 'owner')`).run(clubId, clubId);
  tellOwner(clubId);
}

/** Admin requests not yet passed on (the club's WhatsApp was offline): sent from the club's own number once it's back. */
export function tellOwner(clubId) {
  const club = db.prepare("SELECT name, signup_status FROM clubs WHERE id = ?").get(clubId);
  if (!club || club.signup_status === "pending" || club.signup_status === "removed") return 0;
  const owner = db.prepare("SELECT u.phone FROM club_memberships cm INNER JOIN users u ON u.id = cm.user_id WHERE cm.club_id = ? AND cm.role = 'owner'").get(clubId);
  const connected = db.prepare("SELECT 1 FROM whatsapp_connections WHERE club_id = ? AND status = 'connected' AND desired = 'on'").get(clubId);
  if (!owner?.phone || !connected) return 0;
  const waiting = db.prepare("SELECT * FROM club_access_requests WHERE club_id = ? AND owner_told = 0 AND created_at > ?").all(clubId, iso(Date.now() - 7 * 86400000));
  for (const r of waiting) {
    const text = `*${r.name}* (${prettyPhone(r.phone)}) asked to help run *${club.name}* on PaceUp.\n\nTo make them a club admin, open ${appUrl()}/#members and add this number.\n\nDon't know them? Just ignore this.`;
    db.prepare("INSERT INTO whatsapp_direct (id, club_id, to_phone, text, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(randomUUID(), clubId, owner.phone, text, iso(Date.now() + DAY_MS), iso());
    db.prepare("UPDATE club_access_requests SET owner_told = 1 WHERE id = ?").run(r.id);
  }
  return waiting.length;
}

function deleteClub(clubId) {
  const club = db.prepare("SELECT signup_dir_snapshot, number_owner_id FROM clubs WHERE id = ?").get(clubId);
  const dir = db.prepare("SELECT id FROM club_directory WHERE club_id = ?").get(clubId);
  // The owner is also kept as number_owner_id, so they're found even after a removal cleared the memberships.
  const people = [...new Set([...db.prepare("SELECT user_id FROM club_memberships WHERE club_id = ?").all(clubId).map((r) => r.user_id), club?.number_owner_id].filter(Boolean))];
  db.prepare("DELETE FROM clubs WHERE id = ?").run(clubId);
  // The directory entry is back to exactly how it was, free for the real owner.
  if (dir) {
    const was = club?.signup_dir_snapshot ? JSON.parse(club.signup_dir_snapshot) : { status: "prospect" };
    const keep = ["status", "name", "name_key", "city", "city_key", "activity"].filter((k) => k in was);
    db.prepare(`UPDATE club_directory SET ${keep.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @ts WHERE id = @id`).run({ ...was, ts: iso(), id: dir.id });
  }
  // An account made only for this sign-up goes too.
  for (const id of people) {
    const u = db.prepare("SELECT signup_unverified, password_hash FROM users WHERE id = ?").get(id);
    if (!u?.signup_unverified || u.password_hash !== "!" || db.prepare("SELECT 1 FROM club_memberships WHERE user_id = ?").get(id)) continue;
    try { db.prepare("DELETE FROM users WHERE id = ?").run(id); } catch { revokeAllSessions(id); }
  }
}

/** Pending clubs not linked within 14 days are released; removed clubs go once their number is unlinked. */
export function releaseStaleSignups(now = Date.now()) {
  return db.transaction(() => {
    const stale = db.prepare(`SELECT c.id FROM clubs c LEFT JOIN whatsapp_connections wc ON wc.club_id = c.id
      WHERE (c.signup_status = 'pending' AND c.signup_at <= ? AND COALESCE(wc.status, '') != 'connected' AND COALESCE(wc.desired, 'off') != 'logout')
         OR (c.signup_status = 'removed' AND COALESCE(wc.desired, 'off') != 'logout')`).all(iso(now - HOLD_MS));
    for (const { id } of stale) deleteClub(id);
    return stale.length;
  }).immediate();
}

/** The PaceUp Admin removes a self-signed-up club (e.g. someone who isn't really the club). */
export function removeSignupClub(clubId, actorId) {
  const c = db.prepare("SELECT name, signup_status FROM clubs WHERE id = ?").get(clubId);
  if (!c?.signup_status || c.signup_status === "removed") throw new DomainError(404, "Only clubs that signed up themselves can be removed here.");
  db.transaction(() => {
    const wa = db.prepare("SELECT desired, status FROM whatsapp_connections WHERE club_id = ?").get(clubId);
    // Nobody in the club can use it from now on.
    for (const { user_id } of db.prepare("SELECT user_id FROM club_memberships WHERE club_id = ? AND role IN ('owner', 'admin')").all(clubId)) {
      const u = db.prepare("SELECT signup_unverified FROM users WHERE id = ?").get(user_id);
      if (u?.signup_unverified) revokeAllSessions(user_id);
    }
    if (wa && (wa.desired !== "off" || wa.status === "connected")) {
      // The worker unlinks the number from the phone first; the club is deleted after that.
      db.prepare("UPDATE whatsapp_connections SET desired = 'logout' WHERE club_id = ?").run(clubId);
      db.prepare("UPDATE clubs SET signup_status = 'removed' WHERE id = ?").run(clubId);
      db.prepare("DELETE FROM club_memberships WHERE club_id = ?").run(clubId);
    } else deleteClub(clubId);
    audit({ actorUserId: actorId, action: "club.signup_removed", newValue: c.name });
  }).immediate();
  return { removed: true };
}

/** Someone wants to help run a club that's already on PaceUp: its owner is told from the club's own number. */
export function requestAccess({ clubId, name, phone: rawPhone, userId = null }) {
  const club = clubState(clubId);
  if (!club) throw new DomainError(404, "We couldn't find that club.");
  let person = cleanName(name), phone = cleanPhone(rawPhone);
  if (userId) { const u = getUserById(userId); person = u.name; phone = db.prepare("SELECT phone FROM users WHERE id = ?").get(userId)?.phone || phone; }
  if (person.length < 2) throw new DomainError(400, "Enter your name.");
  if (!phone) throw new DomainError(400, "Enter your mobile number with the country code, e.g. +91 98765 43210.");
  const asked = db.prepare("SELECT 1 FROM club_access_requests WHERE club_id = ? AND phone = ? AND created_at > ?").get(clubId, phone, iso(Date.now() - DAY_MS));
  if (asked) return { sent: true };
  db.transaction(() => {
    db.prepare("INSERT INTO club_access_requests (id, club_id, name, phone, owner_told, created_at) VALUES (?, ?, ?, ?, 0, ?)").run(randomUUID(), clubId, person, phone, iso());
    // Told now if the club's WhatsApp is up; otherwise as soon as it reconnects.
    tellOwner(clubId);
  }).immediate();
  return { sent: true };
}

/** The PaceUp Admin's "New sign-ups" list. */
export function listSignups() {
  releaseStaleSignups();
  const clubs = db.prepare(`SELECT c.id, c.name, c.city, c.activity, c.signup_status, c.signup_at, c.signup_live_at,
      u.name AS owner_name, u.phone AS owner_phone, u.signup_unverified,
      wc.status AS wa_status, wc.phone AS wa_phone, d.phone AS directory_phone, d.id AS directory_id
    FROM clubs c
    LEFT JOIN club_memberships cm ON cm.club_id = c.id AND cm.role = 'owner'
    LEFT JOIN users u ON u.id = cm.user_id
    LEFT JOIN whatsapp_connections wc ON wc.club_id = c.id
    LEFT JOIN club_directory d ON d.club_id = c.id
    WHERE c.signup_status IN ('pending', 'live') ORDER BY c.signup_at DESC`).all()
    .map((c) => ({
      ...c,
      signup_unverified: Boolean(c.signup_unverified),
      in_directory: Boolean(c.directory_id),
      // The linked (or owner's) number is the one the directory has for the club.
      number_matches_directory: Boolean(c.directory_phone && [c.wa_phone, c.owner_phone].includes(c.directory_phone)),
      released_at: c.signup_status === "pending" ? iso(new Date(c.signup_at).getTime() + HOLD_MS) : null
    }));
  const requests = db.prepare(`SELECT r.id, r.name, r.phone, r.owner_told, r.created_at, c.id AS club_id, c.name AS club_name
    FROM club_access_requests r INNER JOIN clubs c ON c.id = r.club_id ORDER BY r.created_at DESC`).all()
    .map((r) => ({ ...r, owner_told: Boolean(r.owner_told) }));
  const week = iso(Date.now() - 7 * 86400000);
  return { clubs, requests, this_week: clubs.filter((c) => c.signup_at > week).length };
}

export function registerSignupRoutes(app, { setSession, requirePlatformAdmin, authLimit, signedInUser }) {
  const fail = (reply, error) => {
    if (error instanceof DomainError) return reply.code(error.status).send({ error: error.message, ...(error.code ? { code: error.code } : {}), ...(error.club ? { club: error.club } : {}) });
    throw error;
  };
  const s = (n) => ({ type: "string", maxLength: n });
  app.get("/api/signup/clubs", { config: authLimit(300), schema: { querystring: { type: "object", properties: { q: s(80) } } } },
    async (req) => ({ clubs: publicSearch(req.query.q || "") }));
  app.get("/api/signup/clubs/:id", { config: authLimit(60), schema: { params: { type: "object", properties: { id: s(200) }, required: ["id"] } } },
    async (req, reply) => { try { return { club: publicClub(req.params.id) }; } catch (error) { return fail(reply, error); } });
  app.get("/api/signup/activities", async () => ({ activities: [...ACTIVITY_TYPES, "Other"] }));
  // Who is setting up: a signed-in person uses their account, everyone else gives a name and mobile.
  app.get("/api/signup/me", async (req) => {
    const user = await signedInUser(req);
    return { user: user ? { name: user.name, phone: user.phone ? prettyPhone(user.phone) : null } : null };
  });
  app.post("/api/signup", {
    config: authLimit(10),
    schema: { body: { type: "object", properties: { directoryId: s(200), clubName: s(200), city: s(80), activity: s(80), name: s(200), phone: s(30) } } }
  }, async (req, reply) => {
    try {
      const user = await signedInUser(req);
      const result = createSignupClub({ ...req.body, userId: user?.id || null, ip: req.ip });
      if (!user) setSession(reply, result.user);
      return reply.code(201).send({ club_id: result.club.id, club_name: result.club.name, clubs: listClubsForUser(result.user.id) });
    } catch (error) { return fail(reply, error); }
  });
  app.post("/api/signup/request-access", {
    config: authLimit(10),
    schema: { body: { type: "object", properties: { clubId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" }, name: s(200), phone: s(30) }, required: ["clubId"] } }
  }, async (req, reply) => {
    try { const user = await signedInUser(req); return requestAccess({ ...req.body, userId: user?.id || null }); } catch (error) { return fail(reply, error); }
  });
  app.get("/api/platform/signups", { preHandler: [app.authenticate, requirePlatformAdmin] }, async () => listSignups());
  app.delete("/api/platform/signups/:clubId", {
    preHandler: [app.authenticate, requirePlatformAdmin],
    schema: { params: { type: "object", properties: { clubId: { type: "string", pattern: "^[0-9a-fA-F-]{36}$" } }, required: ["clubId"] } }
  }, async (req, reply) => { try { return removeSignupClub(req.params.clubId, req.user.sub); } catch (error) { return fail(reply, error); } });
}
