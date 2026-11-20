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
