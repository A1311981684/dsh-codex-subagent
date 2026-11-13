# Changelog

All notable changes to this project are documented here. The format follows a
simple version-per-release list; this project is pre-1.0 and versioned by
capability, not by compatibility guarantees.

## 0.1.0

First version.

- New DSH bundle `dsh-codex-subagent`: it registers its own `codex` tool and
  turns the local `codex-dev` wrapper into an out-of-process subagent.
- A private `CODEX_HOME` per run (`<sessionDir>/home`, mode 700), seeded with a
  copy of the user's `config.toml` and `auth.json`, so `~/.codex` is never
  written to.
- Codex's `--json` NDJSON event stream is projected into a real DSH child
  session: a `subagent/descriptor` v3 and a parent `subagent/catalog` row, one
  step per Codex turn, `assistant/message` blocks for replies, reasoning and
  command calls, `tool/call` + `tool/result` for every `command_execution`, and
  a `turn/end` with the run's real end state.
- Delegations can be continued: the returned `session` id maps to the Codex
  `thread_id` from `thread.started`, and a later call resumes the same child
  session and the same Codex thread (`codex exec resume`).
- `logMode: "summary"` (default) writes a few-KB log per run; `logMode: "full"`
  lets the wrapper tee the raw event stream.
- `labelPrefix` (default `'codex · '`): every newly projected child session's label
  is prefixed so Codex rows stand out from Pi/Claude Code rows in DSH's subagent
  panel. Set it to `''` to disable the prefix. Existing catalog rows keep their old
  labels, and a continuation keeps the label it was opened with.
- One line per run is appended to the delegation record
  (`$HOME/.dsh/codex-delegations.log`).
- `scripts/cleanup.mjs` prunes old logs by age (`--dry-run` supported) and can
  list — never delete — old Codex thread candidates (`--sessions`).
- Tests: 64 `node --test` cases covering the wrapper, the tool/projection, and
  the cleanup script, plus the opt-in `test/real-codex.mjs` end-to-end check
  that runs the real Codex CLI twice (create + resume).
