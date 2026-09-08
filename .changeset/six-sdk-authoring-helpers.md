---
"@alexkroman1/aai": major
"@alexkroman1/aai-runtime": patch
---

Move six things the templates kept rebuilding into the SDK.

- **The OUTBOUND half of `spoken.ts`.** `spokenMoney`, `spokenDate`,
  `spokenTime` and `mintCode` — data as the words a TTS voice reads correctly,
  which is the same problem `resolveOne` solves from the other end. Fixed ASCII
  shapes and no `Intl`: the `toLocaleDateString("en-US", …)` this replaces
  answers to the host's ICU build, so a desk could read dates correctly on a
  laptop and differently in a sandbox.
- **`ctx.random`.** `ToolContext` gains a required `random`, with `randomInt` /
  `pickOne` / `shuffled` / `createSeededRandom` beside it. Ten sites across
  seven templates called `Math.random()` directly and could not be pinned by a
  spec. `createToolContext` defaults it to a SEEDED source, so a spec that never
  mentions randomness is still deterministic.
- **`isoDate(what)` / `clockTime(what)`**, plus the `calendar.ts` predicates and
  UTC arithmetic behind them. A tool-argument rule declared where the model
  READS it rather than discovered by being refused after it has committed.
- **`orFail` / `failable`.** The forwarding half of the `T | ToolFailure` union,
  so a chain of lookups is written once rather than guarded per step. The union
  and how a tool returns it are unchanged.
- **`parseWav`** and the RIFF chunk walk, the read side matching `encodeWav`.
  A reader that assumes 44 bytes transcribes ffmpeg's own `LIST`/`INFO` chunk as
  audio.
- **`roundMoney`**, sharing `formatMoney`'s `toFixed(2)` basis so a total cannot
  compare as one number and print as another.

Breaking: `ToolContext.random` is required, so code that hand-builds a
`ToolContext` rather than using `createToolContext` no longer compiles.
