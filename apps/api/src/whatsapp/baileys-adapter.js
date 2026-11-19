// Baileys (unofficial WhatsApp Web protocol) implementation of the adapter.
import { rmSync, mkdirSync } from "node:fs";
import makeWASocket, { useMultiFileAuthState, DisconnectReason, Browsers, fetchLatestBaileysVersion } from "baileys";
import pino from "pino";

const quiet = pino({ level: process.env.WHATSAPP_LOG_LEVEL || "warn" });

export const baileysAdapter = {
  name: "baileys",
  async connect(clubId, { authDir, onQr, onOpen, onClose, onGroupsChanged = () => {}, onMessage = () => {} }) {
    mkdirSync(authDir, { recursive: true, mode: 0o700 });
    const { state, saveCreds } = await useMultiFileAuthState(authDir);
    let version;
    try { ({ version } = await fetchLatestBaileysVersion()); } catch { /* use the library default */ }
    const sock = makeWASocket({
      auth: state, logger: quiet, version,
      browser: Browsers.ubuntu("PaceUp"),
      markOnlineOnConnect: false, syncFullHistory: false,
      generateHighQualityLinkPreview: false
    });
    let closed = false;
    sock.ev.on("creds.update", saveCreds);
    // Joined or created a group, renamed one, or membership changed: re-read the list.
    for (const ev of ["groups.upsert", "groups.update", "group-participants.update"]) sock.ev.on(ev, () => onGroupsChanged());
    // Direct text messages to the club number (admins creating activities).
    // Only live messages: history synced on reconnect arrives as type "append".
    sock.ev.on("messages.upsert", ({ messages, type }) => {
      if (type !== "notify") return;
      for (const m of messages) {
        const jid = m.key?.remoteJid || "";
        if (m.key?.fromMe || !/@(s\.whatsapp\.net|lid)$/.test(jid)) continue; // skip groups, status, channels
        const ts = Number(m.messageTimestamp || 0) * 1000;
        if (ts && Date.now() - ts > 10 * 60 * 1000) continue;
        const inner = m.message?.ephemeralMessage?.message || m.message?.viewOnceMessage?.message || m.message;
        const text = inner?.conversation || inner?.extendedTextMessage?.text;
        if (text) onMessage({ id: m.key.id, from: jid, fromAlt: m.key.remoteJidAlt || null, text });
      }
    });
    sock.ev.on("connection.update", (update) => {
      if (update.qr) onQr(update.qr);
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
        await sock.sendMessage(jid, { text });
      },
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
