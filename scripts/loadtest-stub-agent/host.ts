// Serve the stubbed agent in ONE process — which is not a convenience, it is the
// only shape that works.
//
// `registerSttKind` and friends write to a MODULE-LEVEL record in
// `@alexkroman1/aai-runtime`, so a registration only takes effect for a resolver
// holding the same module instance. That is exactly what a host embedding the
// runtime is, and it is what the seam is documented for. It is NOT what an
// `agent.ts` is: `aai build` inlines the runtime into the worker bundle, so a
// stub registered from inside an agent lands in the bundle's own copy while the
// server resolves against the one in `node_modules` — measured, and it fails as
// `Unknown STT provider kind: "loadtest-stub-stt". Supported: assemblyai, …`
// under both `aai dev` and `npm start`. So the stub agent is served from here,
// with no bundle in the path, rather than by either of those.
//
// What that costs the measurement is worth stating: the bundler is gone, so this
// does not exercise `aai build`'s output or the dev server's Vite half. Every
// other layer is the real one — the socket, the session, the turn machine, the
// TTS coalescer, the audio gate, the tool executor, the Postgres session state.
//
// Started by `scripts/loadtest-boot.sh stub`, which copies this beside `agent.ts`
// and `stubs.ts` in a scaffolded project. It runs from THERE, not from the repo:
// the project is what has the SDK linked into a `node_modules`, and running it
// in place would resolve nothing.
//
//   PORT=4900 DATABASE_URL=... node host.ts
import { createAgentServer, ensureSessionStateSchema } from "@alexkroman1/aai-runtime";
// Importing the agent is what runs `stubs.ts`, and therefore what registers the
// three kinds — in THIS instance, which is the whole point above.
import agent from "./agent.ts";
import { stubEnv } from "./stubs.ts";

const { DATABASE_URL } = process.env;

/**
 * The agent's env: the stub credentials, plus a database when one was supplied.
 *
 * Only these — the rule `aai dev` and the scaffold both follow, so a load test
 * cannot come to depend on a variable that happens to be in this shell. An EMPTY
 * value is treated as absent for the scaffold's reason: a `DATABASE_URL` of `""`
 * would have the runtime report `sessionState: postgres` and then fail to
 * connect, where a missing one selects memory and says so.
 */
const env: Record<string, string> = { ...stubEnv };
if (DATABASE_URL) env.DATABASE_URL = DATABASE_URL;

// Same call the scaffold's `server.mjs` makes, for the same reason: the tables
// come with whoever owns the database, and for a load test that is us. Without
// it every session dies at start on a missing relation.
if (DATABASE_URL) await ensureSessionStateSchema({ url: DATABASE_URL, logger: console });

const server = createAgentServer({ agent, env, providerEnv: env });
await server.listen(Number(process.env.PORT ?? 4900), "127.0.0.1");
console.log(`stub agent listening on http://127.0.0.1:${server.port}`);

for (const signal of ["SIGINT", "SIGTERM"]) {
  // Synchronous, so a rejecting close is a non-zero exit rather than an
  // unhandled rejection — the rule `guard-invariants` rule 23 enforces.
  process.once(signal, () => {
    server.close().then(
      () => process.exit(0),
      (error: unknown) => {
        console.error(`shutdown failed: ${String(error)}`);
        process.exit(1);
      },
    );
  });
}
