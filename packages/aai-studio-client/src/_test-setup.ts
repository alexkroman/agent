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
 *
 * It also unmounts everything rendered by a test. Testing Library registers
 * its own automatic cleanup only when the runner exposes globals, and this
 * package deliberately does not set `globals: true` — so before this, sixteen
 * files hand-wrote `afterEach(cleanup)` and the seventeenth
 * (`use-event-stream.test.ts`) leaned on a per-test `unmount()`, which an
 * assertion failing above that line skips: the hook stays mounted holding a
 * pending fake timer into the next test. Registering it here is the only
 * version a new suite cannot forget. It runs LAST (vitest stacks `afterEach`
 * hooks, so the setup file's is the outermost), which is what a suite that
 * restores timers or globals in its own hook wants.
 */

import { cleanup, configure } from "@testing-library/react";
import { afterEach } from "vitest";

configure({ asyncUtilTimeout: 10_000 });

afterEach(cleanup);
