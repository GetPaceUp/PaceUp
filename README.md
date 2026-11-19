# PaceUp

**PaceUp** is an open-source, sport-agnostic community platform for endurance sports clubs.

It helps clubs organise activities, bring members together and make participation simple — starting with a lightweight club directory and activity RSVP workflow.

## Current status

The first application slice is underway:

- Fastify API with a health endpoint.
- SQLite-backed club creation and listing.
- React + Vite web interface.
- Local development setup using npm workspaces.

This is an early development build. Club creation is currently a local prototype flow; authentication, authorisation and production deployment hardening are not implemented yet.

## Run locally

Requirements: Node.js 20 or newer and npm.

1. Clone this repository.
2. Copy `.env.example` to `.env` in the repository root.
3. Install dependencies:

   ```bash
   npm install
   ```

4. Start the API and web app:

   ```bash
   npm run dev
   ```

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
