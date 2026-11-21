import { useEffect, useRef, useState } from "react";
import { ResetLinkButton } from "./PasswordReset.jsx";
import { GroupPicker } from "./WhatsApp.jsx";
export default function SuperAdmin() {
 const [data,setData]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(""),[busy,setBusy]=useState("");
 async function load(){setLoading(true);setError("");try{const r=await fetch("/api/platform/overview",{credentials:"include"});if(r.status===401){window.location.href="/";return;}if(!r.ok)throw new Error((await r.json()).error||"Access denied");setData(await r.json());}catch(e){setError(e.message);}finally{setLoading(false);}}
 useEffect(()=>{load();},[]);
 async function role(id,value){setBusy(id);try{const r=await fetch("/api/platform/users/"+id+"/role",{method:"PATCH",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({role:value})});if(!r.ok)throw new Error((await r.json()).error||"Update failed");await load();}catch(e){setError(e.message);}finally{setBusy("");}}
 return <main className="page-shell platform-shell"><nav className="topbar"><a className="wordmark" href="/"><span className="mark">P</span> paceup</a><span className="topbar-note">PLATFORM CONTROL</span></nav><section className="dashboard"><div className="dashboard-head"><div><p className="eyebrow">PACEUP ADMIN CONSOLE</p><h2>PaceUp Admin</h2><p className="hero-copy">Central platform administration.</p></div><a className="secondary-button" href="/">Club dashboard</a></div>
 {loading&&<p className="empty-state">Loading…</p>}{error&&<p className="error">{error}</p>}
 {!loading&&!data&&!error&&<section className="workspace"><h3>Platform owner access required</h3><p className="panel-copy">Set PACEUP_SUPERADMIN_EMAIL to your registered account email in the production environment and restart the API.</p></section>}
 {data&&<><div className="platform-stats">{Object.entries(data.counts).map(([k,v])=><div className="workspace" key={k}><span>{k.toUpperCase()}</span><strong>{v}</strong></div>)}</div>
 <Signups onChange={load} /><CreateClub onCreated={load} /><section className="workspace platform-section"><h2>All clubs</h2><div className="club-list">{data.clubs.map(c=><ClubRow key={c.id} club={c} onChange={load} />)}</div></section>
 <Directory />
 <section className="workspace platform-section"><h2>Users and platform roles</h2><div className="platform-table"><div className="platform-row platform-user-header"><span>User</span><span>Clubs</span><span>Role</span><span>Action</span></div>{data.users.map(u=><div className="platform-row platform-user-row" key={u.id}><span><strong>{u.name}</strong><small>{u.email || (u.phone ? "+" + u.phone : "")}</small></span><span>{u.club_count}<span className="platform-mobile-count"> club{u.club_count === 1 ? "" : "s"}</span></span><span>{u.platform_role === "super_admin" ? "PaceUp Admin" : "User"}</span><span><button className="secondary-button" disabled={busy===u.id} onClick={()=>role(u.id,u.platform_role==="super_admin"?"user":"super_admin")}>{busy===u.id?"Saving…":u.platform_role==="super_admin"?"Remove PaceUp Admin":"Make PaceUp Admin"}</button><ResetLinkButton endpoint={"/api/platform/users/"+u.id+"/password-reset"} name={u.name} /></span></div>)}</div></section>
 <section className="workspace platform-section"><h2>System status</h2><p>API: Online</p><p>WhatsApp: connected per club, from each club's dashboard</p><p>SSL: Managed by deployment configuration</p><button className="secondary-button" onClick={load}>Refresh</button></section></>}</section><footer><span>PACEUP <em className="endorse">by Feet and Pedals</em></span><span>PaceUp Admin console</span></footer></main>;
}
const api = async (url, options = {}) => {
  const r = await fetch(url, { credentials: "include", ...options, headers: options.body ? { "Content-Type": "application/json" } : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || "Something went wrong.");
  return d;
};
const phoneText = (p) => (p ? `+${p.slice(0, p.length - 10)} ${p.slice(-10, -5)} ${p.slice(-5)}` : "");

/** Where a club is in onboarding, in one word or two. */
function clubStage(c) {
  if (c.wa_status === "connected") return ["live", "Live"];
  if (c.wa_desired === "on") return ["wait", "Linking number"];
  if (c.owner_signed_in_at) return ["wait", "Owner signed in"];
  if (c.owner_link_at) return ["invited", "Owner invited"];
  return ["off", "Number not linked"];
}

/** The owner's one-time sign-in link, shared by hand from the PaceUp Admin's own WhatsApp. */
function OwnerLinkCard({ link }) {
  const [copied, setCopied] = useState(false);
  const wa = `https://wa.me/${link.phone}?text=${encodeURIComponent(link.text)}`;
  const first = link.name.split(" ")[0];
  return <div className="owner-link">
    <h3>Send {first} the sign-in link</h3>
    <p className="panel-copy">The club has no WhatsApp number yet, so PaceUp can't send {first} a code. This link signs {first} in once, with no code. PaceUp never sends it from your number: you send it yourself.</p>
    <p className="share-preview">{link.text}</p>
    <a className="button-link wa-button" href={wa} target="_blank" rel="noopener noreferrer">Share on WhatsApp</a>
    <button type="button" className="secondary-button" onClick={async () => { try { await navigator.clipboard.writeText(link.text); setCopied(true); } catch { setCopied(false); } }}>{copied ? "Copied" : "Copy message"}</button>
    <ul className="panel-copy owner-link-rules"><li>Works once, for 7 days</li><li>Only for {phoneText(link.phone).replace(/\d{5}$/, "•••••")}: {first} confirms the last 4 digits</li><li>Lost it? Make a new link from All clubs. The old one stops working.</li></ul>
  </div>;
}

const when = (t) => new Date(t).toLocaleString([], { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
const timeLeft = (t) => { const h = Math.max(1, Math.round((new Date(t).getTime() - Date.now()) / 3600000)); return h < 48 ? `${h} H` : `${Math.round(h / 24)} DAYS`; };

/** Clubs that set themselves up at getpaceup.com/start, and requests to help run a club. */
function Signups({ onChange }) {
  const [data, setData] = useState(null), [err, setErr] = useState(""), [confirm, setConfirm] = useState("");
  const load = () => api("/api/platform/signups").then(setData).catch((e) => setErr(e.message));
  useEffect(() => { load(); }, []);
  // Opens WhatsApp on the PaceUp Admin's own phone with the help note typed in. They press Send; PaceUp sends nothing.
  const [helpLink, setHelpLink] = useState(null);
  const help = async (id) => {
    setErr("");
    const tab = window.open("", "_blank");
    try {
      const link = (await api(`/api/platform/clubs/${id}/owner-link`, { method: "POST", body: JSON.stringify({ help: true }) })).owner_link;
      const wa = `https://wa.me/${link.phone}?text=${encodeURIComponent(link.text)}`;
      if (tab) { tab.opener = null; tab.location.href = wa; setHelpLink(null); } else setHelpLink({ id, link });
    } catch (e) { tab?.close(); setErr(e.message); }
  };
  const remove = async (id) => { setErr(""); try { await api(`/api/platform/signups/${id}`, { method: "DELETE" }); setConfirm(""); load(); onChange?.(); } catch (e) { setErr(e.message); } };
  if (!data) return null;
  const rows = [...data.clubs.map((c) => ({ ...c, kind: "club", at: c.signup_at })), ...data.requests.map((r) => ({ ...r, kind: "request", at: r.created_at }))].sort((a, b) => b.at.localeCompare(a.at));
  return <section className="workspace platform-section" id="signups">
    <div className="section-heading"><div><h2>New sign-ups</h2><p className="panel-copy">Clubs that set themselves up at getpaceup.com/start.</p></div><span className="count">{data.this_week} THIS WEEK</span></div>
    {err && <p className="error">{err}</p>}
    {!rows.length && <p className="empty-state">No sign-ups yet. Share getpaceup.com/start with clubs.</p>}
    {rows.map((r) => r.kind === "club"
      ? <div className="signup-row" key={r.id}><span className="su-av" style={r.signup_status === "pending" ? { background: "#c9cfc7" } : undefined}>{r.name[0]}</span>
          <span><b>{r.name}</b>{[r.city, r.activity].filter(Boolean).map((x) => ` · ${x}`).join("")}{!r.in_directory && <> <span className="su-tag" style={{ background: "#f2f4f0", color: "#7a867e" }}>NEW, NOT IN DIRECTORY</span></>}
            <small>{r.owner_name} · {phoneText(r.owner_phone)} · {when(r.signup_at)}{r.wa_phone && r.wa_phone !== r.owner_phone ? ` · linked ${phoneText(r.wa_phone)}` : ""}</small></span>
          <span className="act">
            {r.signup_status === "pending"
              ? <><span className="su-pill su-wait">WAITING FOR WHATSAPP · {timeLeft(r.released_at)} LEFT</span>
                  {r.owner_phone && <button type="button" className="wa-help-btn" onClick={() => help(r.id)}>Help on WhatsApp</button>}
                  {helpLink?.id === r.id && <a className="button-link wa-button" href={`https://wa.me/${helpLink.link.phone}?text=${encodeURIComponent(helpLink.link.text)}`} target="_blank" rel="noopener noreferrer">Open WhatsApp</a>}</>
              : r.number_matches_directory ? <span className="su-pill su-ok">LIVE · NUMBER MATCHES DIRECTORY</span>
              : <span className="su-pill su-warn">LIVE · CHECK: {r.in_directory ? "NUMBER NOT IN DIRECTORY" : "NEW CLUB"}</span>}
            {confirm === r.id
              ? <span className="confirm-row"><span>Remove {r.name}? Its number is unlinked and the club is deleted.</span><button type="button" onClick={() => remove(r.id)}>Remove</button><button type="button" className="secondary-button" onClick={() => setConfirm("")}>Keep</button></span>
              : <button type="button" className="secondary-button" onClick={() => setConfirm(r.id)}>Remove club</button>}
          </span></div>
      : <div className="signup-row" key={r.id}><span className="su-av" style={{ background: "#7b877f" }}>{r.name[0]}</span>
          <span><b>{r.name}</b> asked to admin <b>{r.club_name}</b><small>{phoneText(r.phone)} · {r.owner_told ? "owner told on WhatsApp" : "owner told once the club's WhatsApp is back"} · {when(r.created_at)}</small></span>
          <span className="act"><span className="su-pill su-wait">ADMIN REQUEST</span></span></div>)}
  </section>;
}

/** One club: where it is in onboarding, its owner link, club owner and groups. */
function ClubRow({ club, onChange }) {
  const [open, setOpen] = useState("");
  const [link, setLink] = useState(null), [err, setErr] = useState("");
  const [admins, setAdmins] = useState(null);
  const [cls, label] = clubStage(club);
  const newLink = async () => { setErr(""); try { setLink((await api(`/api/platform/clubs/${club.id}/owner-link`, { method: "POST" })).owner_link); setOpen("link"); onChange?.(); } catch (e) { setErr(e.message); } };
  const openOwner = async () => { setOpen(open === "owner" ? "" : "owner"); setErr(""); try { setAdmins(await api(`/api/platform/clubs/${club.id}/admins`)); } catch (e) { setErr(e.message); } };
  const [newName, setNewName] = useState(club.name);
  const rename = async (e) => { e.preventDefault(); setErr(""); try { const r = await fetch(`/api/clubs/${club.id}`, { method: "PATCH", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: newName }) }); const d = await r.json().catch(() => ({})); if (!r.ok) throw new Error(d.error || "Could not rename the club."); setOpen(""); onChange?.(); } catch (e2) { setErr(e2.message); } };
  const setOwner = async (userId) => { if (!userId) return; try { setAdmins(await api(`/api/clubs/${club.id}/owner`, { method: "PUT", body: JSON.stringify({ userId }) })); onChange?.(); } catch (e) { setErr(e.message); } };
  return <div className="club-item">
    <div className="club-item-head">
      <div className="club-item-main"><strong>{club.name}</strong><small>{[club.city, club.activity, `${club.member_count} member${club.member_count === 1 ? "" : "s"}`, club.owner_name && `owner ${club.owner_name}`].filter(Boolean).join(" · ")}</small></div>
      <span className={`stage stage-${cls}`}>{label}</span>
    </div>
    <div className="club-item-actions">
      <button type="button" className="secondary-button small-button" onClick={() => { setNewName(club.name); setOpen(open === "rename" ? "" : "rename"); }}>Rename</button>
      <button type="button" className="secondary-button small-button" onClick={() => setOpen(open === "groups" ? "" : "groups")}>{open === "groups" ? "Close groups" : "Groups"}</button>
      <button type="button" className="secondary-button small-button" onClick={openOwner}>Club owner{club.owner_name ? `: ${club.owner_name}` : ""}</button>
      {club.wa_status !== "connected" && <button type="button" className="secondary-button small-button" onClick={newLink}>New owner link</button>}
    </div>
    {err && <p className="error" role="alert">{err}</p>}
    {open === "rename" && <form className="inline-form" onSubmit={rename}>
      <div className="field-grow"><label className="field-label" htmlFor={`rn-${club.id}`}>Club name</label><input id={`rn-${club.id}`} value={newName} onChange={(e) => setNewName(e.target.value)} minLength={2} maxLength={80} required autoFocus /></div>
      <button type="submit">Save</button>
    </form>}
    {open === "groups" && <GroupPicker url={`/api/platform/clubs/${club.id}/whatsapp-groups`} />}
    {open === "link" && link && <OwnerLinkCard link={link} />}
    {open === "owner" && admins && <div className="platform-groups">
      <label className="field-label" htmlFor={`no-${club.id}`}>Club owner</label>
      <select id={`no-${club.id}`} value={admins.owner_id || ""} onChange={(e) => setOwner(e.target.value)}>
        {!admins.owner_id && <option value="">Nobody yet</option>}
        {admins.admins.map((a) => <option key={a.id} value={a.id}>{a.name}{a.role === "owner" ? " (owner)" : " (club admin)"}</option>)}
      </select>
      <p className="panel-copy">One owner per club. The owner links the club's WhatsApp number, picks its groups, renames the club, sees message counts and makes club admins. The old owner stays on as a club admin. You can always do all of this too.</p>
    </div>}
  </div>;
}

function CreateClub({ onCreated }) {
  const empty = { name: "", city: "", activity: "", otherActivity: "", directoryId: "", adminPhone: "", adminName: "" };
  const [f, setF] = useState(empty);
  const [types, setTypes] = useState(["Cycling", "Running", "Trekking", "Triathlon", "Swimming", "Walking", "Multi-sport"]);
  useEffect(() => { api("/api/platform/directory/activities").then((d) => setTypes(d.activities.map((a) => a.name))).catch(() => {}); }, []);
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState({}), [link, setLink] = useState(null);
  const [sug, setSug] = useState([]), [showSug, setShowSug] = useState(false), [active, setActive] = useState(0);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  useEffect(() => {
    if (f.directoryId || f.name.trim().length < 2) { setSug([]); return; }
    const t = setTimeout(() => api(`/api/platform/directory/suggest?q=${encodeURIComponent(f.name)}`).then((d) => { setSug(d.clubs); setActive(0); }).catch(() => setSug([])), 150);
    return () => clearTimeout(t);
  }, [f.name, f.directoryId]);
  function pick(c) {
    setShowSug(false);
    if (c.on_paceup) { setMsg({ error: `${c.name} is already on PaceUp. Find it under All clubs.` }); return; }
    setMsg({}); setF({ ...f, name: c.name, city: c.city || "", activity: c.activity_type || "", otherActivity: c.activity_type === "Other" ? c.activity || "" : "", directoryId: c.directory_id });
  }
  async function submit(e) {
    e.preventDefault(); setBusy(true); setMsg({}); setLink(null);
    try {
      const { otherActivity, ...rest } = f;
      const body = { ...rest, activity: f.activity === "Other" ? otherActivity.trim() || "Other" : f.activity };
      const d = await api("/api/platform/clubs", { method: "POST", body: JSON.stringify(Object.fromEntries(Object.entries(body).filter(([, v]) => v))) });
      setMsg({ ok: `${d.club.name} is on PaceUp. ${d.owner.name} is its owner.` });
      setLink(d.owner_link); setF(empty); onCreated();
    } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }
  const onKey = (e) => {
    if (!showSug || !sug.length) return;
    if (e.key === "ArrowDown") { e.preventDefault(); setActive((a) => Math.min(sug.length - 1, a + 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === "Enter") { e.preventDefault(); pick(sug[active]); }
    else if (e.key === "Escape") setShowSug(false);
  };
  return <section className="workspace platform-section"><h2>Create a club</h2><p className="panel-copy">Start typing. Clubs in the PaceUp directory fill in their details.</p>
    <form className="stack-form" onSubmit={submit} autoComplete="off">
      <label htmlFor="cc-name">Club name</label>
      <div className="combo">
        <input id="cc-name" role="combobox" aria-expanded={showSug && sug.length > 0} aria-controls="cc-sug" aria-autocomplete="list" value={f.name}
          onChange={(e) => { setF({ ...f, name: e.target.value, directoryId: "" }); setShowSug(true); }} onFocus={() => setShowSug(true)} onBlur={() => setTimeout(() => setShowSug(false), 150)} onKeyDown={onKey} minLength={2} maxLength={80} required />
        {showSug && sug.length > 0 && <ul id="cc-sug" role="listbox" className="combo-list">
          {sug.map((c, i) => <li key={c.club_id || c.directory_id} role="option" aria-selected={i === active} className={i === active ? "on" : ""} onMouseDown={(e) => { e.preventDefault(); pick(c); }}>
            <b>{c.name}</b><small>{[c.city, c.activity, c.on_paceup ? "already on PaceUp" : "from directory"].filter(Boolean).join(" · ")}</small>
          </li>)}
        </ul>}
      </div>
      {f.directoryId && <p className="panel-copy">Filled in from the directory. Change anything that's wrong.</p>}
      <div className="two-col"><div><label htmlFor="cc-city">City</label><input id="cc-city" value={f.city} onChange={set("city")} maxLength={80} /></div>
        <div><label htmlFor="cc-act">Activity</label><select id="cc-act" value={f.activity} onChange={set("activity")}>
          <option value="">Pick one</option>
          {types.map((t) => <option key={t} value={t}>{t}</option>)}
          <option value="Other">Other</option>
        </select>
        {f.activity === "Other" && <input id="cc-act-other" aria-label="Other activity" className="cc-act-other" value={f.otherActivity} onChange={set("otherActivity")} maxLength={80} placeholder="Type the activity" />}</div></div>
      <p className="eyebrow cc-owner-label">CLUB OWNER</p>
      <p className="panel-copy">The owner links the club's own WhatsApp number. Codes and posts for this club come only from that number. Leave empty to own the club yourself.</p>
      <label htmlFor="cc-admin">Owner's name <span className="optional">(if they're new to PaceUp)</span></label><input id="cc-admin" value={f.adminName} onChange={set("adminName")} maxLength={80} />
      <label htmlFor="cc-phone">Owner's mobile number</label><input id="cc-phone" type="tel" value={f.adminPhone} onChange={set("adminPhone")} placeholder="+91 98765 43210" />
      {msg.error && <p className="error" role="alert">{msg.error}</p>}{msg.ok && <p className="success-note" role="status">{msg.ok}</p>}
      <button type="submit" disabled={busy}>{busy ? "Creating…" : f.adminPhone.replace(/\D/g, "").length >= 10 ? "Create club and get owner link" : "Create club"}</button>
    </form>
    {link && <OwnerLinkCard link={link} />}
  </section>;
}

const STATUS_LABEL = { prospect: "Prospect", contacted: "Contacted", pilot: "Pilot", live: "Live" };

/** The club directory: imported from the PaceUp Admin's file. Contacts are only ever shown here. */
function Directory() {
  const [q, setQ] = useState(""), [status, setStatus] = useState("");
  const [data, setData] = useState(null), [openId, setOpenId] = useState(""), [msg, setMsg] = useState({}), [busy, setBusy] = useState(false);
  const file = useRef();
  const load = () => api(`/api/platform/directory?q=${encodeURIComponent(q)}&status=${status}`).then(setData).catch((e) => setMsg({ error: e.message }));
  useEffect(() => { const t = setTimeout(load, 200); return () => clearTimeout(t); }, [q, status]);
  async function upload(f) {
    if (!f) return;
    setBusy(true); setMsg({});
    try {
      const s = (await api("/api/platform/directory/import", { method: "POST", body: JSON.stringify({ csv: await f.text() }) })).stats;
      setMsg({ ok: `Import done. ${s.rows} rows: ${s.added} clubs added, ${s.updated} already there and updated, ${s.merged_in_file} duplicates merged, ${s.skipped_no_name} skipped (no name).` });
      load();
    } catch (e) { setMsg({ error: e.message }); } finally { setBusy(false); if (file.current) file.current.value = ""; }
  }
  const total = data ? Object.values(data.counts).reduce((a, b) => a + b, 0) : 0;
  return <section className="workspace platform-section">
    <h2>Club directory</h2>
    <p className="panel-copy">Every column of your file is kept. Only the name, city and activity are ever used outside this page (to fill in names as you type). Contacts stay here.</p>
    {data && <p className="dir-counts">{total} clubs · {Object.entries(STATUS_LABEL).map(([k, v]) => `${data.counts[k] || 0} ${v.toLowerCase()}`).join(" · ")}</p>}
    {msg.error && <p className="error" role="alert">{msg.error}</p>}{msg.ok && <p className="success-note" role="status">{msg.ok}</p>}
    <div className="two-col dir-filters">
      <div><label htmlFor="dir-q">Search</label><input id="dir-q" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Club, city or state" /></div>
      <div><label htmlFor="dir-s">Status</label><select id="dir-s" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All</option>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
    </div>
    <div className="dir-list">
      {data?.items.map((d) => <DirectoryRow key={d.id} d={d} open={openId === d.id} onToggle={() => setOpenId(openId === d.id ? "" : d.id)} onSaved={load} />)}
      {data && !data.items.length && <p className="panel-copy">{total ? "No clubs match." : "The directory is empty. Upload your file below."}</p>}
      {data && data.total > data.items.length && <p className="panel-copy">Showing {data.items.length} of {data.total}. Search to narrow down.</p>}
    </div>
    <div className="dir-upload">
      <button type="button" className="secondary-button" disabled={busy} onClick={() => file.current?.click()}>{busy ? "Importing…" : "Upload a directory file (CSV)"}</button>
      <input ref={file} type="file" accept=".csv,text/csv" hidden onChange={(e) => upload(e.target.files[0])} />
      <p className="panel-copy">Same columns as before. Clubs already here are updated, never duplicated; statuses and notes are kept.</p>
    </div>
  </section>;
}

function DirectoryRow({ d, open, onToggle, onSaved }) {
  const [f, setF] = useState({ status: d.status, notes: d.notes || "" }), [err, setErr] = useState(""), [saved, setSaved] = useState(false);
  useEffect(() => { setF({ status: d.status, notes: d.notes || "" }); }, [d.id, d.status, d.notes]);
  const save = async (patch) => { setErr(""); setSaved(false); try { await api(`/api/platform/directory/${d.id}`, { method: "PATCH", body: JSON.stringify(patch) }); setSaved(true); onSaved(); } catch (e) { setErr(e.message); } };
  const link = (url, text) => url ? <a href={url} target="_blank" rel="noopener noreferrer">{text}</a> : <span className="muted">none</span>;
  return <div className={`dir-row${d.hidden ? " dir-hidden" : ""}`}>
    <button type="button" className="dir-row-head" aria-expanded={open} onClick={onToggle}>
      <span><b>{d.name}</b><small>{[d.city, d.state, d.activity].filter(Boolean).join(" · ")}</small></span>
      <span className={`stage stage-${d.status === "live" ? "live" : d.status === "prospect" ? "off" : "wait"}`}>{STATUS_LABEL[d.status]}{d.hidden ? " · hidden" : ""}</span>
    </button>
    {open && <div className="dir-record">
      <dl>
        <dt>Instagram</dt><dd>{link(d.instagram, d.instagram?.replace(/^https?:\/\/(www\.)?instagram\.com\//, "@").replace(/\/$/, ""))}</dd>
        <dt>Facebook</dt><dd>{link(d.facebook, "Page")}</dd>
        <dt>Website</dt><dd>{link(d.website, d.website?.replace(/^https?:\/\/(www\.)?/, "").slice(0, 40))}</dd>
        <dt>Email</dt><dd>{d.email ? <a href={`mailto:${d.email}`}>{d.email}</a> : <span className="muted">none</span>}</dd>
        <dt>Mobile</dt><dd>{d.phone ? <a href={`https://wa.me/${d.phone}`} target="_blank" rel="noopener noreferrer">{phoneText(d.phone)}</a> : <span className="muted">none</span>}</dd>
        {d.other_links && <><dt>Other</dt><dd className="wrap">{d.other_links}</dd></>}
        {d.club_name && <><dt>On PaceUp</dt><dd>{d.club_name}</dd></>}
        <dt>Source</dt><dd>{d.source_name || "—"}</dd>
      </dl>
      <label className="field-label" htmlFor={`st-${d.id}`}>Status</label>
      <select id={`st-${d.id}`} value={f.status} onChange={(e) => { setF({ ...f, status: e.target.value }); save({ status: e.target.value }); }}>{Object.entries(STATUS_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
      <label className="field-label" htmlFor={`nt-${d.id}`}>Notes</label>
      <textarea id={`nt-${d.id}`} rows={3} value={f.notes} maxLength={2000} onChange={(e) => setF({ ...f, notes: e.target.value })} onBlur={() => f.notes !== (d.notes || "") && save({ notes: f.notes })} />
      <div className="dir-record-actions">
        <button type="button" className="text-button" onClick={() => save({ hidden: !d.hidden })}>{d.hidden ? "Show in suggestions again" : "Hide from suggestions"}</button>
        {saved && <span className="panel-copy" role="status">Saved</span>}
      </div>
      {err && <p className="error" role="alert">{err}</p>}
    </div>}
  </div>;
}
