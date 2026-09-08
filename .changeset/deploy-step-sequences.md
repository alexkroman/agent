---
"@alexkroman1/aai-cli": minor
---

Print the deploy SEQUENCE each host needs, not one command.

`aai build --target <host>` told you how to ship what it just built with a single string, and for both hosts that deploy from your own machine that string did not work. Verified end to end against a scaffolded `quickstart-agent`, with no change to the generated project:

- `cd .aai/deno && deno deploy` fails `APP_NOT_FOUND` — the app has to be created first, and the create has to override Deno Deploy's auto-detected build config, which for this directory resolves to no entrypoint and fails the build. The deployment then fails at `warming` until the declared secret is set, because the server refuses to start without a provider credential rather than starting and failing at its first session. Three distinct failures behind one printed line.
- `modal deploy .aai/modal/app.py` dies unless the secret already exists, because `app.py` resolves `Secret.from_name` at deploy time.

So `TargetOutput.deploy` is an ordered list of steps, each carrying `when`: `build`, `once`, `perSecret` or `each`. What a reader now sees after `aai build --target deno`:

```
Deploy it with:
  1. deno deploy create --source local --region us --runtime-mode dynamic
       --entrypoint server.mjs --do-not-use-detected-build-config
       --org <ORG> --app <APP>                       (first deploy only)
  2. deno deploy env add ASSEMBLYAI_API_KEY <value> --org <ORG> --app <APP>
  3. cd .aai/deno && deno deploy --prod --org <ORG> --app <APP>
Re-run `aai build --target deno` before every deploy.
```

`resolveDeploySteps` fills in what the build knows and leaves the rest as prompts, which is the line `.env.example` already draws — declarations ship, values do not. Declared variable names are substituted, and so is Modal's secret name, derived from the agent's own exactly as `app.py` derives it (`modal secret create quickstart-assistant-env ASSEMBLYAI_API_KEY=<value>`), because a reader who invents that name gets a deploy that dies on `Secret.from_name`. `<ORG>`, `<APP>` and `<value>` survive into the printed command: they are account state and secrets, and this build knows neither.

`when` is also what lets the two surfaces differ correctly from one source. The post-build log omits the `build` step — you just ran one — while the `--json` result keeps it, because a CI job scripting a fresh checkout has to run it. That step exists because its omission is the one silent failure here: both hosts upload the emitted directory as it stands, so a forgotten rebuild ships the previous bundle and reports success (Deno prints "No files were changed, so there is nothing to upload", which reads like a no-op). `once` is a label rather than a branch — whether your app exists is state on someone else's platform, so the step is printed with its caveat instead of guessed at.

This retires `TargetOutput.secret`, which was absent for `deno` and `modal` on the grounds that their commands were unverified — the two hosts whose secret command is least guessable, so both fell back to "Set it in the ⟨target⟩ environment" and named nothing to run. The warning now reads the resolved `perSecret` step, so it and the printed sequence cannot name two different commands. `node` is unchanged and still prints no deploy sequence: it deploys nowhere, and the scaffold's `prestart` already chains a build to `aai start`.

Separately, every target's bundle is now emitted without JSDoc (`comments: { legal: true, annotation: true, jsdoc: false }`). A commented `import()` is an edge in the module graph, so `deno info` on the emitted entry reported nine unresolvable specifiers — from undici, from html-to-text and from this SDK's own workflow docs — against an artifact whose `app.py` header claims "a bundle with no imports left to resolve". Deno Deploy tolerates them today; `deno info`, `deno check` and `@vercel/nft` all walk graphs rather than executing them. `annotation` and `legal` are kept deliberately: the first carries `@__PURE__` (6043 of them, an instruction to the tree-shaker), the second the licences of every third-party package inlined here. The bundle also gets ~1.5 MB smaller.

Both targets are verified live — HTTP on `/health`, `/client-config` and `/`, plus a real voice session returning the greeting and TTS audio frames, on Modal and on Deno Deploy.
