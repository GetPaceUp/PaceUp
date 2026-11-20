import { useEffect, useState } from "react";
import { ResetLinkButton } from "./PasswordReset.jsx";
export default function SuperAdmin() {
 const [data,setData]=useState(null),[loading,setLoading]=useState(true),[error,setError]=useState(""),[busy,setBusy]=useState("");
 async function load(){setLoading(true);setError("");try{const r=await fetch("/api/platform/overview",{credentials:"include"});if(r.status===401){window.location.href="/";return;}if(!r.ok)throw new Error((await r.json()).error||"Access denied");setData(await r.json());}catch(e){setError(e.message);}finally{setLoading(false);}}
 useEffect(()=>{load();},[]);
 async function role(id,value){setBusy(id);try{const r=await fetch("/api/platform/users/"+id+"/role",{method:"PATCH",credentials:"include",headers:{"Content-Type":"application/json"},body:JSON.stringify({role:value})});if(!r.ok)throw new Error((await r.json()).error||"Update failed");await load();}catch(e){setError(e.message);}finally{setBusy("");}}
 return <main className="page-shell platform-shell"><nav className="topbar"><a className="wordmark" href="/"><span className="mark">P</span> paceup</a><span className="topbar-note">PLATFORM CONTROL</span></nav><section className="dashboard"><div className="dashboard-head"><div><p className="eyebrow">PACEUP OWNER CONSOLE</p><h2>Super Admin</h2><p className="hero-copy">Central platform administration.</p></div><a className="secondary-button" href="/">Club dashboard</a></div>
 {loading&&<p className="empty-state">Loading…</p>}{error&&<p className="error">{error}</p>}
 {!loading&&!data&&!error&&<section className="workspace"><h3>Platform owner access required</h3><p className="panel-copy">Set PACEUP_SUPERADMIN_EMAIL to your registered account email in the production environment and restart the API.</p></section>}
 {data&&<><div className="platform-stats">{Object.entries(data.counts).map(([k,v])=><div className="workspace" key={k}><span>{k.toUpperCase()}</span><strong>{v}</strong></div>)}</div>
 <CreateClub onCreated={load} /><section className="workspace platform-section"><h2>All clubs</h2><div className="platform-table"><div className="platform-row platform-club-row platform-header"><span>Club</span><span>Slug</span><span>Members</span><span>WhatsApp</span></div>{data.clubs.map(c=><ClubRow key={c.id} club={c} />)}</div></section>
 <section className="workspace platform-section"><h2>Users and platform roles</h2><div className="platform-table"><div className="platform-row platform-user-header"><span>User</span><span>Clubs</span><span>Role</span><span>Action</span></div>{data.users.map(u=><div className="platform-row platform-user-row" key={u.id}><span><strong>{u.name}</strong><small>{u.email || (u.phone ? "+" + u.phone : "")}</small></span><span>{u.club_count}<span className="platform-mobile-count"> club{u.club_count === 1 ? "" : "s"}</span></span><span>{u.platform_role === "super_admin" ? "Super Admin" : "User"}</span><span><button className="secondary-button" disabled={busy===u.id} onClick={()=>role(u.id,u.platform_role==="super_admin"?"user":"super_admin")}>{busy===u.id?"Saving…":u.platform_role==="super_admin"?"Remove owner":"Make owner"}</button><ResetLinkButton endpoint={"/api/platform/users/"+u.id+"/password-reset"} name={u.name} /></span></div>)}</div></section>
 <section className="workspace platform-section"><h2>System status</h2><p>API: Online</p><p>WhatsApp: connected per club, from each club's dashboard</p><p>SSL: Managed by deployment configuration</p><button className="secondary-button" onClick={load}>Refresh</button></section></>}</section><footer><span>PACEUP</span><span>Platform owner console</span></footer></main>;
}
/** One club, with the WhatsApp groups only the Super Admin can link to it. */
function ClubRow({ club }) {
  const [open, setOpen] = useState(false);
  return <>
    <div className="platform-row platform-club-row"><strong>{club.name}</strong><span>{club.slug}<span className="platform-mobile-count"> · {club.member_count} member{club.member_count === 1 ? "" : "s"}</span></span><span>{club.member_count}</span><span><button className="secondary-button" onClick={() => setOpen(!open)}>{open ? "Close" : "Groups"}</button></span></div>
    {open && <ClubGroups clubId={club.id} />}
  </>;
}
function ClubGroups({ clubId }) {
  const url = `/api/platform/clubs/${clubId}/whatsapp-groups`;
  const [view, setView] = useState(null), [picked, setPicked] = useState(new Set()), [q, setQ] = useState("");
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState({});
  const apply = (d) => { setView(d); setPicked(new Set(d.groups.filter((g) => g.linked).map((g) => g.jid))); };
  useEffect(() => { fetch(url, { credentials: "include" }).then((r) => r.json()).then(apply).catch(() => setMsg({ error: "Could not load groups." })); }, [clubId]);
  async function save() {
    setBusy(true); setMsg({});
    try {
      const r = await fetch(url, { method: "PUT", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jids: [...picked] }) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not save.");
      apply(d); setMsg({ ok: `Saved. Club admins now see ${picked.size} group${picked.size === 1 ? "" : "s"}.` });
    } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }
  if (!view) return <div className="platform-groups"><p className="panel-copy">{msg.error || "Loading…"}</p></div>;
  const toggle = (jid) => setPicked((s) => { const n = new Set(s); n.has(jid) ? n.delete(jid) : n.add(jid); return n; });
  const shown = view.groups.filter((g) => !q || String(g.name).toLowerCase().includes(q.toLowerCase()));
  return <div className="platform-groups">
    <p className="panel-copy"><b>WhatsApp groups for this club.</b> {view.groups.length ? <>Club admins see and post only to the groups ticked here. Every other group on the linked phone stays hidden from them.</> : view.status === "connected" ? "The linked number isn't in any groups yet." : "The club hasn't connected WhatsApp yet."}{view.phone ? ` Linked number ${view.phone}.` : ""}</p>
    {view.groups.length > 8 && <input className="platform-groups-search" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search groups" aria-label="Search groups" />}
    {view.groups.length > 0 && <ul className="cleanup-list">{shown.map((g) => <li key={g.jid}><label><input type="checkbox" checked={picked.has(g.jid)} onChange={() => toggle(g.jid)} /><span><b>{g.name}</b><small className="panel-copy">{g.size == null ? "Not on the phone anymore" : `${g.size} members`}</small></span></label></li>)}</ul>}
    {msg.error && <p className="error" role="alert">{msg.error}</p>}{msg.ok && <p className="success-note" role="status">{msg.ok}</p>}
    {view.groups.length > 0 && <button type="button" disabled={busy} onClick={save}>{busy ? "Saving…" : `Save (${picked.size} linked)`}</button>}
  </div>;
}
function CreateClub({ onCreated }) {
  const [f, setF] = useState({ name: "", adminPhone: "", adminName: "" });
  const [busy, setBusy] = useState(false), [msg, setMsg] = useState({});
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  async function submit(e) {
    e.preventDefault(); setBusy(true); setMsg({});
    try {
      const r = await fetch("/api/platform/clubs", { method: "POST", credentials: "include", headers: { "Content-Type": "application/json" }, body: JSON.stringify(f) });
      const d = await r.json(); if (!r.ok) throw new Error(d.error || "Could not create the club.");
      setMsg({ ok: `${d.club.name} created. ${d.owner.name} is its admin and signs in with their mobile number.` });
      setF({ name: "", adminPhone: "", adminName: "" }); onCreated();
    } catch (err) { setMsg({ error: err.message }); } finally { setBusy(false); }
  }
  return <section className="workspace platform-section"><h2>Create a club</h2><p className="panel-copy">Only you can create clubs. Name its admin by mobile number; leave it empty to be the admin yourself.</p>
    <form className="stack-form" onSubmit={submit}>
      <label htmlFor="cc-name">Club name</label><input id="cc-name" value={f.name} onChange={set("name")} minLength={2} maxLength={80} required />
      <label htmlFor="cc-phone">Admin's mobile number <span className="optional">(optional)</span></label><input id="cc-phone" type="tel" value={f.adminPhone} onChange={set("adminPhone")} placeholder="+91 98765 43210" />
      <label htmlFor="cc-admin">Admin's name <span className="optional">(if they're new to PaceUp)</span></label><input id="cc-admin" value={f.adminName} onChange={set("adminName")} maxLength={80} />
      {msg.error && <p className="error" role="alert">{msg.error}</p>}{msg.ok && <p className="success-note" role="status">{msg.ok}</p>}
      <button type="submit" disabled={busy}>{busy ? "Creating…" : "Create club"}</button>
    </form></section>;
}
