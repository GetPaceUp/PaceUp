# PaceUp

**PaceUp** is an open-source, sport-agnostic community platform that helps clubs organise activities and make participation simple.

It is being designed for endurance and outdoor-sport communities — including cycling, running, hiking and triathlon.

## The idea

Club admins organise activities through a conversational WhatsApp workflow. PaceUp turns the details into a shareable activity page. Members open the link, find their name in their club directory and RSVP — without creating an account for basic participation.

## Product principles

- **Community-first:** support the clubs and groups people already belong to.
- **Sport-agnostic:** do not assume every activity is a cycling event.
- **Low-friction participation:** make viewing and responding to an activity straightforward.
- **Club autonomy:** each club manages its own members, activities, admins and messaging connection.
- **Reliable by design:** an RSVP must not depend on a messaging provider being available.
- **Self-hostable:** keep deployment approachable for independent communities.
- **Open source:** build in public and welcome contributions.

## Planned MVP

1. A club admin creates an activity through WhatsApp.
2. PaceUp collects the activity details and asks for confirmation before publishing.
3. PaceUp publishes a public activity page and a ready-to-share announcement.
4. A member opens the page, selects their name from that club's member directory and confirms an RSVP.
5. The participant list updates and a notification is queued for the club's WhatsApp group.
6. Members can cancel an RSVP; duplicate responses are prevented.

The initial release is focused on activity publishing, RSVPs, club member directories and dependable notifications. Attendance tracking, QR check-in, analytics, Strava integrations and other enhancements are later-stage ideas.

## Project status

PaceUp is in early development. Product decisions and implementation details may evolve as the first community pilot is built and tested.

## Documentation

- [Product definition](docs/PRODUCT.md)
- [Architecture](docs/ARCHITECTURE.md)
- [Contributing](CONTRIBUTING.md)
- [Security](SECURITY.md)

## Licence

PaceUp is released under the [MIT Licence](LICENSE).
