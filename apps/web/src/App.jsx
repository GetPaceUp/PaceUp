import SuperAdmin from "./SuperAdmin.jsx";
import { ClubRides, RidePage } from "./Rides.jsx";
import { WhatsAppPanel, LinkStrip } from "./WhatsApp.jsx";
import { RosterPanel, MembersCard } from "./Roster.jsx";
import { PhoneAuth, AddPhone, ForgotPassword, phoneText } from "./Auth.jsx";
import { PeoplePanel } from "./People.jsx";
import { ResetPage } from "./PasswordReset.jsx";
import { StartPage, SignupPage } from "./Start.jsx";
import AlertsCard from "./AlertsCard.jsx";
import { useEffect, useState } from "react";

const emptyForm = { name: "", email: "", password: "" };

export default function App() {
  if (window.location.pathname === "/superadmin") return <SuperAdmin />;
  const rideMatch = window.location.pathname.match(/^\/r\/([A-Za-z0-9_-]{6,16})$/);
  if (rideMatch) return <RidePage code={rideMatch[1]} />;
  const resetMatch = window.location.pathname.match(/^\/reset\/([A-Za-z0-9_-]{20,200})$/);
  if (resetMatch) return <ResetPage token={resetMatch[1]} />;
  const startMatch = window.location.pathname.match(/^\/start\/([A-Za-z0-9_-]{20,100})$/);
  if (startMatch) return <StartPage token={startMatch[1]} />;
  if (/^\/start\/?$/.test(window.location.pathname)) return <SignupPage />;
  const [user, setUser] = useState(null);
  const [clubs, setClubs] = useState([]);
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState(emptyForm);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [selectedClub, setSelectedClub] = useState("");
  // Only the PaceUp Admin gets a way into the PaceUp Admin console from the dashboard.
  const [isSuper, setIsSuper] = useState(false);
  useEffect(() => {
    if (!user?.id) { setIsSuper(false); return; }
    fetch("/api/auth/me", { credentials: "include" }).then((r) => (r.ok ? r.json() : null)).then((d) => setIsSuper(Boolean(d?.user?.super_admin))).catch(() => {});
  }, [user?.id]);
  // The member list has its own page (#members) so the dashboard stays short.
  const [page, setPage] = useState(() => (window.location.hash === "#members" ? "members" : "home"));
  useEffect(() => {
    const onHash = () => { setPage(window.location.hash === "#members" ? "members" : "home"); window.scrollTo(0, 0); };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const openPage = (name) => { window.location.hash = name === "members" ? "members" : ""; };
  const [clubName, setClubName] = useState("");
  const [editingName, setEditingName] = useState(false);
  const [members, setMembers] = useState([]);
  const [invitations, setInvitations] = useState([]);
  const [notice, setNotice] = useState("");
  const [inviteToken, setInviteToken] = useState("");
  const [forgot, setForgot] = useState(false);
  const [useEmail, setUseEmail] = useState(false);

  async function loadSession() {
    try {
      const response = await fetch("/api/auth/me", { credentials: "include" });
      if (response.ok) {
        if (returnToNext()) return;
        const data = await response.json();
        setUser(data.user);
        setClubs(data.clubs);
        // Just set up a club at /start: open that club.
        const wanted = new URLSearchParams(window.location.search).get("club");
        if (data.clubs.length) setSelectedClub(data.clubs.find((c) => c.id === wanted)?.id || data.clubs[0].id);
      }
    } catch {
      setError("Can't reach PaceUp. Check that the development server is running.");
    } finally {
      setLoading(false);
    }
  }
  // After signing in from a ride link, go back to that ride.
  function returnToNext() {
    const next = new URLSearchParams(window.location.search).get("next");
    if (next && /^\/r\/[A-Za-z0-9_-]{6,16}(\?absent)?$/.test(next)) { window.location.href = next; return true; }
    // Signed in from the club set-up page: back to it.
    if (next && /^\/start(\?club=[A-Za-z0-9._~%-]{1,200})?$/.test(next)) { window.location.href = next; return true; }
    return false;
  }
  useEffect(() => {
    if (new URLSearchParams(window.location.search).get("next")) setMode("login");
    const match = window.location.pathname.match(/^\/invite\/([^/]+)$/);
    if (match) setInviteToken(match[1]);
    loadSession();
  }, []);

  async function loadClubData(clubId) {
    if (!clubId) return;
    const selected = clubs.find((item) => item.id === clubId);
    if (!selected || !["owner", "admin"].includes(selected.role)) { setMembers([]); setInvitations([]); return; }
    const [membersResponse, invitesResponse] = await Promise.all([
      fetch(`/api/clubs/${clubId}/members`, { credentials: "include" }),
      fetch(`/api/clubs/${clubId}/invitations`, { credentials: "include" })
    ]);
    if (membersResponse.ok) setMembers((await membersResponse.json()).members);
    if (invitesResponse.ok) setInvitations((await invitesResponse.json()).invitations);
    const club = clubs.find((item) => item.id === clubId);
    if (club) setClubName(club.name);
    setEditingName(false);
  }
  useEffect(() => { if (user && selectedClub) loadClubData(selectedClub); }, [user, selectedClub]);

  function update(field, value) { setForm((current) => ({ ...current, [field]: value })); }

  async function handleSubmit(event) {
    event.preventDefault(); setError(""); setSaving(true);
    try {
      const response = await fetch(mode === "register" ? "/api/auth/register" : "/api/auth/login", {
        method: "POST", credentials: "include",
        headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, ...(mode === "register" && inviteToken ? { inviteToken } : {}) })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Something went wrong.");
      if (returnToNext()) return;
      setUser(data.user); setClubs(data.clubs); setSelectedClub(data.clubs[0]?.id || ""); setForm(emptyForm);
      if (mode === "register" && inviteToken) {
        // Registering through an invitation joins the club in the same step.
        window.history.replaceState({}, "", "/"); setInviteToken(""); setNotice("Account created and invitation accepted.");
      }
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
      setNotice("Club name saved."); setEditingName(false);
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
            <div className="section-heading"><div><p className="eyebrow">{inviteToken ? "YOU HAVE AN INVITATION" : mode === "register" ? "GET STARTED" : "WELCOME BACK"}</p><h2>{mode === "register" ? "Create your account" : "Sign in"}</h2></div></div>
            {!useEmail ? <>
              <PhoneAuth key={mode} mode={mode} inviteToken={inviteToken} onDone={(data) => {
                if (returnToNext()) return;
                setUser(data.user); setClubs(data.clubs); setSelectedClub(data.clubs[0]?.id || "");
                if (inviteToken) { window.history.replaceState({}, "", "/"); setInviteToken(""); setNotice("Welcome! You've joined the club."); }
              }} />
              <p className="auth-switch"><button type="button" className="text-button" onClick={() => { setUseEmail(true); setError(""); }}>Use email and password instead</button></p>
            </> : mode === "login" && forgot ? <ForgotPassword onBack={() => setForgot(false)} onDone={(data) => {
              if (returnToNext()) return;
              setUser(data.user); setClubs(data.clubs); setSelectedClub(data.clubs[0]?.id || ""); setForgot(false); setNotice("Password updated. You're signed in.");
            }} /> : <>
            <form className="create-form" onSubmit={handleSubmit}>
              {mode === "register" && <><label htmlFor="name">Your name</label><input id="name" value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Full name" minLength={2} maxLength={80} autoComplete="name" required /></>}
              <label htmlFor="email">Email address</label><input id="email" type="email" value={form.email} onChange={(e) => update("email", e.target.value)} placeholder="you@example.com" autoComplete="email" required />
              <label htmlFor="password">Password</label><input id="password" type="password" value={form.password} onChange={(e) => update("password", e.target.value)} placeholder={mode === "register" ? "At least 10 characters" : "Your password"} minLength={mode === "register" ? 10 : undefined} maxLength={128} autoComplete={mode === "register" ? "new-password" : "current-password"} required />
              {error && <p className="error" role="alert">{error}</p>}
              <button className="primary-button" type="submit" disabled={saving}>{saving ? "Please wait…" : mode === "register" ? "Create account" : "Sign in"}</button>
            </form>
            <p className="auth-switch"><button type="button" className="text-button" onClick={() => setUseEmail(false)}>Use mobile number instead</button></p>
            {mode === "login" && !forgot && <p className="auth-switch"><button type="button" className="text-button" onClick={() => setForgot(true)}>Forgot password?</button></p>}
            </>}
            <p className="auth-switch">{mode === "register" ? "Already have an account?" : "New to PaceUp?"} <button type="button" className="text-button" onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(""); }}>{mode === "register" ? "Sign in" : "Create an account"}</button></p>
            <p className="endorse-line">PaceUp by Feet and Pedals</p>
          </section>
        </section>
      ) : (
        <section className="dashboard">
          <div className="dashboard-head">
            <div><p className="eyebrow">YOUR PACEUP</p><h2>Welcome, {user.name.split(" ")[0]}</h2><p className="hero-copy">{user.phone ? phoneText(user.phone) : user.email}</p>{!user.phone && <AddPhone onAdded={(u) => setUser(u)} />}</div>
            <div className="head-actions">{isSuper && <a className="secondary-button" href="/superadmin">PaceUp Admin</a>}<button type="button" className="secondary-button" onClick={logout}>Sign out</button></div>
          </div>
          {(isSuper || clubs.some((club) => ["owner", "admin"].includes(club.role))) && <AlertsCard key={user.id} isSuper={isSuper} />}
          {inviteToken && <section className="workspace invite-accept"><h3>You've been invited to a PaceUp club</h3><p>Accept the invitation using the account signed in above.</p><button onClick={acceptInvite}>Accept invitation</button></section>}
          <section className="workspace">
            <div className="section-heading"><div><p className="eyebrow">CLUB ADMINISTRATION</p><h2>Your clubs</h2></div><span className="count">{clubs.length} {clubs.length === 1 ? "CLUB" : "CLUBS"}</span></div>
            {clubs.length > 1 && <label className="field-label" htmlFor="club-select">Choose a club</label>}
            {clubs.length > 1 && <select id="club-select" value={selectedClub} onChange={(e) => setSelectedClub(e.target.value)}>{clubs.map((club) => <option key={club.id} value={club.id}>{club.name}</option>)}</select>}
            {clubs.length === 0 && <p className="panel-copy">You're not in a club yet. Ask your club admin for an invite link. If your number is on a club's member list, sign in with it and you'll join automatically.</p>}
            {clubs.length > 0 && !["owner", "admin"].includes(clubs.find((club) => club.id === selectedClub)?.role) && <p className="panel-copy">You are a member of this club. Club administration is available to its admins.</p>}
            {clubs.length > 0 && ["owner", "admin"].includes(clubs.find((club) => club.id === selectedClub)?.role) && <>
              {editingName && (isSuper || clubs.find((club) => club.id === selectedClub)?.role === "owner")
                ? <form className="inline-form" onSubmit={saveClub}><div className="field-grow"><label htmlFor="club-name">Club name</label><input id="club-name" value={clubName} onChange={(e) => setClubName(e.target.value)} maxLength={80} minLength={2} required autoFocus /></div><button type="submit">Save</button><button type="button" className="secondary-button" onClick={() => { setClubName(clubs.find((club) => club.id === selectedClub)?.name || ""); setEditingName(false); setError(""); }}>Cancel</button></form>
                : <div className="inline-form club-name-view"><div className="field-grow"><span className="field-label">Club name</span><strong className="club-name-text">{clubs.find((club) => club.id === selectedClub)?.name}</strong></div>{(isSuper || clubs.find((club) => club.id === selectedClub)?.role === "owner") && <button type="button" className="secondary-button" onClick={() => { setNotice(""); setEditingName(true); }}>Edit name</button>}</div>}
              {page === "members" && <RosterPanel clubId={selectedClub} onBack={() => openPage("home")} />}
            </>}
          </section>
          {error && <p className="error" role="alert">{error}</p>}
          {notice && <p className="success-note" role="status">{notice}</p>}
          {/* Activities (Create activity + Most regular) come first: that's what admins open PaceUp for. Club admin tools follow. */}
          {page !== "members" && ["owner", "admin"].includes(clubs.find((club) => club.id === selectedClub)?.role) && <LinkStrip clubId={selectedClub} />}
          {page !== "members" && clubs.find((club) => club.id === selectedClub) && <ClubRides club={clubs.find((club) => club.id === selectedClub)} />}
          {page !== "members" && ["owner", "admin"].includes(clubs.find((club) => club.id === selectedClub)?.role) && (
            <section className="workspace club-tools">
              <div className="admin-grid">
                <PeoplePanel clubId={selectedClub} members={members} me={user.id} isOwner={isSuper || clubs.find((club) => club.id === selectedClub)?.role === "owner"} onChange={() => loadClubData(selectedClub)} />
              </div>
              <MembersCard clubId={selectedClub} onOpen={() => openPage("members")} />
              <WhatsAppPanel clubId={selectedClub} />
            </section>
          )}
        </section>
      )}
      <footer><span>PACEUP <em className="endorse">by Feet and Pedals</em></span><span>Built for every kind of active community.</span></footer>
    </main>
  );
}
