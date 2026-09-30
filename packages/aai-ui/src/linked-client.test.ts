// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `createLinkedClient`: the linked id while there is a valid one, this
 * browser's own otherwise — a corrupted entry is no link, never an id the
 * server would ignore.
 */

import { beforeEach, describe, expect, test } from "vitest";
import { browserClientId } from "./client-identity.ts";
import { createLinkedClient } from "./linked-client.ts";

beforeEach(() => {
  localStorage.clear();
});

describe("createLinkedClient", () => {
  test("unlinked, it is the browser's own id; linked, the device's; cleared, back again", () => {
    const client = createLinkedClient({ key: "t:linked" });
    expect(client.id()).toBe(browserClientId());
    expect(client.linked()).toBeUndefined();
    client.set("speaker-kitchen");
    expect(client.id()).toBe("speaker-kitchen");
    expect(client.own()).toBe(browserClientId());
    expect(localStorage.getItem("t:linked")).toBe("speaker-kitchen");
    client.clear();
    expect(client.id()).toBe(browserClientId());
  });

  test("an invalid id unlinks, and a corrupted stored one reads as no link", () => {
    const client = createLinkedClient({ key: "t:linked", fallback: () => "legacy-id" });
    client.set("speaker-1");
    client.set("not a client id!");
    expect(client.linked()).toBeUndefined();
    localStorage.setItem("t:linked", "x".repeat(65));
    expect(client.id()).toBe("legacy-id");
  });
});
