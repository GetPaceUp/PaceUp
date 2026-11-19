import { useEffect, useState } from "react";

export function ResetPage({ token }) {
  const [info, setInfo] = useState(null);
  const [state, setState] = useState("loading");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch("/api/password-reset/check", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) })
      .then(async (r) => { const d = await r.json(); if (!r.ok) throw new Error(d.error); setInfo(d); setState("ready"); })
      .catch((e) => { setError(e.message || "This reset link isn't valid."); setState("invalid"); });
  }, [token]);

  async function submit(event) {
    event.preventDefault(); setError("");
    if (password !== confirm) { setError("The two passwords don't match."); return; }
    setSaving(true);
    try {
      const r = await fetch("/api/password-reset", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token, password }) });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not set the password.");
      setState("done");
      setTimeout(() => { window.location.href = "/"; }, 1500);
    } catch (e) { setError(e.message); }
    finally { setSaving(false); }
  }

  return (
    <main className="page-shell">
      <nav className="topbar"><a className="wordmark" href="/" aria-label="PaceUp home"><span className="mark">P</span> paceup</a><span className="topbar-note">RESET PASSWORD</span></nav>
      <section className="workspace auth-card reset-card">
        {state === "loading" && <p className="empty-state">Checking your link…</p>}
        {state === "invalid" && <><h2>Link not valid</h2><p className="panel-copy">{error}</p><a className="button-link secondary-button" href="/">Go to sign in</a></>}
        {state === "done" && <><h2>Password updated</h2><p className="success-note">You're signed in. Taking you to PaceUp…</p></>}
        {state === "ready" && <>
          <p className="eyebrow">HI {info.name.split(" ")[0].toUpperCase()}</p>
          <h2>Choose a new password</h2>
          <p className="panel-copy">For {info.email}. This link works once. Other devices will be signed out.</p>
          <form className="create-form" onSubmit={submit}>
            <label htmlFor="new-password">New password</label>
            <input id="new-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} maxLength={128} autoComplete="new-password" placeholder="At least 10 characters" required />
            <label htmlFor="confirm-password">Type it again</label>
            <input id="confirm-password" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={10} maxLength={128} autoComplete="new-password" required />
            {error && <p className="error" role="alert">{error}</p>}
            <button className="primary-button" type="submit" disabled={saving}>{saving ? "Saving…" : "Set password and sign in"}</button>
          </form>
        </>}
      </section>
    </main>
  );
}

/** Button that creates a one-time reset link for someone and shows it ready to share. */
export function ResetLinkButton({ endpoint, name, className = "secondary-button small-button" }) {
  const [link, setLink] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function create() {
    setBusy(true); setError("");
    try {
      const r = await fetch(endpoint, { method: "POST", credentials: "include" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "Could not create a reset link.");
      setLink(d.resetUrl);
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  }
  const message = `Hi ${name.split(" ")[0]}, here's your PaceUp password reset link. It works once and expires in 24 hours:\n${link}`;

  if (!link) return <span className="reset-inline"><button type="button" className={className} disabled={busy} onClick={create}>{busy ? "Creating…" : "Reset link"}</button>{error && <small className="reset-error">{error}</small>}</span>;
  return (
    <div className="invite-result reset-result">
      <p>One-time reset link for {name}. Valid 24 hours:</p>
      <input readOnly value={link} onFocus={(e) => e.target.select()} />
      <div className="share-row">
        <a className="button-link wa-button" href={`https://wa.me/?text=${encodeURIComponent(message)}`} target="_blank" rel="noreferrer">Send on WhatsApp</a>
        <button type="button" className="secondary-button" onClick={() => navigator.clipboard?.writeText(link).then(() => setCopied(true))}>{copied ? "Copied" : "Copy link"}</button>
      </div>
    </div>
  );
}
