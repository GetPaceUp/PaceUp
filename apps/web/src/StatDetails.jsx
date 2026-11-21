import { useEffect, useState } from "react";

const phone = (p) => (p ? `+${p.slice(0, p.length - 10)} ${p.slice(-10, -5)} ${p.slice(-5)}` : "");
const day = (t) => (t ? new Date(t.replace(" ", "T") + (t.endsWith("Z") ? "" : "Z")).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" }) : "");
const ROLE = { owner: "Owner", admin: "Admin", member: "Member" };
const TITLE = { clubs: "Clubs", users: "Users", memberships: "Memberships" };
const has = (q, ...parts) => !q || parts.filter(Boolean).join(" ").toLowerCase().includes(q);

/** The Clubs / Users / Memberships counts. Tap one to see who and what is behind the number. */
export default function PlatformStats({ data }) {
  const [open, setOpen] = useState("");
  return <>
    <div className="platform-stats">{Object.entries(data.counts).map(([k, v]) =>
      <button type="button" className="workspace stat-card" key={k} onClick={() => setOpen(k)} aria-label={`${v} ${k}. Show list`}>
        <span>{k.toUpperCase()}</span><strong>{v}</strong><em>View ›</em>
      </button>)}</div>
    {open && <StatSheet kind={open} data={data} onClose={() => setOpen("")} />}
  </>;
}

function StatSheet({ kind, data, onClose }) {
  const [q, setQ] = useState("");
  useEffect(() => {
    const esc = (e) => e.key === "Escape" && onClose();
    document.addEventListener("keydown", esc);
    const prev = document.body.style.overflow; document.body.style.overflow = "hidden";
    return () => { document.removeEventListener("keydown", esc); document.body.style.overflow = prev; };
  }, [onClose]);
  const s = q.trim().toLowerCase();
  const byUser = {}, byClub = {};
  for (const m of data.memberships || []) { (byUser[m.user_id] ||= []).push(m); (byClub[m.club_id] ||= []).push(m); }

  let body;
  if (kind === "clubs") {
    const rows = data.clubs.filter((c) => has(s, c.name, c.city, c.activity, c.owner_name));
    body = rows.map((c) => <div className="sheet-row" key={c.id}>
      <div className="sheet-row-top"><b>{c.name}</b>{c.wa_status === "connected" ? <span className="stage stage-live">WhatsApp ✓</span> : <span className="stage stage-off">No WhatsApp</span>}</div>
      <small>{[c.city, c.activity].filter(Boolean).join(" · ") || "No city yet"}</small>
      <small>{c.owner_name ? `Owner ${c.owner_name}` : "No owner yet"} · {c.member_count} member{c.member_count === 1 ? "" : "s"} · since {day(c.created_at)}</small>
    </div>);
  } else if (kind === "users") {
    const rows = data.users.filter((u) => has(s, u.name, u.phone, u.email, ...(byUser[u.id] || []).map((m) => m.club_name)));
    body = rows.map((u) => <div className="sheet-row" key={u.id}>
      <div className="sheet-row-top"><b>{u.name}</b>{u.platform_role === "super_admin" && <span className="stage stage-wait">PaceUp Admin</span>}</div>
      <small>{u.phone ? phone(u.phone) : u.email || "No number"}</small>
      <div className="sheet-chips">{(byUser[u.id] || []).length
        ? byUser[u.id].map((m) => <span className={`chip chip-${m.role}`} key={m.club_id}>{ROLE[m.role]} · {m.club_name}</span>)
        : <span className="chip chip-none">No club yet</span>}</div>
    </div>);
  } else {
    const clubs = data.clubs.filter((c) => byClub[c.id]).map((c) => ({ ...c, people: byClub[c.id].filter((m) => has(s, m.name, m.phone, c.name)) })).filter((c) => c.people.length);
    body = clubs.map((c) => <div className="sheet-group" key={c.id}>
      <h4>{c.name} <span>{c.people.length}</span></h4>
      {c.people.map((m) => <div className="sheet-row sheet-row-tight" key={m.user_id}>
        <div className="sheet-row-top"><b>{m.name}</b><span className={`chip chip-${m.role}`}>{ROLE[m.role]}</span></div>
        {m.phone && <small>{phone(m.phone)}</small>}
      </div>)}
    </div>);
  }

  return <div className="sheet-backdrop" onClick={onClose}>
    <div className="sheet" role="dialog" aria-modal="true" aria-label={TITLE[kind]} onClick={(e) => e.stopPropagation()}>
      <div className="sheet-head"><h3>{TITLE[kind]} <span>{data.counts[kind]}</span></h3><button type="button" className="sheet-close" onClick={onClose} aria-label="Close">×</button></div>
      <input className="sheet-search" type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={kind === "clubs" ? "Search club, city, owner" : "Search name, number, club"} />
      <div className="sheet-list">{body.length ? body : <p className="empty-state">Nothing matches.</p>}</div>
    </div>
  </div>;
}
