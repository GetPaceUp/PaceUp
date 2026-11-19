# PaceUp — Product Definition

## 1. Vision

PaceUp is an open-source, sport-agnostic community platform that helps clubs organise activities and turn individual participation into shared community momentum.

It should be useful to a small informal riding group as well as a larger multi-sport club. The product is not a booking engine for one event organiser and is not limited to cycling.

## 2. Users and roles

The initial product should support these conceptual roles:

- **Platform administrator:** manages platform-wide configuration and operations.
- **Club administrator:** manages a club, its members, activities, and communication.
- **Activity organiser:** creates and manages activities and participant lists.
- **Member:** discovers activities, responds to invitations, and receives relevant updates.
- **Guest:** may be invited to an activity where the club permits guest participation.

Role names and permission granularity can evolve, but access must be scoped to the relevant club.

## 3. Core journeys

### Club setup
An administrator creates a club, configures its identity and basic settings, and invites members.

### Activity publishing
An authorised organiser creates an activity with its title, description, date and time, location or meeting point, capacity (if applicable), and participation rules.

### RSVP
A member opens an activity and responds. The system records the response and makes the current participant status visible to authorised viewers. Members can update or withdraw their response according to the activity's rules.

### Community momentum
Meaningful RSVP activity can trigger a community update, such as a new participant joining or a participation milestone being reached. The system should avoid duplicate, excessive, or irrelevant messages. Members and clubs should have sensible notification controls.

### Activity operations
Organisers can view the participant list, communicate changes, and manage cancellations or updates. A change should reach affected participants through their enabled channels.

## 4. MVP scope

The first usable release should prioritise:

1. Club and member management
2. Authentication and club-scoped authorisation
3. Activity creation, editing, publishing, and cancellation
4. RSVP and participant status management
5. Participant list for organisers
6. In-app notification foundation
7. Notification-provider abstraction, with WhatsApp as a planned integration
8. Responsive mobile-first interface

## 5. Not in the first MVP

Unless validated by actual pilot usage, defer:

- Full social networking and public activity feeds
- Complex training plans and performance analytics
- Payments, ticketing, and marketplace features
- Route tracking and live GPS
- Gamification systems and leaderboards
- Native mobile applications

## 6. Product principles

- Sport agnostic by default; sport-specific fields should be extensible.
- A club's data and administration must remain scoped to that club.
- Mobile-first for member journeys.
- Make RSVP state and event changes easy to understand.
- Notifications are an outcome of product events, not business logic embedded in a messaging provider.
- Keep the core usable without optional third-party integrations.

## 7. Pilot and validation

Folks On Forks is the initial pilot community. Validate the core flows with real organisers and members before expanding scope. Pilot-specific branding, rules, and workflows must remain configuration or integration concerns rather than assumptions baked into the core product.

## 8. Success signals

- Organisers can publish an activity without assistance.
- Members can RSVP and change their response on a phone.
- Organisers can trust the participant list.
- Event changes reach the right people.
- Community momentum updates increase awareness without creating notification fatigue.
- A second club can use the product without code changes specific to the pilot club.
