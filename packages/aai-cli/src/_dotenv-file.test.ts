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
import { describe, expect } from "vitest";
import {
  deleteLocalSecret,
  formatEnvValue,
  putLocalSecret,
  removeEnv,
  upsertEnv,
} from "./_dotenv-file.ts";
import { test } from "./_test-utils.ts";

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

  test("refuses a carriage return, which parseEnv deletes from any spelling", () => {
    // `a\r\nb` used to be written and read back as `a\nb`, reported as set.
    expect(() => upsertEnv("", "KEY", "a\r\nb")).toThrow(/carriage return/);
  });
});

/**
 * Files whose quoting a line edit can misread. Each case is judged by
 * `parseEnv`: the edit changes exactly the one key, or the file is refused.
 */
describe("only top-level assignments are edited", () => {
  const CERT = 'CERT="-----BEGIN\nTOKEN=inner\n-----END"\n';

  test("an unclosed quote is one line's value, so put replaces only that line", () => {
    // The old scan ran an unclosed quote to EOF and replaced every later line.
    const before = "A='abc\nB=two\nC=three\n";
    const after = upsertEnv(before, "A", "new");
    expect(after).toBe("A=new\nB=two\nC=three\n");
    expect(parsed(after)).toEqual({ A: "new", B: "two", C: "three" });
  });

  test("delete leaves a same-named line INSIDE another key's multi-line value alone", () => {
    const before = `${CERT}TOKEN=outer\n`;
    const { text, removed } = removeEnv(before, "TOKEN");
    expect(removed).toBe(true);
    expect(text).toBe(CERT);
    expect(parsed(text)).toEqual({ CERT: "-----BEGIN\nTOKEN=inner\n-----END" });
  });

  test("a key that appears only inside another value is absent: delete finds nothing", () => {
    expect(removeEnv(CERT, "TOKEN")).toEqual({ text: CERT, removed: false });
  });

  test("put of a key that appears only inside another value appends, CERT untouched", () => {
    const after = upsertEnv(CERT, "TOKEN", "v");
    expect(after).toBe(`${CERT}TOKEN=v\n`);
    expect(parsed(after)).toEqual({ CERT: "-----BEGIN\nTOKEN=inner\n-----END", TOKEN: "v" });
  });

  test("an edit that would change how ANOTHER entry parses is refused", () => {
    // `A='x` is unclosed; an appended value spelled with `'` would close it,
    // swallowing the new line into A.
    expect(() => upsertEnv("A='x\n", "KEY", "has space")).toThrow(/Refusing to edit \.env/);
  });

  test("CRLF files: the edit lands, the other lines keep their bytes", () => {
    const after = upsertEnv("A=1\r\nKEY=old\r\nB='x\r\ny'\r\n", "KEY", "new");
    expect(after).toBe("A=1\r\nKEY=new\nB='x\r\ny'\r\n");
    expect(parsed(after)).toEqual({ A: "1", KEY: "new", B: "x\ny" });
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
  test("creates .env 0600, then keeps the mode an existing file has", async ({ tmpDir: dir }) => {
    const file = await putLocalSecret(dir, "KEY", "v1");
    expect(file).toBe(path.join(dir, ".env"));
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);

    await fs.chmod(file, 0o640);
    await putLocalSecret(dir, "KEY", "v2");
    expect((await fs.stat(file)).mode & 0o777).toBe(0o640);
    expect(parsed(await fs.readFile(file, "utf-8"))).toEqual({ KEY: "v2" });
    expect(await fs.readdir(dir)).toEqual([".env"]);
  });

  test("delete removes the key, and says false for a key or file that is not there", async ({
    tmpDir: dir,
  }) => {
    expect(await deleteLocalSecret(dir, "KEY")).toBe(false);
    await fs.writeFile(path.join(dir, ".env"), "A=1\nKEY=x\n");
    expect(await deleteLocalSecret(dir, "KEY")).toBe(true);
    expect(await fs.readFile(path.join(dir, ".env"), "utf-8")).toBe("A=1\n");
    expect(await deleteLocalSecret(dir, "KEY")).toBe(false);
  });

  test("a symlinked .env is refused by put and delete, link and target untouched", async ({
    tmpDir: dir,
  }) => {
    // The atomic rename replaced the LINK with a regular file holding a copy of
    // its target — `.env -> ~/.aws/credentials` put AWS keys in the project.
    const target = path.join(dir, "elsewhere");
    await fs.writeFile(target, "KEY=x\n");
    const project = path.join(dir, "proj");
    await fs.mkdir(project);
    await fs.symlink(target, path.join(project, ".env"));
    await expect(putLocalSecret(project, "NEW", "v")).rejects.toThrow(/is a symlink/);
    await expect(deleteLocalSecret(project, "KEY")).rejects.toThrow(/is a symlink/);
    expect((await fs.lstat(path.join(project, ".env"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(target, "utf-8")).toBe("KEY=x\n");
  });

  test("a refused edit leaves the file byte for byte", async ({ tmpDir: dir }) => {
    const file = path.join(dir, ".env");
    await fs.writeFile(file, "A='x\n");
    await expect(putLocalSecret(dir, "KEY", "has space")).rejects.toThrow(/Refusing/);
    expect(await fs.readFile(file, "utf-8")).toBe("A='x\n");
  });
});
