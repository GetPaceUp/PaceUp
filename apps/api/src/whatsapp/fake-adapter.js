// In-memory adapter for tests and local development without a phone.
export const sent = [];
const sessions = new Map();

export const fakeAdapter = {
  name: "fake",
  async connect(clubId, { onQr, onOpen, onClose, onGroupsChanged = () => {}, onMessage = () => {}, onContacts = () => {} }) {
    const session = {
      clubId, open: false, failNext: 0,
      groups: [{ jid: `${clubId.slice(0, 8)}-main@g.us`, name: "Club group", size: 42 }, { jid: `${clubId.slice(0, 8)}-admins@g.us`, name: "Club admins", size: 5 }],
      scan() { this.open = true; onOpen({ phone: "919800004521" }); },
      drop(loggedOut = false) { this.open = false; onClose({ loggedOut, error: "simulated" }); },
      async sendText(jid, text) {
        if (!this.open) throw new Error("not connected");
        if (this.failNext > 0) { this.failNext--; throw new Error("simulated send failure"); }
        sent.push({ clubId, jid, text, at: Date.now() });
      },
      async listGroups() { return this.groups; },
      addResults: {},     // phone -> "200" | "403" | "409" | Error, for tests
      added: [],
      async addToGroup(groupJid, phone) {
        const r = this.addResults[phone] ?? "200";
        if (r instanceof Error) throw r;
        if (r === "200") this.added.push({ groupJid, phone });
        return { status: r };
      },
      async groupInviteLink(groupJid) { return `https://chat.whatsapp.com/fake-${groupJid}`; },
      participants: [],   // [{ phone, lid }] of the club group
      groupMembers: {},   // other groups' members, by jid
      async groupParticipants(jid) { return this.groupMembers[jid] || this.participants; },
      /** Simulates WhatsApp reporting names (contacts sync or pushName on a message). */
      contacts(list) { onContacts(list); },
      /** Simulates someone sending the club number a direct message. */
      receive(from, text, id = `m-${Math.random().toString(36).slice(2)}`, fromAlt = null) { return onMessage({ id, from, fromAlt, text }); },
      joinGroup(group) { this.groups = [...this.groups, group]; onGroupsChanged(); },
      async logout() { this.open = false; sessions.delete(clubId); },
      end() { this.open = false; sessions.delete(clubId); }
    };
    sessions.set(clubId, session);
    onQr(`fake-qr-${clubId}-${Date.now()}`);
    return session;
  }
};
export const fakeSessions = sessions;
