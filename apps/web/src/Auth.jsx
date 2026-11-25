import { useEffect, useRef, useState } from "react";
import { api } from "./Rides.jsx";

export const phoneText = (p) => (p ? `+${p.slice(0, p.length - 10)} ${p.slice(-10, -5)} ${p.slice(-5)}` : "");

function useCountdown() {
  const [left, setLeft] = useState(0);
  useEffect(() => { if (left <= 0) return; const t = setTimeout(() => setLeft(left - 1), 1000); return () => clearTimeout(t); }, [left]);
  return [left, setLeft];
}


// Zero of every Unicode digit block a phone keyboard can type (ASCII, Arabic, Devanagari, Bengali,
// Gurmukhi, Gujarati, Odia, Tamil, Telugu, Kannada, Malayalam, Thai, fullwidth...).
const DIGIT_ZEROS = [0x30, 0x660, 0x6f0, 0x966, 0x9e6, 0xa66, 0xae6, 0xb66, 0xbe6, 0xc66, 0xce6, 0xd66, 0xe50, 0xed0, 0xf20, 0x1040, 0xff10];
const asciiDigits = (s) => String(s || "").replace(/\p{Nd}/gu, (ch) => {
  const c = ch.codePointAt(0); const z = DIGIT_ZEROS.find((zero) => c >= zero && c <= zero + 9);
  return z === undefined ? ch : String(c - z);
});
/** The code from whatever was typed, pasted or autofilled: "482 910", "४८२९१०", or the whole WhatsApp message. */
export function extractCode(raw) {
  const s = asciiDigits(raw);
  const whole = s.match(/(?<!\d)\d{6}(?!\d)/);
  return whole ? whole[0] : s.replace(/\D/g, "").slice(0, 6);
}

/** The 6-digit code box. It never gets stuck: it takes any digits, a pasted message, or iPhone autofill. */
function CodeInput({ id, code, setCode, inputRef, onComplete }) {
  const take = (raw) => {
    const next = extractCode(raw);
    if (next === code) return;
    setCode(next);
    if (next.length === 6 && onComplete) setTimeout(() => onComplete(next), 0);
  };
  async function paste() {
    try { const text = await navigator.clipboard.readText(); take(text); inputRef.current?.focus(); }
    catch { inputRef.current?.focus(); }
  }
  return <>
    <label htmlFor={id}>6-digit code</label>
    <div className="otp-row">
      <input id={id} ref={inputRef} name="one-time-code" className="otp-input" type="text" value={code}
        onChange={(e) => take(e.target.value)}
        inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" autoCorrect="off" autoCapitalize="off" spellCheck={false}
        placeholder="••••••" maxLength={200} autoFocus />
      {typeof navigator !== "undefined" && navigator.clipboard?.readText && <button type="button" className="secondary-button otp-paste" onClick={paste}>Paste</button>}
    </div>
  </>;
}

/** Remembers the code step for 10 minutes, so coming back from WhatsApp never lands on an empty form. */
const PENDING_KEY = "paceup-code-step";
function readPending(mode) {
  try {
    const p = JSON.parse(sessionStorage.getItem(PENDING_KEY) || "null");
    return p && p.mode === mode && Date.now() - p.at < 10 * 60 * 1000 ? p : null;
  } catch { return null; }
}
function savePending(value) {
  try { value ? sessionStorage.setItem(PENDING_KEY, JSON.stringify({ ...value, at: Date.now() })) : sessionStorage.removeItem(PENDING_KEY); } catch { /* private mode */ }
}

/** Sign in or create an account with a mobile number and a code sent on WhatsApp. */
export function PhoneAuth({ mode, inviteToken, onDone }) {
  const pending = readPending(mode);
  const [step, setStep] = useState(pending ? "code" : "phone");
  const [phone, setPhone] = useState(pending?.phone || "");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [needsName, setNeedsName] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [resendIn, setResendIn] = useCountdown();
  const codeRef = useRef(null);
  const registering = mode === "register" || needsName;

  async function send(e) {
    e?.preventDefault(); setError("");
    if (mode === "register" && name.trim().length < 2) { setError("Enter your name."); return; }
    setBusy(true);
    try { await api("/api/auth/otp/start", { method: "POST", body: JSON.stringify({ phone, ...(inviteToken ? { inviteToken } : {}) }) }); setStep("code"); setResendIn(30); if (mode === "login" && !inviteToken) savePending({ mode, phone }); }
    catch (err) { setError(err.message); }
    finally { setBusy(false); }
  }
  const checking = useRef(false);
  async function verify(e, typed) {
    e?.preventDefault(); setError("");
    if (checking.current) return;
    // Read the box itself too: iPhone autofill can fill it without telling the app.
    const value = typed || extractCode(codeRef.current?.value || code);
    if (value !== code) setCode(value);
    if (value.length !== 6) { setError("Type the 6-digit code from WhatsApp."); codeRef.current?.focus(); return; }
    if (registering && name.trim().length < 2) { setError("Enter your name."); return; }
    checking.current = true; setBusy(true);
    try {
      const body = { phone, code: value, ...(registering ? { name, ...(inviteToken ? { inviteToken } : {}) } : {}) };
      const data = await api("/api/auth/otp/verify", { method: "POST", body: JSON.stringify(body) });
      if (data.needs_signup) { setNeedsName(true); if (data.name_hint && !name.trim()) setName(data.name_hint); return; }
      savePending(null);
      onDone(data);
    } catch (err) { setError(err.message); }
    finally { checking.current = false; setBusy(false); }
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
      <p className="panel-copy">Code sent on WhatsApp to <b>{phone}</b>. <button type="button" className="text-button" onClick={() => { setStep("phone"); setCode(""); setError(""); setNeedsName(false); savePending(null); }}>Change</button></p>
      <CodeInput id="otp" code={code} setCode={setCode} inputRef={codeRef} onComplete={needsName ? null : (value) => verify(null, value)} />
      {needsName && <>
        <p className="success-note">This number isn't on PaceUp yet. Check your name to finish. Already have an account with email? Go back, sign in with email and add this number there instead.</p>
        <label htmlFor="name2">Your name</label><input id="name2" value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" minLength={2} maxLength={80} autoComplete="name" required />
      </>}
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Checking…" : needsName ? "Create account" : "Continue"}</button>
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
  const codeRef = useRef(null);
  async function finish(e) {
    e.preventDefault(); setError("");
    const value = extractCode(codeRef.current?.value || code);
    if (value !== code) setCode(value);
    if (value.length !== 6) { setError("Type the 6-digit code from WhatsApp."); return; }
    if (password !== confirm) { setError("The two passwords don't match."); return; }
    setBusy(true);
    try { onDone(await api("/api/auth/password-reset/finish", { method: "POST", body: JSON.stringify({ phone, code: value, password }) })); }
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
      <p className="panel-copy">No mobile number on your account yet? Ask your club admin to send you a reset link. Club admins and owners can ask the PaceUp team.</p>
      <p className="auth-switch"><button type="button" className="text-button" onClick={onBack}>Back to sign in</button></p>
    </form>
  );
  return (
    <form className="create-form" onSubmit={finish}>
      <p className="panel-copy">If <b>{phone}</b> is on a PaceUp account, a code is on its way on WhatsApp. <button type="button" className="text-button" onClick={() => { setStep("phone"); setCode(""); setError(""); }}>Change</button></p>
      <CodeInput id="fp-code" code={code} setCode={setCode} inputRef={codeRef} />
      <label htmlFor="fp-password">New password</label>
      <input id="fp-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} minLength={10} maxLength={128} autoComplete="new-password" placeholder="At least 10 characters" required />
      <label htmlFor="fp-confirm">Type it again</label>
      <input id="fp-confirm" type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} minLength={10} maxLength={128} autoComplete="new-password" required />
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary-button" type="submit" disabled={busy}>{busy ? "Saving…" : "Set password and sign in"}</button>
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
          : <><label htmlFor="add-code">Code sent on WhatsApp to {phone}</label><input id="add-code" value={code} onChange={(e) => setCode(extractCode(e.target.value))} inputMode="numeric" pattern="[0-9]*" autoComplete="one-time-code" required /></>}
        {error && <p className="error" role="alert">{error}</p>}
      </div>
      <button type="submit" disabled={busy}>{step === "phone" ? "Send code" : "Verify"}</button>
    </form>
  );
}
