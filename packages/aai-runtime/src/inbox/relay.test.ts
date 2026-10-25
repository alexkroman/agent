// Copyright 2026 the AAI authors. MIT license.
import type { ClientNotifier } from "@alexkroman1/aai/host-internal";
import { afterEach, describe, expect, test } from "vitest";
import { notifyClientHere, routedClientNotifier, setClientNotifyRelay } from "./relay.ts";

afterEach(() => setClientNotifyRelay(undefined));

const notice = { id: "n1", event: "reminder" };
const opts = { ackTimeoutMs: 1000, signal: undefined };

/** A notifier that answers `outcome` and records whom it was asked about. */
function recording(outcome: Awaited<ReturnType<ClientNotifier>>) {
  const asked: string[] = [];
  const notify: ClientNotifier = async (clientId) => {
    asked.push(clientId);
    return outcome;
  };
  return { notify, asked };
}

describe("routedClientNotifier", () => {
  test("with no relay every client is delivered locally", async () => {
    const local = recording("acked");
    const routed = routedClientNotifier(local.notify);
    await expect(routed("phone-1", notice, opts)).resolves.toBe("acked");
    expect(local.asked).toEqual(["phone-1"]);
  });

  test("a client the relay says another process owns goes through the relay", async () => {
    const local = recording("offline");
    const remote = recording("acked");
    setClientNotifyRelay({ forward: (id) => (id === "phone-2" ? remote.notify : undefined) });
    const routed = routedClientNotifier(local.notify);
    await expect(routed("phone-2", notice, opts)).resolves.toBe("acked");
    await expect(routed("phone-1", notice, opts)).resolves.toBe("offline");
    expect(remote.asked).toEqual(["phone-2"]);
    expect(local.asked).toEqual(["phone-1"]);
  });

  test("notifyClientHere is the owner's half: the local inbox, never the relay", async () => {
    const local = recording("acked");
    const remote = recording("busy");
    setClientNotifyRelay({ forward: () => remote.notify });
    routedClientNotifier(local.notify);
    await expect(notifyClientHere("phone-3", notice, opts)).resolves.toBe("acked");
    expect(remote.asked).toEqual([]);
  });
});
