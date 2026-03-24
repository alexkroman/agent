// Copyright 2025 the AAI authors. MIT license.
/** Browser event polyfills for Node.js environments. @module */

/** CloseEvent polyfill — available natively in browsers but not in Node.js. */
export const CloseEventImpl =
  typeof globalThis.CloseEvent !== "undefined"
    ? globalThis.CloseEvent
    : class CloseEvent extends Event {
        readonly code: number;
        readonly reason: string;
        readonly wasClean: boolean;
        constructor(type: string, init?: { code?: number; reason?: string; wasClean?: boolean }) {
          super(type);
          this.code = init?.code ?? 1000;
          this.reason = init?.reason ?? "";
          this.wasClean = init?.wasClean ?? true;
        }
      };

/** ErrorEvent polyfill — available natively in browsers but not in Node.js. */
export const ErrorEventImpl =
  typeof globalThis.ErrorEvent !== "undefined"
    ? globalThis.ErrorEvent
    : class ErrorEvent extends Event {
        readonly message: string;
        constructor(type: string, init?: { message?: string }) {
          super(type);
          this.message = init?.message ?? "";
        }
      };
