---

---

Test-only, and it ships in nothing: the assertion gate's parser
(`scripts/_test-assertions-parse.mjs`) now runs on `oxc-parser` instead of a
hand-written lexer, which found eleven `test.concurrent(…)` bodies in
`packages/aai-cli/e2e.test.ts` whose claims were bare `await`s. Those bodies and
the gate's own spec in `aai-templates` are the only files in `packages/` touched.
