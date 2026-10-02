// Copyright 2026 the AAI authors. MIT license.
// The origin a studio route hands a guest's `aai deploy` (studio-context.ts).

import { describe, expect, test } from "vitest";
import { requestPublicOrigin } from "./studio-context.ts";

describe("requestPublicOrigin", () => {
  /** A request as the studio sees it behind Modal: cleartext, public Host. */
  const behindTls = (headers: Record<string, string> = {}) => ({
    req: {
      raw: new Request("http://agent.example.modal.run/studio/projects/p/deploy", { headers }),
    },
  });

  test("publishes https for a public host behind a TLS-terminating proxy", () => {
    // Publish hands this origin to the guest's `aai deploy`. Resolving it as
    // http:// made the platform 308-redirect the deploy POST to https, which
    // strips Authorization across the scheme change — every Publish 401'd.
    expect(requestPublicOrigin(behindTls(), {})).toBe("https://agent.example.modal.run");
  });

  test("honors the agent service's forwarded headers in split mode", () => {
    const origin = requestPublicOrigin(
      behindTls({ "x-forwarded-host": "public.example", "x-forwarded-proto": "https" }),
      {},
    );
    expect(origin).toBe("https://public.example");
  });

  test("AAI_PUBLIC_ORIGIN still wins", () => {
    expect(requestPublicOrigin(behindTls(), { AAI_PUBLIC_ORIGIN: "https://aai.example/" })).toBe(
      "https://aai.example",
    );
  });
});
