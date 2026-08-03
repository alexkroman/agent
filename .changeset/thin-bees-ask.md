---
"aai-server": minor
"aai-studio-server": minor
"aai-guest": minor
"@alexkroman1/aai-cli": minor
---

Email login via Supabase Auth, for the studio and the CLI. The studio's browser bearer is now a session token (magic-link sign-in) resolved server-side to the user's stored AssemblyAI key (`user-key:<uid>` in Vault); connecting that key is the mandatory onboarding step after sign-in — every AssemblyAI key on the platform is user-provided, and the browser never holds one. `aai login` drives the same flow from the terminal via Supabase email OTP and saves the fetched key in the CLI config. A dev-token auth implementation keeps local dev Supabase-free. The guest chat surface is gated by a broker-minted per-session token instead of the caller's key. Slug-ownership hashes drop argon2id for plain SHA-256 digests (high-entropy machine keys need no slow hash), removing `@node-rs/argon2` and the verify cache. Raw API-key bearers keep working on every route.
