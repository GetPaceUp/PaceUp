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
  entering: ["st-wait", "Waiting for you to enter the code"],
  reconnecting: ["st-wait", "Reconnecting…"],
  connected: ["st-on", "Connected"],
  logged_out: ["st-bad", "Unlinked from the phone"],
  error: ["st-bad", "Connection problem"]
};

/** "+919011022222" → "+91 90110 22222"; other countries keep the code apart from the rest. */
export const prettyPhone = (p) => {
  const d = String(p || "").replace(/\D/g, "");
  if (!d) return p || "";
  if (d.length === 12 && d.startsWith("91")) return `+91 ${d.slice(2, 7)} ${d.slice(7)}`;
  return p.startsWith("+") ? p : `+${d}`;
};

const mmss = (ms) => { const t = Math.max(0, Math.ceil(ms / 1000)); return `${Math.floor(t / 60)}:${String(t % 60).padStart(2, "0")}`; };

/** The 8-character code, the time left on it, and how to type it on the club phone. */
function LinkCode({ wa, busy, onNewCode }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t); }, []);
  const left = wa.pairing_expires_at ? new Date(wa.pairing_expires_at).getTime() - now : null;
  const expired = left !== null && left <= 0;
  return (
    <div className="wa-code-block">
      <p className="panel-copy">Link code for <b>{prettyPhone(wa.pairing_phone)}</b></p>
      <div className={`wa-code${expired ? " expired" : ""}`} aria-label="Link code">{wa.pairing_code}</div>
      {expired
        ? <div className="wa-code-expired"><span>This code has expired.</span><button type="button" disabled={busy} onClick={onNewCode}>Get a new code</button></div>
        : left !== null && <p className="wa-code-timer">Code expires in {mmss(left)}</p>}
      <ol className="wa-steps">
        <li>Open WhatsApp on the <b>club's phone</b></li>
        <li>Go to <b>Settings</b> (iPhone) or the <b>⋮ menu</b> (Android), then <b>Linked devices</b> → <b>Link a device</b></li>
        <li>Tap <b>Link with phone number instead</b></li>
        <li>Type the code above</li>
      </ol>
    </div>
  );
}

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

/** Which of the linked phone's groups belong to the club. The club owner and the PaceUp Admin choose. */
export function GroupPicker({ url, onSaved }) {
  const [view, setView] = useState(null), [picked, setPicked] = useState(new Set()), [q, setQ] = useState("");
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState({});
  const apply = (d) => { setView(d); setPicked(new Set(d.groups.filter((g) => g.linked).map((g) => g.jid))); };
  useEffect(() => { fetch(url, { credentials: "include" }).then((r) => r.json()).then(apply).catch(() => setMsg({ error: "Could not load groups." })); }, [url]);
  async function save() {
    setBusy(true); setMsg({});
    try {
      const r = await fetch(url, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jids: [...picked] }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not save.");
      apply(d); setMsg({ ok: `Saved. The club uses ${picked.size} group${picked.size === 1 ? "" : "s"}.` }); onSaved?.();
    } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }
  if (!view) return <div className="platform-groups"><p className="panel-copy">{msg.error || "Loading…"}</p></div>;
  const toggle = (jid) => setPicked((s) => { const n = new Set(s); n.has(jid) ? n.delete(jid) : n.add(jid); return n; });
  const shown = view.groups.filter((g) => !q || String(g.name).toLowerCase().includes(q.toLowerCase()));
  return <div className="platform-groups">
    <p className="panel-copy"><b>Groups for this club.</b> {view.groups.length ? <>Club admins see and post only to the groups ticked here. Every other group on the phone stays hidden from them.</> : view.status === "connected" ? "The linked number isn't in any groups yet." : "The club hasn't connected WhatsApp yet."}{view.phone ? ` Linked number ${view.phone}.` : ""}</p>
    {view.groups.length > 8 && <input className="platform-groups-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups" aria-label="Search groups" />}
    {view.groups.length > 0 && <ul className="cleanup-list">{shown.map((g) => <li key={g.jid}><label><input type="checkbox" checked={picked.has(g.jid)} onChange={() => toggle(g.jid)} /><span><b>{g.name}</b><small className="panel-copy">{g.size == null ? "Not on the phone anymore" : `${g.size} members`}</small></span></label></li>)}</ul>}
    {msg.error && <p className="error" role="alert">{msg.error}</p>}{msg.ok && <p className="success-note" role="status">{msg.ok}</p>}
    {view.groups.length > 0 && <button type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : `Save (${picked.size} linked)`}</button>}
  </div>;
}

/** Linking the club's own number: a code typed on the club phone, or a QR code scanned from another screen. */
function ConnectNumber({ busy, onConnect, lastPhone, expired }) {
  const phoneFirst = typeof window !== "undefined" && window.matchMedia?.("(max-width: 800px)").matches;
  const [how, setHow] = useState(lastPhone || phoneFirst ? "code" : "qr");
  const [phone, setPhone] = useState(lastPhone ? prettyPhone(lastPhone) : "+91 ");
  return (
    <div className="wa-connect">
      <p className="wa-warn">Use the club's own number, not your personal one.</p>
      <div className="seg" role="tablist" aria-label="How to link">
        <button type="button" role="tab" aria-selected={how === "code"} className={how === "code" ? "on" : ""} onClick={() => setHow("code")}>On this phone</button>
        <button type="button" role="tab" aria-selected={how === "qr"} className={how === "qr" ? "on" : ""} onClick={() => setHow("qr")}>Scan QR</button>
      </div>
      {how === "code"
        ? <form className="stack-form" onSubmit={(e) => { e.preventDefault(); onConnect({ phone }); }}>
            <label htmlFor="wa-num">Club's WhatsApp number</label>
            <input id="wa-num" type="tel" inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210" pattern="[+0-9 \(\)\-]{10,20}" required />
            <button type="submit" disabled={busy}>{expired ? "Get a new code" : "Get a link code"}</button>
          </form>
        : <><p className="panel-copy">Scan it with the club phone.</p><button type="button" disabled={busy} onClick={() => onConnect({})}>Show QR code</button></>}
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
  // Arriving from the owner's sign-in link: bring the Connect step into view.
  useEffect(() => { if (wa && window.location.hash === "#connect") document.getElementById("connect")?.scrollIntoView({ behavior: "smooth", block: "start" }); }, [Boolean(wa)]);
  useEffect(() => {
    clearInterval(timer.current);
    const fast = wa && wa.desired === "on" && (wa.status !== "connected" || wa.groups_refreshing);
    timer.current = setInterval(load, fast ? 2000 : 15000);
    return () => clearInterval(timer.current);
  }, [clubId, wa?.desired, wa?.status, wa?.groups_refreshing]);

  if (!wa) return <section className="admin-panel wa-panel"><h3>WhatsApp</h3><p className="panel-copy">Loading…</p></section>;
  const [cls, label] = STATUS[wa.status === "pairing" && wa.pairing_phone ? "entering" : wa.status] || STATUS.disconnected;
  const codeExpired = wa.desired !== "on" && Boolean(wa.pairing_phone) && /expired/.test(wa.last_error || "");
  const connected = wa.status === "connected";
  const starting = wa.desired === "on" && !connected;
  const manager = Boolean(wa.can_manage_number); // the club owner, or the PaceUp Admin
  const owner = wa.club_owner;

  return (
    <section className="admin-panel wa-panel" id="connect">
      <h3>WhatsApp</h3>
      <p className="panel-copy">{wa.signup_pending && !connected ? "Last step: link your club's WhatsApp." : "Posts your activities and who's going to your WhatsApp group."}</p>
      <div className={`wa-status ${cls}`}><i />{label}{connected && wa.phone ? ` · ${wa.phone}` : ""}{connected && wa.group ? ` · posting to ${wa.group.name}` : ""}</div>
      {wa.last_error && !connected && <p className="error">{codeExpired ? "That link code expired before it was used. Get a new one below." : wa.last_error}</p>}

      {wa.desired !== "on" && (manager
        ? <ConnectNumber key={codeExpired ? "again" : "new"} busy={busy} lastPhone={codeExpired ? wa.pairing_phone : null} expired={codeExpired} onConnect={(body) => act("/connect", "POST", body)} />
        : <p className="panel-copy">{owner ? `${owner.name}, the club owner, links the club's WhatsApp number.` : "The PaceUp team links the club's WhatsApp number."}</p>)}

      {starting && !manager && <p className="panel-copy">{owner ? `${owner.name} is linking the club's number.` : "The club's number is being linked."}</p>}
      {starting && manager && (wa.pairing_phone
        ? (wa.pairing_code
          ? <LinkCode wa={wa} busy={busy} onNewCode={() => act("/connect", "POST", { phone: wa.pairing_phone })} />
          : <p className="panel-copy">Getting your link code for {prettyPhone(wa.pairing_phone)}…</p>)
        : (wa.qr
          ? <div className="wa-pair qr">
              <img className="wa-qr" src={wa.qr} alt="WhatsApp link code. Scan it with the club phone." />
              <ol className="wa-howto"><li>Open WhatsApp on the <b>club's phone</b></li><li>Settings → <b>Linked devices</b> → Link a device</li><li>Point the phone at this code</li></ol>
            </div>
          : <p className="panel-copy">Preparing a code to scan…</p>))}
      {starting && manager && <div className="wa-pair-actions">
        <button type="button" className="text-button" onClick={() => act("/disconnect")}>Cancel</button>
      </div>}

      {connected && <>
        <p className="success-note">Admins can create activities by sending this number a WhatsApp message{wa.phone ? ` (${wa.phone})` : ""}, e.g. "Create a run Sunday 6 AM from Cubbon Park, 10 km". It recognises you by the mobile number on your PaceUp account.</p>
        <label className="field-label" htmlFor="wa-group">Post activities in (default)</label>
        {wa.groups.length
          ? <select id="wa-group" value={wa.group?.jid || ""} disabled={busy} onChange={(e) => e.target.value && act("/group", "PUT", { jid: e.target.value })}>
              <option value="">Choose a group…</option>
              {wa.groups.map((g) => <option key={g.jid} value={g.jid}>{g.name} ({g.size})</option>)}
            </select>
          : <p className="panel-copy">{wa.groups_linked ? "Your club's groups aren't on this number anymore." : "No WhatsApp groups are linked to your club yet."} {manager ? "Choose them below." : owner ? `${owner.name} chooses which groups belong to the club.` : "The PaceUp team chooses which groups belong to the club."}</p>}
        {manager && <details className="wa-groups-pick"><summary>Choose the club's groups</summary><GroupPicker url={`${base}/all-groups`} onSaved={load} /></details>}
        {!manager && owner && <p className="panel-copy">The club owner, {owner.name}, manages this number. Only they or the PaceUp team can change or disconnect it.</p>}
        {wa.group && <p className="panel-copy">You can pick a different group for any activity or template.</p>}
        {wa.groups.length > 1 && <MemberGroups wa={wa} busy={busy} onSave={(jids) => act("/member-groups", "PUT", { jids })} />}
        <button type="button" className="text-button" disabled={busy || wa.groups_refreshing} onClick={() => act("/groups/refresh")}>{wa.groups_refreshing ? "Refreshing groups…" : "Group name out of date? Refresh"}</button>
        {wa.group && <>
          <p className="wa-section-label">Post to the group when…</p>
          <Toggle id="wa-new" label="New activity published" hint="Details and the link to join" checked={wa.settings.post_new_ride} onChange={(v) => act("/settings", "PATCH", { post_new_ride: v })} />
          <Toggle id="wa-list" label="Who's going, after people join" hint="One updated list per activity, at most every 30 seconds" checked={wa.settings.post_rider_list} onChange={(v) => act("/settings", "PATCH", { post_rider_list: v })} />
          <Toggle id="wa-changes" label="Activity changed or cancelled" hint="New time, place or cancellation" checked={wa.settings.post_changes} onChange={(v) => act("/settings", "PATCH", { post_changes: v })} />
          <Toggle id="wa-quiet" label="Quiet hours 10 PM – 5 AM" hint="Held messages go out at 5 AM" checked={wa.settings.quiet_hours} onChange={(v) => act("/settings", "PATCH", { quiet_hours: v })} />
          {wa.stats && <dl className="wa-stats">
            <div><dt>Last message</dt><dd>{ago(wa.stats.last_sent_at)}</dd></div>
            <div><dt>Waiting to send</dt><dd>{wa.stats.pending}</dd></div>
            <div><dt>Sent in 24 h</dt><dd>{wa.stats.sent_24h}</dd></div>
          </dl>}
          <button type="button" className="secondary-button" disabled={busy} onClick={async () => { if (await act("/test")) setNotice("Test message queued. It should appear in the group within a minute."); }}>Send a test message</button>
        </>}
        {notice && <p className="success-note">{notice}</p>}
        {manager && (confirmOff
          ? <div className="confirm-row"><span>Unlink this number from PaceUp?</span><button type="button" disabled={busy} onClick={() => { setConfirmOff(false); act("/disconnect"); }}>Disconnect</button><button type="button" className="secondary-button" onClick={() => setConfirmOff(false)}>Keep</button></div>
          : <button type="button" className="text-button wa-off" onClick={() => setConfirmOff(true)}>Disconnect this number</button>)}
      </>}
      {error && <p className="error" role="alert">{error}</p>}
    </section>
  );
}
