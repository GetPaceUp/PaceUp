# PaceUp

**PaceUp** is an open-source, sport-agnostic community platform for endurance sports clubs.

It helps clubs bring their people together around activities: publish events, collect RSVPs, coordinate participants, and build momentum before the start line.

## Product direction

PaceUp is being designed as a reusable platform that any club or community can operate. **Folks On Forks** is the initial pilot community, not the product's identity or boundary.

### Initial MVP

- Club and member foundations
- Create, publish, edit, and cancel activities
- RSVP flows with clear participation status and capacity handling
- Participant lists and event updates
- Activity-specific communication and notifications
- A configurable notification layer, with WhatsApp integration as an adapter rather than a hard-coded dependency
- A responsive experience that works well on mobile

### A social layer: Ride Buzz

When members RSVP, the community should feel the momentum. Ride Buzz is the product concept for timely group updates around participation, milestones, and event activity. Notifications should be useful and configurable, not noisy.

## Project status

This repository currently contains the product foundation and planning documents. Implementation choices will be recorded in the architecture documentation and accepted through focused changes.

## Documentation

- [Product definition](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## Principles

1. **Community first** — make it easier for people to show up together.
2. **Sport agnostic** — support cycling, running, triathlon, hiking, and other communities.
3. **Open and extensible** — integrations should be replaceable adapters.
4. **Mobile friendly** — the primary journeys must work smoothly on a phone.
5. **Respect attention** — notifications should be relevant, timely, and configurable.

## License

PaceUp is released under the [MIT License](LICENSE).
