import { useEffect, useState } from "react";

export default function App() {
  const [clubs, setClubs] = useState([]);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function loadClubs() {
    try {
      const response = await fetch("/api/clubs");
      if (!response.ok) throw new Error("Could not load clubs.");
      const data = await response.json();
      setClubs(data.clubs);
    } catch {
      setError("Can't reach the PaceUp API. Make sure the development server is running.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadClubs();
  }, []);

  async function handleSubmit(event) {
    event.preventDefault();
    setError("");
    setSaving(true);

    try {
      const response = await fetch("/api/clubs", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Could not create club.");
      setClubs((current) => [data.club, ...current]);
      setName("");
    } catch (err) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="page-shell">
      <nav className="topbar">
        <a className="wordmark" href="/" aria-label="PaceUp home">
          <span className="mark">P</span> paceup
        </a>
        <span className="topbar-note">COMMUNITY, IN MOTION</span>
      </nav>

      <section className="hero">
        <p className="eyebrow">YOUR PEOPLE. YOUR PACE. YOUR CLUB.</p>
        <h1>Good things happen<br /><span>when we move together.</span></h1>
        <p className="hero-copy">
          A simple home for sports communities to organise activities,
          bring members together and make showing up easier.
        </p>
      </section>

      <section className="workspace" aria-labelledby="clubs-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">GET STARTED</p>
            <h2 id="clubs-heading">Your clubs</h2>
          </div>
          <span className="count">{clubs.length} {clubs.length === 1 ? "CLUB" : "CLUBS"}</span>
        </div>

        <form className="create-form" onSubmit={handleSubmit}>
          <label htmlFor="club-name">Create your first club</label>
          <div className="form-row">
            <input
              id="club-name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. Sunday Trail Crew"
              minLength={2}
              maxLength={80}
              required
            />
            <button type="submit" disabled={saving || name.trim().length < 2}>
              {saving ? "Creating…" : "Create club"}
            </button>
          </div>
          <p className="hint">Start with a name. You can configure your club next.</p>
        </form>

        {error && <p className="error" role="alert">{error}</p>}

        <div className="club-list">
          {loading ? (
            <p className="empty-state">Loading your clubs…</p>
          ) : clubs.length === 0 ? (
            <p className="empty-state">Your first club will show up here.</p>
          ) : clubs.map((club) => (
            <article className="club-card" key={club.id}>
              <div className="club-avatar">{club.name.slice(0, 1).toUpperCase()}</div>
              <div className="club-info">
                <h3>{club.name}</h3>
                <p>paceup/{club.slug}</p>
              </div>
              <span className="club-status">CREATED</span>
            </article>
          ))}
        </div>
      </section>

      <footer>
        <span>PACEUP</span>
        <span>Built for every kind of active community.</span>
      </footer>
    </main>
  );
}
