// The link in the Lead's WhatsApp: "Rahul wants to join. Add them?"
import { useEffect, useState } from "react";
import { api } from "./Rides.jsx";

export function JoinRequestPage({ code }) {
  const [req, setReq] = useState(null);
  const [state, setState] = useState("loading"); // loading | ready | signin | error
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState("");

  useEffect(() => {
    api(`/api/join-requests/${code}`).then((d) => { setReq(d.request); setState("ready"); })
      .catch((err) => { if (err.status === 401) setState("signin"); else { setError(err.message); setState("error"); } });
  }, [code]);

  async function act(body) {
    setBusy(true); setError("");
    try {
      const d = await api(`/api/join-requests/${code}`, { method: "POST", body: JSON.stringify(body) });
      setReq(d.request);
      setDone(body.action === "dismiss" ? "dismissed" : d.request.added_to_group ? "group" : "added");
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
  else if (req.status === "added" || done) body = <>
    <h2>{req.name} is in 🎉</h2>
    <p className="panel-copy">{done === "group" ? `They'll be added to ${req.group.name} shortly. ` : ""}{first} can tap "I'm in" again and it works.</p>
    <a className="button-link secondary-button" href="/">Go to my club</a>
  </>;
  else body = <>
    <h2>Add {req.name}?</h2>
    <p className="panel-copy join-req-phone">{req.phone}{req.activity ? ` · wants to join ${req.activity.title}` : ""}</p>
    {error && <p className="error" role="alert">{error}</p>}
    <div className="join-req-actions">
      <button type="button" className="primary-button" disabled={busy} onClick={() => act({ action: "add" })}>Add to club</button>
      {req.group && <button type="button" className="secondary-button" disabled={busy} onClick={() => act({ action: "add", to_group: true })}>Add + put in WhatsApp group</button>}
      <button type="button" className="text-button" disabled={busy} onClick={() => act({ action: "dismiss" })}>Not now</button>
    </div>
  </>;

  return (
    <main className="page-shell ride-shell">
      <nav className="topbar"><a className="wordmark" href="/" aria-label="PaceUp home"><span className="mark">P</span> paceup</a><span className="topbar-note">{req?.club.name.toUpperCase() || ""}</span></nav>
      <section className="workspace ride-card join-req">{body}</section>
      <footer><span>PACEUP <em className="endorse">by Feet and Pedals</em></span><span>Built for every kind of active community.</span></footer>
    </main>
  );
}
