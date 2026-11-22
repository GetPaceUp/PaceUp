import { useEffect, useState } from "react";

// "Get alerts on this phone" for club owners, admins and the PaceUp Admin. The browser only asks
// for permission when they tap "Turn on", never on page load. iPhone needs PaceUp on the home
// screen first (the install card handles that), so this card waits until then.
const KEY = "paceup-alerts-dismissed";
// Right after PaceUp is installed (or first opened from the home screen) we ask once, up front,
// in a sheet. After that, the dashboard card is the fallback.
const SHEET_KEY = "paceup-alerts-sheet-seen";
const sheetSeen = () => { try { return localStorage.getItem(SHEET_KEY) === "1"; } catch { return false; } };
const markSheetSeen = () => { try { localStorage.setItem(SHEET_KEY, "1"); } catch {} };
const installed = () => window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
const QUIET_DAYS = 30;

function supported() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}
function iosNotInstalled() {
  const ios = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && !(window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true);
}
function toKey(base64) {
  const pad = "=".repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, "+").replace(/_/g, "/"));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}
async function subscribe(publicKey, { fresh = false } = {}) {
  const reg = await navigator.serviceWorker.ready;
  // "Try again" starts over with a brand-new phone address, in case the old one went dead at the push service.
  if (fresh) await (await reg.pushManager.getSubscription())?.unsubscribe().catch(() => {});
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
  const json = sub.toJSON();
  const res = await fetch("/api/push/subscribe", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }) });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `Couldn't turn alerts on (${res.status}).`);
}

export default function AlertsCard({ isSuper = false }) {
  const [state, setState] = useState("hidden"); // hidden | ask | on | blocked | error
  const [note, setNote] = useState("");
  const [key, setKey] = useState("");
  const [sheet, setSheet] = useState(false);

  useEffect(() => {
    if (!supported() || iosNotInstalled() || Notification.permission === "denied") return;
    let alive = true;
    (async () => {
      const info = await fetch("/api/push/key", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!alive || !info?.allowed) return;
      setKey(info.publicKey);
      if (Notification.permission === "granted") { // already said yes: keep this phone signed up, and show a way to test it
        subscribe(info.publicKey).then(() => alive && setState("on")).catch((e) => { if (alive) { setNote(e.message); setState("error"); } });
        return;
      }
      if (installed() && !sheetSeen()) { setSheet(true); setState("ask"); return; }
      try { const t = Number(localStorage.getItem(KEY)); if (t && Date.now() - t < QUIET_DAYS * 864e5) return; } catch {}
      setState("ask");
    })();
    // Installed from the browser just now (Android/desktop "Add"): ask straight away.
    const onInstalled = () => { if (alive && Notification.permission === "default" && !sheetSeen()) { setSheet(true); setState((s) => (s === "hidden" ? "ask" : s)); } };
    window.addEventListener("paceup-installed", onInstalled);
    return () => { alive = false; window.removeEventListener("paceup-installed", onInstalled); };
  }, []);

  if (state === "hidden") return null;
  const later = () => {
    if (sheet) { markSheetSeen(); setSheet(false); return; } // the dashboard card stays as the fallback
    try { localStorage.setItem(KEY, String(Date.now())); } catch {} setState("hidden");
  };
  const turnOn = async () => {
    markSheetSeen();
    const answer = await Notification.requestPermission();
    if (answer !== "granted") { setState(answer === "denied" ? "blocked" : "hidden"); return; }
    try { await subscribe(key); setState("on"); } catch (e) { setNote(e.message); setState("error"); }
  };
  const sendTest = async () => {
    setNote("Sending…");
    try {
      const res = await fetch("/api/push/test", { method: "POST", credentials: "include" });
      const r = await res.json();
      if (!res.ok) throw new Error(r.error || `Error ${res.status}`);
      if (!r.phones) { setNote("This phone isn't signed up yet. Tap Try again."); setState("error"); return; }
      const bad = r.results.filter((x) => !x.ok);
      setNote(bad.length ? `Couldn't send: ${bad.map((x) => `${x.service} ${x.status ?? ""} ${x.error || ""}`.trim()).join("; ")}` : "Sent ✅ Check your notifications.");
    } catch (e) { setNote(`Couldn't send: ${e.message}`); }
  };
  const retry = async () => {
    setNote("");
    try { await subscribe(key, { fresh: true }); setState("on"); } catch (e) { setNote(e.message); setState("error"); }
  };

  const close = () => { markSheetSeen(); setSheet(false); };
  if (sheet) return (
    <div className="alerts-sheet-backdrop">
      <section className="alerts-sheet" role="dialog" aria-label="Turn on alerts" aria-live="polite">
        <span className="alerts-sheet-bell" aria-hidden="true">🔔</span>
        {state === "ask" && <>
          <h3>Turn on alerts?</h3>
          <p>{isSuper ? "Drop-outs, no-show checks and new club sign-ups." : "Know when someone drops out, and when to mark no-shows."}</p>
          <button type="button" className="primary-button" onClick={turnOn}>Turn on alerts</button>
          <button type="button" className="text-button alerts-sheet-later" onClick={later}>Not now</button>
        </>}
        {state === "on" && <><h3>Alerts are on ✅</h3><p>We'll only ping you when it matters.</p><button type="button" className="primary-button" onClick={close}>Done</button></>}
        {state === "error" && <><h3>Alerts aren't working yet</h3><p>{note}</p><button type="button" className="primary-button" onClick={retry}>Try again</button><button type="button" className="text-button alerts-sheet-later" onClick={close}>Close</button></>}
        {state === "blocked" && <><h3>Alerts are blocked</h3><p>Allow notifications for PaceUp in your phone settings.</p><button type="button" className="primary-button" onClick={close}>OK</button></>}
      </section>
    </div>
  );

  return (
    <section className="alerts-card" aria-live="polite">
      <span className="alerts-bell" aria-hidden="true">🔔</span>
      {state === "ask" && <>
        <div className="alerts-text"><strong>Get PaceUp alerts</strong><span>{isSuper ? "Drop-outs, no-show checks and new club sign-ups." : "Know when someone drops out, and when to mark no-shows."}</span></div>
        <div className="alerts-actions"><button type="button" onClick={turnOn}>Turn on</button><button type="button" className="secondary-button" onClick={later}>Not now</button></div>
      </>}
      {state === "on" && <>
        <div className="alerts-text"><strong>Alerts are on</strong><span>{note || "We'll only ping you when it matters."}</span></div>
        <div className="alerts-actions"><button type="button" className="secondary-button" onClick={sendTest}>Send test alert</button></div>
      </>}
      {state === "error" && <>
        <div className="alerts-text"><strong>Alerts aren't working yet</strong><span>{note}</span></div>
        <div className="alerts-actions"><button type="button" onClick={retry}>Try again</button></div>
      </>}
      {state === "blocked" && <div className="alerts-text"><strong>Alerts are blocked</strong><span>Allow notifications for PaceUp in your phone settings.</span></div>}
    </section>
  );
}
