// Messaging adapter. Everything WhatsApp-specific lives behind this interface so
// the transport can be swapped (e.g. for the official Business API) without
// touching rides, RSVPs or the outbox.
//
//   const adapter = await loadAdapter();
//   const session = await adapter.connect(clubId, { authDir, onQr, onOpen, onClose });
//   await session.sendText(groupJid, text);   // resolves when accepted by WhatsApp
//   await session.listGroups();               // [{ jid, name, size }]
//   await session.logout();                   // unlinks the device
//   session.end();                            // closes the socket, keeps the link

export async function loadAdapter(kind = process.env.WHATSAPP_ADAPTER || "baileys") {
  if (kind === "fake") return (await import("./fake-adapter.js")).fakeAdapter;
  if (kind === "baileys") return (await import("./baileys-adapter.js")).baileysAdapter;
  throw new Error(`Unknown WHATSAPP_ADAPTER: ${kind}`);
}
