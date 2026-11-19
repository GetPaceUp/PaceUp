import { useEffect, useState } from "react";

const api = async (url, options = {}) => {
  const response = await fetch(url, {
    credentials: "include", ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || "Something went wrong."); error.status = response.status; throw error; }
  return data;
};

const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const dayNum = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "2-digit" });
const monthShort = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short" }).toUpperCase();
const timeOnly = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const rideUrl = (code) => `${window.location.origin}/r/${code}`;

export function shareText(ride) {
  const details = [ride.distance_km ? `${ride.distance_km} km` : null, ride.pace, ride.capacity ? `${ride.capacity} spots` : null].filter(Boolean).join(" · ");
  const lines = [`🚴 *${ride.title}*`, when(ride.starts_at), `📍 ${ride.meeting_point}`];
  if (details) lines.push(details);
  lines.push("", "Tap to say you're in:", rideUrl(ride.code));
  return lines.join("\n");
}
const whatsappLink = (ride) => `https://wa.me/?text=${encodeURIComponent(shareText(ride))}`;

function ShareButtons({ ride }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="share-row">
      <a className="button-link wa-button" href={whatsappLink(ride)} target="_blank" rel="noreferrer">Share to WhatsApp</a>
      <button type="button" className="secondary-button" onClick={() => navigator.clipboard?.writeText(rideUrl(ride.code)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 2000); })}>{copied ? "Link copied" : "Copy link"}</button>
    </div>
  );
}

const emptyRide = { title: "", date: "", time: "", meeting_point: "", map_url: "", distance_km: "", pace: "", capacity: "", notes: "" };

function RideForm({ clubId, onCreated }) {
  const [form, setForm] = useState(emptyRide);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const set = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function submit(status) {
    setError("");
    if (!form.title || !form.date || !form.time || !form.meeting_point) { setError("Add a title, date, start time and meeting point."); return; }
    const startsAt = new Date(`${form.date}T${form.time}`);
    if (Number.isNaN(startsAt.getTime())) { setError("Check the date and start time."); return; }
    setSaving(true);
    try {
      const body = {
        title: form.title, starts_at: startsAt.toISOString(), meeting_point: form.meeting_point,
        map_url: form.map_url || null, pace: form.pace || null, notes: form.notes || null,
        distance_km: form.distance_km ? Number(form.distance_km) : null,
        capacity: form.capacity ? Number(form.capacity) : null, status
      };
      const data = await api(`/api/clubs/${clubId}/rides`, { method: "POST", body: JSON.stringify(body) });
      setForm(emptyRide); onCreated(data.ride);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  return (
    <form className="stack-form ride-form" onSubmit={(e) => { e.preventDefault(); submit("published"); }}>
      <label htmlFor="ride-title">Title</label><input id="ride-title" value={form.title} onChange={set("title")} placeholder="Saturday long ride" maxLength={120} required />
      <div className="two-col">
        <div><label htmlFor="ride-date">Date</label><input id="ride-date" type="date" value={form.date} onChange={set("date")} required /></div>
        <div><label htmlFor="ride-time">Start</label><input id="ride-time" type="time" value={form.time} onChange={set("time")} required /></div>
      </div>
      <label htmlFor="ride-meet">Meeting point</label><input id="ride-meet" value={form.meeting_point} onChange={set("meeting_point")} placeholder="Where riders gather" maxLength={200} required />
      <label htmlFor="ride-map">Map link (optional)</label><input id="ride-map" type="url" value={form.map_url} onChange={set("map_url")} placeholder="https://maps.app.goo.gl/…" maxLength={500} pattern="https://.*" />
      <div className="two-col">
        <div><label htmlFor="ride-km">Distance (km)</label><input id="ride-km" type="number" min="0" max="1000" step="0.1" inputMode="decimal" value={form.distance_km} onChange={set("distance_km")} /></div>
        <div><label htmlFor="ride-pace">Pace</label><input id="ride-pace" value={form.pace} onChange={set("pace")} placeholder="24–26 km/h" maxLength={60} /></div>
      </div>
      <label htmlFor="ride-cap">Spots (optional)</label><input id="ride-cap" type="number" min="1" max="10000" inputMode="numeric" value={form.capacity} onChange={set("capacity")} placeholder="No limit" />
      <label htmlFor="ride-notes">Notes</label><textarea id="ride-notes" value={form.notes} onChange={set("notes")} rows={3} maxLength={2000} placeholder="Lights mandatory, regroup points, café stop…" />
      {error && <p className="error" role="alert">{error}</p>}
      <button type="submit" disabled={saving}>{saving ? "Publishing…" : "Publish ride"}</button>
      <button type="button" className="text-button" disabled={saving} onClick={() => submit("draft")}>Save as draft</button>
    </form>
  );
}

export function ClubRides({ club }) {
  const [rides, setRides] = useState([]);
  const [showForm, setShowForm] = useState(false);
  const [justPublished, setJustPublished] = useState(null);
  const [error, setError] = useState("");
  const admin = ["owner", "admin"].includes(club.role);

  async function load() {
    try { setRides((await api(`/api/clubs/${club.id}/rides`)).rides); } catch (err) { setError(err.message); }
  }
  useEffect(() => { setJustPublished(null); setShowForm(false); load(); }, [club.id]);

  async function publish(ride) {
    try {
      const data = await api(`/api/clubs/${club.id}/rides/${ride.id}`, { method: "PATCH", body: JSON.stringify({ status: "published" }) });
      setJustPublished(data.ride); load();
    } catch (err) { setError(err.message); }
  }

  return (
    <section className="workspace rides-section">
      <div className="section-heading">
        <div><p className="eyebrow">{club.name.toUpperCase()}</p><h2>Upcoming rides</h2></div>
        {admin && !showForm && <button type="button" onClick={() => { setShowForm(true); setJustPublished(null); }}>Post a ride</button>}
      </div>
      {showForm && <RideForm clubId={club.id} onCreated={(ride) => { setShowForm(false); if (ride.status === "published") setJustPublished(ride); load(); }} />}
      {justPublished && (
        <div className="published-note">
          <p className="success-note">Ride published. Share it with the club's WhatsApp group:</p>
          <pre className="share-preview">{shareText(justPublished)}</pre>
          <ShareButtons ride={justPublished} />
        </div>
      )}
      {error && <p className="error" role="alert">{error}</p>}
      {rides.length === 0 && !showForm && <p className="empty-state">{admin ? "No rides yet. Post one and share it with your club." : "No upcoming rides yet."}</p>}
      <div className="ride-list">
        {rides.map((ride) => (
          <div className="ride-item" key={ride.id}>
            <a className="ride-link" href={`/r/${ride.code}`}>
              <div className="ride-date"><b>{dayNum(ride.starts_at)}</b><span>{monthShort(ride.starts_at)}</span></div>
              <div className="ride-main"><strong>{ride.title}</strong><small>{timeOnly(ride.starts_at)}{ride.distance_km ? ` · ${ride.distance_km} km` : ""} · {ride.meeting_point}</small></div>
            </a>
            {ride.status === "draft" ? <button type="button" className="secondary-button small-button" onClick={() => publish(ride)}>Publish</button>
              : ride.status === "cancelled" ? <span className="pill">Cancelled</span>
              : ride.my_rsvp === "going" ? <span className="pill pill-go">You're in</span>
              : ride.capacity && ride.going_count >= ride.capacity ? <span className="pill">Full</span>
              : <span className="pill">{ride.going_count} going</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

export function RidePage({ code }) {
  const [ride, setRide] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);

  async function load() {
    try { setRide((await api(`/api/r/${code}`)).ride); setState("ready"); }
    catch (err) { setState(err.status === 404 ? "missing" : "error"); setError(err.message); }
  }
  useEffect(() => { load(); }, [code]);

  async function rsvp(status) {
    setBusy(true); setError("");
    try { setRide((await api(`/api/r/${code}/rsvp`, { method: "PUT", body: JSON.stringify({ status }) })).ride); }
    catch (err) { setError(err.message); if (err.status === 409) load(); }
    finally { setBusy(false); }
  }

  async function cancelRide() {
    setBusy(true); setError("");
    try { await api(`/api/clubs/${ride.club.id}/rides/${ride.id}`, { method: "PATCH", body: JSON.stringify({ status: "cancelled" }) }); await load(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const shell = (children) => (
    <main className="page-shell ride-shell">
      <nav className="topbar"><a className="wordmark" href="/" aria-label="PaceUp home"><span className="mark">P</span> paceup</a><span className="topbar-note">{ride?.club.name.toUpperCase() || "RIDE"}</span></nav>
      {children}
      <footer><span>PACEUP</span><span>Built for every kind of active community.</span></footer>
    </main>
  );
  if (state === "loading") return shell(<p className="empty-state">Loading ride…</p>);
  if (state !== "ready") return shell(<section className="workspace ride-card"><h2>Ride not found</h2><p className="panel-copy">{state === "missing" ? "This link may be wrong, or the ride hasn't been published yet." : error}</p><a className="button-link secondary-button" href="/">Go to PaceUp</a></section>);

  const started = new Date(ride.starts_at).getTime() <= Date.now();
  const pct = ride.capacity ? Math.min(100, Math.round((ride.going_count / ride.capacity) * 100)) : null;
  const next = encodeURIComponent(`/r/${code}`);

  return shell(
    <section className="workspace ride-card">
      {ride.status === "cancelled" && <p className="error">This ride has been cancelled.</p>}
      {ride.status === "draft" && <p className="panel-copy draft-note">Draft. Only club admins can see this until it's published.</p>}
      <h2 className="ride-title">{ride.title}</h2>
      <dl className="ride-meta">
        <div><dt>When</dt><dd>{when(ride.starts_at)}</dd></div>
        <div><dt>Meet</dt><dd>{ride.meeting_point}{ride.map_url && <><br /><a href={ride.map_url} target="_blank" rel="noreferrer">Open in Maps</a></>}</dd></div>
        {(ride.distance_km || ride.pace) && <div><dt>Ride</dt><dd>{[ride.distance_km && `${ride.distance_km} km`, ride.pace].filter(Boolean).join(" · ")}</dd></div>}
        {ride.organiser && <div><dt>Organiser</dt><dd>{ride.organiser.name}</dd></div>}
        {ride.notes && <div><dt>Notes</dt><dd className="ride-notes">{ride.notes}</dd></div>}
      </dl>

      <div className="going-head"><span>Going</span><strong>{ride.going_count}{ride.capacity ? ` / ${ride.capacity}` : ""}</strong></div>
      {pct !== null && <div className="meter"><i style={{ width: `${pct}%` }} /></div>}
      {ride.riders && <div className="rider-chips">{ride.riders.map((r) => <span key={r.id} className={r.is_you ? "chip chip-you" : "chip"}>{r.is_you ? "You" : r.name}</span>)}</div>}

      {error && <p className="error" role="alert">{error}</p>}
      {ride.my_rsvp === "going" && <p className="success-note you-in">You're in ✓</p>}

      <div className="ride-actions">
        {!ride.viewer.signed_in && <>
          <p className="panel-copy">{ride.club.name} members can RSVP here. Sign in once on this phone and you'll stay signed in.</p>
          <a className="button-link big-button" href={`/?next=${next}`}>Sign in to RSVP</a>
          <p className="panel-copy">Not a member yet? Ask a club admin for an invite link.</p>
        </>}
        {ride.viewer.signed_in && !ride.viewer.member && <p className="panel-copy">Only {ride.club.name} members can RSVP. Ask a club admin for an invite link.</p>}
        {ride.viewer.member && ride.status === "published" && !started && (ride.my_rsvp === "going"
          ? <button type="button" className="secondary-button big-button" disabled={busy} onClick={() => rsvp("cancelled")}>Can't make it anymore</button>
          : ride.is_full ? <button type="button" className="big-button" disabled>Ride is full</button>
          : <button type="button" className="big-button" disabled={busy} onClick={() => rsvp("going")}>{busy ? "Saving…" : "I'm in"}</button>)}
        {ride.viewer.member && ride.status === "published" && started && <p className="panel-copy">This ride has started. RSVPs are closed.</p>}
      </div>

      {ride.viewer.admin && ride.status === "published" && !started && <div className="admin-tools"><h3>Organiser tools</h3><ShareButtons ride={ride} />{confirmCancel
        ? <div className="confirm-row"><span>Cancel this ride for everyone?</span><button type="button" disabled={busy} onClick={cancelRide}>Yes, cancel ride</button><button type="button" className="secondary-button" onClick={() => setConfirmCancel(false)}>Keep it</button></div>
        : <button type="button" className="text-button" onClick={() => setConfirmCancel(true)}>Cancel this ride</button>}</div>}
    </section>
  );
}
