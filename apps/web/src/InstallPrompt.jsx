import { useEffect, useState } from "react";

// "Add PaceUp to your home screen". Shown only to signed-in club owners, club admins and the
// PaceUp Admin, on the dashboard and admin console (see main.jsx). Members never see it. Android/Chrome uses the browser's own
// install dialog; iPhone Safari has none, so we show the two taps instead.
const KEY = "paceup-install-dismissed";
const QUIET_DAYS = 30;

function dismissedRecently() {
  try { const t = Number(localStorage.getItem(KEY)); return t && Date.now() - t < QUIET_DAYS * 864e5; } catch { return false; }
}
function isInstalled() {
  return window.matchMedia?.("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function isIosSafari() {
  const ua = navigator.userAgent;
  const ios = /iPhone|iPad|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  // In-app browsers (WhatsApp, Instagram…) and other iOS browsers can't add to the home screen.
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA|Instagram|FBAN|FBAV|WhatsApp/.test(ua);
}

function ShareIcon() {
  return <svg className="install-share" viewBox="0 0 24 24" aria-label="Share" role="img"><path d="M12 3v12M7.5 7.5 12 3l4.5 4.5" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /><path d="M8 11H6a1 1 0 0 0-1 1v8a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8a1 1 0 0 0-1-1h-2" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" /></svg>;
}

export default function InstallPrompt() {
  const [kind, setKind] = useState(null); // "android" | "ios" | null
  const [deferred, setDeferred] = useState(null);

  useEffect(() => {
    if (isInstalled() || dismissedRecently()) return;
    let timer;
    let alive = true;
    // Is this person an owner or admin of any club (or the PaceUp Admin)?
    const isAdmin = fetch("/api/auth/me", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => Boolean(d?.user && (d.user.super_admin || (d.clubs || []).some((c) => ["owner", "admin"].includes(c.role)))))
      .catch(() => false);
    const showAs = (k) => isAdmin.then((ok) => { if (ok && alive) timer = setTimeout(() => setKind(k), 1500); });
    const onPrompt = (e) => { e.preventDefault(); setDeferred(e); showAs("android"); };
    const onInstalled = () => setKind(null);
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    if (isIosSafari()) showAs("ios");
    return () => { alive = false; clearTimeout(timer); window.removeEventListener("beforeinstallprompt", onPrompt); window.removeEventListener("appinstalled", onInstalled); };
  }, []);

  if (!kind) return null;
  const close = () => { try { localStorage.setItem(KEY, String(Date.now())); } catch {} setKind(null); };
  const install = async () => {
    if (!deferred) return close();
    deferred.prompt();
    const { outcome } = await deferred.userChoice.catch(() => ({}));
    setDeferred(null);
    if (outcome === "accepted") setKind(null); else close();
  };

  const desktop = !window.matchMedia?.("(pointer: coarse)").matches;
  const title = desktop ? "Install PaceUp" : "Add PaceUp to your home screen";
  return (
    <aside className="install-card" role="dialog" aria-label={title}>
      <img className="install-icon" src="/icons/icon-192.png" alt="" width="48" height="48" />
      <div className="install-text">
        <strong>{title}</strong>
        {kind === "android"
          ? <span>{desktop ? "Open your club in one click." : "Open your club in one tap."}</span>
          : <span>Tap <ShareIcon /> then <b>Add to Home Screen</b>.</span>}
      </div>
      <div className="install-actions">
        {kind === "android" && <button type="button" onClick={install}>{desktop ? "Install" : "Add"}</button>}
        <button type="button" className="install-later" onClick={close}>{kind === "android" ? "Not now" : "Got it"}</button>
      </div>
    </aside>
  );
}
