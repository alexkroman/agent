// Copyright 2026 the AAI authors. MIT license.
/**
 * What `aai build --target modal` puts on disk that is MODAL's.
 *
 * The runtime files are the shared assembly and are asserted in
 * `_target-output.test.ts`. What is left here is the fourth file — `app.py` —
 * which is the whole reason this target differs in kind from the other two:
 * `modal deploy` runs a Python module rather than being pointed at a directory.
 *
 * The bundler is stubbed; the real pass, a `python3` parse and an import
 * against the real `modal` library live in `_modal-output.scenario.test.ts`.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { CLIENT_ARTIFACT_REL, WORKER_ARTIFACT_REL } from "./_artifacts.ts";
import { MODAL_APP_FILE, MODAL_ENTRY_FILE, MODAL_OUTPUT_DIR } from "./_build-target.ts";
import { emitModalOutput } from "./_modal-output.ts";
import { withTempDir } from "./_test-utils.ts";

const STUB = "// bundled entry\n";
const stubBundle = () => Promise.resolve(STUB);

/** A project as `aai build` leaves it. */
async function project(dir: string): Promise<void> {
  const files: Record<string, string> = {
    [WORKER_ARTIFACT_REL]: "export default { name: 'a' };",
    [path.join(CLIENT_ARTIFACT_REL, "index.html")]: "<!doctype html><title>built</title>",
    ".env.example": "ASSEMBLYAI_API_KEY=\n",
  };
  for (const [rel, body] of Object.entries(files)) {
    const target = path.join(dir, rel);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, body);
  }
}

const emit = (dir: string, name = "Retail Support Bot") =>
  emitModalOutput(dir, { name, bundle: stubBundle });
const out = (dir: string, ...rel: string[]) => path.join(dir, MODAL_OUTPUT_DIR, ...rel);
const read = (p: string) => fs.readFile(p, "utf-8");

describe("emitModalOutput", () => {
  test("the entry sits where the generated app.py spawns it", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emit(dir);
      expect(await read(out(dir, MODAL_ENTRY_FILE))).toBe(STUB);
    });
  });

  test("app.py lands beside the directory it describes", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emit(dir);
      // `add_local_dir(HERE, …)` is a claim about THIS directory, so the module
      // has to sit in it — a path a user could otherwise only get wrong.
      const app = await read(out(dir, MODAL_APP_FILE));
      expect(app).toContain("modal.App(APP_NAME)");
      expect(app).toContain("HERE = Path(__file__).parent");
    });
  });

  test("the app is named for the agent, not for the directory", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emit(dir, "Night Shift Dispatcher");
      // The name reaches a URL, and the temp directory this runs in is not a
      // name any user chose.
      const app = await read(out(dir, MODAL_APP_FILE));
      expect(app).toContain('"night-shift-dispatcher"');
      expect(app).toContain('"night-shift-dispatcher-env"');
      expect(app).not.toContain(path.basename(dir));
    });
  });

  test("app.py is regenerated, never merged with a previous build's", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emit(dir, "First Name");
      await emit(dir, "Second Name");
      // The whole directory is rebuilt, so a rename cannot leave a deployment
      // whose app.py still names the old app — which would deploy TWO apps.
      const app = await read(out(dir, MODAL_APP_FILE));
      expect(app).toContain("second-name");
      expect(app).not.toContain("first-name");
    });
  });

  test("nothing but app.py, the entry and the runtime files is emitted", async () => {
    await withTempDir(async (dir) => {
      await project(dir);
      await emit(dir);
      // The directory is baked into an image layer, so every extra file is
      // permanent weight on the cold-start path of every container.
      const written = (await fs.readdir(out(dir))).sort();
      expect(written).toEqual([".aai", ".env.example", MODAL_APP_FILE, MODAL_ENTRY_FILE]);
    });
  });
});
