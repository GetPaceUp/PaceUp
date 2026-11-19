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

/** The member list is built from these groups, e.g. the master announcements group that has everyone. */
function MemberGroups({ wa, busy, onSave }) {
  const current = (wa.member_groups || []).map((g) => g.jid);
  const [open, setOpen] = useState(false);
  const [picked, setPicked] = useState(new Set(current));
  useEffect(() => { setPicked(new Set(current)); }, [current.join(",")]);
  const names = (wa.member_groups || []).map((g) => g.name).join(" + ");
  if (!open) return (
    <div className="member-groups">
      <p className="panel-copy"><b>Member list comes from:</b> {names || "no group yet"}. <button type="button" className="text-button" onClick={() => setOpen(true)}>Change</button></p>
    </div>
  );
  const toggle = (jid) => setPicked((s) => { const n = new Set(s); n.has(jid) ? n.delete(jid) : n.add(jid); return n; });
  return (
    <div className="member-groups">
      <p className="panel-copy"><b>Build the member list from</b> these groups. Tick the group that has everyone (like your announcements group), or several groups. People in more than one are listed once.</p>
      <ul className="cleanup-list">
        {wa.groups.map((g) => <li key={g.jid}><label><input type="checkbox" checked={picked.has(g.jid)} onChange={() => toggle(g.jid)} /><span><b>{g.name}</b><small className="panel-copy">{g.size} members</small></span></label></li>)}
      </ul>
      <div className="cleanup-actions">
        <button type="button" disabled={busy || !picked.size} onClick={async () => { await onSave([...picked]); setOpen(false); }}>Save ({picked.size})</button>
        <button type="button" className="text-button" onClick={() => { setPicked(new Set(current)); setOpen(false); }}>Cancel</button>
      </div>
    </div>
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
      <p className="panel-copy">Post new activities and the updated list of who's going to your club's WhatsApp group automatically.</p>
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
        <p className="success-note">Admins can create activities by sending this number a WhatsApp message{wa.phone ? ` (${wa.phone})` : ""}, e.g. "Create a run Sunday 6 AM from Cubbon Park, 10 km". It recognises you by the mobile number on your PaceUp account.</p>
        <label className="field-label" htmlFor="wa-group">Post activities in (default)</label>
        {wa.groups.length
          ? <select id="wa-group" value={wa.group?.jid || ""} disabled={busy} onChange={(e) => e.target.value && act("/group", "PUT", { jid: e.target.value })}>
              <option value="">Choose a group…</option>
              {wa.groups.map((g) => <option key={g.jid} value={g.jid}>{g.name} ({g.size})</option>)}
            </select>
          : <p className="panel-copy">{wa.groups_linked ? "Your club's groups aren't on this number anymore. Ask the PaceUp Super Admin to check them." : "No WhatsApp groups are linked to your club yet. The PaceUp Super Admin chooses which groups belong to the club."}</p>}
        {wa.can_pick_groups && <p className="panel-copy">You're the Super Admin: <a href="/superadmin">choose this club's groups</a> (Super Admin → All clubs → Groups).</p>}
        {wa.group && <p className="panel-copy">You can pick a different group for any activity or template.</p>}
        {wa.groups.length > 1 && <MemberGroups wa={wa} busy={busy} onSave={(jids) => act("/member-groups", "PUT", { jids })} />}
        <button type="button" className="text-button" disabled={busy || wa.groups_refreshing} onClick={() => act("/groups/refresh")}>{wa.groups_refreshing ? "Refreshing groups…" : "Group name out of date? Refresh"}</button>
        {wa.group && <>
          <Toggle id="wa-new" label="New activity published" hint="Details and the link to join" checked={wa.settings.post_new_ride} onChange={(v) => act("/settings", "PATCH", { post_new_ride: v })} />
          <Toggle id="wa-list" label="Who's going, after people join" hint="One updated list per activity, at most every 30 seconds" checked={wa.settings.post_rider_list} onChange={(v) => act("/settings", "PATCH", { post_rider_list: v })} />
          <Toggle id="wa-changes" label="Activity changed or cancelled" hint="New time, place or cancellation" checked={wa.settings.post_changes} onChange={(v) => act("/settings", "PATCH", { post_changes: v })} />
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
