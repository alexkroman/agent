// Copyright 2026 the AAI authors. MIT license.
/**
 * Setup for every suite in this package.
 *
 * Testing Library's async utilities (`waitFor`, `findBy*`) default to a
 * **1000 ms** ceiling. Ten suites here lean on them to drive React Query
 * fetches, SSE subscriptions and the broker retry loop, and 1000 ms is a bound
 * that always holds standalone and does not hold under a contended
 * `turbo run test:coverage`, where all eight packages' suites run at once:
 * `app.test.tsx`'s "a failed workspace fetch surfaces an error banner" failed
 * at **1391 ms** looking for a sidebar button that a standalone run finds in a
 * few hundred.
 *
 * `waitFor` polls and settles the instant its condition holds, so a generous
 * ceiling costs nothing on the happy path — it only changes how long a
 * genuinely failing test takes to report. The same reasoning is written out
 * over `aai-cli/_dev-server-restart.test.ts`'s 15 s `vi.waitFor` ceilings.
 *
 * Set here rather than per call site so a new suite inherits it: the flake is
 * a property of the runner's load, not of any one assertion.
 */

import { configure } from "@testing-library/react";

configure({ asyncUtilTimeout: 10_000 });
