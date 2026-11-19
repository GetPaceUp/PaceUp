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

  async function loadSession() {
    try {
      const response = await fetch("/api/auth/me", { credentials: "include" });
      if (response.ok) {
        const data = await response.json();
        setUser(data.user);
        setClubs(data.clubs);
      }
    } catch {
      setError("Can't reach PaceUp. Check that the development server is running.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadSession(); }, []);

  function update(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSaving(true);
    try {
      const response = await fetch(
        mode === "register" ? "/api/auth/register" : "/api/auth/login",
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(form)
        }
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Something went wrong.");
      setUser(data.user);
      setClubs(data.clubs);
      setForm(emptyForm);
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  async function logout() {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setUser(null);
    setClubs([]);
    setMode("login");
  }

  if (loading) {
    return <main className="page-shell"><p className="empty-state">Loading PaceUp…</p></main>;
  }

  return (
    <main className="page-shell">
      <nav className="topbar">
        <a className="wordmark" href="/" aria-label="PaceUp home">
          <span className="mark">P</span> paceup
        </a>
        <span className="topbar-note">COMMUNITY, IN MOTION</span>
      </nav>

      {!user ? (
        <section className="auth-layout">
          <div className="hero">
            <p className="eyebrow">YOUR PEOPLE. YOUR PACE. YOUR CLUB.</p>
            <h1>Good things happen<br /><span>when we move together.</span></h1>
            <p className="hero-copy">
              A simple home for sports communities to organise activities,
              bring members together and make showing up easier.
            </p>
          </div>

          <section className="workspace auth-card">
            <div className="section-heading">
              <div>
                <p className="eyebrow">{mode === "register" ? "GET STARTED" : "WELCOME BACK"}</p>
                <h2>{mode === "register" ? "Create your account" : "Sign in"}</h2>
              </div>
            </div>

            <form className="create-form" onSubmit={handleSubmit}>
              {mode === "register" && (
                <>
                  <label htmlFor="name">Your name</label>
                  <input id="name" value={form.name} onChange={(e) => update("name", e.target.value)} placeholder="Full name" minLength={2} maxLength={80} autoComplete="name" required />
                  <label htmlFor="clubName">Club or community name</label>
                  <input id="clubName" value={form.clubName} onChange={(e) => update("clubName", e.target.value)} placeholder="e.g. Sunday Trail Crew" minLength={2} maxLength={80} required />
                </>
              )}
              <label htmlFor="email">Email address</label>
              <input id="email" type="email" value={form.email} onChange={(e) => update("email", e.target.value)} placeholder="you@example.com" autoComplete="email" required />
              <label htmlFor="password">Password</label>
              <input id="password" type="password" value={form.password} onChange={(e) => update("password", e.target.value)} placeholder={mode === "register" ? "At least 10 characters" : "Your password"} minLength={mode === "register" ? 10 : undefined} maxLength={128} autoComplete={mode === "register" ? "new-password" : "current-password"} required />
              {error && <p className="error" role="alert">{error}</p>}
              <button className="primary-button" type="submit" disabled={saving}>
                {saving ? "Please wait…" : mode === "register" ? "Create account and club" : "Sign in"}
              </button>
            </form>
            <p className="auth-switch">
              {mode === "register" ? "Already have an account?" : "New to PaceUp?"}
              {" "}
              <button type="button" className="text-button" onClick={() => { setMode(mode === "register" ? "login" : "register"); setError(""); }}>
                {mode === "register" ? "Sign in" : "Create an account"}
              </button>
            </p>
          </section>
        </section>
      ) : (
        <section className="workspace dashboard">
          <div className="section-heading">
            <div>
              <p className="eyebrow">YOUR PACEUP</p>
              <h2>Welcome, {user.name.split(" ")[0]}</h2>
              <p className="hero-copy">You're signed in as {user.email}.</p>
            </div>
            <button type="button" className="secondary-button" onClick={logout}>Sign out</button>
          </div>
          <div className="section-heading clubs-heading">
            <h2>Your clubs</h2>
            <span className="count">{clubs.length} {clubs.length === 1 ? "CLUB" : "CLUBS"}</span>
          </div>
          <div className="club-list">
            {clubs.map((club) => (
              <article className="club-card" key={club.id}>
                <div className="club-avatar">{club.name.slice(0, 1).toUpperCase()}</div>
                <div className="club-info">
                  <h3>{club.name}</h3>
                  <p>paceup/{club.slug} · {club.role}</p>
                </div>
                <span className="club-status">ACTIVE</span>
              </article>
            ))}
          </div>
        </section>
      )}

      <footer>
        <span>PACEUP</span>
        <span>Built for every kind of active community.</span>
      </footer>
    </main>
  );
}
