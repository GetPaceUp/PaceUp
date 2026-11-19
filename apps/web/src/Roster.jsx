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
  const [confirming, setConfirming] = useState(false);
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
            {onRemove && <button type="button" className="text-button remove" disabled={busy} aria-label={`Remove ${label}`} onClick={() => setConfirming(true)}>✕</button>}</>}
      {confirming && <div className="confirm-row" role="alertdialog" aria-label={`Remove ${label}?`}>
        <span>Remove <b>{label}</b> from the list?</span>
        <button type="button" className="small-button danger" disabled={busy} onClick={async () => { setConfirming(false); await onRemove(); }}>Remove</button>
        <button type="button" className="text-button" onClick={() => setConfirming(false)}>Keep</button>
      </div>}
    </div>
  );
}

/** Phone-book names often carry tags ("Aneesh Saraiya Cycling Sector 65"). Preview the tidy names and apply the ticked ones. */
function NameCleanup({ base, onApplied }) {
  const [people, setPeople] = useState([]);
  const [open, setOpen] = useState(false);
  const [off, setOff] = useState(new Set());
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  async function load() { try { setPeople((await api(`${base}/cleanup`)).people); } catch { setPeople([]); } }
  useEffect(() => { load(); }, [base]);
  if (!people.length) return msg ? <p className="success-note" role="status">{msg}</p> : null;
  const chosen = people.filter((p) => !off.has(p.id));
  const toggle = (id) => setOff((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  async function apply() {
    setBusy(true);
    try {
      const r = await api(`${base}/cleanup`, { method: "POST", body: JSON.stringify({ ids: chosen.map((p) => p.id) }) });
      setMsg(`Tidied ${r.applied} ${r.applied === 1 ? "name" : "names"}.${r.skipped.length ? ` Left as they were, because the tidy name is already on the list: ${r.skipped.join(", ")}.` : ""}`);
      setOpen(false); setOff(new Set()); await load(); onApplied();
    } catch (err) { setMsg(err.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="cleanup-box">
      <p><b>✨ {people.length} {people.length === 1 ? "name has" : "names have"} extra words from your phone book</b>, like "{people[0].name}". Members would see "{people[0].suggested}" instead.</p>
      {!open
        ? <button type="button" className="secondary-button small-button" onClick={() => setOpen(true)}>Review and tidy</button>
        : <>
            <ul className="cleanup-list">
              {people.map((p) => (
                <li key={p.id}><label>
                  <input type="checkbox" checked={!off.has(p.id)} onChange={() => toggle(p.id)} />
                  <span><s>{p.name}</s><b>{p.suggested}</b></span>
                </label></li>
              ))}
            </ul>
            <div className="cleanup-actions">
              <button type="button" disabled={busy || !chosen.length} onClick={apply}>{busy ? "Tidying…" : `Apply cleanup (${chosen.length})`}</button>
              <button type="button" className="text-button" onClick={() => setOpen(false)}>Not now</button>
            </div>
            <p className="panel-copy">Untick any that look wrong. You can still edit any name afterwards.</p>
          </>}
      {msg && <p className="success-note" role="status">{msg}</p>}
    </div>
  );
}

/** Club admins: the names riders pick from when they tap "I'm in". */
export function RosterPanel({ clubId, onBack }) {
  const [data, setData] = useState(null);
  const [q, setQ] = useState("");
  const [view, setView] = useState("named");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("+91 ");
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
        ? `${r.named} of ${r.group_members} group members now have names${r.unnamed ? `, ${r.unnamed} still unnamed` : ""}. ${r.added + r.renamed} names came from your phone book. The other ${r.contacts - r.matched} contacts weren't in the group and were not saved.${r.clashes.length ? ` Not added, because the name is already on the list with a different number: ${r.clashes.slice(0, 5).join(", ")}. If that's the same person with two numbers, there's nothing to do. Otherwise add a surname or initial to one of them.` : ""}`
        : `Read ${r.read} ${r.read === 1 ? "name" : "names"}: ${r.added} added, ${r.updated} updated, ${r.unchanged} already there.`);
      setQ(""); await load("");
    } finally { if (fileInput.current) fileInput.current.value = ""; }
  });
  const sync = () => run(async () => { await api(`${base}/sync`, { method: "POST" }); await load(); });
  const [added, setAdded] = useState(null); // { ok, text, existing }
  const [adding, setAdding] = useState(false);
  const [toGroup, setToGroup] = useState(true);
  const [groupJid, setGroupJid] = useState("");
  const [groupAdd, setGroupAdd] = useState(null); // status of the WhatsApp group add
  const groups = data?.whatsapp?.groups || [];
  const pickedGroup = groupJid || data?.whatsapp?.add_group || groups[0]?.jid || "";
  // Follow the WhatsApp add until the club number has done it (it waits between adds to stay safe).
  useEffect(() => {
    if (!groupAdd || groupAdd.status !== "pending") return;
    let tries = 0;
    const t = setInterval(async () => {
      tries++;
      try { const d = await api(`${base}/group-adds/${groupAdd.id}`); setGroupAdd(d.group_add); if (d.group_add.status !== "pending") clearInterval(t); } catch { /* keep the last status */ }
      if (tries > 60) clearInterval(t);
    }, 3000);
    return () => clearInterval(t);
  }, [groupAdd?.id, groupAdd?.status]);
  async function add(e) {
    e.preventDefault(); setAdding(true); setAdded(null); setGroupAdd(null);
    try {
      const wa_group_jid = groups.length && toGroup ? pickedGroup : null;
      const r = await api(base, { method: "POST", body: JSON.stringify({ name, phone, wa_group_jid }) });
      setGroupAdd(r.group_add || null);
      setAdded({ ok: true, text: `✓ Added ${r.person?.name || name.trim()}${r.person?.phone ? ` (${phoneText(r.person.phone)})` : ""}.` });
      setName(""); setPhone("+91 "); setQ(""); await load("");
    } catch (err) {
      setAdded({ ok: false, text: err.message, existing: err.data?.existing || null });
    } finally { setAdding(false); }
  }
  // Show the entry that's already there, so it can be checked or edited.
  const showExisting = (p) => { setView("named"); setQ(p.phone || p.name); };
  const rename = async (p, value) => { await api(`${base}/${p.id}`, { method: "PATCH", body: JSON.stringify({ name: value }) }); await load(); };
  const nameMember = async (p, value) => { await api(`${base}/from-group/${p.id}`, { method: "POST", body: JSON.stringify({ name: value }) }); await load(); };
  const remove = (p) => run(async () => { await api(`${base}/${p.id}`, { method: "DELETE" }); await load(); });

  if (!data) return <section className="admin-panel roster-panel"><h3>Member list</h3><p className="panel-copy">Loading…</p></section>;
  const wa = data.whatsapp;
  const unnamed = data.unnamed;

  return (
    <section className="admin-panel roster-panel">
      {onBack && <button type="button" className="text-button back-link" onClick={onBack}>← Back to dashboard</button>}
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
      <NameCleanup key={`${base}:${data.total}:${notice}`} base={base} onApplied={() => load()} />

      <div className="tabs" role="tablist">
        <button type="button" role="tab" aria-selected={view === "named"} className={view === "named" ? "tab on" : "tab"} onClick={() => setView("named")}>On the list ({data.total})</button>
        {unnamed.count > 0 && <button type="button" role="tab" aria-selected={view === "unnamed"} className={view === "unnamed" ? "tab on" : "tab"} onClick={() => setView("unnamed")}>Need a name ({unnamed.count})</button>}
      </div>

      {view === "named" || !unnamed.count ? <>
        <form className="stack-form roster-add" onSubmit={add}>
          <label htmlFor="roster-add">Add someone</label>
          <input id="roster-add" value={name} onChange={(e) => { setName(e.target.value); setAdded(null); }} placeholder="Full name" minLength={2} maxLength={80} autoCapitalize="words" required />
          <input id="roster-add-phone" aria-label="Mobile number" type="tel" inputMode="tel" value={phone} onChange={(e) => { setPhone(e.target.value); setAdded(null); }} placeholder="+91 98765 43210" maxLength={20} pattern="[+0-9 ()-]{10,20}" required />
          {groups.length > 0 && <div className="group-add-pick">
            <label className="check-label"><input type="checkbox" checked={toGroup} onChange={(e) => setToGroup(e.target.checked)} /> Also add to the WhatsApp group</label>
            {toGroup && groups.length > 1 && <select value={pickedGroup} onChange={(e) => setGroupJid(e.target.value)} aria-label="WhatsApp group">{groups.map((g) => <option key={g.jid} value={g.jid}>{g.name}</option>)}</select>}
            {toGroup && groups.length === 1 && <small className="panel-copy">{groups[0].name}</small>}
          </div>}
          <button type="submit" disabled={busy || adding}>{adding ? "Adding…" : "Add"}</button>
          {added && (added.ok
            ? <p className="success-note" role="status">{added.text}</p>
            : <p className="error" role="alert">{added.text}{added.existing && <> <button type="button" className="text-button" onClick={() => showExisting(added.existing)}>Show {added.existing.name}</button></>}</p>)}
          {groupAdd && <GroupAddStatus g={groupAdd} />}
        </form>
        {(data.total > 8 || q) && <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${data.total} names`} aria-label="Search the member list" />}
        <div className="roster-list">
          {data.people.map((p) => <NameRow key={p.id} label={p.name} sub={[p.phone && phoneText(p.phone), p.self_added && "Added themselves from an RSVP link"].filter(Boolean).join(" · ")} initial={p.name} action="Edit" busy={busy} onSave={(v) => rename(p, v)} onRemove={() => remove(p)} />)}
          {data.people.length === 0 && <p className="panel-copy">{q ? "No names match." : "No names yet."}</p>}
          {data.total > data.people.length && !q && <p className="panel-copy">Showing the first {data.people.length}. Search to find others.</p>}
        </div>
      </> : <div className="roster-list">
        <p className="panel-copy">These group members haven't got a name yet. Type the name the club knows them by.</p>
        {unnamed.people.map((p) => <NameRow key={p.id} label={phoneText(p.phone)} sub={p.hint ? `WhatsApp name: ${p.hint}` : "No name from WhatsApp"} initial={p.hint || ""} action="Add name" busy={busy} onSave={(v) => nameMember(p, v)} />)}
      </div>}
    </section>
  );
}

/** Dashboard card: the member list lives on its own page, it isn't needed day to day. */
export function MembersCard({ clubId, onOpen }) {
  const [info, setInfo] = useState(null);
  useEffect(() => { setInfo(null); api(`/api/clubs/${clubId}/roster?q=`).then((d) => setInfo({ total: d.total, unnamed: d.unnamed.count })).catch(() => setInfo({})); }, [clubId]);
  return (
    <section className="admin-panel members-card">
      <div><h3>Member list {info?.total != null && <span className="count">{info.total}</span>}</h3>
        <p className="panel-copy">The names members pick from when they tap "I'm in".{info?.unnamed ? ` ${info.unnamed} group members still need a name.` : ""}</p></div>
      <button type="button" className="secondary-button" onClick={onOpen}>Open member list</button>
    </section>
  );
}

/** What happened with the WhatsApp group add, in plain words. */
function GroupAddStatus({ g }) {
  if (g.status === "pending") return <p className="panel-copy" role="status">Adding to {g.group} on WhatsApp… {g.ahead ? `${g.ahead} ahead in the queue. ` : ""}The club number waits between adds to keep it safe, so this can take a minute or two.</p>;
  if (g.status === "added") return <p className="success-note" role="status">✓ Added to {g.group} on WhatsApp.</p>;
  if (g.status === "already") return <p className="success-note" role="status">Already in {g.group} on WhatsApp.</p>;
  if (g.status === "invited") return <p className="success-note" role="status">Invite link to {g.group} sent on WhatsApp. {g.detail}</p>;
  return <p className="error" role="alert">Not added to {g.group}: {g.detail}</p>;
}
