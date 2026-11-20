import { useEffect, useState } from "react";
import { api } from "./Rides.jsx";

const monthLabel = (key) => new Date(`${key}-15T00:00:00Z`).toLocaleDateString("en-GB", { month: "long", timeZone: "UTC" });

/** Admins: who showed up most this month or last, and one tap to thank them in the club group. */
export function MostRegular({ club }) {
  const [data, setData] = useState(null);
  const [month, setMonth] = useState(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [error, setError] = useState("");
  useEffect(() => {
    setNote(""); setError("");
    api(`/api/clubs/${club.id}/regulars${month ? `?month=${month}` : ""}`).then((d) => { setData(d); if (!month) setMonth(d.current); }).catch((err) => setError(err.message));
  }, [club.id, month]);
  if (!data) return error ? <p className="error">{error}</p> : null;
  const r = data.regulars;
  async function post() {
    setBusy(true); setError(""); setNote("");
    try { await api(`/api/clubs/${club.id}/regulars/post`, { method: "POST", body: JSON.stringify({ month: r.month }) }); setNote("Posted. It shows in the group within a minute."); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  return (
    <div className="regulars">
      <div className="regulars-head">
        <h3>🏅 Most regular</h3>
        <span className="month-pick">
          {[data.current, data.previous].map((m, i) => <button key={m} type="button" className={r.month === m ? "on" : ""} aria-pressed={r.month === m} onClick={() => setMonth(m)}>{monthLabel(m)}</button>)}
        </span>
      </div>
      <p className="panel-copy">Showed up = joined minus no-shows. {r.activities} {r.activities === 1 ? "activity" : "activities"} in {r.month_name}.</p>
      {r.people.length
        ? <ol className="people">{r.people.map((p) => <li key={p.name}><span className="num">{p.rank}</span><span className="who">{p.name}</span><b>{p.count}</b></li>)}</ol>
        : <p className="panel-copy">No one yet this month.</p>}
      {r.people.length > 0 && <button type="button" disabled={busy} onClick={post}>{busy ? "Posting…" : "Post to group"}</button>}
      {note && <p className="success-note" role="status">{note}</p>}
      {error && <p className="error" role="alert">{error}</p>}
    </div>
  );
}
