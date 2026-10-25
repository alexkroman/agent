// jest-dom's DOM matchers (`toBeInTheDocument`, `toHaveAttribute`, …) on
// vitest's `expect`, plus their type augmentation — this file is in the
// typecheck program, so the side-effect import is what makes them type.
import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, beforeEach } from "vitest";

// Testing Library registers its hooks ONCE, when its module first loads: an
// `afterEach` that unmounts what a test rendered, and a `beforeAll`/`afterAll`
// pair that sets and restores `IS_REACT_ACT_ENVIRONMENT`. With one module
// graph per worker (`isolate: false`) that is the first file's suite alone:
// every later file's renders would pile up in the same `document` ("Found
// multiple elements…"), and after the first file's `afterAll` React's `act()`
// would warn that the environment is not configured. A setup file runs per
// test file, so both are registered here, per file.
afterEach(cleanup);
beforeAll(() => {
  // React's own switch for `act()` support, which nothing here declares a type for.
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});

// The same sharing reaches web storage: one jsdom `sessionStorage` now outlives
// a file, so an id a spec wrote and did not clear met the next file's "starts
// empty" assertion (seen once in four seeds). Every test starts with both
// stores empty — this is the one clear a spec needs; a spec's own `clear()`
// is only for the mid-test cases. Guarded, because a node-environment file has
// neither, and `try`, because a spec may have stubbed a store that refuses it.
beforeEach(() => {
  for (const store of [globalThis.sessionStorage, globalThis.localStorage]) {
    try {
      store?.clear();
    } catch {
      // A hostile stub from the previous test; `unstubGlobals` is removing it.
    }
  }
});

// Stub APIs not implemented in jsdom.
if (typeof globalThis.Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {
    /* noop */
  };
}

// jsdom has no ResizeObserver; use-stick-to-bottom (MessageList's scroll
// container) requires one.
if (typeof globalThis.ResizeObserver === "undefined") {
  globalThis.ResizeObserver = class ResizeObserverStub {
    observe(): void {
      // jsdom stub — layout never changes.
    }
    unobserve(): void {
      // jsdom stub.
    }
    disconnect(): void {
      // jsdom stub.
    }
  };
}
