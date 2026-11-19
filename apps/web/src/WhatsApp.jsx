import { useEffect, useRef, useState } from "react";

const api = async (url, options = {}) => {
  const response = await fetch(url, { credentials: "include", ...options, headers: options.body ? { "Content-Type": "application/json" } : undefined });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || "Something went wrong.");
  return data.whatsapp;
};

const STATUS = {
  disconnected: ["st-off", "Not connected"],
  pairing: ["st-wait", "Waiting for you to scan the code"],
  reconnecting: ["st-wait", "Reconnecting…"],
  connected: ["st-on", "Connected"],
  logged_out: ["st-bad", "Unlinked from the phone"],
  error: ["st-bad", "Connection problem"]
};

const ago = (iso) => {
  if (!iso) return "never";
  const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

function Toggle({ id, label, hint, checked, onChange }) {
  return (
    <label className="wa-toggle" htmlFor={id}>
      <span><strong>{label}</strong><small>{hint}</small></span>
      <input id={id} type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}

export function WhatsAppPanel({ clubId }) {
  const [wa, setWa] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const [notice, setNotice] = useState("");
  const base = `/api/clubs/${clubId}/whatsapp`;
  const timer = useRef();

  async function load() { try { setWa(await api(base)); } catch (err) { setError(err.message); } }
  async function act(path, method = "POST", body) {
    setBusy(true); setError(""); setNotice("");
    try { setWa(await api(`${base}${path}`, { method, body: body ? JSON.stringify(body) : undefined })); return true; }
    catch (err) { setError(err.message); return false; }
    finally { setBusy(false); }
  }

  useEffect(() => { setWa(null); setConfirmOff(false); load(); }, [clubId]);
  useEffect(() => {
    clearInterval(timer.current);
    const fast = wa && wa.desired === "on" && (wa.status !== "connected" || wa.groups_refreshing);
    timer.current = setInterval(load, fast ? 2000 : 15000);
    return () => clearInterval(timer.current);
  }, [clubId, wa?.desired, wa?.status, wa?.groups_refreshing]);

  if (!wa) return <section className="admin-panel wa-panel"><h3>WhatsApp</h3><p className="panel-copy">Loading…</p></section>;
  const [cls, label] = STATUS[wa.status] || STATUS.disconnected;
  const connected = wa.status === "connected";
  const starting = wa.desired === "on" && !connected;

  return (
    <section className="admin-panel wa-panel">
      <h3>WhatsApp</h3>
      <p className="panel-copy">Post new rides and the updated rider list to your club's WhatsApp group automatically.</p>
      <div className={`wa-status ${cls}`}><i />{label}{connected && wa.phone ? ` · ${wa.phone}` : ""}{connected && wa.group ? ` · posting to ${wa.group.name}` : ""}</div>
      {wa.last_error && !connected && <p className="error">{wa.last_error}</p>}

      {wa.desired !== "on" && <>
        <p className="panel-copy">Use a phone number only for the club. Don't link a personal number.</p>
        <button type="button" disabled={busy} onClick={() => act("/connect")}>Connect WhatsApp</button>
      </>}

      {starting && (wa.qr
        ? <div className="wa-pair">
            <img className="wa-qr" src={wa.qr} alt="WhatsApp link code. Scan it with the club phone." />
            <ol className="wa-howto"><li>Open WhatsApp on the <b>club's phone</b></li><li>Settings → <b>Linked devices</b> → Link a device</li><li>Point the phone at this code</li></ol>
          </div>
        : <p className="panel-copy">Preparing a code to scan…</p>)}
      {starting && <button type="button" className="text-button" onClick={() => act("/disconnect")}>Cancel</button>}

      {connected && <>
        <label className="field-label" htmlFor="wa-group">Post rides in</label>
        {wa.groups.length
          ? <select id="wa-group" value={wa.group?.jid || ""} disabled={busy} onChange={(e) => e.target.value && act("/group", "PUT", { jid: e.target.value })}>
              <option value="">Choose a group…</option>
              {wa.groups.map((g) => <option key={g.jid} value={g.jid}>{g.name} ({g.size})</option>)}
            </select>
          : <p className="panel-copy">This number isn't in any groups yet. Add it to your club group in WhatsApp, then press Refresh groups.</p>}
        <button type="button" className="text-button" disabled={busy || wa.groups_refreshing} onClick={() => act("/groups/refresh")}>{wa.groups_refreshing ? "Refreshing groups…" : "Group missing? Refresh groups"}</button>
        {wa.group && <>
          <Toggle id="wa-new" label="New ride published" hint="Ride details and the RSVP link" checked={wa.settings.post_new_ride} onChange={(v) => act("/settings", "PATCH", { post_new_ride: v })} />
          <Toggle id="wa-list" label="Rider list after RSVPs" hint="One updated list per ride, at most every 2 minutes" checked={wa.settings.post_rider_list} onChange={(v) => act("/settings", "PATCH", { post_rider_list: v })} />
          <Toggle id="wa-changes" label="Ride changed or cancelled" hint="New time, place or cancellation" checked={wa.settings.post_changes} onChange={(v) => act("/settings", "PATCH", { post_changes: v })} />
          <Toggle id="wa-quiet" label="Quiet hours 10 PM – 5 AM" hint="Held messages go out at 5 AM" checked={wa.settings.quiet_hours} onChange={(v) => act("/settings", "PATCH", { quiet_hours: v })} />
          <dl className="wa-stats">
            <div><dt>Last message</dt><dd>{ago(wa.stats.last_sent_at)}</dd></div>
            <div><dt>Waiting to send</dt><dd>{wa.stats.pending}</dd></div>
            <div><dt>Sent in 24 h</dt><dd>{wa.stats.sent_24h}</dd></div>
          </dl>
          <button type="button" className="secondary-button" disabled={busy} onClick={async () => { if (await act("/test")) setNotice("Test message queued. It should appear in the group within a minute."); }}>Send a test message</button>
        </>}
        {notice && <p className="success-note">{notice}</p>}
        {confirmOff
          ? <div className="confirm-row"><span>Unlink this number from PaceUp?</span><button type="button" disabled={busy} onClick={() => { setConfirmOff(false); act("/disconnect"); }}>Disconnect</button><button type="button" className="secondary-button" onClick={() => setConfirmOff(false)}>Keep</button></div>
          : <button type="button" className="text-button wa-off" onClick={() => setConfirmOff(true)}>Disconnect this number</button>}
      </>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
