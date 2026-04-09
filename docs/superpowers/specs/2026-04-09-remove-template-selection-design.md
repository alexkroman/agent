# Remove Template Selection from CLI

## Problem

The `aai init` command offers 17 templates via an interactive selection
prompt. This adds friction for both humans and AI agents. The simple
template is the right starting point in nearly all cases — users build
what they need from there. Template browsing is decision paralysis, not
productivity.

## Goal

`aai init my-agent` creates a project from the simple template with no
questions asked. Template selection is removed entirely from the CLI.

## Design

### What changes

| Area | Change |
|------|--------|
| `init.ts` | Remove `promptTemplate()`. Always use `"simple"`. |
| `cli.ts` | Remove `--template` / `-t` arg from init command |
| `_templates.ts` | Remove `listTemplates()` export. Keep `downloadAndMergeTemplate()` (used by `_init.ts`). |
| `_init.ts` | `runInit()` no longer accepts `template` param — hardcodes `"simple"` |
| `init.test.ts` | Remove template selection tests, update existing tests |
| `integration.test.ts` | Update init tests that reference templates |
| `cli.test.ts` | Update help snapshot (no `--template` flag) |
| scaffold `CLAUDE.md` | Remove template list and `aai init -t` references |

### What doesn't change

- Simple template content (agent.json, client.tsx, agent.test.ts)
- Scaffold files (package.json, vite config, tsconfig, etc.)
- Merge algorithm in `_init.ts`
- `packages/aai-templates/templates/` directory (stays in repo as examples)
- Deploy flow after init

### Init flow after change

```
aai init my-agent        # Creates my-agent/ with simple template
aai init                 # Creates my-voice-agent/ with simple template (default name)
aai init my-agent --yes  # Same as above (--yes is now a no-op for init)
```

No `--template`, no `--force` (no template means no "which template"
decision). The `--force` flag stays for overwriting existing directories.

### Scaffold CLAUDE.md changes

Remove:
- The "18 Template Examples" list
- `aai init [-t template]` syntax — replace with just `aai init [dir]`
- Any "check existing templates before custom code" guidance

Keep:
- All API reference content (agent.json, tools, hooks, KV, testing, etc.)
- The workflow guidance (understand intent, start minimal, verify with build)
