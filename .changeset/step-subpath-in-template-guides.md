---
"aai-templates": patch
---

Correct the subpath every step primitive is named under. `packages/aai-templates/CLAUDE.md`
and `scaffold/CLAUDE.md` said `mapConcurrent`, `emit`, `stepEnv` / `requireStepEnv`,
`stepGenerate`, `stepFetch` / `multipartBody`, `stepSpeak`, `writeUpload`, `report`,
`encodeWav` / `pcmDurationMs` and the four `stepTranscribe*` were on
`@alexkroman1/aai/utils`. That subpath has 15 exports and not one of them is a step
primitive — all of the above are on `@alexkroman1/aai/step`, which was split out of
`/utils` precisely because "zod-free so the CLI can import it cheaply" is a build
property nobody imports BY. Nine prose claims across the two guides, nine template
doc comments, and three of the scaffold guide's copy-paste import lines.

The scaffold guide is the one that mattered: it ships twice, as the studio coding
agent's system prompt and as `AGENT_GUIDE.md` inside the `@alexkroman1/aai` tarball.
`packages/aai-studio-server/studio-preamble-mode.ts` had copied the error, and every
workflow the studio generated from it carried an import that cannot resolve. Its three
fences are `ts no-check` fragments, so `check:doc-examples` compiles them for nobody —
which is why a wrong specifier in a shipped guide survived a gate that exists to catch
exactly that.

Two more names, found by validating every `@alexkroman1/*` import in the two guides
against `API-EXPORTS.json`. The scaffold's workflow-app page imported
`WorkflowOutputOf` from `@alexkroman1/aai`, where it does not exist; all six template
`client.tsx` files take it from `@alexkroman1/aai/workflow-api`. And the HTTP/2
fan-out passage still named `mapInBatches`, which `sdk/map-concurrent.ts` declares a
`@deprecated` alias — `research-workflow` was the last template still calling it, and
is converted (the alias IS `mapConcurrent`, so the two calls are identical), with the
`recap-workflow` prose mention that named it as a live primitive. The two
`transcription-workflow` mentions stay: both narrate the rename.

Also drops two claims about the coverage gate that the wrong subpath had propped up.
`template-api-coverage.test.ts`'s `SCOPED_MODULES` is the `aai` root plus
`stt`/`tts`/`llm`/`s2s` and the `aai-ui` root — so `/step` and `/testing` are outside
it entirely, and neither the step surface nor the bare `stubGateway` has, or could
have, the allowlist entry the guide credited them with.

And re-baselines `template-api-allowlist.json` against the surface either side of it
moved. Down by four — `BaseOptions`, `ComponentTier`, `ConfigTier` and
`VOICE_CAPTURE_CONSTRAINTS` are no longer exported by `@alexkroman1/aai-ui`, so the
gate reported them stale. Up by two, and only after exhausting the better option:
`isRecord`, `omitUndefined` and `responseErrorMessage` joined the `aai` root barrel,
where no template exercised them because every template takes them from `/utils`,
which the gate does not scan. `omitUndefined` needs no entry — its four agent-side
consumers (`retail/store.ts`, `retail/tools/get_order_details.ts`,
`support-line/procedure.ts`, and `plan-and-execute/shared.ts` for `isToolFailure`)
already import the root barrel one line above, so the second import line is now
merged into the first and the name is exercised for real. The other two are consumed
ONLY from `workflows/*.ts` modules, where a root import is the exact thing the
bundling rule above forbids, so they are recorded instead — beside the seven
root-and-`/utils` names (`safeJsonParse`, `errorDetail`, `createKeyedLock`, …) already
there for the same reason.
