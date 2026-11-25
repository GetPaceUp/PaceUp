import { useEffect, useState } from "react";

/**
 * First-time guide for club owners and admins: a "Getting started" card, one-line tips shown once,
 * and an "It's live" screen after Publish. Also the PaceUp Admin's "Getting started" funnel.
 */

/** A dark one-line tip with "Got it", pointing at what is above it. */
export function Tip({ text, onDismiss }) {
  return <div className="guide-tip" role="note"><span>{text}</span><button type="button" className="guide-tip-ok" onClick={onDismiss}>Got it</button></div>;
}

/** The tip for the next thing to fill in on a first activity, if it belongs in this slot. */
export function formTip(form, slot) {
  const next = !form.title?.trim() ? "title" : !form.date || !form.time ? "when" : !form.meeting_point?.trim() ? "meet" : "done";
  const text = {
    title: "Name it the way your group says it.",
    when: "When should people show up?",
    meet: "Use the name everyone knows. Map link is optional.",
    done: "All set. Tap Publish 👇"
  }[next];
  const where = { title: "title", when: "when", meet: "meet", done: "meet" }[next];
  return where === slot ? text : null;
}

/** Top of the dashboard until someone joins the person's first activity. */
export function GettingStarted({ guide, onCreate, tipOn, onDismissTip }) {
  const step = (done, now, label) => <li className={done ? "gs-done" : now ? "gs-now" : ""}><i aria-hidden="true">{done ? "✓" : ""}</i><span>{label}</span></li>;
  return <div className="guide-card">
    <h3>Welcome{guide.first_name ? `, ${guide.first_name}` : ""} 👋</h3>
    <ol className="gs-steps">
      {step(true, false, "Signed in")}
      {step(guide.published, !guide.published, "Create your first activity")}
      {step(false, guide.published, "See who's going")}
    </ol>
    {guide.published
      ? <>
          <p className="panel-copy">Names show up as people tap I'M IN.</p>
          {guide.latest_code && <a className="button-link secondary-button" href={`/r/${guide.latest_code}`}>See your activity</a>}
        </>
      : <>
          <button type="button" onClick={onCreate}>Create activity</button>
          {tipOn && <Tip text="Takes a minute. Just 4 things." onDismiss={onDismissTip} />}
        </>}
  </div>;
}

/** After Publish: where it went. Posting itself when WhatsApp is linked, otherwise one big Share. */
export function LiveNow({ ride, whatsapp, share, onDone }) {
  const [shareOpen, setShareOpen] = useState(false);
  const posting = whatsapp?.status === "connected" && whatsapp.group && whatsapp.settings?.post_new_ride !== false;
  const group = posting ? (whatsapp.groups?.find((g) => g.jid === ride.wa_group_jid)?.name || whatsapp.group.name) : null;
  return <div className="live-now" role="status">
    <p className="live-emoji" aria-hidden="true">🎉</p>
    <h3>It's live!</h3>
    {posting && <p className="live-posted">Posting in {group} ✓</p>}
    <p className="panel-copy">Names show up as people tap I'M IN.</p>
    <a className="button-link secondary-button" href={`/r/${ride.code}`}>See the activity</a>
    {posting
      ? (shareOpen ? share : <button type="button" className="text-button" onClick={() => setShareOpen(true)}>Share somewhere else</button>)
      : <><p className="panel-copy live-share-head">Share it in your group:</p>{share}</>}
    <button type="button" className="text-button" onClick={onDone}>Done</button>
  </div>;
}

// ---------------------------------------------------------------- PaceUp Admin

const TABS = [["admin", "Owners & admins"], ["owner", "Club sign-ups"], ["member", "Members"]];

function helpLink(s) {
  const first = String(s.name || "").split(" ")[0];
  const text = `Hi ${first}! Need a hand posting your first activity for ${s.club_name}? Happy to help 🙂\n${window.location.origin}\n– Amit, PaceUp`;
  return `https://wa.me/${s.phone}?text=${encodeURIComponent(text)}`;
}

/** Where first-timers drop off, and who's stuck (with a ready-made WhatsApp message you send yourself). */
export function GettingStartedFunnel() {
  const [data, setData] = useState(null);
  const [tab, setTab] = useState("admin");
  const [error, setError] = useState("");
  useEffect(() => {
    fetch("/api/platform/getting-started", { credentials: "include" })
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error("Couldn't load."))))
      .then(setData).catch((e) => setError(e.message));
  }, []);
  if (error) return <section className="workspace platform-section"><h2>Getting started</h2><p className="error">{error}</p></section>;
  if (!data) return null;
  const steps = data[tab];
  const top = Math.max(1, steps[0]?.n || 0);
  return <section className="workspace platform-section gs-funnel" id="getting-started">
    <div className="gs-head"><h2>Getting started</h2><span className="panel-copy">Last {data.days} days</span></div>
    <div className="tabs" role="tablist">
      {TABS.map(([key, label]) => <button key={key} type="button" role="tab" aria-selected={tab === key} className={tab === key ? "tab on" : "tab"} onClick={() => setTab(key)}>{label}</button>)}
    </div>
    <div className="gs-bars">
      {steps.map((s) => <div className="gs-bar" key={s.step}><span>{s.step}</span><span className="gs-track"><i style={{ width: `${Math.round((s.n / top) * 100)}%` }} /></span><b>{s.n}</b></div>)}
    </div>
    {tab === "owner" && <p className="panel-copy">Stuck at WhatsApp? See <a href="#signups">New sign-ups</a> for Help.</p>}
    {tab === "admin" && (data.stuck.length
      ? <div className="gs-stuck">
          <h3>Stuck</h3>
          {data.stuck.map((s, i) => <div className="gs-stuck-row" key={i}>
            <span><b>{s.name}</b> · {s.club_name}<small>{s.role === "owner" ? "Owner" : "Admin"} · {s.where} · {s.days}d</small></span>
            {s.phone && <a className="button-link wa-button small-button" href={helpLink(s)} target="_blank" rel="noopener noreferrer">Help</a>}
          </div>)}
        </div>
      : <p className="panel-copy">Nobody stuck right now 🙌</p>)}
  </section>;
}
