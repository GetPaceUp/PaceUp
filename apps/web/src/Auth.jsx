import { useEffect, useState } from "react";
import { api } from "./Rides.jsx";

export const phoneText = (p) => (p ? `+${p.slice(0, p.length - 10)} ${p.slice(-10, -5)} ${p.slice(-5)}` : "");

function useCountdown() {
  const [left, setLeft] = useState(0);
  useEffect(() => { if (left <= 0) return; const t = setTimeout(() => setLeft(left - 1), 1000); return () => clearTimeout(t); }, [left]);
  return [left, setLeft];
}

/** Sign in or create an account with a mobile number and a code sent on WhatsApp. */
export function PhoneAuth({ mode, inviteToken, onDone }) {
  const [step, setStep] = useState("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [needsName, setNeedsName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resendIn, setResendIn] = useCountdown();
  const registering = mode === "register" || needsName;

  async function send(e) {
    e?.preventDefault(); setError("");
    if (mode === "register" && name.trim().length < 2) { setError("Enter your name."); return; }
    setBusy(true);
    try { await api("/api/auth/otp/start", { method: "POST", body: JSON.stringify({ phone }) }); setStep("code"); setResendIn(30); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function verify(e) {
    e.preventDefault(); setError(""); setBusy(true);
    try {
      const body = { phone, code, ...(registering ? { name, ...(inviteToken ? { inviteToken } : {}) } : {}) };
      const data = await api("/api/auth/otp/verify", { method: "POST", body: JSON.stringify(body) });
      if (data.needs_signup) { setNeedsName(true); if (data.name_hint && !name.trim()) setName(data.name_hint); return; }
      onDone(data);
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  if (step === "phone") return (
    <form className="create-form" onSubmit={send}>
      {mode === "register" && <><label htmlFor="name">Your name</label><input id="name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" minLength={2} maxLength={80} autoComplete="name" required /></>}
      <label htmlFor="phone">Mobile number</label>
      <input id="phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" autoComplete="tel" maxLength={20} required />
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Sending…" : "Send code on WhatsApp"}</button>
      <p className="panel-copy">We'll send a 6-digit code to this number on WhatsApp.</p>
    </form>
  );

  return (
    <form className="create-form" onSubmit={verify}>
      <p className="panel-copy">Code sent on WhatsApp to <b>{phone}</b>. <button type="button" className="text-button" onClick={() => { setStep("phone"); setCode(""); setError(""); setNeedsName(false); }}>Change</button></p>
      <label htmlFor="otp">6-digit code</label>
      <input id="otp" className="otp-input" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="••••••" required autoFocus />
      {needsName && <>
        <p className="success-note">This number isn't on PaceUp yet. Check your name to finish. Already have an account with email? Go back, sign in with email and add this number there instead.</p>
        <label htmlFor="name2">Your name</label><input id="name2" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" minLength={2} maxLength={80} autoComplete="name" required />
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={busy || code.length !== 6}>{busy ? "Checking…" : needsName ? "Create account" : "Continue"}</button>
      <p className="panel-copy">No code? {resendIn > 0 ? `You can ask again in ${resendIn}s.` : <button type="button" className="text-button" disabled={busy} onClick={() => send()}>Send again</button>}</p>
    </form>
  );
}

/** Forgot password: a code on WhatsApp, then a new password. Works with no email and no admin. */
export function ForgotPassword({ onDone, onBack }) {
  const [step, setStep] = useState("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resendIn, setResendIn] = useCountdown();

  async function send(e) {
    e?.preventDefault(); setError(""); setBusy(true);
    try { await api("/api/auth/password-reset/start", { method: "POST", body: JSON.stringify({ phone }) }); setStep("code"); setResendIn(30); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  async function finish(e) {
    e.preventDefault(); setError("");
    if (password !== confirm) { setError("The two passwords don't match."); return; }
    setBusy(true);
    try { onDone(await api("/api/auth/password-reset/finish", { method: "POST", body: JSON.stringify({ phone, code, password }) })); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }

  if (step === "phone") return (
    <form className="create-form" onSubmit={send}>
      <h3>Forgot your password?</h3>
      <p className="panel-copy">Enter the mobile number on your PaceUp account. We'll send a 6-digit code on WhatsApp, then you choose a new password.</p>
      <label htmlFor="fp-phone">Mobile number</label>
      <input id="fp-phone" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" autoComplete="tel" maxLength={20} required autoFocus />
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Sending…" : "Send code on WhatsApp"}</button>
      <p className="panel-copy">No mobile number on your account yet? Ask your club admin to send you a reset link.</p>
      <p className="auth-switch"><button type="button" className="text-button" onClick={onBack}>Back to sign in</button></p>
    </form>
  );
  return (
    <form className="create-form" onSubmit={finish}>
      <p className="panel-copy">If <b>{phone}</b> is on a PaceUp account, a code is on its way on WhatsApp. <button type="button" className="text-button" onClick={() => { setStep("phone"); setCode(""); setError(""); }}>Change</button></p>
      <label htmlFor="fp-code">6-digit code</label>
      <input id="fp-code" className="otp-input" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" placeholder="••••••" required autoFocus />
      <label htmlFor="fp-password">New password</label>
      <input id="fp-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} maxLength={128} autoComplete="new-password" placeholder="At least 10 characters" required />
      <label htmlFor="fp-confirm">Type it again</label>
      <input id="fp-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={10} maxLength={128} autoComplete="new-password" required />
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={busy || code.length !== 6}>{busy ? "Saving…" : "Set password and sign in"}</button>
      <p className="panel-copy">No code? {resendIn > 0 ? `You can ask again in ${resendIn}s.` : <button type="button" className="text-button" disabled={busy} onClick={() => send()}>Send again</button>}</p>
    </form>
  );
}

/** For accounts made with email: add a mobile number to sign in with WhatsApp codes. */
export function AddPhone({ onAdded }) {
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState("phone");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  async function go(e) {
    e.preventDefault(); setBusy(true); setError("");
    try {
      if (step === "phone") { await api("/api/auth/phone/start", { method: "POST", body: JSON.stringify({ phone }) }); setStep("code"); }
      else { const d = await api("/api/auth/phone/verify", { method: "POST", body: JSON.stringify({ phone, code }) }); onAdded(d.user); }
    } catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  if (!open) return <div className="phone-banner" role="note"><p><b>📱 Add your mobile number.</b> Sign in with a WhatsApp code, and create activities by messaging the club number.</p><button type="button" onClick={() => setOpen(true)}>Add mobile number</button></div>;
  return (
    <form className="inline-form add-phone" onSubmit={go}>
      <div className="field-grow">
        {step === "phone"
          ? <><label htmlFor="add-phone">Mobile number</label><input id="add-phone" type="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" required /></>
          : <><label htmlFor="add-code">Code sent on WhatsApp to {phone}</label><input id="add-code" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))} inputMode="numeric" autoComplete="one-time-code" required /></>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <button type="submit" disabled={busy}>{step === "phone" ? "Send code" : "Verify"}</button>
    </form>
  );
}
