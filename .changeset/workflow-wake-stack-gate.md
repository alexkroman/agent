---
---

Gate `workflow-wake.scenario.test.ts` on the Supabase stack rather than on a
database: it writes through the real Vault, so on the plain-Postgres arm that
`pnpm test:pg` legitimately resolves it failed in `beforeAll` instead of
announcing a skip. Test-only, no release.
