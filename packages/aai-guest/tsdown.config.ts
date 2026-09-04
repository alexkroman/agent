import { defineConfig } from "tsdown";

export default defineConfig({
  entry: ["src/harness.ts"],
  platform: "node",
  format: "esm",
  target: "node22",
  outDir: "dist",
  // Bundle everything the harness itself runs -- EXCEPT the packages that must
  // stay a runtime import resolved from the node_modules baked next to the
  // harness (modal-harness-image.ts installs them; in dev the harness sits
  // inside this package, whose own node_modules provide them).
  //
  // Two different reasons to be on that list, and the second one cost a feature:
  //
  // - **The build toolchain** would be both enormous and broken bundled --
  //   rolldown ships native binaries.
  // - **`@workflow/world-postgres` ships DATA, not just modules.** Its Drizzle
  //   migrator reads `drizzle/migrations/meta/_journal.json` off disk, resolved
  //   relative to its own module location, and tsdown carries modules rather
  //   than the directories beside them -- so bundled it dies on
  //   `Can't find meta/_journal.json` before a single migration runs, and the
  //   workflow API's own runtime `require` of it fails from the temp dir it
  //   dispatches steps in. The durable Postgres workflow world therefore never
  //   worked ANYWHERE, production included, and nothing noticed because the one
  //   prerequisite -- an agent with storage enabled -- had never been met.
  //   Enabling the database by default for studio projects is what surfaced it.
  deps: {
    alwaysBundle: [/.*/],
    neverBundle: [
      /^@alexkroman1\/aai-cli(\/|$)/,
      /^@vitejs\/plugin-react(\/|$)/,
      /^@tailwindcss\/vite(\/|$)/,
    ],
  },
  // ONE artifact: the harness is baked into the guest image as a single
  // file (aai-server's modal-harness-image.ts), so the providers' lazy
  // imports must be inlined rather than emitted as sibling chunks the
  // guest can't load. (External dynamic imports -- the toolchain above --
  // stay external.)
  outputOptions: { codeSplitting: false },
});
