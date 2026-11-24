# ADR 008 — CQRS read projection and append-only booking event store

- **Status:** Accepted
- **Context:** Agency booking reads must not compete with transactional reservation/Saga writes, and the team must be able to explain the history of a reservation.
- **Decision:** Keep `bookings` as the transactional aggregate, append state changes to `booking_events` in the same PostgreSQL transaction through a trigger, and maintain `booking_read_model` as a query projection. `/v2` reads the projection; an admin-only endpoint rebuilds it from state-bearing events. Event rows reject UPDATE/DELETE.
- **Consequences:** Reads are optimized and history is inspectable/replayable. The selected design is a hybrid event-sourcing approach, not a fully event-sourced write model; this avoids rewriting the existing Saga but retains the operational aggregate as the write authority. Projection rebuild must be tested after schema changes.
