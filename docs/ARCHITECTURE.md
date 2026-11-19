# PaceUp — Architecture Notes

## 1. Architectural intent

Build a dependable, modular platform that can be self-hosted and extended by the community. Keep the first implementation simple; do not introduce distributed infrastructure before usage requires it.

The initial implementation should favour a **modular monolith** with clear domain boundaries. A service can be extracted later when scale or operational needs justify it.

## 2. Logical modules

- **Identity and access:** users, authentication, sessions, roles, and permissions.
- **Clubs:** club profiles, membership, invitations, and club settings.
- **Activities:** activity lifecycle, schedules, locations, capacity, and organiser controls.
- **Participation:** RSVP responses, status transitions, and participant lists.
- **Notifications:** notification preferences, templates, delivery records, and dispatch.
- **Integrations:** adapters for external channels such as WhatsApp and email.
- **Administration:** platform configuration and operational visibility.

Modules should expose intentional interfaces and avoid reaching into one another's internal data structures.

## 3. Core domain concepts

Initial conceptual entities:

- User
- Club
- ClubMembership
- Invitation
- Activity
- RSVP
- NotificationPreference
- Notification
- IntegrationConfiguration
- DeliveryAttempt

Every club-owned record should carry an explicit club scope, directly or through a well-defined parent relationship. Enforce that scope in the application and data-access layers.

## 4. Event-driven notifications

Business actions should produce domain events, for example:

- `ActivityPublished`
- `RSVPSubmitted`
- `RSVPChanged`
- `ActivityUpdated`
- `ActivityCancelled`
- `CapacityReached`

The notification module decides whether an event warrants a message, who should receive it, and through which enabled channel. Provider adapters handle channel-specific delivery.

This separation allows Ride Buzz to evolve without coupling RSVP processing to WhatsApp APIs. Delivery should be asynchronous where practical, with retries and idempotency to prevent duplicate messages.

## 5. API and interface

Expose stable application interfaces between the client and domain modules. Whether the first release uses REST or another transport should be recorded when the implementation stack is selected.

The member experience must be responsive and mobile-first. Organiser workflows may expose richer management views while remaining usable on smaller screens.

## 6. Data and tenancy

The initial tenancy model is club-scoped access within one platform deployment.

- A user may belong to more than one club.
- A club administrator's authority applies only to that club.
- Queries and mutations must enforce club membership and role permissions.
- Public activity visibility, guest access, and member-directory visibility must be explicit club settings.
- Sensitive integration credentials must not be stored as ordinary plaintext configuration.

## 7. Operational qualities

- Validate inputs at system boundaries.
- Keep secrets in environment or secret-management configuration.
- Log operational events without leaking credentials or unnecessary personal data.
- Provide database migrations and repeatable setup instructions.
- Include automated tests for permissions, RSVP transitions, and notification idempotency.
- Make external integrations optional so core activity and RSVP flows remain usable if a provider is unavailable.

## 8. Decisions still to record

The following are implementation decisions, not yet locked by this document:

- Backend and frontend frameworks
- Database and migration tooling
- Authentication provider or implementation
- Hosting and deployment model
- API contract and versioning strategy
- WhatsApp provider and message-template workflow
- Queue and background-job implementation

Record these decisions with rationale before implementation depends on them. Avoid selecting infrastructure merely for fashion or hypothetical scale.
