// WhatsApp worker: a separate long-running process (systemd unit paceup-whatsapp).
// It keeps one linked-device session per club that asked to be connected, and
// delivers that club's outbox to that club's group only.
import "dotenv/config";
import { join, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { db } from "../db.js";
import { codeVersion } from "../version.js";
import { loadAdapter } from "./adapter.js";
import { HOURLY_CAP, MAX_ATTEMPTS, PAIRING_TIMEOUT_MS, memberGroups, clubGroups, isClubGroup } from "./outbox.js";
import { participants } from "../rides.js";
import { handleIncoming } from "./conversation.js";
import { processGroupAdds } from "./group-adds.js";
import { recordContacts, setGroupParticipants, syncRosterFromGroup } from "./contacts.js";
import { markClubLive } from "../directory.js";
import { queueNoShowNudges } from "../no-shows.js";
import { regularsText } from "../regulars.js";
import { ridePublishedText, riderListText, rideUpdatedText, rideCancelledText, testText } from "./messages.js";

const iso = (ms) => new Date(ms).toISOString();
const GROUPS_REFRESH_MS = 2 * 60 * 1000;
const ROSTER_REFRESH_MS = 30 * 60 * 1000;
const QUIET_START = 22, QUIET_END = 5;

function defaultDataDir() {
  if (process.env.WHATSAPP_DATA_DIR) return process.env.WHATSAPP_DATA_DIR;
  const url = process.env.DATABASE_URL || "file:./data/paceup.sqlite";
  const path = url.startsWith("file:") ? url.slice(5) : url;
  return join(dirname(resolve(path)), "whatsapp");
}

function localHour(ms) {
  return Number(new Date(ms).toLocaleString("en-GB", { timeZone: process.env.PACEUP_TIMEZONE || "Asia/Kolkata", hour: "2-digit", hourCycle: "h23" }));
}

export class WhatsAppWorker {
  constructor({ adapter, dataDir = defaultDataDir(), log = console, sendGapMs = [4000, 9000], groupAddLimits = {} } = {}) {
    this.adapter = adapter;
    this.dataDir = dataDir;
    this.log = log;
    this.sendGapMs = sendGapMs;
    this.groupAddLimits = groupAddLimits; // tests shorten the gap between group adds
    this.sessions = new Map();      // clubId -> { session, open, startedAt, retryAt, retries }
    this.nextSendAt = new Map();    // clubId -> ms (spacing between posts of one number)
    this.busy = false;
  }

  setConn(clubId, fields) {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE whatsapp_connections SET ${keys.map((k) => `${k} = @${k}`).join(", ")}, updated_at = @updated_at WHERE club_id = @club_id`)
      .run({ ...fields, updated_at: iso(Date.now()), club_id: clubId });
  }

  authDir(clubId) {
    if (!/^[0-9a-f-]{36}$/i.test(clubId)) throw new Error("bad club id");
    return join(this.dataDir, clubId);
  }

  async startSession(clubId, pairingPhone = null) {
    const entry = { open: false, startedAt: Date.now(), retries: this.sessions.get(clubId)?.retries || 0, pairingPhone };
    this.sessions.set(clubId, entry);
    try {
      entry.session = await this.adapter.connect(clubId, {
        authDir: this.authDir(clubId),
        pairingPhone,
        // Once a link code is out, QR rotations don't matter: the code's own clock (qr_updated_at) must not move.
        onQr: (qr) => { if (!entry.codeAt) this.setConn(clubId, { status: "pairing", qr, qr_updated_at: iso(Date.now()), last_error: null }); },
        // "Link with phone number instead": WhatsApp gives a code the owner types on the club phone.
        onPairingCode: (code) => {
          entry.codeAt = Date.now();
          this.setConn(clubId, { status: "pairing", pairing_code: code, qr_updated_at: iso(entry.codeAt), last_error: null });
        },
        onOpen: async ({ phone }) => {
          // Each club sends from its own number only. A number already serving another club is refused
          // at once: one ban would otherwise take down both clubs.
          const taken = phone && db.prepare("SELECT c.name FROM whatsapp_connections wc INNER JOIN clubs c ON c.id = wc.club_id WHERE wc.phone = ? AND wc.club_id != ? AND wc.desired = 'on'").get(phone, clubId);
          if (taken) {
            this.log.warn?.(`[whatsapp] club ${clubId} tried to link a number already used by another club; unlinked`);
            this.sessions.delete(clubId);
            await entry.session?.logout?.().catch?.(() => {});
            this.setConn(clubId, { desired: "off", status: "disconnected", phone: null, qr: null, groups_json: null, last_error: "This number is already linked to another club on PaceUp. Each club needs its own WhatsApp number." });
            return;
          }
          entry.open = true; entry.retries = 0;
          this.setConn(clubId, { status: "connected", phone, qr: null, pairing_code: null, pairing_phone: null, last_error: null, last_seen_at: iso(Date.now()) });
          markClubLive(clubId);
          this.log.info?.(`[whatsapp] club ${clubId} connected`);
          await this.refreshGroups(clubId);
        },
        onMessage: (msg) => this.onMessage(clubId, msg),
        onContacts: (list) => {
          // Names are kept in memory until we know who is in the club group; only group members are stored.
          entry.names ||= new Map();
          for (const c of list) {
            if (!c.saved_name && !c.push_name) continue;
            for (const k of [c.phone, c.lid].filter(Boolean)) entry.names.set(k, { ...entry.names.get(k), ...c });
          }
          if (entry.names.size > 50000) entry.names = new Map([...entry.names].slice(-25000));
          try { if (recordContacts(clubId, list, { groupOnly: true })) entry.rosterDirty = true; }
          catch (error) { this.log.warn?.(`[whatsapp] could not record contacts for ${clubId}: ${error.message}`); }
        },
        // WhatsApp told us the number's groups changed: refetch on the next tick.
        onGroupsChanged: () => { entry.groupsAt = 0; },
        onClose: ({ loggedOut, restartRequired, error }) => {
          entry.open = false;
          this.sessions.delete(clubId);
          if (loggedOut) {
            this.log.warn?.(`[whatsapp] club ${clubId} was unlinked from the phone`);
            entry.session?.logout?.().catch?.(() => {});
            this.setConn(clubId, { status: "logged_out", desired: "off", phone: null, qr: null, groups_json: null, last_error: "The phone unlinked PaceUp. Connect again to resume posting." });
            return;
          }
          const retries = restartRequired ? 0 : entry.retries + 1;
          const wait = restartRequired ? 500 : Math.min(5 * 60 * 1000, 2000 * 2 ** Math.min(retries, 8));
          this.sessions.set(clubId, { open: false, retryAt: Date.now() + wait, retries, placeholder: true });
          this.setConn(clubId, { status: "reconnecting", last_error: error || null });
        }
      });
    } catch (error) {
      this.sessions.set(clubId, { open: false, retryAt: Date.now() + 30000, retries: entry.retries + 1, placeholder: true });
      this.setConn(clubId, { status: "error", last_error: String(error.message || error) });
    }
  }

  /** An admin chatting with the club number to create an activity. Replies go straight back to them. */
  async onMessage(clubId, msg) {
    let reply;
    try { reply = handleIncoming(clubId, msg); }
    catch (error) {
      this.log.error?.(`[whatsapp] could not handle a message for ${clubId}: ${error.stack || error}`);
      reply = "Sorry, something went wrong on our side. Nothing was published. Please try again in a minute.";
    }
    if (!reply) return;
    const entry = this.sessions.get(clubId);
    try { await entry?.session?.sendText(msg.from, reply); }
    catch (error) { this.log.warn?.(`[whatsapp] could not reply to an admin for ${clubId}: ${error.message}`); }
  }

  /** Keeps the roster filled from the club group: participant list every 30 min or on request, new names as they arrive. */
  async syncRoster(conn, entry) {
    const groups = memberGroups(conn);
    if (!groups.length) return;
    const key = groups.join(",");
    const asked = conn.roster_sync_wanted_at && new Date(conn.roster_sync_wanted_at).getTime() > (entry.rosterAt || 0);
    try {
      if (asked || entry.rosterGroup !== key || Date.now() - (entry.rosterAt || 0) > ROSTER_REFRESH_MS) {
        entry.rosterAt = Date.now();
        entry.rosterGroup = key;
        // Everyone in any of the member groups, once each (the same person is often in several groups).
        const seen = new Set(), members = [];
        for (const jid of groups) {
          for (const m of await entry.session.groupParticipants(jid)) {
            const id = m.phone || m.lid;
            if (!id || seen.has(id)) continue;
            seen.add(id); members.push(m);
          }
        }
        setGroupParticipants(conn.club_id, members.map((m) => ({ ...(entry.names?.get(m.phone) || entry.names?.get(m.lid) || {}), ...m })));
        entry.rosterDirty = true;
      }
      if (entry.rosterDirty) {
        entry.rosterDirty = false;
        syncRosterFromGroup(conn.club_id);
        this.setConn(conn.club_id, { roster_synced_at: iso(Date.now()) });
      }
    } catch (error) { this.log.warn?.(`[whatsapp] roster sync failed for ${conn.club_id}: ${error.message}`); }
  }

  async refreshGroups(clubId) {
    const entry = this.sessions.get(clubId);
    if (!entry?.open) return;
    try {
      const groups = await entry.session.listGroups();
      entry.groupsAt = Date.now();
      this.setConn(clubId, { groups_json: JSON.stringify(groups), groups_updated_at: iso(entry.groupsAt) });
    } catch (error) { this.log.warn?.(`[whatsapp] could not list groups for ${clubId}: ${error.message}`); }
  }

  /** Bring live sessions in line with what each club asked for. */
  async reconcile() {
    const conns = db.prepare("SELECT * FROM whatsapp_connections").all();
    const wanted = new Set();
    for (const c of conns) {
      const entry = this.sessions.get(c.club_id);
      if (c.desired === "logout") {
        if (entry?.session) await entry.session.logout().catch(() => {});
        else {
          // Not running: open the stored link just long enough to remove it.
          const { rmSync } = await import("node:fs");
          rmSync(this.authDir(c.club_id), { recursive: true, force: true });
        }
        this.sessions.delete(c.club_id);
        this.setConn(c.club_id, { desired: "off", status: "disconnected", phone: null, qr: null, groups_json: null, group_jid: null, group_name: null, last_error: null });
        continue;
      }
      if (c.desired !== "on") continue;
      wanted.add(c.club_id);
      if (entry && !entry.open && !entry.placeholder && ((c.pairing_phone || null) !== (entry.pairingPhone || null) || (entry.codeAt && !c.pairing_code))) {
        // The owner switched between a code and a QR, or asked for a new code: start pairing again.
        entry.session?.end();
        this.sessions.delete(c.club_id);
        await this.startSession(c.club_id, c.pairing_phone || null);
      } else if (!entry || (entry.placeholder && Date.now() >= entry.retryAt)) await this.startSession(c.club_id, c.pairing_phone || null);
      else if (!entry.open && c.status === "pairing" && c.qr_updated_at && Date.now() - (entry.codeAt || entry.startedAt) > PAIRING_TIMEOUT_MS) {
        entry.session?.end();
        this.sessions.delete(c.club_id);
        // pairing_phone stays, so "Get a new code" can reuse the number.
        this.setConn(c.club_id, { desired: "off", status: "disconnected", qr: null, pairing_code: null, last_error: c.pairing_phone ? "The link code expired before it was used." : "The QR code expired before it was scanned. Press Show QR code to try again." });
      } else if (entry.open) {
        this.setConn(c.club_id, { last_seen_at: iso(Date.now()) });
        const asked = c.groups_wanted_at && new Date(c.groups_wanted_at).getTime() > (entry.groupsAt || 0);
        if (asked || !entry.groupsAt || Date.now() - entry.groupsAt > GROUPS_REFRESH_MS) await this.refreshGroups(c.club_id);
        await this.syncRoster(c, entry);
      }
    }
    for (const [clubId, entry] of this.sessions) {
      if (!wanted.has(clubId)) { entry.session?.end(); this.sessions.delete(clubId); }
    }
  }

  buildText(item) {
    if (item.kind === "test") {
      const club = db.prepare("SELECT name FROM clubs WHERE id = ?").get(item.club_id);
      return { text: testText(club?.name || "Your club") };
    }
    if (item.kind === "regulars") return { text: regularsText(item.club_id, JSON.parse(item.payload).month), payload: item.payload };
    const ride = db.prepare(`SELECT r.*, u.name AS organiser_name, c.name AS club_name FROM rides r LEFT JOIN users u ON u.id = r.organiser_id LEFT JOIN clubs c ON c.id = r.club_id WHERE r.id = ?`).get(item.ride_id);
    if (!ride) return { skip: "ride deleted" };
    if (item.kind === "ride_cancelled") return { text: rideCancelledText(ride) };
    if (ride.status !== "published") return { skip: `ride is ${ride.status}` };
    if (new Date(ride.starts_at).getTime() <= Date.now()) return { skip: "ride already started" };
    // Stable key per person for the "new"/"dropped out" diff: user id, roster id, or the RSVP id for a guest.
    const riders = participants(ride.id).map((p) => ({ id: p.user_id || p.roster_id || p.id, user_id: p.user_id, name: p.name, join_point: ride.meeting_point_2 ? p.join_point : 1 }));
    const payload = JSON.stringify({ riders });
    // Every post carries the full details and the going list.
    if (item.kind === "ride_published") return { text: ridePublishedText(ride, riders), payload };
    if (item.kind === "ride_updated") return { text: rideUpdatedText(ride, riders), payload };
    const prevRow = db.prepare("SELECT payload FROM outbox WHERE ride_id = ? AND kind IN ('rider_list', 'ride_published', 'ride_updated') AND status = 'sent' AND payload IS NOT NULL ORDER BY sent_at DESC LIMIT 1").get(ride.id);
    const previous = prevRow?.payload ? JSON.parse(prevRow.payload).riders : null;
    if (previous && previous.length === riders.length && previous.every((r, i) => r.id === riders[i].id && (r.join_point || 1) === riders[i].join_point)) return { skip: "list unchanged since last post" };
    return { text: riderListText(ride, riders, previous), payload };
  }

  /** Send whatever is due, one post per club per pass, within each club's limits. */
  async deliver() {
    const now = Date.now();
    const due = db.prepare("SELECT * FROM outbox WHERE status = 'pending' AND not_before <= ? ORDER BY not_before LIMIT 50").all(iso(now));
    const handled = new Set();
    for (const item of due) {
      if (handled.has(item.club_id)) continue;
      const conn = db.prepare("SELECT * FROM whatsapp_connections WHERE club_id = ?").get(item.club_id);
      const entry = this.sessions.get(item.club_id);
      if (!conn || conn.desired !== "on" || !isClubGroup(conn, conn.group_jid)) { this.finish(item, "skipped", "WhatsApp posting is not set up for this club"); continue; }
      if (!entry?.open) continue; // stays queued until the club is connected again
      const settingOff = { ride_published: !conn.post_new_ride, rider_list: !conn.post_rider_list, ride_updated: !conn.post_changes, ride_cancelled: !conn.post_changes }[item.kind];
      if (settingOff) { this.finish(item, "skipped", "turned off in club settings"); continue; }
      if (conn.quiet_hours && item.kind !== "test") {
        const h = localHour(now);
        if (h >= QUIET_START || h < QUIET_END) { this.postpone(item, now + 15 * 60 * 1000); continue; }
      }
      const hourAgo = iso(now - 60 * 60 * 1000);
      const recent = db.prepare("SELECT sent_at FROM outbox WHERE club_id = ? AND status = 'sent' AND sent_at >= ? ORDER BY sent_at").all(item.club_id, hourAgo);
      if (recent.length >= HOURLY_CAP) { this.postpone(item, new Date(recent[0].sent_at).getTime() + 60 * 60 * 1000 + 5000); continue; }
      if ((this.nextSendAt.get(item.club_id) || 0) > now) continue;

      handled.add(item.club_id);
      const built = this.buildText(item);
      if (built.skip) { this.finish(item, "skipped", built.skip); handled.delete(item.club_id); continue; }
      try {
        const own = item.ride_id && item.kind !== "test" ? db.prepare("SELECT wa_group_jid FROM rides WHERE id = ?").get(item.ride_id)?.wa_group_jid : null;
        const target = own && clubGroups(conn).some((g) => g.jid === own) ? own : conn.group_jid;
        await entry.session.sendText(target, built.text);
        db.prepare("UPDATE outbox SET status = 'sent', sent_at = ?, attempts = attempts + 1, payload = ?, last_error = NULL WHERE id = ?").run(iso(Date.now()), built.payload ?? null, item.id);
        const [lo, hi] = this.sendGapMs;
        this.nextSendAt.set(item.club_id, Date.now() + lo + Math.random() * (hi - lo));
      } catch (error) {
        const attempts = item.attempts + 1;
        if (attempts >= MAX_ATTEMPTS) this.finish(item, "failed", error.message, attempts);
        else db.prepare("UPDATE outbox SET attempts = ?, last_error = ?, not_before = ? WHERE id = ?")
          .run(attempts, String(error.message).slice(0, 500), iso(Date.now() + Math.min(30 * 60 * 1000, 30000 * 2 ** (attempts - 1))), item.id);
      }
    }
  }

  /** Sign-in codes and other one-to-one messages: sent at once, never held for quiet hours or caps. */
  async deliverDirect() {
    const now = iso(Date.now());
    db.prepare("UPDATE whatsapp_direct SET status = 'failed', last_error = COALESCE(last_error, 'expired before sending') WHERE status = 'pending' AND expires_at <= ?").run(now);
    for (const msg of db.prepare("SELECT * FROM whatsapp_direct WHERE status = 'pending' ORDER BY created_at LIMIT 20").all()) {
      const entry = this.sessions.get(msg.club_id);
      if (!entry?.open) continue; // waits (until it expires) for the number to reconnect
      try {
        await entry.session.sendText(`${msg.to_phone}@s.whatsapp.net`, msg.text);
        db.prepare("UPDATE whatsapp_direct SET status = 'sent', sent_at = ?, attempts = attempts + 1 WHERE id = ?").run(iso(Date.now()), msg.id);
      } catch (error) {
        db.prepare("UPDATE whatsapp_direct SET attempts = attempts + 1, last_error = ?, status = CASE WHEN attempts + 1 >= 3 THEN 'failed' ELSE status END WHERE id = ?").run(String(error.message).slice(0, 300), msg.id);
      }
    }
  }

  /** The Lead's one reminder to mark no-shows (checked at most once a minute). */
  nudgeNoShows() {
    if (this.nudgedAt && Date.now() - this.nudgedAt < 60000) return;
    this.nudgedAt = Date.now();
    try { queueNoShowNudges(); }
    catch (error) { this.log.warn?.(`[whatsapp] could not queue no-show reminders: ${error.message}`); }
  }

  finish(item, status, reason, attempts = item.attempts) {
    db.prepare("UPDATE outbox SET status = ?, last_error = ?, attempts = ? WHERE id = ?").run(status, reason ? String(reason).slice(0, 500) : null, attempts, item.id);
  }
  postpone(item, ms) { db.prepare("UPDATE outbox SET not_before = ? WHERE id = ?").run(iso(ms), item.id); }

  async tick() {
    if (this.busy) return;
    this.busy = true;
    try { this.checkIn(); await this.reconcile(); this.nudgeNoShows(); await this.deliverDirect(); await processGroupAdds(this.sessions, { ...this.groupAddLimits, log: this.log }); await this.deliver(); }
    catch (error) { this.log.error?.(`[whatsapp] tick failed: ${error.stack || error}`); }
    finally { this.busy = false; }
  }

  /** Tells /health which code this worker runs and that it is alive (at most every 10 seconds). */
  checkIn() {
    if (this.checkedIn && Date.now() - this.checkedIn < 10000) return;
    this.checkedIn = Date.now();
    db.prepare(`INSERT INTO service_status (name, version, started_at, seen_at) VALUES ('whatsapp-worker', @v, @now, @now)
      ON CONFLICT(name) DO UPDATE SET version = @v, seen_at = @now, started_at = CASE WHEN version = @v THEN started_at ELSE @now END`)
      .run({ v: codeVersion || "unknown", now: new Date().toISOString() });
  }

  stop() { for (const entry of this.sessions.values()) entry.session?.end(); this.sessions.clear(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const adapter = await loadAdapter();
  const worker = new WhatsAppWorker({ adapter });
  console.log(`[whatsapp] worker started (${adapter.name}), sessions in ${worker.dataDir}`);
  // Reset statuses left over from a previous run; sessions reconnect on the first tick.
  db.prepare("UPDATE whatsapp_connections SET status = CASE WHEN desired = 'on' THEN 'reconnecting' ELSE 'disconnected' END, qr = NULL").run();
  const timer = setInterval(() => worker.tick(), 3000);
  worker.tick();
  const shutdown = () => { clearInterval(timer); worker.stop(); db.close(); process.exit(0); };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}
