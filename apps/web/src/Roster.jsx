import { useEffect, useRef, useState } from "react";
import { api } from "./Rides.jsx";

const toBase64 = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = () => resolve(String(reader.result).split(",")[1] || "");
  reader.onerror = () => reject(new Error("Couldn't read that file."));
  reader.readAsDataURL(file);
});
const phoneText = (p) => (p ? `+${p.slice(0, p.length - 10)} ${p.slice(-10, -5)} ${p.slice(-5)}` : "");

/** Club admins: the list of names riders pick from when they tap "I'm in". */
export function RosterPanel({ clubId }) {
  const [data, setData] = useState({ total: 0, people: [] });
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [open, setOpen] = useState(false);
  const fileInput = useRef();
  const base = `/api/clubs/${clubId}/roster`;

  async function load(query = q) {
    try { setData(await api(`${base}?q=${encodeURIComponent(query)}`)); } catch (err) { setError(err.message); }
  }
  useEffect(() => { setQ(""); setNotice(""); setError(""); load(""); }, [clubId]);
  useEffect(() => { const t = setTimeout(() => load(q), 200); return () => clearTimeout(t); }, [q]);

  async function upload(file) {
    if (!file) return;
    setBusy(true); setError(""); setNotice("");
    try {
      if (file.size > 5 * 1024 * 1024) throw new Error("That file is over 5 MB. Keep just the names and phone numbers.");
      const r = await api(`${base}/import`, { method: "POST", body: JSON.stringify({ filename: file.name, data: await toBase64(file) }) });
      setNotice(`Read ${r.read} ${r.read === 1 ? "name" : "names"}: ${r.added} added, ${r.updated} updated, ${r.unchanged} already there. ${r.total} on the list now.`);
      setQ(""); load("");
    } catch (err) { setError(err.message); }
    finally { setBusy(false); if (fileInput.current) fileInput.current.value = ""; }
  }
  async function add(e) {
    e.preventDefault(); setBusy(true); setError(""); setNotice("");
    try { await api(base, { method: "POST", body: JSON.stringify({ name }) }); setNotice(`Added ${name.trim()}.`); setName(""); load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function remove(person) {
    setBusy(true); setError("");
    try { await api(`${base}/${person.id}`, { method: "DELETE" }); load(); } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  return (
    <section className="admin-panel roster-panel">
      <h3>Rider list <span className="count">{data.total}</span></h3>
      <p className="panel-copy">Riders tap "I'm in", type a few letters and pick their name from this list. No sign-in. Upload an Excel or CSV file with a "Name" column (and "Phone" if you have it). Uploading again adds new people and updates existing ones. Nobody is duplicated or removed.</p>
      <input ref={fileInput} type="file" accept=".xlsx,.csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,text/csv" hidden onChange={(e) => upload(e.target.files[0])} />
      <button type="button" disabled={busy} onClick={() => fileInput.current?.click()}>{busy ? "Working…" : "Upload Excel or CSV"}</button>
      {notice && <p className="success-note" role="status">{notice}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {(data.total > 0 || open) ? <>
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${data.total} names`} aria-label="Search the rider list" />
        <div className="roster-list">
          {data.people.map((p) => (
            <div className="member-row" key={p.id}>
              <div className="member-avatar">{p.name.slice(0, 1).toUpperCase()}</div>
              <div className="member-info"><strong>{p.name}</strong>{p.phone && <small>{phoneText(p.phone)}</small>}</div>
              <button type="button" className="text-button remove" disabled={busy} aria-label={`Remove ${p.name}`} onClick={() => remove(p)}>Remove</button>
            </div>
          ))}
          {data.people.length === 0 && <p className="panel-copy">No names match.</p>}
          {data.total > data.people.length && !q && <p className="panel-copy">Showing the first {data.people.length}. Search to find others.</p>}
        </div>
        <form className="inline-form" onSubmit={add}><div className="field-grow"><label htmlFor="roster-add">Add one person</label><input id="roster-add" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" minLength={2} maxLength={80} required /></div><button type="submit" disabled={busy}>Add</button></form>
      </> : <button type="button" className="text-button" onClick={() => setOpen(true)}>Or add names one by one</button>}
    </section>
  );
}
