// The link in the Lead's WhatsApp: "Rahul wants to join. Add them?"
// If they're already a member under another number, the Lead links this number to them instead.
import { useEffect, useState } from "react";
import { api } from "./Rides.jsx";

export function JoinRequestPage({ code }) {
  const [req, setReq] = useState(null);
  const [state, setState] = useState("loading"); // loading | ready | signin | error
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");
  const [picking, setPicking] = useState(false);
  const [q, setQ] = useState("");
  const [people, setPeople] = useState([]);

  useEffect(() => {
    if (!picking || !q.trim()) { setPeople([]); return undefined; }
    const t = setTimeout(() => api(`/api/join-requests/${code}/people?q=${encodeURIComponent(q.trim())}`).then((d) => setPeople(d.people)).catch(() => setPeople([])), 200);
    return () => clearTimeout(t);
  }, [code, picking, q]);

  useEffect(() => {
    api(`/api/join-requests/${code}`).then((d) => { setReq(d.request); setState("ready"); })
      .catch((err) => { if (err.status === 401) setState("signin"); else { setError(err.message); setState("error"); } });
  }, [code]);

  async function act(body) {
    setBusy(true); setError("");
    try {
      const d = await api(`/api/join-requests/${code}`, { method: "POST", body: JSON.stringify(body) });
      setReq(d.request);
      setDone(body.action === "dismiss" ? "dismissed" : body.action === "link" ? "linked" : d.request.added_to_group ? "group" : "added");
      setPicking(false);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const first = req?.name.split(" ")[0];
  let body;
  if (state === "loading") body = <p className="empty-state">Loading…</p>;
  else if (state === "signin") body = <>
    <h2>Add a new member</h2>
    <p className="panel-copy">Sign in as a club admin to add them.</p>
    <a className="button-link primary-button" href={`/?next=${encodeURIComponent(`/m/${code}`)}`}>Sign in</a>
  </>;
  else if (state === "error") body = <><h2>Hmm</h2><p className="panel-copy">{error}</p><a className="button-link secondary-button" href="/">Go to my club</a></>;
  else if (done === "dismissed") body = <><h2>OK, not now</h2><a className="button-link secondary-button" href="/">Go to my club</a></>;
  else if (done === "linked") body = <>
    <div className="join-note join-ok"><strong>Done 🙌</strong><span>{req.linked_to} can now join from either number.</span></div>
    <a className="button-link secondary-button" href="/">Go to my club</a>
  </>;
  else if (picking) body = <>
    <h2>Who is this?</h2>
    <p className="panel-copy join-req-phone">"{req.name}" · {req.phone}</p>
    {error && <p className="error" role="alert">{error}</p>}
    <label htmlFor="jr-search">Search the member list</label>
    <input id="jr-search" autoFocus value={q} onChange={(e) => setQ(e.target.value)} autoComplete="off" />
    {people.length > 0 && <ul className="name-list join-req-pick">{people.map((p) => <li key={p.id}><button type="button" disabled={busy} onClick={() => act({ action: "link", roster_id: p.id })}><span>{p.name}</span>{p.tail && <small> ·· {p.tail}</small>}</button></li>)}</ul>}
    {q.trim() && !people.length && <p className="panel-copy">No one by that name.</p>}
    <button type="button" className="text-button" onClick={() => { setPicking(false); setError(""); }}>Back</button>
  </>;
  else if (req.status === "added" || done) body = <>
    <h2>{req.listed_as || req.name} is in 🎉</h2>
    <p className="panel-copy">{done === "group" ? `They'll be added to ${req.group.name} shortly. ` : ""}{first} can tap "I'm in" again and it works.</p>
    <a className="button-link secondary-button" href="/">Go to my club</a>
  </>;
  else {
    const same = req.same_person;
    body = <>
      <h2>Add {req.name}?</h2>
      <p className="panel-copy join-req-phone">{req.phone}{req.activity ? ` · wants to join ${req.activity.title}` : ""}</p>
      {error && <p className="error" role="alert">{error}</p>}
      {same && <div className="join-same">
        <strong>Same person as {same.name}?</strong>
        <span>Already a member with {same.phone}</span>
        <button type="button" className="primary-button" disabled={busy} onClick={() => act({ action: "link", roster_id: same.id })}>Yes, it's them. Add this number</button>
      </div>}
      <div className="join-req-actions">
        <button type="button" className={same ? "secondary-button" : "primary-button"} disabled={busy} onClick={() => act({ action: "add" })}>{same ? "No, add as a new member" : "Add to club"}</button>
        {req.group && <button type="button" className="secondary-button" disabled={busy} onClick={() => act({ action: "add", to_group: true })}>{same ? "New member + put in WhatsApp group" : "Add + put in WhatsApp group"}</button>}
        <button type="button" className="text-button" disabled={busy} onClick={() => { setPicking(true); setError(""); }}>{same ? "It's someone else on the list" : "Already a member with another number?"}</button>
        <button type="button" className="text-button muted-link" disabled={busy} onClick={() => act({ action: "dismiss" })}>Not now</button>
      </div>
    </>;
  }

  return (
    <main className="page-shell ride-shell">
      <nav className="topbar"><a className="wordmark" href="/" aria-label="PaceUp home"><span className="mark">P</span> paceup</a><span className="topbar-note">{req?.club.name.toUpperCase() || ""}</span></nav>
      <section className="workspace ride-card join-req">{body}</section>
      <footer><span>PACEUP <em className="endorse">by Feet and Pedals</em></span><span>Built for every kind of active community.</span></footer>
    </main>
  );
}
