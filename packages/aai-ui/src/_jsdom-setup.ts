// jest-dom's DOM matchers (`toBeInTheDocument`, `toHaveAttribute`, …) on
// vitest's `expect`, plus their type augmentation — this file is in the
// typecheck program, so the side-effect import is what makes them type.
import "@testing-library/jest-dom/vitest";

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
