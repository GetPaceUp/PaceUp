import { useEffect, useState } from "react";

// "Get alerts on this phone" for club owners, admins and the PaceUp Admin. The browser only asks
// for permission when they tap "Turn on", never on page load. iPhone needs PaceUp on the home
// screen first (the install card handles that), so this card waits until then.
const KEY = "paceup-alerts-dismissed";
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
async function subscribe(publicKey) {
  const reg = await navigator.serviceWorker.ready;
  const sub = (await reg.pushManager.getSubscription()) || await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: toKey(publicKey) });
  const json = sub.toJSON();
  const res = await fetch("/api/push/subscribe", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys }) });
  if (!res.ok) throw new Error("Couldn't turn alerts on.");
}

export default function AlertsCard({ isSuper = false }) {
  const [state, setState] = useState("hidden"); // hidden | ask | on | blocked
  const [key, setKey] = useState("");

  useEffect(() => {
    if (!supported() || iosNotInstalled() || Notification.permission === "denied") return;
    let alive = true;
    (async () => {
      const info = await fetch("/api/push/key", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (!alive || !info?.allowed) return;
      setKey(info.publicKey);
      if (Notification.permission === "granted") { subscribe(info.publicKey).catch(() => {}); return; } // already said yes: keep this phone signed up quietly
      try { const t = Number(localStorage.getItem(KEY)); if (t && Date.now() - t < QUIET_DAYS * 864e5) return; } catch {}
      setState("ask");
    })();
    return () => { alive = false; };
  }, []);

  if (state === "hidden") return null;
  const later = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch {} setState("hidden"); };
  const turnOn = async () => {
    const answer = await Notification.requestPermission();
    if (answer !== "granted") { setState(answer === "denied" ? "blocked" : "hidden"); return; }
    try { await subscribe(key); setState("on"); } catch { setState("blocked"); }
  };

  return (
    <section className="alerts-card" aria-live="polite">
      <span className="alerts-bell" aria-hidden="true">🔔</span>
      {state === "ask" && <>
        <div className="alerts-text"><strong>Get PaceUp alerts</strong><span>{isSuper ? "Drop-outs, no-show checks and new club sign-ups." : "Know when someone drops out, and when to mark no-shows."}</span></div>
        <div className="alerts-actions"><button type="button" onClick={turnOn}>Turn on</button><button type="button" className="secondary-button" onClick={later}>Not now</button></div>
      </>}
      {state === "on" && <div className="alerts-text"><strong>Alerts are on</strong><span>We'll only ping you when it matters.</span></div>}
      {state === "blocked" && <div className="alerts-text"><strong>Alerts are blocked</strong><span>Allow notifications for PaceUp in your phone settings.</span></div>}
    </section>
  );
}
