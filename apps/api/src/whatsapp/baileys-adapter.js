// Baileys (unofficial WhatsApp Web protocol) implementation of the adapter.
import { rmSync, mkdirSync } from "node:fs";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from "baileys";
import pino from "pino";
import { phoneFromJid, lidFromJid } from "./contacts.js";

const quiet = pino({ level: process.env.WHATSAPP_LOG_LEVEL || "warn" });

// libsignal (used by Baileys) prints whole session records, private keys included,
// with console.info/warn. Drop those lines so keys never reach the system journal.
const SIGNAL_NOISE = /^(Closing session|Opening session|Removing old closed session|Session already (closed|open)|Closing open session|Migrating session|Decrypted message with closed session|Closing stale open session)/;
for (const level of ["info", "warn", "log"]) {
  const original = console[level].bind(console);
  console[level] = (...args) => { if (typeof args[0] === "string" && SIGNAL_NOISE.test(args[0])) return; original(...args); };
}

export const baileysAdapter = {
  name: "baileys",
  async connect(clubId, { authDir, pairingPhone = null, onQr, onPairingCode = () => {}, onOpen, onClose, onGroupsChanged = () => {}, onMessage = () => {}, onContacts = () => {} }) {
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use the library default */ }
    const sentByUs = new Set();
    const bare = (jid) => String(jid || "").replace(/:\d+@/, "@");
    const isSelfChat = (jid) => [sock.user?.id, sock.user?.lid].filter(Boolean).map(bare).includes(bare(jid));
    const sock = makeWASocket({
      auth: state, logger: quiet, version,
      browser: Browsers.ubuntu("PaceUp"),
      // WhatsApp hands out about six pairing refs. By default Baileys rotates them every 20 s and then
      // closes the socket (~2.5 min), which silently kills a link code the owner is still typing.
      // With a code, keep each ref for a minute so the socket (and the code) lasts past our 5-minute limit.
      ...(pairingPhone ? { qrTimeout: 60_000 } : {}),
      markOnlineOnConnect: false, syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });
    let closed = false;
    sock.ev.on("creds.update", saveCreds);
    // Joined or created a group, renamed one, or membership changed: re-read the list.
    for (const ev of ["groups.upsert", "groups.update", "group-participants.update"]) sock.ev.on(ev, () => onGroupsChanged());
    // Direct text messages to the club number (admins creating activities).
    // Only live messages: history synced on reconnect arrives as type "append".
    // Names for the roster: contacts saved on the club phone, and the names people set themselves.
    const toContact = (c) => ({
      phone: phoneFromJid(c.phoneNumber) || phoneFromJid(c.id), lid: lidFromJid(c.lid) || lidFromJid(c.id),
      saved_name: c.name || null, push_name: c.notify || c.verifiedName || null
    });
    sock.ev.on("contacts.upsert", (list) => onContacts(list.map(toContact)));
    sock.ev.on("contacts.update", (list) => onContacts(list.filter((c) => c.id).map(toContact)));
    sock.ev.on("messaging-history.set", ({ contacts = [], lidPnMappings = [] }) => {
      onContacts([...contacts.map(toContact), ...lidPnMappings.map((m) => ({ phone: phoneFromJid(m.pn), lid: lidFromJid(m.lid) }))]);
    });
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      const seen = [];
      for (const m of messages) {
        if (m.key?.fromMe || !m.pushName) continue;
        const ids = [m.key.participant, m.key.participantAlt, m.key.remoteJid, m.key.remoteJidAlt].filter((j) => j && !j.endsWith("@g.us"));
        const phone = ids.map(phoneFromJid).find(Boolean), lid = ids.map(lidFromJid).find(Boolean);
        if (phone || lid) seen.push({ phone, lid, push_name: m.pushName });
      }
      if (seen.length) onContacts(seen);
      if (type !== "notify") return;
      for (const m of messages) {
        const jid = m.key?.remoteJid || "";
        if (!/@(s\.whatsapp\.net|lid)$/.test(jid)) continue; // skip groups, status, channels
        // Our own messages are skipped, except notes typed into "Message yourself" on the club phone
        // (when the club number is an admin's own phone). Our replies there are never read back.
        if (m.key?.fromMe && (!isSelfChat(jid) || sentByUs.has(m.key.id))) continue;
        const ts = Number(m.messageTimestamp || 0) * 1000;
        if (ts && Date.now() - ts > 10 * 60 * 1000) continue;
        const inner = m.message?.ephemeralMessage?.message || m.message?.viewOnceMessage?.message || m.message;
        const text = inner?.conversation || inner?.extendedTextMessage?.text;
        if (text) onMessage({ id: m.key.id, from: jid, fromAlt: m.key.remoteJidAlt || null, text });
      }
    });
    let codeAsked = false;
    sock.ev.on("connection.update", (update) => {
      if (update.qr) {
        onQr(update.qr);
        // Linking by phone number: once the socket is ready for pairing, ask WhatsApp for the 8-character code.
        if (pairingPhone && !codeAsked && !sock.authState?.creds?.registered) {
          codeAsked = true;
          sock.requestPairingCode(pairingPhone).then((code) => onPairingCode(String(code).replace(/^(.{4})(.{4})$/, "$1-$2")))
            .catch((error) => quiet.warn({ err: error?.message }, "pairing code request failed"));
        }
      }
      if (update.connection === "open") {
        const phone = (sock.user?.id || "").split(":")[0].split("@")[0];
        onOpen({ phone });
      }
      if (update.connection === "close" && !closed) {
        closed = true;
        const code = update.lastDisconnect?.error?.output?.statusCode;
        onClose({ loggedOut: code === DisconnectReason.loggedOut, restartRequired: code === DisconnectReason.restartRequired, error: update.lastDisconnect?.error?.message || `closed (${code})` });
      }
    });
    return {
      async sendText(jid, text) {
        await sock.presenceSubscribe(jid).catch(() => {});
        await sock.sendPresenceUpdate("composing", jid).catch(() => {});
        await new Promise((r) => setTimeout(r, 1200 + Math.random() * 1800));
        await sock.sendPresenceUpdate("paused", jid).catch(() => {});
        const sent = await sock.sendMessage(jid, { text });
        if (sent?.key?.id) { sentByUs.add(sent.key.id); if (sentByUs.size > 500) sentByUs.delete(sentByUs.values().next().value); }
      },
      /** Who is in a group: [{ phone, lid }] (either may be missing). */
      async groupParticipants(jid) {
        const meta = await sock.groupMetadata(jid);
        const people = meta.participants.map((p) => ({ phone: phoneFromJid(p.phoneNumber) || phoneFromJid(p.id), lid: lidFromJid(p.lid) || lidFromJid(p.id) }));
        // Big groups and community announcement groups list members by private id (@lid) only.
        // The linked phone already knows the number behind many of them: look it up.
        const unknown = people.filter((p) => !p.phone && p.lid).map((p) => p.lid);
        if (unknown.length) {
          try {
            const found = await sock.signalRepository?.lidMapping?.getPNsForLIDs?.(unknown);
            const byLid = new Map((found || []).map((m) => [lidFromJid(m.lid), phoneFromJid(m.pn)]));
            for (const p of people) if (!p.phone && byLid.get(p.lid)) p.phone = byLid.get(p.lid);
          } catch { /* keep the private ids; names can still come from WhatsApp or an admin */ }
        }
        return people;
      },
      /** Adds one person to a group. WhatsApp answers per person: "200" added, "409" already in, "403" their privacy settings refuse. */
      async addToGroup(groupJid, phone) {
        const [result] = await sock.groupParticipantsUpdate(groupJid, [`${phone}@s.whatsapp.net`], "add");
        return { status: String(result?.status ?? "") };
      },
      async groupInviteLink(groupJid) { return `https://chat.whatsapp.com/${await sock.groupInviteCode(groupJid)}`; },
      async listGroups() {
        const groups = await sock.groupFetchAllParticipating();
        return Object.values(groups).map((g) => ({ jid: g.id, name: g.subject, size: g.participants?.length || 0 }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      async logout() {
        closed = true;
        try { await sock.logout(); } catch { /* already gone */ }
        rmSync(authDir, { recursive: true, force: true });
      },
      end() { closed = true; try { sock.end(undefined); } catch { /* ignore */ } }
    };
  }
};
