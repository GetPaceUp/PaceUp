import { useEffect, useState } from "react";
import { api } from "./Rides.jsx";
import { phoneText } from "./Auth.jsx";
import { ResetLinkButton } from "./PasswordReset.jsx";

const shareLink = (w) => `https://wa.me/${w.phone}?text=${encodeURIComponent(w.text)}`;

function Delivery({ w, name }) {
  if (!w) return null;
  if (w.sent) return <p className="success-note" role="status">Invite sent to {name} on WhatsApp from the club number.</p>;
  return <p className="panel-copy">The club WhatsApp isn't connected, so nothing was sent. <a href={shareLink(w)} target="_blank" rel="noreferrer">Send it from your WhatsApp</a> or <button type="button" className="text-button" onClick={() => navigator.clipboard?.writeText(w.text)}>copy the message</button>.</p>;
}

/** Club admins: invite people by mobile number and manage who is in the club. */
export function PeoplePanel({ clubId, members, me, onChange }) {
  const [phone, setPhone] = useState("+91 ");
  const [name, setName] = useState("");
  const [role, setRole] = useState("member");
  const [suggest, setSuggest] = useState([]);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);

  // Pick from the club's member list: typing a name offers people whose number PaceUp knows.
  useEffect(() => {
    const q = name.trim();
    if (q.length < 2) { setSuggest([]); return; }
    const t = setTimeout(() => api(`/api/clubs/${clubId}/roster?q=${encodeURIComponent(q)}`).then((d) => setSuggest(d.people.filter((p) => p.phone).slice(0, 6))).catch(() => setSuggest([])), 200);
    return () => clearTimeout(t);
  }, [name, clubId]);

  async function invite(e) {
    e.preventDefault(); setBusy("invite"); setError(""); setResult(null);
    try {
      const d = await api(`/api/clubs/${clubId}/people`, { method: "POST", body: JSON.stringify({ phone, name, role }) });
      setResult({ w: d.whatsapp, name: d.person.name }); setPhone("+91 "); setName(""); setRole("member"); onChange();
    } catch (err) { setError(err.message); }
    finally { setBusy(""); }
  }
  async function resend(m) {
    setBusy(m.id); setError(""); setResult(null);
    try { const d = await api(`/api/clubs/${clubId}/members/${m.id}/welcome`, { method: "POST" }); setResult({ w: d.whatsapp, name: m.name }); }
    catch (err) { setError(err.message); } finally { setBusy(""); }
  }
  async function remove(m) {
    if (busy !== `confirm-${m.id}`) { setBusy(`confirm-${m.id}`); return; }
    setBusy(m.id); setError("");
    try { await api(`/api/clubs/${clubId}/members/${m.id}`, { method: "DELETE" }); onChange(); } catch (err) { setError(err.message); } finally { setBusy(""); }
  }

  return <>
    <section className="admin-panel">
      <h3>Invite someone</h3>
      <p className="panel-copy">They get a WhatsApp message from the club number and sign in with their mobile number. No email or password.</p>
      <form className="stack-form" onSubmit={invite}>
        <label htmlFor="inv-name">Name</label>
        <input id="inv-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Type to pick from the member list" maxLength={80} autoComplete="off" />
        {suggest.length > 0 && <ul className="name-list">{suggest.map((p) => <li key={p.id}><button type="button" onClick={() => { setName(p.name); setPhone(`+${p.phone}`); setSuggest([]); }}><span>{p.name}</span><small> {phoneText(p.phone)}</small></button></li>)}</ul>}
        <label htmlFor="inv-phone">Mobile number</label>
        <input id="inv-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" required />
        <label htmlFor="inv-role">Role</label>
        <select id="inv-role" value={role} onChange={(e) => setRole(e.target.value)}><option value="member">Member</option><option value="admin">Club admin</option></select>
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" disabled={busy === "invite"}>{busy === "invite" ? "Sending…" : "Send invite"}</button>
      </form>
      {result && <Delivery w={result.w} name={result.name} />}
    </section>
    <section className="admin-panel">
      <h3>Members <span className="count">{members.length}</span></h3>
      {members.map((m) => <div className="member-row" key={m.id}>
        <div className="member-avatar">{m.name.slice(0, 1).toUpperCase()}</div>
        <div className="member-info"><strong>{m.name}</strong><small>{m.phone ? phoneText(m.phone) : m.email}</small></div>
        <span className="role-tag">{m.role}</span>
        {m.role !== "owner" && m.id !== me && <>
          {m.phone && <button type="button" className="text-button" disabled={busy === m.id} onClick={() => resend(m)}>Resend</button>}
          {!m.phone && m.role === "member" && <ResetLinkButton endpoint={`/api/clubs/${clubId}/members/${m.id}/password-reset`} name={m.name} />}
          <button type="button" className="text-button remove" disabled={busy === m.id} onClick={() => remove(m)}>{busy === `confirm-${m.id}` ? "Tap to confirm" : "Remove"}</button>
        </>}
      </div>)}
    </section>
  </>;
}
