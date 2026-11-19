# PaceUp

**PaceUp** is an open-source, sport-agnostic community platform for endurance sports clubs.

It helps clubs organise activities, bring members together and make participation simple — starting with club administration and a lightweight activity RSVP workflow.

## Current status

The first application foundation is underway:

- Fastify API and React + Vite web interface.
- SQLite-backed accounts, clubs and club memberships.
- Email/password registration and sign-in with HTTP-only session cookies.
- Club-scoped administration, member listing and invitation links.
- Local development setup using npm workspaces.

This is an early development build. The API includes an automated integration test for account registration, club-scoped administration, invitation acceptance and permission boundaries. Email delivery is not connected; club invitations are shared as one-time links.

## Run locally

Requirements: Node.js 20 or newer and npm.

1. Clone this repository.
2. Copy `.env.example` to `.env` in the repository root.
3. Install dependencies with `npm ci` (uses the committed lockfile, the same install CI and servers use).
4. Start the API and web app with `npm run dev`.
5. Open http://localhost:5173.

The API runs on http://127.0.0.1:3001. Its health endpoint is http://127.0.0.1:3001/health. Run API tests with `npm test --workspace @paceup/api` and build the web app with `npm run build`.

SQLite data is stored in `data/paceup.sqlite` by default.

### Database migrations

Schema changes live in `apps/api/src/migrations.js` as numbered, forward-only steps. The API applies any pending ones automatically when it starts. If the database already has data, a snapshot is written beside it first (`<db>.pre-migration-<timestamp>.bak`), so an upgrade can be undone by stopping the API and restoring that file. `npm run migrate --workspace @paceup/api` applies migrations without starting the server and lists what has been applied. Never edit a shipped migration; add a new one.

## Project principles

- Sport-agnostic and community-first.
- Independent club data and administration.
- Low-friction member participation.
- RSVP persistence independent of notification delivery.
- Self-hostable and open source.

## Documentation

- [Product definition](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Licence

MIT. See [LICENSE](LICENSE).

### WhatsApp posting

Each club links its own dedicated WhatsApp number from the club admin page (QR code, like WhatsApp Web) and picks one group. New rides, the updated rider list after RSVPs, and changes or cancellations are posted to that group.

- Ride and RSVP changes are written to an `outbox` table in the same transaction; the separate worker (`npm run worker --workspace @paceup/api`, systemd unit in `deploy/`) delivers them. RSVPs never depend on WhatsApp being up.
- Bursts coalesce: at most one rider-list post per ride every 2 minutes, a few seconds of jitter and a typing pause per post, and at most 20 posts per club number per hour. Nothing over a limit is dropped; it waits.
- Everything WhatsApp-specific is behind `apps/api/src/whatsapp/adapter.js` (Baileys today), so the transport can be replaced without touching rides or RSVPs.
