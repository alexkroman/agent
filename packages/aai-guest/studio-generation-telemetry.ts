// Copyright 2026 the AAI authors. MIT license.
/**
 * Telemetry for the studio's own one-shot model calls.
 *
 * Three of them existed with NO observability whatever, and all three fail by
 * returning something bland: context compaction (`catch` → the original
 * messages), tool-call repair (`catch { return null }`), and
 * `generate_design_inspiration` (`catch` → an error string the model reads as
 * a result). A provider outage, a rejected model id or an exhausted key
 * therefore looked from the outside like the feature quietly not working, with
 * nothing in the guest's stderr — which the host relays — to say otherwise.
 *
 * The integration itself is the SDK's (`oneShotTelemetry`, in
 * `@alexkroman1/aai/internal`); this is the guest's console binding for it.
 * Imported from `/internal` rather than `/runtime` deliberately: the harness
 * embeds no agent runtime, and `Telemetry` is a type-only import there, so
 * this adds nothing to the bundle but the function itself.
 */

import { oneShotTelemetry, type TelemetryLogger } from "@alexkroman1/aai/internal";

/**
 * The guest logs to the console, which the host drains from the sandbox's
 * stderr (`startGuestLogging`) — so a line here reaches the platform's log
 * without any channel of its own.
 */
const consoleLog: TelemetryLogger = {
  debug: (message, context) => {
    if (process.env.AAI_DEBUG) console.debug(message, context ?? {});
  },
  warn: (message, context) => console.warn(message, context ?? {}),
};

/** Per-call telemetry for a studio generation, tagged with what made it. */
export function studioGenerationTelemetry(label: string): {
  telemetry: { isEnabled: true; integrations: [ReturnType<typeof oneShotTelemetry>] };
} {
  return {
    telemetry: {
      isEnabled: true,
      integrations: [oneShotTelemetry({ log: consoleLog, label })],
    },
  };
}
