import { useEffect, useState } from "react";

/** A new club's owner opens the one-time link the PaceUp team shared, confirms the last 4 digits and is signed in. */
export function StartPage({ token }) {
  const [info, setInfo] = useState(null);
  const [state, setState] = useState("loading");
  const [digits, setDigits] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const post = (url, body) => fetch(url, { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
    .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || "Something went wrong."), { status: r.status }); return d; });

  useEffect(() => {
    post("/api/start/check", { token }).then((d) => { setInfo(d); setState("ready"); })
      .catch((e) => { setError(e.message); setState("invalid"); });
  }, [token]);

  async function submit(event) {
    event.preventDefault(); setError(""); setSaving(true);
    try {
      await post("/api/start", { token, last4: digits });
      // A full page load (not just a hash change) so the dashboard opens signed in.
      window.location.replace("/?welcome=1#connect");
    } catch (e) {
      setError(e.message);
      if (e.status === 410) setState("invalid");
    } finally { setSaving(false); }
  }

  return (
    <main className="page-shell">
      <nav className="topbar"><a className="wordmark" href="/" aria-label="PaceUp home"><span className="mark">P</span> paceup</a><span className="topbar-note">WELCOME</span></nav>
      <section className="start-page">
        {state === "loading" && <p className="empty-state">Checking your link…</p>}
        {state === "invalid" && <section className="workspace auth-card"><h2>Link not valid</h2><p className="panel-copy">{error}</p><a className="button-link secondary-button" href="/">Go to sign in</a></section>}
        {state === "ready" && <>
          <p className="eyebrow">WELCOME TO PACEUP</p>
          <h1 className="start-title">Hi {info.first_name}, you own {info.club_name} on PaceUp</h1>
          <p className="hero-copy">Two steps and your club is live: confirm it's you, then link the club's WhatsApp number.</p>
          <section className="workspace start-step">
            <div className="step-head"><span className="step-num">1</span><b>Confirm it's you</b></div>
            <form className="stack-form" onSubmit={submit}>
              <label htmlFor="last4">Last 4 digits of your mobile ({info.phone})</label>
              <input id="last4" className="digits-input" inputMode="numeric" autoComplete="off" value={digits} onChange={(e) => setDigits(e.target.value.replace(/\D/g, "").slice(0, 4))} pattern="\d{4}" required />
              {error && <p className="error" role="alert">{error}</p>}
              <button className="primary-button" type="submit" disabled={saving || digits.length !== 4}>{saving ? "Checking…" : "Continue"}</button>
              <p className="panel-copy">No password, no code. You stay signed in on this device for 90 days.</p>
            </form>
          </section>
          <section className="workspace start-step step-next">
            <div className="step-head"><span className="step-num off">2</span><b>Link the club's WhatsApp number</b></div>
            <p className="panel-copy">PaceUp posts new activities and who's going to your groups, and sends your members their sign-in codes, from this number.</p>
          </section>
        </>}
      </section>
    </main>
  );
}

const ACTIVITIES = ["Cycling", "Running", "Trekking", "Triathlon", "Swimming", "Walking", "Multi-sport", "Other"];
const call = (url, body) => fetch(url, { method: body ? "POST" : "GET", credentials: "include", headers: body ? { "Content-Type": "application/json" } : undefined, body: body ? JSON.stringify(body) : undefined })
  .then(async (r) => { const d = await r.json().catch(() => ({})); if (!r.ok) throw Object.assign(new Error(d.error || "Something went wrong."), { status: r.status, data: d }); return d; });

function Steps({ at }) {
  const steps = ["Pick your club", "Your name and mobile", "Link WhatsApp, pick your groups"];
  return <ul className="su-steps">{steps.map((s, i) => <li key={s} className={i < at ? "ok" : i === at ? "on" : ""}><span>{i < at ? "✓" : i + 1}</span>{s}</li>)}</ul>;
}

function Picked({ club, onChange }) {
  return <div className="su-picked"><span className="su-av">{club.name[0]?.toUpperCase()}</span><span><b>{club.name}</b><small>{[club.city, club.activity_type || club.activity].filter(Boolean).join(" · ")}</small></span><button type="button" className="text-button" onClick={onChange}>Change</button></div>;
}

/** getpaceup.com/start: a club sets itself up. Find it, say who you are, then link the club's WhatsApp number. */
export function SignupPage() {
  const preset = new URLSearchParams(window.location.search).get("club");
  const [me, setMe] = useState(undefined);
  const [club, setClub] = useState(null);
  const [adding, setAdding] = useState(false);
  const [q, setQ] = useState("");
  const [sug, setSug] = useState([]);
  const [active, setActive] = useState(0);
  const [nc, setNc] = useState({ city: "", activity: "", other: "" });
  const [person, setPerson] = useState({ name: "", phone: "+91 " });
  const [error, setError] = useState("");
  const [hasAccount, setHasAccount] = useState(false);
  const [saving, setSaving] = useState(false);
  const [asked, setAsked] = useState(null);

  useEffect(() => {
    call("/api/signup/me").then((d) => setMe(d.user)).catch(() => setMe(null));
    if (preset) call(`/api/signup/clubs/${encodeURIComponent(preset)}`).then((d) => setClub(d.club)).catch(() => {});
  }, []);
  useEffect(() => {
    if (club || adding || q.trim().length < 2) { setSug([]); return undefined; }
    const t = setTimeout(() => call(`/api/signup/clubs?q=${encodeURIComponent(q)}`).then((d) => { setSug(d.clubs); setActive(0); }).catch(() => setSug([])), 150);
    return () => clearTimeout(t);
  }, [q, club, adding]);

  const reset = () => { setClub(null); setAdding(false); setError(""); setHasAccount(false); setAsked(null); };
  const pick = (c) => { setClub(c); setSug([]); setError(""); };
  function keys(e) {
    if (!sug.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(sug.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(sug[active]); }
  }

  async function submit(event) {
    event.preventDefault(); setError(""); setHasAccount(false); setSaving(true);
    try {
      const who = me ? {} : { name: person.name, phone: person.phone };
      const activityValue = nc.activity === "Other" ? (nc.other.trim() ? `Other: ${nc.other.trim()}` : "Other") : nc.activity;
      const body = adding
        ? { clubName: q, city: nc.city, activity: activityValue, ...who }
        : { directoryId: club.directory_id, ...(club.city ? {} : { city: nc.city }), ...(club.activity ? {} : { activity: activityValue }), ...who };
      const d = await call("/api/signup", body);
      // A full page load so the dashboard opens signed in, on the new club, at the WhatsApp step.
      window.location.replace(`/?welcome=1&club=${d.club_id}#connect`);
    } catch (e) {
      if (e.data?.code === "has_account") setHasAccount(true);
      else if (e.data?.club) { setAdding(false); setClub(e.data.club); }
      setError(e.message);
    } finally { setSaving(false); }
  }

  async function askAccess(event) {
    event.preventDefault(); setError(""); setSaving(true);
    try { setAsked(await call("/api/signup/request-access", { clubId: club.club_id, ...(me ? (me.phone ? {} : { phone: person.phone }) : person) })); }
    catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  const activityFields = <>
    <label htmlFor="su-act">What does your club do?</label>
    <select id="su-act" value={nc.activity} onChange={(e) => setNc({ ...nc, activity: e.target.value })} required>
      <option value="" disabled>Pick one</option>
      {ACTIVITIES.map((a) => <option key={a}>{a}</option>)}
    </select>
    {nc.activity === "Other" && <input aria-label="Which activity?" placeholder="Which activity?" value={nc.other} onChange={(e) => setNc({ ...nc, other: e.target.value })} maxLength={60} />}
  </>;
  const phoneField = <>
    <label htmlFor="su-phone">Your mobile number</label>
    <input id="su-phone" type="tel" inputMode="tel" autoComplete="tel" value={person.phone} onChange={(e) => setPerson({ ...person, phone: e.target.value })} pattern="[+0-9 \(\)\-]{10,20}" required />
  </>;
  const whoFields = me
    ? <><p className="panel-copy">Signed in as <b>{me.name}</b>{me.phone ? ` (${me.phone})` : ""}.</p>{!me.phone && phoneField}</>
    : <>
        <label htmlFor="su-name">Your name</label>
        <input id="su-name" autoComplete="name" value={person.name} onChange={(e) => setPerson({ ...person, name: e.target.value })} minLength={2} maxLength={80} required />
        {phoneField}
      </>;
  const signInLink = <a href={`/?next=${encodeURIComponent(window.location.pathname + window.location.search)}`}>Sign in</a>;
  const step = club || adding ? 1 : 0;

  return (
    <main className="page-shell">
      <nav className="topbar"><a className="wordmark" href="/" aria-label="PaceUp home"><span className="mark">P</span> paceup</a><span className="topbar-note">SET UP</span></nav>
      <section className="start-page su-page">
        {step === 0 && <>
          <span className="su-free">Absolutely free, for life</span>
          <h1 className="start-title">Set up PaceUp for your club</h1>
          <p className="hero-copy">Post activities to your WhatsApp group in seconds. Members tap "I'm in", no app. The "who's going" list updates itself.</p>
          <section className="workspace su-card">
            <label htmlFor="su-q">Your club's name</label>
            <input id="su-q" role="combobox" aria-expanded={sug.length > 0} aria-controls="su-sug" aria-autocomplete="list" autoComplete="off" value={q} onChange={(e) => setQ(e.target.value)} onKeyDown={keys} placeholder="Start typing…" autoFocus />
            {sug.length > 0 && <ul id="su-sug" role="listbox" className="su-sug">
              {sug.map((c, i) => <li key={c.club_id || c.directory_id} role="option" aria-selected={i === active} className={i === active ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); pick(c); }}>
                <span><b>{c.name}</b><small>{[c.city, c.activity_type || c.activity].filter(Boolean).join(" · ")}</small></span>
                {c.on_paceup && <span className="su-tag">{c.pending ? "BEING SET UP" : "ON PACEUP"}</span>}
              </li>)}
            </ul>}
            <button type="button" className="text-button su-add" onClick={() => { setAdding(true); setError(""); }}>{q.trim().length >= 2 && !sug.length ? `Not listed? + Add "${q.trim()}"` : "Not listed? + Add my club"}</button>
          </section>
        </>}

        {step === 1 && club && !club.on_paceup && <>
          <h1 className="start-title su-small">Almost there</h1>
          <Picked club={club} onChange={reset} />
          <form className="workspace su-card" onSubmit={submit}>
            {!club.city && <><label htmlFor="su-city">City</label><input id="su-city" value={nc.city} onChange={(e) => setNc({ ...nc, city: e.target.value })} maxLength={80} required /></>}
            {!club.activity && activityFields}
            {whoFields}
            <p className="panel-copy">Next you link your club's WhatsApp number. PaceUp posts only this club's activities from it.</p>
            {error && <p className="error" role="alert">{error}{hasAccount && <> {signInLink}</>}</p>}
            <button className="primary-button" type="submit" disabled={saving}>{saving ? "Setting up…" : "Continue"}</button>
          </form>
        </>}

        {step === 1 && adding && <>
          <h1 className="start-title su-small">Add your club</h1>
          <form className="workspace su-card" onSubmit={submit}>
            <label htmlFor="su-cn">Club name</label>
            <input id="su-cn" value={q} onChange={(e) => setQ(e.target.value)} minLength={2} maxLength={80} required />
            <label htmlFor="su-city">City</label>
            <input id="su-city" value={nc.city} onChange={(e) => setNc({ ...nc, city: e.target.value })} maxLength={80} required />
            {activityFields}
            {whoFields}
            {error && <p className="error" role="alert">{error}{hasAccount && <> {signInLink}</>}</p>}
            <button className="primary-button" type="submit" disabled={saving}>{saving ? "Setting up…" : "Continue"}</button>
            <button type="button" className="text-button" onClick={reset}>Back to search</button>
          </form>
        </>}

        {step === 1 && club?.on_paceup && <>
          <Picked club={club} onChange={reset} />
          {asked
            ? <section className="workspace su-card"><b className="su-h">Request sent</b><p className="panel-copy">We've let the club's owner know. You'll get a WhatsApp message once you're added.</p></section>
            : club.pending
              ? <section className="workspace su-card"><b className="su-h">{club.name} is being set up</b><p className="panel-copy">Someone started setting it up a short while ago. If they don't finish within 24 hours, it's free for you to set up. Check back tomorrow.</p></section>
              : <form className="workspace su-card" onSubmit={askAccess}>
                  <b className="su-h">{club.name} is already on PaceUp</b>
                  <p className="panel-copy">Ask to be added as an admin and we'll let the club's owner know.</p>
                  {whoFields}
                  {error && <p className="error" role="alert">{error}</p>}
                  <button className="primary-button" type="submit" disabled={saving}>{saving ? "Sending…" : "Ask to be an admin"}</button>
                </form>}
        </>}

        {!(step === 1 && club?.on_paceup) && <Steps at={step} />}
        <p className="su-foot">{step === 0 && <>About 2 minutes · {me ? <>Signed in as {me.name}</> : <>Already on PaceUp? {signInLink}</>}<br /></>}🔒 Your club's data stays private. Never shared.<br /><br />PACEUP <em className="endorse">by Feet and Pedals</em></p>
      </section>
    </main>
  );
}
