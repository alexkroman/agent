// Copyright 2026 the AAI authors. MIT license.
/**
 * Every write is judged by the parser that READS `.env` (`node:util`'s
 * `parseEnv`, which `resolveServerEnv` uses), not by the text it produced: the
 * regex edit this replaced produced plausible text that parsed to something
 * else.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, test } from "vitest";
import {
  deleteLocalSecret,
  formatEnvValue,
  putLocalSecret,
  removeEnv,
  upsertEnv,
} from "./_dotenv-file.ts";
import { withTempDir } from "./_test-utils.ts";

const parsed = (text: string) => parseEnv(text) as Record<string, string>;

const AWKWARD_VALUES = [
  "plain-value_1.2:3/4",
  "",
  "has space",
  "  padded  ",
  "hash#not-a-comment",
  "it's",
  'say "hi"',
  "both ' and \"",
  "line one\nline two",
  "multi\nline 'quoted'",
  "back\\slash",
  "a=b=c",
  "$NOT_EXPANDED",
];

describe("upsertEnv", () => {
  test.each(AWKWARD_VALUES)("round-trips %j through parseEnv", (value) => {
    const text = upsertEnv("OTHER=1\n", "KEY", value);
    expect(parsed(text)).toEqual({ OTHER: "1", KEY: value });
  });

  test("replaces in place and keeps every other line byte for byte", () => {
    const before = "# header\nA=1\n\nKEY=old # trailing\nB='two words'\n";
    const after = upsertEnv(before, "KEY", "new");
    expect(after).toBe("# header\nA=1\n\nKEY=new\nB='two words'\n");
  });

  test("replaces the LAST assignment — the one parseEnv honours — and an export form", () => {
    const after = upsertEnv("KEY=first\nexport KEY=second\n", "KEY", "third");
    expect(after).toBe("KEY=first\nKEY=third\n");
    expect(parsed(after).KEY).toBe("third");
  });

  test("replaces a multi-line quoted value whole, continuation lines included", () => {
    const before = "A=1\nKEY='line one\nline two'\nB=2\n";
    const after = upsertEnv(before, "KEY", "x");
    expect(after).toBe("A=1\nKEY=x\nB=2\n");
  });

  test("appends a new key with exactly one newline between", () => {
    expect(upsertEnv("", "KEY", "v")).toBe("KEY=v\n");
    expect(upsertEnv("A=1", "KEY", "v")).toBe("A=1\nKEY=v\n");
    expect(upsertEnv("A=1\n\n\n", "KEY", "v")).toBe("A=1\nKEY=v\n");
  });

  test("does not match a key that merely shares a prefix", () => {
    const after = upsertEnv("KEY_2=keep\n", "KEY", "v");
    expect(parsed(after)).toEqual({ KEY_2: "keep", KEY: "v" });
  });

  test("refuses a name that would not parse back as itself", () => {
    expect(() => upsertEnv("", "BAD-NAME", "v")).toThrow(/not a valid \.env name/);
    expect(() => upsertEnv("", "1ST", "v")).toThrow(/not a valid \.env name/);
  });
});

describe("formatEnvValue", () => {
  test("refuses a value no quoting can carry", () => {
    expect(() => formatEnvValue("' ` \"")).toThrow(/all three quote characters/);
  });
});

describe("removeEnv", () => {
  test("removes every assignment and reports whether there was one", () => {
    expect(removeEnv("A=1\nKEY=x\nexport KEY=y\nB=2\n", "KEY")).toEqual({
      text: "A=1\nB=2\n",
      removed: true,
    });
    expect(removeEnv("A=1\n", "KEY")).toEqual({ text: "A=1\n", removed: false });
  });
});

describe("putLocalSecret / deleteLocalSecret", () => {
  test("creates .env 0600, then keeps the mode an existing file has", async () => {
    await withTempDir(async (dir) => {
      const file = await putLocalSecret(dir, "KEY", "v1");
      expect(file).toBe(path.join(dir, ".env"));
      expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

      await fs.chmod(file, 0o640);
      await putLocalSecret(dir, "KEY", "v2");
      expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
      expect(parsed(await fs.readFile(file, "utf-8"))).toEqual({ KEY: "v2" });
      expect(await fs.readdir(dir)).toEqual([".env"]);
    });
  });

  test("delete removes the key, and says false for a key or file that is not there", async () => {
    await withTempDir(async (dir) => {
      expect(await deleteLocalSecret(dir, "KEY")).toBe(false);
      await fs.writeFile(path.join(dir, ".env"), "A=1\nKEY=x\n");
      expect(await deleteLocalSecret(dir, "KEY")).toBe(true);
      expect(await fs.readFile(path.join(dir, ".env"), "utf-8")).toBe("A=1\n");
      expect(await deleteLocalSecret(dir, "KEY")).toBe(false);
    });
  });
});
