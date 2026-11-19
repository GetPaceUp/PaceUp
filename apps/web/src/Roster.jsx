import { useEffect, useRef, useState } from "react";
import { api } from "./Rides.jsx";
import { readVcf } from "./phonebook.js";

const toBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
  reader.onerror = () => reject(new Error("Couldn't read that file."));
  reader.readAsDataURL(file);
});
const phoneText = (p) => (p ? `+${p.slice(0, p.length - 10)} ${p.slice(-10, -5)} ${p.slice(-5)}` : "No number");
const ago = (iso) => {
  if (!iso) return "not yet";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

function NameRow({ label, sub, initial = "", action, onSave, onRemove, busy }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  async function save(e) {
    e.preventDefault(); setError("");
    try { await onSave(value); setEditing(false); } catch (err) { setError(err.message); }
  }
  return (
    <div className="member-row">
      <div className="member-avatar">{(label || "?").slice(0, 1).toUpperCase()}</div>
      {editing
        ? <form className="name-edit" onSubmit={save}>
            <input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Full name" minLength={2} maxLength={80} autoFocus required />
            <button type="submit" className="small-button" disabled={busy}>Save</button>
            <button type="button" className="text-button" onClick={() => { setEditing(false); setError(""); }}>Cancel</button>
            {error && <small className="reset-error">{error}</small>}
          </form>
        : <><div className="member-info"><strong>{label}</strong><small>{sub}</small></div>
            <button type="button" className="text-button" onClick={() => { setValue(initial); setEditing(true); }}>{action}</button>
            {onRemove && <button type="button" className="text-button remove" disabled={busy} aria-label={`Remove ${label}`} onClick={onRemove}>✕</button>}</>}
    </div>
  );
}

/** Club admins: the names riders pick from when they tap "I'm in". */
export function RosterPanel({ clubId }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState("named");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const fileInput = useRef();
  const base = `/api/clubs/${clubId}/roster`;

  async function load(query = q) {
    try { setData(await api(`${base}?q=${encodeURIComponent(query)}`)); } catch (err) { setError(err.message); }
  }
  useEffect(() => { setData(null); setQ(""); setNotice(""); setError(""); load(""); }, [clubId]);
  useEffect(() => { const t = setTimeout(() => load(q), 200); return () => clearTimeout(t); }, [q]);
  useEffect(() => {
    if (!data?.whatsapp.syncing) return;
    const t = setInterval(() => load(), 2500);
    return () => clearInterval(t);
  }, [data?.whatsapp.syncing]);

  async function run(fn) {
    setBusy(true); setError(""); setNotice("");
    try { await fn(); } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const upload = (file) => file && run(async () => {
    try {
      let r;
      if (/\.vcf$/i.test(file.name) || /vcard/i.test(file.type)) {
        // Read on the phone: only names and numbers are sent, never photos or other details.
        const contacts = readVcf(await file.text());
        if (!contacts.length) throw new Error("No contacts with phone numbers found in that file.");
        r = await api(`${base}/phonebook`, { method: "POST", body: JSON.stringify({ contacts }) });
      } else {
        if (file.size > 30 * 1024 * 1024) throw new Error("That file is over 30 MB. Export it as .vcf or CSV instead.");
        r = await api(`${base}/import`, { method: "POST", body: JSON.stringify({ filename: file.name, data: await toBase64(file) }) });
      }
      setNotice(r.mode === "phonebook"
        ? `${r.named} of ${r.group_members} group members now have names${r.unnamed ? `, ${r.unnamed} still unnamed` : ""}. ${r.added + r.renamed} names came from your phone book. The other ${r.contacts - r.matched} contacts weren't in the group and were not saved.${r.clashes.length ? ` Check these duplicates: ${r.clashes.slice(0, 5).join(", ")}.` : ""}`
        : `Read ${r.read} ${r.read === 1 ? "name" : "names"}: ${r.added} added, ${r.updated} updated, ${r.unchanged} already there.`);
      setQ(""); await load("");
    } finally { if (fileInput.current) fileInput.current.value = ""; }
  });
  const sync = () => run(async () => { await api(`${base}/sync`, { method: "POST" }); await load(); });
  const add = (e) => { e.preventDefault(); run(async () => { await api(base, { method: "POST", body: JSON.stringify({ name }) }); setNotice(`Added ${name.trim()}.`); setName(""); await load(); }); };
  const rename = async (p, value) => { await api(`${base}/${p.id}`, { method: "PATCH", body: JSON.stringify({ name: value }) }); await load(); };
  const nameMember = async (p, value) => { await api(`${base}/from-group/${p.id}`, { method: "POST", body: JSON.stringify({ name: value }) }); await load(); };
  const remove = (p) => run(async () => { await api(`${base}/${p.id}`, { method: "DELETE" }); await load(); });

  if (!data) return <section className="admin-panel roster-panel"><h3>Member list</h3><p className="panel-copy">Loading…</p></section>;
  const wa = data.whatsapp;
  const unnamed = data.unnamed;

  return (
    <section className="admin-panel roster-panel">
      <h3>Member list <span className="count">{data.total}</span></h3>
      <p className="panel-copy">Members tap "I'm in", type a few letters and pick their name from this list. Nobody signs in.</p>

      {wa.group ? <div className="roster-source">
        <p><b>{wa.group}</b>: {wa.group_members} members, {wa.group_members - unnamed.count} named{unnamed.count ? `, ${unnamed.count} without a name` : ""}. <span className="panel-copy">Updated {wa.syncing ? "now…" : ago(wa.synced_at)}</span></p>
        <button type="button" className="secondary-button small-button" disabled={busy || wa.syncing || !wa.connected} onClick={sync}>{wa.syncing ? "Reading the group…" : "Refresh from group"}</button>
      </div> : <p className="panel-copy">Connect WhatsApp below and choose the club group. Its members are added here automatically.</p>}

      <div className="roster-upload">
        <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? "Working…" : "Add names from your phone book"}</button>
        <p className="panel-copy">Export your contacts (.vcf from Android, iCloud or Google Contacts) and upload the file. PaceUp keeps only the names of numbers that are in the club group and discards everything else. An Excel or CSV list with a "Name" column also works.</p>
        <input ref={fileInput} type="file" accept=".vcf,.csv,.xlsx,text/vcard,text/x-vcard,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" hidden onChange={(e) => upload(e.target.files[0])} />
      </div>
      {notice && <p className="success-note" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={view === "named"} className={view === "named" ? "tab on" : "tab"} onClick={() => setView("named")}>On the list ({data.total})</button>
        {unnamed.count > 0 && <button type="button" role="tab" aria-selected={view === "unnamed"} className={view === "unnamed" ? "tab on" : "tab"} onClick={() => setView("unnamed")}>Need a name ({unnamed.count})</button>}
      </div>

      {view === "named" || !unnamed.count ? <>
        {data.total > 8 && <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${data.total} names`} aria-label="Search the member list" />}
        <div className="roster-list">
          {data.people.map((p) => <NameRow key={p.id} label={p.name} sub={[p.phone && phoneText(p.phone), p.self_added && "Added themselves from an RSVP link"].filter(Boolean).join(" · ")} initial={p.name} action="Edit" busy={busy} onSave={(v) => rename(p, v)} onRemove={() => remove(p)} />)}
          {data.people.length === 0 && <p className="panel-copy">{q ? "No names match." : "No names yet."}</p>}
          {data.total > data.people.length && !q && <p className="panel-copy">Showing the first {data.people.length}. Search to find others.</p>}
        </div>
        <form className="inline-form" onSubmit={add}><div className="field-grow"><label htmlFor="roster-add">Add someone</label><input id="roster-add" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" minLength={2} maxLength={80} required /></div><button type="submit" disabled={busy}>Add</button></form>
      </> : <div className="roster-list">
        <p className="panel-copy">These group members haven't got a name yet. Type the name the club knows them by.</p>
        {unnamed.people.map((p) => <NameRow key={p.id} label={phoneText(p.phone)} sub={p.hint ? `WhatsApp name: ${p.hint}` : "No name from WhatsApp"} initial={p.hint || ""} action="Add name" busy={busy} onSave={(v) => nameMember(p, v)} />)}
      </div>}
    </section>
  );
}
