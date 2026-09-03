// Copyright 2026 the AAI authors. MIT license.
/**
 * The two on-disk formats a CLI invocation reads, as WRITERS other packages
 * can call — the config home (`config.json`, which holds the API key) and a
 * project's `.aai/project.json` pin.
 *
 * It exists for the studio guest. Publish materializes a workspace into a
 * real project and then spawns this CLI against it
 * (`aai-guest/studio-publish.ts`), which means writing both files first; it
 * used to do that with `JSON.stringify`, so the shapes agreed by coincidence
 * and nothing tied them to the schemas the CLI parses them back with. Two of
 * this file's properties are not obvious from the JSON and were absent from
 * the hand-written copies' successors-in-waiting: the config home is written
 * 0600 through an atomic rename (so an older world-readable file is
 * TIGHTENED rather than left), and the project pin is MERGED, never
 * replaced — `.aai/project.json` also carries the studio link fields, and a
 * writer that replaces the document drops them.
 *
 * Deliberately a thin re-export of `_config.ts` rather than a second
 * implementation: the point is that there is one writer per format, not that
 * there is a nicer one here.
 */

export type { GlobalConfig, ProjectConfig } from "./_config.ts";
export { updateProjectConfig, writeGlobalConfig as writeConfigHome } from "./_config.ts";
