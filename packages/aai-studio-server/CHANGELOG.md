# aai-studio-server

## 0.13.2

### Patch Changes

- Updated dependencies [502507c]
  - @alexkroman1/aai-runtime@0.18.2
  - aai-server@0.2.11
  - @alexkroman1/aai@0.18.2
  - @alexkroman1/aai-ui@0.18.2
  - aai-studio-client@0.7.21

## 0.13.1

### Patch Changes

- Updated dependencies [dea550d]
  - @alexkroman1/aai-runtime@0.18.1
  - aai-server@0.2.10
  - @alexkroman1/aai@0.18.1
  - @alexkroman1/aai-ui@0.18.1
  - aai-studio-client@0.7.20

## 0.13.0

### Minor Changes

- e7cc510: Voice input for the studio composer via AssemblyAI's dictation API, with every
  piece available to framework users. The SDK adds `transcribeDictation()`,
  `handleDictationRequest()` (a web-standard `Request → Response` dictation route:
  body cap, call, `{ text } | { error }` reply) and the `DICTATION_*` limits on
  `@alexkroman1/aai/experimental`; `stepTranscribeSync` now builds on
  `transcribeDictation`. aai-ui adds `useDictation` (record one clip, hand it to
  your `transcribe` callback, get the words back; `buttonProps` and `disabled` for
  the mic button), `dictationTranscriber` (the matching `transcribe`) and
  `appendDictation`. The studio gains `POST /studio/dictation` on the caller's own
  key and a mic button in the chat composer.

### Patch Changes

- 21ec93b: Studio: rotating the account API key releases the old key's owner mapping, so
  its holder's CLI no longer lands in the rotating account's scope; DELETE …/file
  deletes an empty file and 404s a name only the file map's prototype holds
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [ac38a37]
- Updated dependencies [1f6553d]
- Updated dependencies [f1a994b]
- Updated dependencies [1f6553d]
- Updated dependencies [f1a994b]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [5a7e065]
- Updated dependencies [1f6553d]
- Updated dependencies [21ec93b]
- Updated dependencies [f40ff5e]
- Updated dependencies [1f6553d]
- Updated dependencies [6a967bc]
- Updated dependencies [5a7e065]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [e7cc510]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [f40ff5e]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1d6304d]
- Updated dependencies [90f9990]
- Updated dependencies [1f6553d]
- Updated dependencies [fccf609]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [af9fb16]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
- Updated dependencies [1f6553d]
  - @alexkroman1/aai-runtime@0.18.0
  - @alexkroman1/aai@0.18.0
  - @alexkroman1/aai-ui@0.18.0
  - aai-server@0.2.9
  - aai-studio-client@0.7.19

## 0.12.1

### Patch Changes

- Updated dependencies [a8a37ac]
- Updated dependencies [eb14ffe]
- Updated dependencies [1418d62]
- Updated dependencies [b1d73be]
- Updated dependencies [1262e21]
- Updated dependencies [8f93cca]
- Updated dependencies [130bc0c]
  - @alexkroman1/aai@0.17.0
  - @alexkroman1/aai-runtime@0.17.0
  - aai-server@0.2.8
  - @alexkroman1/aai-ui@0.17.0
  - aai-studio-client@0.7.18

## 0.12.0

### Minor Changes

- 06d09d5: AssemblyAI streaming TTS now follows the documented API
  (https://www.assemblyai.com/docs/tts): it dials
  wss://tts.us.assemblyai.com/v1/ws (or tts.eu.assemblyai.com, which
  assemblyAIPipeline({ region: "eu" }) now selects), sends voice_id instead of the
  retired voice param, and splits Generate text at the 2000-character per-frame
  cap, so a long stepSpeak no longer fails. Breaking: voices are voice_id slugs —
  assemblyAITts({ voice: "aai-jane" }), not "jane" — and ASSEMBLYAI_TTS_VOICES is
  now a tuple of the 11 library slugs, every one of which speaks all six
  languages; ttsVoiceIds, ttsVoiceInfo and AssemblyAITtsVoiceInfo are removed (use
  z.enum(ASSEMBLYAI_TTS_VOICES)), as is the voice/language mismatch check.

### Patch Changes

- f5ca0c1: Keep deployed agents reachable through a platform deploy: a shutting-down
  replica hands its agent guests off to the fleet instead of draining them (a
  draining guest held its sandbox name and refused every new session for up to ten
  minutes), and a guest sandbox now stops the moment its harness exits, releasing
  its name.
- f5ca0c1: Studio: a replica going down in a deploy now drains its coding-agent sandboxes
  (bounded) before terminating them, and the client regenerates a turn whose
  sandbox dropped mid-stream instead of showing an error.
- Updated dependencies [f5ca0c1]
- Updated dependencies [06d09d5]
  - aai-server@0.2.7
  - @alexkroman1/aai@0.16.0
  - @alexkroman1/aai-runtime@0.16.0
  - aai-studio-client@0.7.17
  - @alexkroman1/aai-ui@0.16.0

## 0.11.32

### Patch Changes

- 983511d: Offer studio starter prompts for eleven more templates: hotel reception, travel
  concierge, technical support, front desk, home assistant, executive inbox,
  applicant screening, research planner, topic briefing, push-to-talk notes and
  the word game.
- Updated dependencies [b2e8001]
- Updated dependencies [265e845]
  - aai-server@0.2.6
  - @alexkroman1/aai@0.15.5
  - @alexkroman1/aai-runtime@0.15.5
  - @alexkroman1/aai-ui@0.15.5
  - aai-studio-client@0.7.16

## 0.11.31

### Patch Changes

- Updated dependencies [d6bf377]
- Updated dependencies [effb401]
  - @alexkroman1/aai-ui@0.15.4
  - aai-server@0.2.5
  - aai-studio-client@0.7.15
  - @alexkroman1/aai@0.15.4
  - @alexkroman1/aai-runtime@0.15.4

## 0.11.30

### Patch Changes

- d87b9ff: Studio GitHub: route the OAuth code exchange and the user-installations check
  through Octokit (`@octokit/oauth-methods`, `@octokit/plugin-paginate-rest`)
  instead of raw fetch, and recognise GitHub errors by `RequestError`.
- e870563: Studio prompt: the coding agent now ends a turn that adds a secret-reading tool
  with a "Secrets to set" list naming each secret, what it is for, and where to
  get it.
- 4a291dd: Studio packages reuse shared SDK helpers (runCapped, LogLine/formatLogTime,
  estimateMessageTokens, walkWorkspaceFiles, ai UI-message helpers) instead of
  hand-rolled copies; the studio adopt fetch now aborts on timeout.
- 04c1b13: Studio: the home sidebar lists projects most recently worked on first, like
  other coding agents' chat lists, instead of alphabetically.
- Updated dependencies [4a291dd]
  - @alexkroman1/aai@0.15.3
  - aai-server@0.2.4
  - @alexkroman1/aai-runtime@0.15.3
  - aai-studio-client@0.7.14
  - @alexkroman1/aai-ui@0.15.3

## 0.11.29

### Patch Changes

- 887fc58: Studio project header is one row split at the chat column: pane tabs and preview
  chrome move into the top bar, the canvas toolbar row is gone, and Live status
  shows as a dot on Publish
- 3ba3a1e: Studio home sidebar: quieter project search with multi-term matching, match
  highlighting, and keyboard shortcuts (/, Enter, Esc, arrows)
- aai-server@0.2.3
  - @alexkroman1/aai@0.15.2
  - @alexkroman1/aai-runtime@0.15.2
  - @alexkroman1/aai-ui@0.15.2
  - aai-studio-client@0.7.13

## 0.11.28

### Patch Changes

- a03cdca: Slim the studio to voice agents only: remove the Voice agent / Workflow project
  kind (one system prompt, one starter list), the API, Workflows and Logs panes,
  the public /studio/api/<slug> page, and the Secrets pane's .env paste box. The
  Twilio and Telnyx webhook URLs move to the Settings pane.
- 9ed592e: Studio Code pane says the project's code is the user's to keep, and links to
  GitHub sync where the platform has it.
- af984c9: Redesign the studio UI: a builder layout with the chat column beside one framed
  canvas whose toolbar holds the pane tabs and a browser bar for the UI pane
  (reload, desktop/phone, open in a tab); consecutive tool calls fold into one
  step row; a card composer; sentence-case controls on one spacing and
  control-height system; Log out moves into the Account panel. Also restores
  markdown list bullets in the chat (a stale Tailwind @source path dropped every
  aai-ui class).
- Updated dependencies [89737d1]
- Updated dependencies [a03cdca]
- Updated dependencies [9ed592e]
  - @alexkroman1/aai-runtime@0.15.1
  - aai-server@0.2.2
  - @alexkroman1/aai-ui@0.15.1
  - aai-studio-client@0.7.12
  - @alexkroman1/aai@0.15.1

## 0.11.27

### Patch Changes

- Updated dependencies [1949e58]
  - aai-server@0.2.1

## 0.11.26

### Patch Changes

- Updated dependencies [851a4ab]
  - @alexkroman1/aai@0.15.0
  - aai-server@0.2.0
  - @alexkroman1/aai-runtime@0.15.0
  - aai-studio-client@0.7.11
  - @alexkroman1/aai-ui@0.15.0

## 0.11.25

### Patch Changes

- Updated dependencies [d266c27]
  - aai-server@0.1.5
  - @alexkroman1/aai@0.14.4
  - @alexkroman1/aai-runtime@0.14.4
  - aai-studio-client@0.7.10
  - @alexkroman1/aai-ui@0.14.4

## 0.11.24

### Patch Changes

- Updated dependencies [d648b81]
  - @alexkroman1/aai@0.14.3
  - @alexkroman1/aai-runtime@0.14.3
  - aai-server@0.1.4
  - aai-studio-client@0.7.9
  - @alexkroman1/aai-ui@0.14.3

## 0.11.23

### Patch Changes

- Updated dependencies [d66b0c3]
- Updated dependencies [d66b0c3]
- Updated dependencies [f7c51dc]
  - aai-server@0.1.3
  - @alexkroman1/aai@0.14.2
  - @alexkroman1/aai-runtime@0.14.2
  - aai-studio-client@0.7.8
  - @alexkroman1/aai-ui@0.14.2

## 0.11.22

### Patch Changes

- Updated dependencies [7554cd0]
  - @alexkroman1/aai-ui@0.14.1
  - aai-server@0.1.2
  - aai-studio-client@0.7.7
  - @alexkroman1/aai@0.14.1
  - @alexkroman1/aai-runtime@0.14.1

## 0.11.21

### Patch Changes

- 5fa348b: Pay down debt-report ledgers: share the cause-chain walk, the runtime-file copy
  and the tool-message list normalizer; drop four `as never` casts behind typed
  seams
- 016e6ee: Slow test tiers are vitest projects selected with --project; no runtime change.
- 8820f2c: Replace truthiness-guarded conditional spreads with explicit presence checks
  (omitUndefined, != null, === true), so an empty-string body forwarded to a guest
  is no longer dropped; guard-invariants rule 22 is now enforced at zero.
- 0bc4deb: Studio guest: the end-of-turn TURN-COMPLETE sync now waits for in-flight
  workspace checkpoints, so a stale mid-turn checkpoint can no longer land after
  it; and a session-init for a different project arriving during the sandbox's
  first install is refused instead of being handed a session over the first
  project's tree.
- b77171d: Studio idle reaping binds the sandbox with `await using`, so it is terminated
  even if a release step throws; the remaining hand-rolled waits use the shared
  primitives.
- d6ed79e: Studio client test suites assert through jest-dom matchers and type through
  user-event (test-only; the client's devDependencies change).
- 5fa348b: Give every module a co-located test and remove every vi.mock: collaborators the
  specs used to mock by module are now optional injected seams that default to the
  real implementation
- 2dcbe80: Refuse an over-size secret update with a 413 before anything is written: the 64
  KiB env cap is now checked on the merged project record and on every agent's
  merged env, so a refused PUT no longer leaves the value in the project record.
  The per-slug secret PUT and a deploy with an oversized env answer 413 instead of
  500, and a project record already over the cap is applied name-by-name at deploy
  with a warning instead of failing silently.
- Updated dependencies [5fa348b]
- Updated dependencies [016e6ee]
- Updated dependencies [f6aa687]
- Updated dependencies [3c0d0dd]
- Updated dependencies [67f7354]
- Updated dependencies [8820f2c]
- Updated dependencies [f869b6a]
- Updated dependencies [b77171d]
- Updated dependencies [66953d5]
- Updated dependencies [dd2e1db]
- Updated dependencies [99400e3]
- Updated dependencies [5fa348b]
- Updated dependencies [5ded42b]
- Updated dependencies [a9267f2]
- Updated dependencies [3969f74]
- Updated dependencies [99400e3]
- Updated dependencies [2dcbe80]
  - @alexkroman1/aai@0.14.0
  - aai-server@0.1.1
  - @alexkroman1/aai-runtime@0.14.0
  - aai-studio-client@0.7.6
  - @alexkroman1/aai-ui@0.14.0

## 0.11.20

History before the `0.x` reset lives in git.
