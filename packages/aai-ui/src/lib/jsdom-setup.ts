// Stub APIs not implemented in jsdom.
if (typeof globalThis.Element !== "undefined" && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {
    /* noop */
  };
}
