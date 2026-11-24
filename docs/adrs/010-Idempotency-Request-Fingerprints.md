# ADR 010 — Idempotency keys with request fingerprints

- **Status:** Accepted
- **Context:** Network retries and agency bots can submit the same purchase more than once; reusing a key with a changed payload must not silently return a different purchase.
- **Decision:** Require a UUID `Idempotency-Key` at the gateway for booking creation. Scope uniqueness by agency in the Saga table and store a SHA-256 fingerprint of flight, seat, fare quote and payment method. Identical retries replay the existing booking; payload drift returns HTTP 409. A unique-constraint race is resolved by reading the winning record after rollback.
- **Consequences:** Duplicate purchase creation is prevented and key misuse is visible. The gateway's Valkey key is an additional guard; PostgreSQL uniqueness/fingerprint validation is authoritative for the business operation.
