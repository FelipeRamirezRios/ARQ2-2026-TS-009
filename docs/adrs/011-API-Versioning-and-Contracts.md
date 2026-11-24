# ADR 011 — Explicit API versions and OpenAPI contract

- **Status:** Accepted
- **Context:** Agency integrations must not break when query models evolve.
- **Decision:** Preserve existing `/v1` transactional routes and add `/v2` CQRS read routes. Maintain `contracts/openapi.json` as the machine-readable contract and expose the paths through the protected Kong booking route.
- **Consequences:** Existing consumers can remain on v1 while new consumers adopt v2. Both versions require JWT authentication and agency scopes; contract tests guard the documented paths.
