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

This is an early development build. Automated tests are being added as the API is separated into an injectable application for repeatable verification. Email delivery is not connected; club invitations are shared as one-time links.

## Run locally

Requirements: Node.js 20 or newer and npm.

1. Clone this repository.
2. Copy `.env.example` to `.env` in the repository root.
3. Install dependencies with `npm install`.
4. Start the API and web app with `npm run dev`.
5. Open http://localhost:5173.

The API runs on http://127.0.0.1:3001. Its health endpoint is http://127.0.0.1:3001/health.

SQLite data is stored in `data/paceup.sqlite` by default.

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
