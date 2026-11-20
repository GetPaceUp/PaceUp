import { useEffect, useRef, useState } from "react";
import { api } from "./Rides.jsx";

const when = (iso) => `${new Date(iso).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${new Date(iso).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true })}`;

/** "1 no-show" in grey, "2 no-shows" and up in red. Admins only; counts the last 90 days. */
export function NoShowBadge({ count }) {
  if (!count) return null;
  return <span className={count >= 2 ? "ns-badge flag" : "ns-badge"}>{count} no-show{count === 1 ? "" : "s"}</span>;
}

/**
 * After an activity: everyone on the going list is present. Tap a name to mark a no-show,
 * tap again to undo. Each tap saves at once. Locks 48 hours after the start.
 */
export function NoShowMarker({ ride, onChange }) {
  const [saving, setSaving] = useState(0);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState("");
  const box = useRef();
  useEffect(() => {
    if (new URLSearchParams(window.location.search).has("absent")) box.current?.scrollIntoView({ block: "start" });
  }, []);
  // Optimistic: the tap shows at once; the server's answer replaces it.
  const [pending, setPending] = useState({});
  async function toggle(p) {
    const next = !(pending[p.id] ?? p.no_show);
    setPending((m) => ({ ...m, [p.id]: next })); setError(""); setSaved(false); setSaving((n) => n + 1);
    try {
      const data = await api(`/api/clubs/${ride.club.id}/rides/${ride.id}/participants/${p.id}/no-show`, { method: "PUT", body: JSON.stringify({ no_show: next }) });
      onChange(data.ride); setSaved(true);
    } catch (err) { setError(err.message); }
    finally { setPending((m) => { const { [p.id]: _, ...rest } = m; return rest; }); setSaving((n) => n - 1); }
  }
  const people = ride.participants.map((p) => ({ ...p, out: pending[p.id] ?? p.no_show }));
  const out = people.filter((p) => p.out).length;
  if (!people.length) return <p className="panel-copy">No one was on the list.</p>;
  return (
    <div className="noshow" ref={box}>
      <h3>Who didn't turn up?</h3>
      <p className="panel-copy">Tap a name to mark a no-show. Everyone else counts as present.</p>
      <ul className="att">
        {people.map((p) => (
          <li key={p.id}>
            <button type="button" className={p.out ? "out" : ""} aria-pressed={p.out} onClick={() => toggle(p)}>
              <span className="mk" aria-hidden="true">{p.out ? "✕" : "✓"}</span>
              <span className="nm">{p.name}</span>
              <span className="st">{p.out ? "No-show" : ""}</span>
            </button>
          </li>
        ))}
      </ul>
      {error && <p className="error" role="alert">{error}</p>}
      <div className="att-sum"><span><b>{people.length - out}</b> came · <b>{out}</b> no-show</span><span className="saved" role="status">{saving ? "Saving…" : saved ? "Saved ✓" : ""}</span></div>
      <p className="panel-copy">Tap again to undo. Locks {when(ride.absent.locks_at)}.</p>
    </div>
  );
}
