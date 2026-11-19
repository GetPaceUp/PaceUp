// Filling the club roster from the club's WhatsApp group.
//
// WhatsApp gives PaceUp each group member's number (or a private "lid" id), but
// rarely a name. Names come from two places as the linked number sees them:
// the name saved in the club phone's contacts, and the name a person set on
// their own WhatsApp (shown when they message the group). People with a name
// go onto the roster automatically; the rest wait for an admin to type a name.
// Sync only ever adds people: names admins typed or uploaded are never changed.
import { randomUUID } from "node:crypto";
import { db } from "../db.js";
import { cleanName, nameKey } from "../roster.js";

const nowIso = () => new Date().toISOString();

/** "919876543210@s.whatsapp.net" or "919876543210:3@s.whatsapp.net" -> "919876543210" */
export function phoneFromJid(jid) {
  const m = String(jid || "").match(/^(\d{8,15})(?::\d+)?@s\.whatsapp\.net$/);
  return m ? m[1] : null;
}
export const lidFromJid = (jid) => (/@lid$/.test(String(jid || "")) ? String(jid).replace(/:\d+@/, "@") : null);

/** A display name WhatsApp gave us, minus emoji decoration. Null if it isn't a usable name. */
export function usableName(raw) {
  const name = cleanName(String(raw || "").replace(/^[^\p{L}]+/u, "").replace(/[^\p{L}.)]+$/u, ""));
  return (name.match(/\p{L}/gu) || []).length >= 2 ? name : null;
}

/**
 * Records what WhatsApp told us about people. contacts: [{ phone, lid, saved_name, push_name }],
 * any field may be missing. Rows for the same person (number and lid learned separately) are merged.
 */
export function recordContacts(clubId, contacts, { inGroup = null, groupOnly = false } = {}) {
  let named = 0;
  db.transaction(() => {
    const byPhone = db.prepare("SELECT * FROM whatsapp_contacts WHERE club_id = ? AND phone = ?");
    const byLid = db.prepare("SELECT * FROM whatsapp_contacts WHERE club_id = ? AND lid = ?");
    for (const c of contacts) {
      const phone = c.phone || null, lid = c.lid || null;
      if (!phone && !lid) continue;
      const a = phone ? byPhone.get(clubId, phone) : null;
      const b = lid ? byLid.get(clubId, lid) : null;
      if (a && b && a.id !== b.id) { // same person seen two ways: keep one row
        db.prepare("DELETE FROM whatsapp_contacts WHERE id = ?").run(b.id);
        db.prepare("UPDATE whatsapp_contacts SET lid = ?, saved_name = COALESCE(saved_name, ?), push_name = COALESCE(push_name, ?), in_group = MAX(in_group, ?) WHERE id = ?")
          .run(b.lid, b.saved_name, b.push_name, b.in_group, a.id);
      }
      const row = a || b;
      // The club phone may be someone's personal phone: never store people outside the club group.
      if (groupOnly && !(row && row.in_group)) continue;
      const saved = usableName(c.saved_name), push = usableName(c.push_name);
      if (saved || push) named++;
      if (row) {
        db.prepare(`UPDATE whatsapp_contacts SET phone = COALESCE(phone, @phone), lid = COALESCE(lid, @lid),
            saved_name = COALESCE(@saved, saved_name), push_name = COALESCE(@push, push_name),
            in_group = COALESCE(@inGroup, in_group), updated_at = @now WHERE id = @id`)
          .run({ phone, lid, saved, push, inGroup: inGroup == null ? null : inGroup ? 1 : 0, now: nowIso(), id: row.id });
      } else {
        db.prepare("INSERT INTO whatsapp_contacts (id, club_id, phone, lid, saved_name, push_name, in_group, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
          .run(randomUUID(), clubId, phone, lid, saved, push, inGroup ? 1 : 0, nowIso());
      }
    }
  }).immediate();
  return named;
}

/** Replaces who is in the club's group with the participant list WhatsApp returned. */
export function setGroupParticipants(clubId, participants) {
  db.transaction(() => {
    db.prepare("UPDATE whatsapp_contacts SET in_group = 0 WHERE club_id = ?").run(clubId);
    recordContacts(clubId, participants, { inGroup: true });
  }).immediate();
}

function rosterMatch(clubId, contact) {
  return (contact.phone && db.prepare("SELECT * FROM club_roster WHERE club_id = ? AND phone = ?").get(clubId, contact.phone))
    || (contact.lid && db.prepare("SELECT * FROM club_roster WHERE club_id = ? AND wa_jid = ?").get(clubId, contact.lid))
    || null;
}

/** Adds named group members to the roster. Returns how many were added or linked. */
export function syncRosterFromGroup(clubId) {
  return db.transaction(() => {
    const result = { added: 0, linked: 0 };
    const people = db.prepare("SELECT * FROM whatsapp_contacts WHERE club_id = ? AND in_group = 1").all(clubId);
    for (const c of people) {
      const existing = rosterMatch(clubId, c);
      const now = nowIso();
      if (existing) {
        if ((!existing.phone && c.phone) || (!existing.wa_jid && c.lid)) {
          db.prepare("UPDATE club_roster SET phone = COALESCE(phone, ?), wa_jid = COALESCE(wa_jid, ?), updated_at = ? WHERE id = ?").run(c.phone, c.lid, now, existing.id);
        }
        continue;
      }
      const name = c.saved_name || c.push_name;
      if (!name) continue;
      const sameName = db.prepare("SELECT * FROM club_roster WHERE club_id = ? AND name_key = ?").get(clubId, nameKey(name));
      if (sameName) {
        // An uploaded/typed entry with this name and no number yet is this person.
        if (!sameName.phone && !sameName.wa_jid) {
          db.prepare("UPDATE club_roster SET phone = ?, wa_jid = ?, updated_at = ? WHERE id = ?").run(c.phone, c.lid, now, sameName.id);
          result.linked++;
        }
        continue; // otherwise two people share a name: leave it for an admin
      }
      db.prepare("INSERT INTO club_roster (id, club_id, name, name_key, phone, wa_jid, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'whatsapp', ?, ?)")
        .run(randomUUID(), clubId, name, nameKey(name), c.phone, c.lid, now, now);
      result.added++;
    }
    return result;
  }).immediate();
}

/** Group members who aren't on the roster yet (no name known, or a name clash). Admins only. */
export function listUnnamed(clubId, limit = 300) {
  const rows = db.prepare(`
    SELECT wc.id, wc.phone, wc.push_name, wc.saved_name FROM whatsapp_contacts wc
    WHERE wc.club_id = ? AND wc.in_group = 1 AND NOT EXISTS (
      SELECT 1 FROM club_roster ro WHERE ro.club_id = wc.club_id AND ((wc.phone IS NOT NULL AND ro.phone = wc.phone) OR (wc.lid IS NOT NULL AND ro.wa_jid = wc.lid))
    ) ORDER BY wc.phone IS NULL, wc.phone
  `).all(clubId);
  return { count: rows.length, people: rows.slice(0, limit).map((r) => ({ id: r.id, phone: r.phone, hint: r.saved_name || r.push_name || null })) };
}

export function groupCount(clubId) {
  return db.prepare("SELECT COUNT(*) AS n FROM whatsapp_contacts WHERE club_id = ? AND in_group = 1").get(clubId).n;
}

export function contactById(clubId, id) {
  return db.prepare("SELECT * FROM whatsapp_contacts WHERE club_id = ? AND id = ?").get(clubId, id);
}
