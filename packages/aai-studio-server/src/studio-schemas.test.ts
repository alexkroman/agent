// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import {
  AccountKeySchema,
  CliLinkSchema,
  CreateProjectSchema,
  MAX_STUDIO_MESSAGE_BYTES,
  ProjectNameSchema,
  projectBaseFromPrompt,
  UiMessageSchema,
} from "./studio-schemas.ts";

/** The filler set, restated so each entry is exercised individually. */
const FILLER_WORDS = [
  "a",
  "an",
  "the",
  "i",
  "am",
  "is",
  "are",
  "me",
  "my",
  "we",
  "want",
  "need",
  "would",
  "like",
  "please",
  "can",
  "you",
  "to",
  "for",
  "of",
  "and",
  "that",
  "this",
  "with",
  "build",
  "make",
  "create",
  "write",
  "voice",
  "agent",
  "app",
  "bot",
];

describe("projectBaseFromPrompt", () => {
  test.each([
    // Filler ("build me a", "agent", "voice") drops; the subject stays.
    ["Build me a contact form agent", "contact-form"],
    ["I want a voice agent that takes pizza orders", "takes-pizza-orders"],
    ["Café ordering", "cafe-ordering"],
    // Nothing but filler → empty; the generator falls back to words.
    ["build me an agent", ""],
    ["", ""],
    ["!!!", ""],
  ])("%j → %j", (prompt, base) => {
    expect(projectBaseFromPrompt(prompt)).toBe(base);
  });

  // Every entry gets its own case: a set that silently loses one word starts
  // naming projects after the user's phrasing ("i-kitchen") rather than the
  // subject, and one wrong entry is invisible in an aggregate assertion.
  test.each(FILLER_WORDS)("drops the filler word %j", (word) => {
    expect(projectBaseFromPrompt(`${word} kitchen`)).toBe("kitchen");
  });

  test("keeps a non-filler word that merely contains filler letters", () => {
    expect(projectBaseFromPrompt("theatre booking")).toBe("theatre-booking");
  });

  test("takes at most four words", () => {
    // The fifth word would still fit under the length cap, so only the
    // word-count limit can be what drops it.
    const base = projectBaseFromPrompt("order pizza pasta soup rice");
    expect(base).toBe("order-pizza-pasta-soup");
    expect(base.length).toBeLessThan(30);
  });

  test("does not decamelize — a typed camelCase word stays one word", () => {
    // `decamelize: false` is deliberate: splitting "pizzaOrders" would spend
    // two of the four word slots on one typed word.
    expect(projectBaseFromPrompt("pizzaOrders dashboard")).toBe("pizzaorders-dashboard");
  });

  test("stops before a word that would exceed the base cap", () => {
    // "scheduling" would push this to 33 chars, so it is dropped whole
    // rather than truncated mid-word.
    expect(projectBaseFromPrompt("restaurant reservation scheduling helpdesk")).toBe(
      "restaurant-reservation",
    );
  });

  test("admits a base of exactly the cap length", () => {
    // 30 chars exactly — the boundary the cap comparison must let through.
    const base = projectBaseFromPrompt("restaurant reservation kitchen");
    expect(base).toBe("restaurant-reservation-kitchen");
    expect(base).toHaveLength(30);
  });

  test("reads only the first 2000 characters of the prompt", () => {
    // 2000 chars of pure filler, then the real subject: a prompt excerpt that
    // is not truncated would name the project after text far past the cap.
    expect(projectBaseFromPrompt(`${"the ".repeat(500)}pizza kitchen`)).toBe("");
  });

  test("caps the base length for very long prompts", () => {
    const base = projectBaseFromPrompt(
      "supercalifragilistic expialidocious telemarketing dashboard reporting system",
    );
    expect(base.length).toBeLessThanOrEqual(30);
    expect(base.length).toBeGreaterThan(0);
  });
});

describe("ProjectNameSchema", () => {
  test("accepts a slug-shaped name", () => {
    expect(ProjectNameSchema.parse("contact-form-x7k2mq")).toBe("contact-form-x7k2mq");
  });

  test("accepts the underscore the slug grammar allows", () => {
    expect(ProjectNameSchema.parse("has_underscore")).toBe("has_underscore");
  });

  test.each(["My Agent", "UPPER", "trailing-", "-leading", "a", ""])(
    "rejects %j with a named message",
    (name) => {
      const result = ProjectNameSchema.safeParse(name);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("Invalid project name");
    },
  );
});

describe("CreateProjectSchema", () => {
  test("accepts prompt-only, name-only, and empty bodies", () => {
    expect(CreateProjectSchema.safeParse({ prompt: "hi there" }).success).toBe(true);
    expect(CreateProjectSchema.safeParse({ name: "My Agent" }).success).toBe(true);
    expect(CreateProjectSchema.safeParse({}).success).toBe(true);
  });

  test("still slugifies and validates an explicit name", () => {
    const parsed = CreateProjectSchema.parse({ name: "My Agent" });
    expect(parsed.name).toBe("my-agent");
    expect(CreateProjectSchema.safeParse({ name: "!!!" }).success).toBe(false);
    expect(CreateProjectSchema.safeParse({ name: "studio" }).success).toBe(false);
  });

  test("explains an unslugifiable name", () => {
    const result = CreateProjectSchema.safeParse({ name: "!!!" });
    expect(result.error?.issues[0]?.message).toBe(
      "Project name must contain at least two letters or numbers",
    );
  });

  test("explains a reserved name", () => {
    // Refused at creation rather than at publish: a project that can never go
    // live is a dead end the user would only discover after building in it.
    const result = CreateProjectSchema.safeParse({ name: "studio-assets" });
    expect(result.error?.issues[0]?.message).toBe("That name is reserved");
  });

  test("rejects a name longer than the typed cap and an empty one", () => {
    expect(CreateProjectSchema.safeParse({ name: "a".repeat(101) }).success).toBe(false);
    expect(CreateProjectSchema.safeParse({ name: "" }).success).toBe(false);
  });

  test("rejects a prompt longer than the excerpt cap", () => {
    expect(CreateProjectSchema.safeParse({ prompt: "x".repeat(2001) }).success).toBe(false);
    expect(CreateProjectSchema.safeParse({ prompt: "x".repeat(2000) }).success).toBe(true);
  });
});

describe("AccountKeySchema", () => {
  test("trims surrounding whitespace off a pasted key", () => {
    // Keys are pasted from a dashboard, so they arrive with stray whitespace;
    // storing it verbatim fails much later, inside a provider call.
    expect(AccountKeySchema.parse({ apiKey: "  abc123  " }).apiKey).toBe("abc123");
  });

  test("requires a non-empty key", () => {
    const result = AccountKeySchema.safeParse({ apiKey: "   " });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe("API key is required");
  });

  test("rejects a session token by its dot", () => {
    const result = AccountKeySchema.safeParse({ apiKey: "header.payload.sig" });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toBe(
      "That looks like a session token, not an API key",
    );
  });

  test("rejects an implausibly long key", () => {
    expect(AccountKeySchema.safeParse({ apiKey: "a".repeat(512) }).success).toBe(true);
    expect(AccountKeySchema.safeParse({ apiKey: "a".repeat(513) }).success).toBe(false);
  });
});

describe("CliLinkSchema", () => {
  const code = "a".repeat(32);

  test("accepts what `aai login` mints", () => {
    expect(CliLinkSchema.parse({ code }).code).toBe(code);
    expect(CliLinkSchema.safeParse({ code: `${"z9_-".repeat(8)}` }).success).toBe(true);
  });

  test("is anchored at both ends", () => {
    // Without the anchors a hostile code could carry arbitrary bytes either
    // side of a valid-looking run and still match.
    expect(CliLinkSchema.safeParse({ code: `!!!${code}` }).success).toBe(false);
    expect(CliLinkSchema.safeParse({ code: `${code}!!!` }).success).toBe(false);
  });

  test("enforces the length floor and ceiling", () => {
    expect(CliLinkSchema.safeParse({ code: "a".repeat(31) }).success).toBe(false);
    expect(CliLinkSchema.safeParse({ code: "a".repeat(128) }).success).toBe(true);
    expect(CliLinkSchema.safeParse({ code: "a".repeat(129) }).success).toBe(false);
  });

  test("names the failure", () => {
    const result = CliLinkSchema.safeParse({ code: "short" });
    expect(result.error?.issues[0]?.message).toBe("Invalid link code");
  });
});

describe("UiMessageSchema", () => {
  const part = (over: Record<string, unknown> = {}) => ({ type: "text", text: "hi", ...over });

  test.each(["user", "assistant", "system"])("accepts the %j role", (role) => {
    expect(UiMessageSchema.safeParse({ id: "1", role, parts: [part()] }).success).toBe(true);
  });

  test("rejects an unknown role", () => {
    expect(UiMessageSchema.safeParse({ id: "1", role: "tool", parts: [part()] }).success).toBe(
      false,
    );
  });

  test("requires id, role, and parts", () => {
    expect(UiMessageSchema.safeParse({}).success).toBe(false);
    expect(UiMessageSchema.safeParse({ id: "1", role: "user" }).success).toBe(false);
    expect(UiMessageSchema.safeParse({ role: "user", parts: [] }).success).toBe(false);
  });

  test("requires every part to declare a type", () => {
    expect(
      UiMessageSchema.safeParse({ id: "1", role: "user", parts: [{ text: "hi" }] }).success,
    ).toBe(false);
  });

  test("keeps unknown fields — the AI SDK owns part-level validation", () => {
    const parsed = UiMessageSchema.parse({
      id: "1",
      role: "user",
      parts: [part({ providerMetadata: { a: "b" } })],
      metadata: { turn: 3 },
    });
    expect(parsed).toMatchObject({ metadata: { turn: 3 } });
  });

  // The size cap is measured by summing every string reachable inside
  // `parts` — so the walk has to descend arrays and nested objects, and must
  // not trip over the non-string leaves (null, numbers, undefined) that a
  // real UIMessage part carries.
  describe("content size cap", () => {
    /** Parts whose summed string length is exactly `total`. */
    const partsOfSize = (total: number) => [{ type: "t", text: "a".repeat(total - "t".length) }];

    test("accepts a message exactly at the cap", () => {
      const result = UiMessageSchema.safeParse({
        id: "1",
        role: "user",
        parts: partsOfSize(MAX_STUDIO_MESSAGE_BYTES),
      });
      expect(result.success).toBe(true);
    });

    test("rejects a message one character over the cap", () => {
      const result = UiMessageSchema.safeParse({
        id: "1",
        role: "user",
        parts: partsOfSize(MAX_STUDIO_MESSAGE_BYTES + 1),
      });
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe("Message too large");
    });

    test("counts strings nested inside objects", () => {
      // The oversized string is two objects deep, so a walk that stops at the
      // part level would let it through.
      const result = UiMessageSchema.safeParse({
        id: "1",
        role: "user",
        parts: [{ type: "t", output: { detail: { body: "a".repeat(MAX_STUDIO_MESSAGE_BYTES) } } }],
      });
      expect(result.success).toBe(false);
    });

    test("counts strings nested inside arrays", () => {
      const result = UiMessageSchema.safeParse({
        id: "1",
        role: "user",
        parts: [{ type: "t", lines: ["a".repeat(MAX_STUDIO_MESSAGE_BYTES / 2 + 1)] }],
      });
      expect(result.success).toBe(true);
      const over = UiMessageSchema.safeParse({
        id: "1",
        role: "user",
        parts: [{ type: "t", lines: ["a".repeat(MAX_STUDIO_MESSAGE_BYTES), "b"] }],
      });
      expect(over.success).toBe(false);
    });

    test("walks past non-string leaves without counting or throwing", () => {
      // null, numbers, booleans and array holes all reach the walk's tail;
      // each one is a shape `Object.values` would throw on if the guard
      // ordering were wrong.
      const result = UiMessageSchema.safeParse({
        id: "1",
        role: "user",
        parts: [
          {
            type: "t",
            nothing: null,
            count: 7,
            flag: true,
            nested: [null, 1, undefined, { deep: null }],
          },
        ],
      });
      expect(result.success).toBe(true);
    });
  });
});
