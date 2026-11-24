# ADR 009 — PNR and e-ticket lifecycle

- **Status:** Accepted
- **Context:** A reservation record and an issued travel ticket are different business objects and must not be conflated.
- **Decision:** Generate a unique PNR when a booking is created. Allow agency-scoped PNR retrieval and passenger registration. Create a deterministic e-ticket only when the airline booking reaches `CONFIRMED`; void tickets when a booking is cancelled/compensated. Ticket issue/void operations are retry-safe.
- **Consequences:** The local demo can explain booking versus ticket issuance and demonstrate ticket lifecycle. The identifiers are simulated and are not BSP/ARC settlement numbers or a real airline e-ticket issuance integration.
