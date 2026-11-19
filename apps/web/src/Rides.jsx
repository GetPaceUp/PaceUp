import { useEffect, useRef, useState } from "react";

export const api = async (url, options = {}) => {
  const response = await fetch(url, {
    credentials: "include", ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || "Something went wrong. Please try again."); error.status = response.status; throw error; }
  return data;
};

export const CATEGORIES = {
  cycling: { emoji: "🚴", label: "Cycling", noun: "ride" },
  running: { emoji: "🏃", label: "Running", noun: "run" },
  hiking: { emoji: "🥾", label: "Hiking", noun: "hike" },
  triathlon: { emoji: "🏊", label: "Triathlon", noun: "session" },
  other: { emoji: "📍", label: "Other", noun: "activity" }
};
const cat = (a) => CATEGORIES[a.category] || CATEGORIES.cycling;
const when = (iso) => new Date(iso).toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const dayNum = (iso) => new Date(iso).toLocaleDateString(undefined, { day: "2-digit" });
const monthShort = (iso) => new Date(iso).toLocaleDateString(undefined, { month: "short" }).toUpperCase();
const timeOnly = (iso) => new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
const rideUrl = (code) => `${window.location.origin}/r/${code}`;
const pad = (n) => String(n).padStart(2, "0");
const localDate = (iso) => { const d = new Date(iso); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const localTime = (iso) => { const d = new Date(iso); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };

export function shareText(ride) {
  const details = [ride.distance_km ? `${ride.distance_km} km` : null, ride.pace, ride.capacity ? `${ride.capacity} spots` : null].filter(Boolean).join(" · ");
  const lines = [`${cat(ride).emoji} *${ride.title}*`, when(ride.starts_at), `📍 ${ride.meeting_point}`];
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

// ---------------------------------------------------------------- create / edit form

const emptyForm = { title: "", category: "cycling", date: "", time: "", meeting_point: "", map_url: "", distance_km: "", pace: "", capacity: "", notes: "" };
const formFrom = (r) => ({
  title: r.title, category: r.category || "cycling", date: localDate(r.starts_at), time: localTime(r.starts_at), meeting_point: r.meeting_point,
  map_url: r.map_url || "", distance_km: r.distance_km ?? "", pace: r.pace || "", capacity: r.capacity ?? "", notes: r.notes || ""
});

export function ActivityForm({ clubId, ride = null, onSaved, onCancel }) {
  const [form, setForm] = useState(ride ? formFrom(ride) : emptyForm);
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
        title: form.title, category: form.category, starts_at: startsAt.toISOString(), meeting_point: form.meeting_point,
        map_url: form.map_url || null, pace: form.pace || null, notes: form.notes || null,
        distance_km: form.distance_km !== "" ? Number(form.distance_km) : null,
        capacity: form.capacity !== "" ? Number(form.capacity) : null,
        ...(status ? { status } : {})
      };
      const data = ride
        ? await api(`/api/clubs/${clubId}/rides/${ride.id}`, { method: "PATCH", body: JSON.stringify(body) })
        : await api(`/api/clubs/${clubId}/rides`, { method: "POST", body: JSON.stringify(body) });
      if (!ride) setForm(emptyForm);
      onSaved(data.ride);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  return (
    <form className="stack-form ride-form" onSubmit={(e) => { e.preventDefault(); submit(ride ? null : "published"); }}>
      <label htmlFor="a-cat">Type</label>
      <div className="cat-row" id="a-cat" role="radiogroup">
        {Object.entries(CATEGORIES).map(([key, c]) => (
          <button key={key} type="button" role="radio" aria-checked={form.category === key} className={form.category === key ? "cat-chip on" : "cat-chip"} onClick={() => setForm((f) => ({ ...f, category: key }))}>{c.emoji} {c.label}</button>
        ))}
      </div>
      <label htmlFor="a-title">Title</label><input id="a-title" value={form.title} onChange={set("title")} placeholder="Sunday long ride" maxLength={120} required />
      <div className="two-col">
        <div><label htmlFor="a-date">Date</label><input id="a-date" type="date" value={form.date} onChange={set("date")} required /></div>
        <div><label htmlFor="a-time">Start</label><input id="a-time" type="time" value={form.time} onChange={set("time")} required /></div>
      </div>
      <label htmlFor="a-meet">Meeting point</label><input id="a-meet" value={form.meeting_point} onChange={set("meeting_point")} placeholder="Where everyone gathers" maxLength={200} required />
      <label htmlFor="a-map">Map link (optional)</label><input id="a-map" type="url" value={form.map_url} onChange={set("map_url")} placeholder="https://maps.app.goo.gl/…" maxLength={500} pattern="https://.*" />
      <div className="two-col">
        <div><label htmlFor="a-km">Distance (km)</label><input id="a-km" type="number" min="0" max="1000" step="0.1" inputMode="decimal" value={form.distance_km} onChange={set("distance_km")} /></div>
        <div><label htmlFor="a-pace">Pace</label><input id="a-pace" value={form.pace} onChange={set("pace")} placeholder="24–26 km/h" maxLength={60} /></div>
      </div>
      <label htmlFor="a-cap">Spots (optional)</label><input id="a-cap" type="number" min="1" max="10000" inputMode="numeric" value={form.capacity} onChange={set("capacity")} placeholder="No limit" />
      <label htmlFor="a-notes">Notes</label><textarea id="a-notes" value={form.notes} onChange={set("notes")} rows={3} maxLength={2000} placeholder="Lights mandatory, regroup points, café stop…" />
      {error && <p className="error" role="alert">{error}</p>}
      {ride
        ? <><button type="submit" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button><button type="button" className="text-button" onClick={onCancel}>Close without saving</button></>
        : <><button type="submit" disabled={saving}>{saving ? "Publishing…" : "Publish"}</button>
            <button type="button" className="text-button" disabled={saving} onClick={() => submit("draft")}>Save as draft</button>
            {onCancel && <button type="button" className="text-button" onClick={onCancel}>Close</button>}</>}
    </form>
  );
}

// ---------------------------------------------------------------- club dashboard

export function ClubRides({ club }) {
  const [whatsapp, setWhatsapp] = useState(null);
  const [rides, setRides] = useState([]);
  const [tab, setTab] = useState("upcoming");
  const [showForm, setShowForm] = useState(false);
  const [justPublished, setJustPublished] = useState(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const admin = ["owner", "admin"].includes(club.role);

  async function load(which = tab) {
    setLoading(true);
    try { setRides((await api(`/api/clubs/${club.id}/rides?when=${which}`)).rides); setError(""); } catch (err) { setError(err.message); }
    finally { setLoading(false); }
  }
  useEffect(() => {
    setJustPublished(null); setShowForm(false); setTab("upcoming"); load("upcoming"); setWhatsapp(null);
    if (admin) api(`/api/clubs/${club.id}/whatsapp`).then((d) => setWhatsapp(d.whatsapp)).catch(() => {});
  }, [club.id]);

  async function publish(ride) {
    try {
      const data = await api(`/api/clubs/${club.id}/rides/${ride.id}`, { method: "PATCH", body: JSON.stringify({ status: "published" }) });
      setJustPublished(data.ride); load();
    } catch (err) { setError(err.message); }
  }
  const going = rides.filter((r) => r.status === "published").reduce((n, r) => n + r.going_count, 0);

  return (
    <section className="workspace rides-section">
      <div className="section-heading">
        <div><p className="eyebrow">{club.name.toUpperCase()}</p><h2>Activities</h2></div>
        {admin && !showForm && <button type="button" onClick={() => { setShowForm(true); setJustPublished(null); }}>Create activity</button>}
      </div>
      {admin && whatsapp && <p className={`wa-mini ${whatsapp.status === "connected" ? "st-on" : "st-off"}`}><i />WhatsApp {whatsapp.status === "connected" ? `connected${whatsapp.group ? ` · posting to ${whatsapp.group.name}` : " · pick a group below"}` : "not connected · RSVPs still work"}</p>}
      {showForm && <ActivityForm clubId={club.id} onCancel={() => setShowForm(false)} onSaved={(ride) => { setShowForm(false); if (ride.status === "published") setJustPublished(ride); setTab("upcoming"); load("upcoming"); }} />}
      {justPublished && (
        <div className="published-note">
          <p className="success-note">Published. Share it with the club's WhatsApp group:</p>
          <pre className="share-preview">{shareText(justPublished)}</pre>
          <ShareButtons ride={justPublished} />
        </div>
      )}
      <div className="tabs" role="tablist">
        {["upcoming", "past"].map((t) => <button key={t} type="button" role="tab" aria-selected={tab === t} className={tab === t ? "tab on" : "tab"} onClick={() => { setTab(t); load(t); }}>{t === "upcoming" ? "Upcoming" : "Past"}</button>)}
        {tab === "upcoming" && rides.length > 0 && <span className="tab-note">{going} {going === 1 ? "person" : "people"} going</span>}
      </div>
      {error && <p className="error" role="alert">{error}</p>}
      {!loading && rides.length === 0 && !showForm && <p className="empty-state">{tab === "past" ? "No past activities yet." : admin ? "Nothing planned yet. Create an activity and share the link with your club." : "Nothing planned yet."}</p>}
      <div className="ride-list">
        {rides.map((ride) => (
          <div className="ride-item" key={ride.id}>
            <a className="ride-link" href={`/r/${ride.code}`}>
              <div className="ride-date"><b>{dayNum(ride.starts_at)}</b><span>{monthShort(ride.starts_at)}</span></div>
              <div className="ride-main"><strong>{cat(ride).emoji} {ride.title}</strong><small>{timeOnly(ride.starts_at)}{ride.distance_km ? ` · ${ride.distance_km} km` : ""} · {ride.meeting_point}</small></div>
            </a>
            {ride.status === "draft" ? (admin && tab === "upcoming" ? <button type="button" className="secondary-button small-button" onClick={() => publish(ride)}>Publish</button> : <span className="pill">Draft</span>)
              : ride.status === "cancelled" ? <span className="pill">Cancelled</span>
              : tab === "past" ? <span className="pill">{ride.going_count} went</span>
              : ride.capacity && ride.going_count >= ride.capacity ? <span className="pill">Full</span>
              : <span className={ride.my_rsvp ? "pill pill-go" : "pill"}>{ride.going_count} going</span>}
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------------------------------------------------------------- public activity page

/** The name box: type a few letters, pick yourself from the club's list, or join as a guest. */
function NamePicker({ code, initial = "", busy, onPick, onClose }) {
  const [text, setText] = useState(initial);
  const [names, setNames] = useState([]);
  const [searching, setSearching] = useState(false);
  const input = useRef();
  const seq = useRef(0);
  useEffect(() => { input.current?.focus(); }, []);
  useEffect(() => {
    const q = text.trim();
    if (q.length < 2) { setNames([]); return; }
    const mine = ++seq.current;
    setSearching(true);
    const t = setTimeout(async () => {
      try { const data = await api(`/api/r/${code}/names?q=${encodeURIComponent(q)}`); if (mine === seq.current) setNames(data.names); }
      catch { if (mine === seq.current) setNames([]); }
      finally { if (mine === seq.current) setSearching(false); }
    }, 180);
    return () => clearTimeout(t);
  }, [text, code]);
  const typed = text.trim().replace(/\s+/g, " ");
  const exact = names.some((n) => n.name.toLowerCase() === typed.toLowerCase());

  return (
    <div className="name-picker">
      <label htmlFor="rsvp-name" className="field-label">Your name</label>
      <input id="rsvp-name" ref={input} value={text} onChange={(e) => setText(e.target.value)} placeholder="Start typing, e.g. Amit" autoComplete="off" autoCapitalize="words" maxLength={60} />
      {typed.length >= 2 && <ul className="name-list" role="listbox" aria-label="Matching names">
        {names.map((n) => (
          <li key={n.id}><button type="button" role="option" disabled={busy} onClick={() => onPick(n.kind === "member" ? { member_id: n.id } : { roster_id: n.id }, n.name)}>
            <span className="avatar">{n.name.slice(0, 1).toUpperCase()}</span><span>{n.name}</span>
          </button></li>
        ))}
        {!searching && names.length === 0 && <li className="name-empty">Not on the club list yet.</li>}
        {!exact && typed.length >= 2 && <li><button type="button" className="guest-option" disabled={busy} onClick={() => onPick({ name: typed }, typed)}>Join as <b>{typed}</b> (guest)</button></li>}
      </ul>}
      {typed.length < 2 && <p className="panel-copy">Type at least 2 letters, then tap your name.</p>}
      <button type="button" className="text-button" onClick={onClose}>Back</button>
    </div>
  );
}

function Participants({ ride, busy, onRemove }) {
  const [confirm, setConfirm] = useState(null);
  if (!ride.participants.length) return <p className="panel-copy">No one yet. Be the first!</p>;
  return (
    <ol className="people">
      {ride.participants.map((p, i) => (
        <li key={p.id || `${i}-${p.name}`} className={p.is_you ? "you" : ""}>
          <span className="num">{i + 1}</span>
          <span className="who">{p.name}{p.is_you && <em> (you)</em>}{ride.viewer.admin && p.kind === "guest" && <small className="tag">guest</small>}</span>
          {ride.viewer.admin && onRemove && !ride.started && (confirm === p.id
            ? <span className="confirm-inline"><button type="button" className="small-button" disabled={busy} onClick={() => { setConfirm(null); onRemove(p); }}>Remove</button><button type="button" className="text-button" onClick={() => setConfirm(null)}>Keep</button></span>
            : <button type="button" className="text-button remove" aria-label={`Remove ${p.name}`} onClick={() => setConfirm(p.id)}>✕</button>)}
        </li>
      ))}
    </ol>
  );
}

const HISTORY = {
  created_published: "Created and published", created_draft: "Saved as draft", published: "Published", unpublished: "Unpublished",
  cancelled: "Cancelled", edited: "Edited", participant_removed: "Removed a participant"
};
function History({ items }) {
  if (!items?.length) return null;
  return (
    <details className="history"><summary>Change history</summary>
      <ul>{items.map((h, i) => <li key={i}><b>{HISTORY[h.action] || h.action}</b>{h.metadata?.name ? `: ${h.metadata.name}` : ""}{h.metadata?.fields ? ` (${h.metadata.fields.join(", ").replace(/_/g, " ")})` : ""}<small>{h.actor_type === "whatsapp" ? `${h.actor_name || "Admin"} via WhatsApp` : h.actor_name || ""} · {when(h.created_at)}</small></li>)}</ul>
    </details>
  );
}

export function RidePage({ code }) {
  const [ride, setRide] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const [flash, setFlash] = useState("");

  async function load() {
    try { setRide((await api(`/api/r/${code}`)).ride); setState("ready"); }
    catch (err) { setState(err.status === 404 ? "missing" : "error"); setError(err.message); }
  }
  useEffect(() => { load(); }, [code]);
  // Keep the list fresh while the page is open.
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === "visible" && !picking && !editing) load(); }, 20000);
    return () => clearInterval(t);
  }, [code, picking, editing]);

  async function rsvp(body, label) {
    setBusy(true); setError(""); setFlash("");
    try {
      const data = await api(`/api/r/${code}/rsvp`, { method: "PUT", body: JSON.stringify(body) });
      setRide(data.ride); setPicking(false);
      setFlash(body.status === "cancelled" ? "Done. You've been taken off the list." : `You're in, ${label.split(" ")[0]}! ✓`);
    } catch (err) { setError(err.message); if (err.status === 409) load(); }
    finally { setBusy(false); }
  }
  async function adminPatch(body, done) {
    setBusy(true); setError("");
    try { setRide((await api(`/api/clubs/${ride.club.id}/rides/${ride.id}`, { method: "PATCH", body: JSON.stringify(body) })).ride); done?.(); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function removeParticipant(p) {
    setBusy(true); setError("");
    try { setRide((await api(`/api/clubs/${ride.club.id}/rides/${ride.id}/participants/${p.id}`, { method: "DELETE" })).ride); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  const shell = (children) => (
    <main className="page-shell ride-shell">
      <nav className="topbar"><a className="wordmark" href="/" aria-label="PaceUp home"><span className="mark">P</span> paceup</a><span className="topbar-note">{ride?.club.name.toUpperCase() || ""}</span></nav>
      {children}
      <footer><span>PACEUP</span><span>Built for every kind of active community.</span></footer>
    </main>
  );
  if (state === "loading") return shell(<p className="empty-state">Loading…</p>);
  if (state !== "ready") return shell(<section className="workspace ride-card"><h2>Activity not found</h2><p className="panel-copy">{state === "missing" ? "This link may be wrong, or the activity hasn't been published yet." : error}</p><button type="button" className="secondary-button" onClick={() => { setState("loading"); load(); }}>Try again</button></section>);

  const c = cat(ride);
  const open = ride.status === "published" && !ride.started;
  const pct = ride.capacity ? Math.min(100, Math.round((ride.going_count / ride.capacity) * 100)) : null;
  const memberOneTap = ride.viewer.member && !ride.my_rsvp;

  if (editing) return shell(<section className="workspace ride-card"><h2>Edit {c.noun}</h2><ActivityForm clubId={ride.club.id} ride={ride} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); load(); }} /></section>);

  return shell(
    <section className="workspace ride-card">
      <p className="eyebrow cat-eyebrow">{c.emoji} {c.label.toUpperCase()} · {ride.club.name.toUpperCase()}</p>
      {ride.status === "cancelled" && <p className="error">This {c.noun} has been cancelled.</p>}
      {ride.status === "draft" && <p className="panel-copy draft-note">Draft. Only club admins can see this until it's published.</p>}
      <h2 className="ride-title">{ride.title}</h2>
      <dl className="ride-meta">
        <div><dt>When</dt><dd>{when(ride.starts_at)}</dd></div>
        <div><dt>Meet</dt><dd>{ride.meeting_point}{ride.map_url && <><br /><a href={ride.map_url} target="_blank" rel="noreferrer">Open in Maps</a></>}</dd></div>
        {(ride.distance_km || ride.pace) && <div><dt>Distance</dt><dd>{[ride.distance_km && `${ride.distance_km} km`, ride.pace].filter(Boolean).join(" · ")}</dd></div>}
        {ride.organiser && <div><dt>Organiser</dt><dd>{ride.organiser.name}</dd></div>}
        {ride.notes && <div><dt>Notes</dt><dd className="ride-notes">{ride.notes}</dd></div>}
      </dl>

      {open && <div className="ride-actions">
        {flash && <p className="success-note you-in" role="status">{flash}</p>}
        {error && <p className="error" role="alert">{error}</p>}
        {ride.my_rsvp ? <>
          {!flash && <p className="success-note you-in">You're in as {ride.my_rsvp.name} ✓</p>}
          {picking
            ? <NamePicker code={code} busy={busy} onClose={() => setPicking(false)} onPick={(who, label) => rsvp({ status: "going", ...who }, label)} />
            : <div className="two-col">
                <button type="button" className="secondary-button" disabled={busy} onClick={() => { setPicking(true); setFlash(""); }}>Change name</button>
                <button type="button" className="secondary-button" disabled={busy} onClick={() => rsvp({ status: "cancelled" })}>Can't make it</button>
              </div>}
        </> : ride.is_full ? <button type="button" className="big-button" disabled>Full</button>
          : picking ? <NamePicker code={code} busy={busy} onClose={() => setPicking(false)} onPick={(who, label) => rsvp({ status: "going", ...who }, label)} />
          : <button type="button" className="big-button" disabled={busy} onClick={() => (memberOneTap ? rsvp({ status: "going" }, "") : setPicking(true))}>{busy ? "Saving…" : "I'M IN"}</button>}
      </div>}
      {ride.status === "published" && ride.started && <p className="panel-copy">{ride.past ? `This ${c.noun} is over.` : `This ${c.noun} has started. RSVPs are closed.`}</p>}

      <div className="going-head"><span>Going</span><strong>{ride.going_count}{ride.capacity ? ` / ${ride.capacity}` : ""}</strong></div>
      {pct !== null && <div className="meter"><i style={{ width: `${pct}%` }} /></div>}
      <Participants ride={ride} busy={busy} onRemove={removeParticipant} />

      {ride.viewer.admin && ride.status !== "cancelled" && <div className="admin-tools">
        <h3>Organiser tools</h3>
        {ride.status === "published" && open && <ShareButtons ride={ride} />}
        <div className="tool-row">
          {!ride.started && <button type="button" className="secondary-button small-button" onClick={() => setEditing(true)}>Edit details</button>}
          {ride.status === "draft" && <button type="button" className="small-button" disabled={busy} onClick={() => adminPatch({ status: "published" })}>Publish</button>}
          {ride.status === "published" && ride.going_count === 0 && !ride.started && <button type="button" className="secondary-button small-button" disabled={busy} onClick={() => adminPatch({ status: "draft" })}>Unpublish</button>}
        </div>
        {ride.status === "published" && !ride.started && (confirmCancel
          ? <div className="confirm-row"><span>Cancel this {c.noun} for everyone?{ride.going_count ? ` ${ride.going_count} going will see it's cancelled.` : ""}</span><button type="button" disabled={busy} onClick={() => adminPatch({ status: "cancelled" }, () => setConfirmCancel(false))}>Yes, cancel</button><button type="button" className="secondary-button" onClick={() => setConfirmCancel(false)}>Keep it</button></div>
          : <button type="button" className="text-button danger" onClick={() => setConfirmCancel(true)}>Cancel this {c.noun}</button>)}
        <History items={ride.history} />
      </div>}
      {ride.viewer.admin && ride.status === "cancelled" && <History items={ride.history} />}
    </section>
  );
}
