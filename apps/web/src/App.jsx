import { useEffect, useState } from "react";

const emptyForm = { name: "", email: "", password: "", clubName: "" };

export default function App() {
  const [user, setUser] = useState(null);
  const [clubs, setClubs] = useState([]);
  const [mode, setMode] = useState("register");
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [selectedClub, setSelectedClub] = useState("");
  const [clubName, setClubName] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("admin");
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [inviteLink, setInviteLink] = useState("");
  const [notice, setNotice] = useState("");
  const [inviteToken, setInviteToken] = useState("");

  async function loadSession() {
    try {
      const response = await fetch("/api/auth/me", { credentials: "include" });
      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        setClubs(data.clubs);
        if (data.clubs.length) setSelectedClub(data.clubs[0].id);
      }
    } catch {
      setError("Can't reach PaceUp. Check that the development server is running.");
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    const match = window.location.pathname.match(/^\/invite\/([^/]+)$/);
    if (match) setInviteToken(match[1]);
    loadSession();
  }, []);

  async function loadClubData(clubId) {
    if (!clubId) return;
    const [membersResponse, invitesResponse] = await Promise.all([
      fetch(`/api/clubs/${clubId}/members`, { credentials: "include" }),
      fetch(`/api/clubs/${clubId}/invitations`, { credentials: "include" })
    ]);
    if (membersResponse.ok) setMembers((await membersResponse.json()).members);
    if (invitesResponse.ok) setInvitations((await invitesResponse.json()).invitations);
    const club = clubs.find((item) => item.id === clubId);
    if (club) setClubName(club.name);
  }
  useEffect(() => { if (user && selectedClub) loadClubData(selectedClub); }, [user, selectedClub]);

  function update(field, value) { setForm((current) => ({ ...current, [field]: value })); }

  async function handleSubmit(event) {
    event.preventDefault(); setError(""); setSaving(true);
    try {
      const response = await fetch(mode === "register" ? "/api/auth/register" : "/api/auth/login", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify(form)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Something went wrong.");
      setUser(data.user); setClubs(data.clubs); setSelectedClub(data.clubs[0]?.id || ""); setForm(emptyForm);
    } catch (err) { setError(err.message); }
    finally { setSaving(false); }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setUser(null); setClubs([]); setMembers([]); setInvitations([]); setMode("login");
  }

  async function saveClub(event) {
    event.preventDefault(); setNotice(""); setError("");
    try {
      const response = await fetch(`/api/clubs/${selectedClub}`, {
        method: "PATCH", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: clubName })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not update club.");
      setClubs((current) => current.map((club) => club.id === selectedClub ? { ...club, ...data.club } : club));
      setNotice("Club details saved.");
    } catch (err) { setError(err.message); }
  }

  async function sendInvite(event) {
    event.preventDefault(); setNotice(""); setError(""); setInviteLink("");
    try {
      const response = await fetch(`/api/clubs/${selectedClub}/invitations`, {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: inviteEmail, role: inviteRole })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create invitation.");
      setInviteLink(data.invitation.inviteUrl);
      setInviteEmail("");
      await loadClubData(selectedClub);
    } catch (err) { setError(err.message); }
  }

  async function acceptInvite() {
    setError(""); setNotice("");
    try {
      const response = await fetch("/api/invitations/accept", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token: inviteToken })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not accept invitation.");
      window.history.replaceState({}, "", "/");
      setInviteToken(""); setClubs(data.clubs); setSelectedClub(data.clubs.at(-1)?.id || "");
      setNotice("Invitation accepted. The club is now in your list.");
    } catch (err) { setError(err.message); }
  }

  if (loading) return <main className="page-shell"><p className="empty-state">Loading PaceUp…</p></main>;

  return (
    <main className="page-shell">
      <nav className="topbar">
        <a className="wordmark" href="/" aria-label="PaceUp home"><span className="mark">P</span> paceup</a>
        <span className="topbar-note">COMMUNITY, IN MOTION</span>
      </nav>
      {!user ? (
        <section className="auth-layout">
          <div className="hero">
            <p className="eyebrow">YOUR PEOPLE. YOUR PACE. YOUR CLUB.</p>
            <h1>Good things happen<br /><span>when we move together.</span></h1>
            <p className="hero-copy">A simple home for sports communities to organise activities, bring members together and make showing up easier.</p>
          </div>
          <section className="workspace auth-card">
            <div className="section-heading"><div><p className="eyebrow">{mode === "register" ? "GET STARTED" : "WELCOME BACK"}</p><h2>{mode === "register" ? "Create your account" : "Sign in"}</h2></div></div>
            <form className="create-form" onSubmit={handleSubmit}>
              {mode === "register" && <><label htmlFor="name">Your name</label><input id="name" value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Full name" minLength={2} maxLength={80} autoComplete="name" required /><label htmlFor="clubName">Club or community name</label><input id="clubName" value={form.clubName} onChange={(e) => update("clubName", e.target.value)} placeholder="e.g. Sunday Trail Crew" minLength={2} maxLength={80} required /></>}
              <label htmlFor="email">Email address</label><input id="email" type="email" value={form.email} onChange={(e) => update("email", e.target.value)} placeholder="you@example.com" autoComplete="email" required />
              <label htmlFor="password">Password</label><input id="password" type="password" value={form.password} onChange={(e) => update("password", e.target.value)} placeholder={mode === "register" ? "At least 10 characters" : "Your password"} minLength={mode === "register" ? 10 : undefined} maxLength={128} autoComplete={mode === "register" ? "new-password" : "current-password"} required />
              {error && <p className="error" role="alert">{error}</p>}
              <button className="primary-button" type="submit" disabled={saving}>{saving ? "Please wait…" : mode === "register" ? "Create account and club" : "Sign in"}</button>
            </form>
            <p className="auth-switch">{mode === "register" ? "Already have an account?" : "New to PaceUp?"} <button type="button" className="text-button" onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(""); }}>{mode === "register" ? "Sign in" : "Create an account"}</button></p>
          </section>
        </section>
      ) : (
        <section className="dashboard">
          <div className="dashboard-head">
            <div><p className="eyebrow">YOUR PACEUP</p><h2>Welcome, {user.name.split(" ")[0]}</h2><p className="hero-copy">{user.email}</p></div>
            <button type="button" className="secondary-button" onClick={logout}>Sign out</button>
          </div>
          {inviteToken && <section className="workspace invite-accept"><h3>You've been invited to a PaceUp club</h3><p>Accept the invitation using the account signed in above.</p><button onClick={acceptInvite}>Accept invitation</button></section>}
          <section className="workspace">
            <div className="section-heading"><div><p className="eyebrow">CLUB ADMINISTRATION</p><h2>Your clubs</h2></div><span className="count">{clubs.length} {clubs.length === 1 ? "CLUB" : "CLUBS"}</span></div>
            {clubs.length > 1 && <label className="field-label" htmlFor="club-select">Choose a club</label>}
            {clubs.length > 1 && <select id="club-select" value={selectedClub} onChange={(e) => setSelectedClub(e.target.value)}>{clubs.map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select>}
            {clubs.length > 0 && <>
              <form className="inline-form" onSubmit={saveClub}><div className="field-grow"><label htmlFor="club-name">Club name</label><input id="club-name" value={clubName} onChange={(e) => setClubName(e.target.value)} maxLength={80} minLength={2} required /></div><button type="submit">Save changes</button></form>
              <div className="admin-grid">
                <section className="admin-panel"><h3>Invite someone</h3><p className="panel-copy">Create a secure invitation link for a club admin or member.</p><form className="stack-form" onSubmit={sendInvite}><label htmlFor="invite-email">Email address</label><input id="invite-email" type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="person@example.com" required /><label htmlFor="invite-role">Role</label><select id="invite-role" value={inviteRole} onChange={(e) => setInviteRole(e.target.value)}><option value="admin">Club admin</option><option value="member">Member</option></select><button type="submit">Create invite link</button></form>{inviteLink && <div className="invite-result"><p>Invitation created. Copy and share this link:</p><input readOnly value={inviteLink} onFocus={(e) => e.target.select()} /><button type="button" className="secondary-button" onClick={() => navigator.clipboard?.writeText(inviteLink)}>Copy link</button><small>Valid for 7 days. Email delivery isn't connected yet.</small></div>}</section>
                <section className="admin-panel"><h3>Members <span className="count">{members.length}</span></h3>{members.map((member) => <div className="member-row" key={member.id}><div className="member-avatar">{member.name.slice(0,1).toUpperCase()}</div><div className="member-info"><strong>{member.name}</strong><small>{member.email}</small></div><span className="role-tag">{member.role}</span></div>)}{invitations.filter((invite) => !invite.accepted_at).length > 0 && <><h4>Pending invitations</h4>{invitations.filter((invite) => !invite.accepted_at).map((invite) => <div className="pending-row" key={invite.id}>{invite.email}<span>{invite.role}</span></div>)}</>}</section>
              </div>
            </>}
          </section>
          {error && <p className="error" role="alert">{error}</p>}
          {notice && <p className="success-note" role="status">{notice}</p>}
        </section>
      )}
      <footer><span>PACEUP</span><span>Built for every kind of active community.</span></footer>
    </main>
  );
}
