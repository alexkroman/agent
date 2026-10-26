---
"@alexkroman1/aai-cli": minor
---

Harden the `aai` CLI against hostile servers, cloned repos and odd argv, after an adversarial test pass.

- `aai publish` now syncs only the values written in the project's dotenv files. It no longer fills declared keys from your shell, and it refuses a symlinked `.env` that points outside the project.
- `aai pull` no longer writes `.git/`, `.aai/`, `.env`, lockfiles or `node_modules/`. It never writes through a symlink and checks the whole file map before writing anything.
- API requests no longer follow redirects. They also have a timeout and a response size cap.
- Text from the server or agent can no longer send terminal escape sequences.
- `aai delete` asks for confirmation at a terminal and needs `--yes` otherwise.
- Bare `aai` with piped stdout no longer publishes.
- `--server` must be a non-empty http(s) URL.
- `-v` after a subcommand prints the version instead of running the command.
- Extra positional arguments and non-decimal numbers are now refused.
- In JSON mode, `aai dev`, `aai test`, `aai eval` and `aai build` keep their logs off stdout.
- A broken pipe no longer turns a failure into exit code 0.
