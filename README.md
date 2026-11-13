# dsh-codex-subagent

<p align="center"><img src="icon.svg" width="96" height="96" alt="dsh-codex-subagent icon"></p>

English | [中文](README.zh.md)

A [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) bundle that turns the local
[Codex CLI](https://github.com/openai/codex) into an **out-of-process subagent** with an
inspectable child session. DSH's model hands a development task to Codex the way it hands
one to the official Codex or Claude Code subagents, gets Codex's answer back, and can
afterwards open the run as a real, read-only DSH child session: the task text, Codex's
reasoning and replies, its command calls and their output, and how the run ended.

The plugin registers its own `codex` tool and runs one `codex-dev` child per call. The
child session is created before the process starts, and Codex's `--json` NDJSON event
stream is then projected line by line as it arrives: one step per Codex turn, command calls
with their results, reasoning and reply text, with real timestamps. The parent's catalog row
is appended up front too, so the child appears in DSH's subagent list while the task is
still running and opens as read-only history.

Unlike the official [`@deepseek-ai/dsh-subagent-codex`](https://www.npmjs.com/package/@deepseek-ai/dsh-subagent-codex)
(which exposes `subagent_codex`), this plugin's child session is **openable**, **continuable**
(pass the returned id back to keep Codex's own thread), and **logged** (summary or full, plus
the delegation record). Do not enable both as coding backends in one profile: they would
offer two competing Codex tools to the model.

## The thin shell

The plugin deliberately owns almost nothing about *how* Codex runs. That stays inside the
`codex-dev` wrapper:

1. a private `CODEX_HOME` per run — `<sessionDir>/home` for a persistent plugin run, a
   throwaway directory for a bare wrapper call — so `~/.codex` is never written to;
2. the user's `config.toml` and `auth.json` copied into that private home (the login copy is
   mode `600`); `config.toml` is overwritten on every run;
3. the credential handoff: an existing `DEEPSEEK_API_KEY` wins; otherwise a copied
   `auth.json` (a `codex login`) is enough; otherwise the DeepSeek key is read from
   `~/.pi/agent/auth.json` into the environment (never printed, never written to disk);
4. the fixed rules (`rules/CODEX-DEV-RULES.md`) prepended to every brief;
5. no pinned model: the copied `config.toml` names it, so a run follows the same model as an
   interactive `codex` (`--model` / `CODEX_DEV_MODEL` override it);
6. the sandbox policy (`-s <mode>` for a new thread, `-c sandbox_mode=<mode>` for a resumed
   one) and the optional bypass switch;
7. Codex's session storage under the private `CODEX_HOME`, so a thread can be resumed;
8. `--log` tee'ing the full output to a file (the plugin asks for it only in
   `logMode: "full"`);
9. one line appended to the delegation record after every run.

The plugin itself only does two things:

1. **run the delegation** — validate the arguments, write the brief to a scratch directory,
   spawn `codex-dev` (plain `node:child_process`), parse its stdout as NDJSON incrementally,
   keep only the stderr tail for diagnostics, escalate SIGTERM → SIGKILL on cancellation, and
   take the final answer from Codex's last `agent_message`;
2. **project the run live** — create a real DSH child session (`sessions.prepare` +
   `sessionPersistence.create` + `enter`/`announce`) and append its opening events plus the
   parent's `subagent/catalog` row *before* spawning the child, then stream one event per
   Codex record: `step/start`…`step/end` per Codex turn, `assistant/message` with
   reasoning/text/tool-call blocks, `tool/call` + `tool/result` for every command execution,
   and a `turn/end` with the run's real reason; finally flush both sessions (a retained child
   stays open so a later call can append another turn, until the plugin unloads).

It imports no `@deepseek-ai/*` package and has no runtime dependencies — only `node:`
built-ins. DSH injects the `tools`, `sessions`, and `sessionPersistence` services. Every
projection step is best-effort: if a service is missing or an append is rejected, the plugin
logs one warning and still returns Codex's answer.

### Bundled `codex-dev` wrapper

`bin/codex-dev` is the wrapper this plugin was developed against, and its contract is the
only thing the plugin knows: `--brief`, `--cwd`, `--log`, `--model`, `--thinking`,
`--mode text|json` (the plugin always passes `--mode json`), `--session-id`,
`--session-dir`, `--sandbox`, `--bypass`, plus `config.args` appended last; stdout is the
answer (the NDJSON event stream in JSON mode) and the exit code decides success. To use the
bundled one, copy it to `~/.dsh/bin/codex-dev`, symlink it there (the wrapper resolves its
own symlinks, so the bundled rules file is still found), or point the `command` config field
at the package's `bin/codex-dev`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `CODEX_BIN` | `codex` (from `PATH`) | The Codex executable to run. |
| `CODEX_DEV_RULES` | `<wrapper's real dir>/../rules/CODEX-DEV-RULES.md` | Fixed rules file prepended to the brief. |
| `CODEX_HOME_SRC` | `$HOME/.codex` | The user's installation whose `config.toml`/`auth.json` are copied in. |
| `CODEX_DEV_RECORD_DIR` | `$HOME/.dsh` | Directory for `codex-delegations.log`. |
| `CODEX_DEV_MODEL` | empty | Default `--model`; empty means "whatever `config.toml` names". |
| `CODEX_DEV_SESSION_DIR` | `$HOME/.dsh/codex-sessions` | Codex state root for a `--session-id` run without `--session-dir`; without either, a bare wrapper call uses a throwaway directory. |

## Requirements

- **Node.js** `^22.19.0 || >=24.0.0` and **DSH** `>= 0.2.2-rc.1`.
- **Codex CLI** on `PATH` as `codex` (or via `CODEX_BIN`). Measured here against
  codex-cli **0.168.0**; the JSON event format is Codex's own and may change between
  versions.
- **A usable credential**, in one of three forms:
  - `DEEPSEEK_API_KEY` in the environment (wins over everything else);
  - a Codex login, i.e. `~/.codex/auth.json` from `codex login` (copied into the private
    `CODEX_HOME`, so the plugin then runs Codex's native authentication);
  - a DeepSeek key saved with `pi auth login deepseek` (read from
    `~/.pi/agent/auth.json` and exported for the child only).

  With none of the three the wrapper exits `2` and the error names all three routes. No key
  is ever printed.

## Install

This package is a DSH bundle: `package.json` declares
`dsh.bundle.patch = ./cordis.patch.yml`, so installing the package is enough — the patch
mounts the plugin (`id: subagent-codex-cli`, `name: dsh-codex-subagent`), which registers
the `codex` tool and projects child sessions, and it shows up as a card under
**Plugins → Installed** in the web app.

```bash
# from npm
dsh plugin --profile web add dsh-codex-subagent

# from GitHub
dsh plugin --profile web add git+https://github.com/A1311981684/dsh-codex-subagent.git

# from a local checkout
dsh plugin --profile web add file:/path/to/dsh-codex-subagent
```

Or add it to the profile manifest `~/.dsh/profiles/<name>/package.json` and let the profile
resolve it from its own `node_modules`:

```json
{
  "dependencies": {
    "dsh-codex-subagent": "file:/path/to/dsh-codex-subagent"
  },
  "dsh": {
    "profile": {
      "bundles": ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-web-app", "dsh-codex-subagent"]
    }
  }
}
```

After installing, restart DSH (or let HMR reload). The model gains a `codex` tool. No extra
environment variable is needed as long as `codex-dev` can find a credential itself.

If you would rather compose the row by hand — for example to set config values — add it to
the profile's own `cordis.patch.yml`. One row is enough; the plugin registers its own
`codex` tool:

```yaml
- insert:
    - id: subagent-codex-cli
      name: dsh-codex-subagent
      config:
        # command: /usr/local/bin/codex-dev
        # sandbox: workspace-write
        # logDir: /home/me/.dsh/codex-logs
        # logMode: summary
        # sessionDir: /home/me/.dsh/codex-sessions
        # graceMs: 5000
        # projection: true
```

## Configuration

All fields are optional; the bundle patch passes none of them.

| Field | Default | Description |
| --- | --- | --- |
| `command` | `$HOME/.dsh/bin/codex-dev` | The wrapper to execute. Set it when yours lives elsewhere. |
| `args` | `[]` | Extra arguments appended after everything else. |
| `model` | — | When set, passed as `--model`; otherwise the wrapper leaves it to `config.toml`. |
| `thinking` | — | When set, passed as `-c model_reasoning_effort=<level>` (accepted by both `codex exec` and `codex exec resume`). |
| `projection` | `true` | Project each run into a DSH child session. `false` only runs the delegation and writes the log. |
| `labelPrefix` | `codex · ` | Prefix added to every new child session's label, so Codex rows are recognizable next to rows from other backends. Set to `''` to disable it. It only affects rows created after it is set; existing catalog rows keep their old labels. |
| `logMode` | `summary` | `summary` (default) writes a compact log itself; `full` asks the wrapper to tee the whole output (`--log`), which in JSON mode is the raw event stream and can be tens of MB. |
| `logDir` | `$HOME/.dsh/codex-logs` | Where logs go, named `<YYYYMMDD-HHmmss>-<id 8 chars>.log`. |
| `sessionDir` | `$HOME/.dsh/codex-sessions` | The Codex state root, passed as `--session-dir`; the run uses `<sessionDir>/home` as `CODEX_HOME`. |
| `graceMs` | `5000` | SIGTERM → SIGKILL grace for a cancelled child. |
| `maxOutputBytes` | `262144` | In-memory cap for the retained stderr tail and the raw-stdout fallback; the tail is kept. |
| `sandbox` | `workspace-write` | `read-only`, `workspace-write`, or `danger-full-access`; passed as `-s` for a new thread and `-c sandbox_mode=…` for a resumed one. |
| `dangerouslyBypass` | `false` | **Dangerous.** When `true`, adds `--dangerously-bypass-approvals-and-sandbox`, so Codex runs unrestricted. Leave it off unless the process is already sandboxed externally. |

Validation happens at mount time, so a bad value is a load error rather than a surprise on
the first delegation: `graceMs` and `maxOutputBytes` must be positive finite numbers,
`command`, `logDir`, and `sessionDir` must be non-empty strings, `logMode` must be
`"summary"` or `"full"`, `sandbox` must be one of the three modes above, `args` must be an
array of strings, `projection`/`dangerouslyBypass` must be booleans, and `labelPrefix` must be
a string without control characters (an empty string is allowed).

## The tool

The plugin registers one tool, `codex`:

- `prompt` (required) — the complete, self-contained task; Codex does not see the parent
  conversation;
- `cwd` (optional) — absolute working directory that must exist; defaults to the calling
  session's working directory;
- `label` (optional) — short label for the child session shown in DSH's subagent list;
  defaults to the first non-empty line of `prompt` prefixed with `labelPrefix`, at most 60
  characters including the prefix. An explicit `label` also gets the prefix, but is not
  truncated;
- `session` (optional) — a child session id returned by an earlier call, to continue that
  delegation.

The tool value is `{ output, childSessionId, session, logPath, stopReason }`, plus
`diagnostic` when the run failed. The model sees the final answer, an optional diagnostic,
a `subagent session: <id>` line, a `to continue this delegation, pass session: <id>` hint,
and a `full output: <log path>` line. `stopReason` is `completed`, `error`, or `aborted`.

A child session id is only continuable in the host process that opened it. After a DSH
restart the plugin returns a clear error
(`session <id> is not continuable in this host process; omit session to start a new one`)
instead of silently starting a fresh run.

## Session projection

Every delegation with `projection: true` (the default) also produces a real DSH child
session, created *before* Codex starts:

1. `sessions.prepare(childId, { meta })` with the child's `cwd`, `parentSession`,
   `origin: 'subagent'`, and `delegationDepth` (the parent's depth + 1), then
   `sessionPersistence.create(session.header, { inheritedEventCount: 0 })`, the
   pre-publication event suffix, `enter`, and `announce` — the same order `dsh-agent-loop`
   uses;
2. the child's opening events, still before the process exists: `turn/start` (DSH turn 1),
   `subagent/descriptor` (version 3, `mode: 'one-shot'`, `provider: 'codex'`, the label), and
   the task text as `user/message`; the parent's `subagent/catalog` row (version 0) follows
   immediately, so the child is listed while Codex works;
3. stdout is parsed line by line (a partial line is buffered; a line over 2 MiB is dropped
   with a warning) and each Codex record becomes one event:
   - `thread.started` → the run's Codex thread id (used for continuation);
   - `turn.started` → `step/start`: **one Codex turn is one DSH step**;
   - `item.started` (`command_execution`) → `assistant/message` with a `tool-call` block
     plus the matching `tool/call`, both carrying the identical serialized arguments;
   - `item.completed` (`command_execution`) → `tool/result` with the aggregated output and
     the error state;
   - `item.completed` (`agent_message`) → `assistant/message` with a text block; the last one
     is the answer returned to the parent;
   - `item.completed` (`reasoning`) → `assistant/message` with a `reasoning` block;
   - `item.completed` (`error`) → a non-fatal Codex warning: logged, kept for the compact
     log, never turned into a failed turn;
   - `item.updated` → nothing (progress refinement only);
   - `turn.completed` → usage totals recorded for the compact log, then `step/end`;
   - `turn.failed` or a top-level `error` → the run is marked failed, then `step/end`;
4. both sessions are flushed; the child is then kept live (not detached, handle open) so a
   later call can append the next turn, and it is released when the plugin unloads.

The order is not cosmetic: the durable log is relationship-checked when it is restored. A
`step/end` is rejected while an advertised `tool/call` has no `tool/result`, a `turn/end` is
rejected while a step is open, `tool/call` arguments must equal the `tool-call` block's
string exactly, and `step` numbers must run 1, 2, 3… inside the open turn. Normal end,
failure, and cancellation all funnel through the same finalizer, so the log always has
matched brackets and a `turn/end`. The raw Codex event stream never enters the parent
session; the parent only gets the `subagent/catalog` row.

**Degradation.** The projection is best-effort and never affects the delegation:

- a missing `sessions`/`sessionPersistence` service, or a rejected `prepare`/`create`/opening
  append, logs one `warn` and returns the result with an empty `childSessionId`;
- a rejected append mid-run logs one `warn`, stops projecting further content, and still
  appends the structural closers (`step/end`, `turn/end`);
- a child that printed plain text instead of NDJSON is not retried: the whole stdout becomes
  the single answer and the projection still records the prompt and the end state;
- a non-zero exit or `turn.failed` gives `stopReason: 'error'` with the tail of stderr as the
  diagnostic (capped at 4096 bytes); a clean exit without any `agent_message` is also an
  error, because the tool promises to return an answer.

## Session reuse

Every `codex` result carries `session` (the child session id). Passing it back continues that
delegation:

- the same DSH child session gets a new turn (number = last recorded turn + 1) with its own
  task text and its own step numbering; no second `subagent/descriptor` and no second parent
  `subagent/catalog` row;
- `codex-dev` is started with `--session-id <thread_id> --session-dir <sessionDir>`, so Codex
  continues its own thread — the files it read, its decisions, and its tool history are still
  there, and the task usually gets cheaper. A fresh delegation also gets `--session-dir`
  (every run does), so its thread is stored under `<sessionDir>/home` and can be continued
  later;
- `thread_id` (from `thread.started`) is the continuation id and lives only in the plugin's
  in-process registry; the child session and its write handle stay live until a later turn or
  plugin unload;
- only one run per session at a time: a concurrent call fails with `session <id> is already
  running`;
- a session that reported no thread id cannot be continued, and says so instead of silently
  starting a fresh delegation.

`codex exec resume` accepts neither `-C/--cd` nor `-s/--sandbox`, so a continuation keeps the
working directory recorded with the thread, and the wrapper passes the sandbox as
`-c sandbox_mode=<mode>`. Measured against codex-cli 0.168.0: a thread created with
`-s read-only` could still write when resumed with `-c sandbox_mode=workspace-write`, so that
config override **does** take effect on a continuation. This is an empirical result for that
version, not a documented guarantee.

## Behavior details and limitations

- **A private `CODEX_HOME`.** Each plugin run uses `<sessionDir>/home` as `CODEX_HOME`
  (mode `700`), seeded with a copy of the user's `config.toml` (overwritten every run) and
  `auth.json` (copied only when present, mode `600`). `~/.codex` is therefore left
  untouched — but the flip side is that these threads are invisible to a terminal
  `codex resume` listing: they live in the plugin's own state directory, not `~/.codex`.
- **Item types that are not projected.** `file_change` and `mcp_tool_call` (and anything
  Codex adds later) are skipped with one `warn` per type: they do not crash the delegation
  and do not appear as tool calls in the child session. Command executions are the only tool
  calls projected.
- **Output caps.** One stdout line over 2 MiB is dropped whole with a `warn`;
  `maxOutputBytes` bounds the retained stderr (and the raw-stdout fallback), keeping the
  tail.
- **No timeout.** The plugin never kills a run on its own schedule: it waits for the child,
  and cancellation of the calling tool (`exec.signal`) is what stops it — SIGTERM first,
  SIGKILL after `graceMs`. The child session's turn is then closed as `aborted`.
- **No independent Stop for a child.** The child session is rendered as read-only history;
  only cancelling the delegation in the parent conversation stops the run.
- **Sandbox needs bubblewrap.** Codex's `workspace-write`/`read-only` sandboxes rely on
  bubblewrap and user namespaces on Linux; on a host where those are unavailable, Codex's own
  sandboxing fails (the plugin does not change that). `danger-full-access` or
  `dangerouslyBypass` avoid it at the cost of real isolation.
- **Labels carry a backend prefix.** A new child session's label starts with `labelPrefix`
  (default `codex · `), so Codex rows are easy to tell apart from Pi (`pi · `) and Claude Code
  (`claude · `) rows in DSH's subagent panel. A continuation keeps the label it was opened
  with, and an existing catalog row is never rewritten.
- **One tool at a time per session**, and each new delegation is otherwise isolated: its own
  scratch brief (always removed, even on failure), its own child session id, and its own
  process state.

## Security

One local `codex` process per delegation, a private `CODEX_HOME`, no runtime
dependencies, no install scripts, and no network code in the plugin itself.

- Credentials are exported to the child only; the copy of `~/.codex/auth.json`
  in the private `CODEX_HOME` is mode `600`, and `~/.codex` is never written to.
- The default sandbox is `workspace-write`; `dangerouslyBypass` is opt-in and
  documented as dangerous.
- Logs and the delegation record contain task text and command output; treat
  `$HOME/.dsh/codex-logs` as sensitive.
- The Codex child inherits the DSH host environment, exactly as `codex` would
  inherit a terminal's environment.

Full details, including how to report a vulnerability, are in
[SECURITY.md](SECURITY.md).

## Logs and cleanup

`logMode` (default `summary`) decides what one delegation writes to
`<logDir>/<YYYYMMDD-HHmmss>-<id 8 chars>.log`:

- `summary` — the plugin writes the file itself: the task's first line (at most 100
  characters), the final answer, one `tool <name> <durationMs>ms <ok|error>` line per
  command, and one line with the summed usage (`input`/`output`/`cacheRead`/`cacheWrite`/
  `reasoning`), `stopReason`, the child session id, and the Codex thread id; non-fatal Codex
  notes follow as `note …` lines. Usually a few KB.
- `full` — the wrapper tees Codex's whole output (`--log`), which in JSON mode is the raw
  event stream and can reach tens of MB on a long task.

In `summary` mode the tool's `logPath` is empty when the write failed; in `full` mode it is
the path handed to the wrapper. Old logs are never removed automatically:

```bash
node scripts/cleanup.mjs [--days 14] [--dry-run] [--sessions]
```

It deletes `$HOME/.dsh/codex-logs` files older than N days and prints the count and the freed
space; `--dry-run` only lists them. `--sessions` additionally **lists** (never deletes) old
Codex thread candidates — the `*.jsonl` rollout files under
`<sessionDir>/home/sessions/**`, where `sessionDir` is `$HOME/.dsh/codex-sessions` unless
`CODEX_DEV_SESSION_DIR` overrides it. Deleting one of those threads breaks the continuation
of the DSH child session that refers to it, so the script prints that warning and removes
nothing.

## Development and testing

```bash
cd dsh-codex-subagent
node --check lib/index.js
bash -n bin/codex-dev
node --test test/            # 58 unit tests, all green, no network and no model call
node test/real-codex.mjs     # opt-in: two real Codex runs (create + resume), small cost
```

- `test/tool.test.js` mounts the plugin on a fake `ctx` (`tools.register`, `sessions`,
  `sessionPersistence`, `logger`) and runs real child processes: `test/fake-codex-dev.mjs`
  is copied into the scratch root as the configured `command` and reads its
  `FIXTURE`/`RECORD` directives from the brief, so every test controls the child's stdout,
  stderr, exit code, and timing while the plugin's argv, brief, and child-session events are
  asserted exactly. Covered: tool registration and schema, argv building, argument and `cwd`
  validation, the projected event order and payloads (descriptor v3, catalog v0, step
  brackets, reasoning/text/tool-call blocks, `tool/call`/`tool/result` pairing, usage
  mapping), multi-turn step numbering, plain-text and empty-stdout degradation, error/abort
  end states, SIGKILL escalation, missing-service and rejected-append degradation, an
  oversized line, concurrent runs, config validation, HOME-derived defaults, scratch
  cleanup, the compact and full log modes, session continuation, unknown and concurrent
  `session` ids, and the unload effect.
- `test/codex-dev.test.js` executes the bundled wrapper with a fake `CODEX_BIN` and checks
  the Codex argv (fresh vs. `exec resume`, model/thinking/sandbox/bypass), the private
  `CODEX_HOME` and its copied files, the default and overridden session directory, the
  ephemeral state directory, all three credential paths (including the `codex login`
  branch), the never-print guarantee, `--log`, the delegation record, and argument
  validation.
- `test/cleanup.test.js` runs `scripts/cleanup.mjs` against a temporary `$HOME`:
  `--dry-run` never deletes, `--days` filters, deletion keeps fresh files, and `--sessions`
  lists only (default and `CODEX_DEV_SESSION_DIR` layouts).
- `test/real-codex.mjs` is the manual end-to-end check: two real `codex-dev` runs against
  the local Codex CLI and its DeepSeek provider. The first creates a file and runs a
  command; the second passes the first run's `thread.started` id back as `--session-id` and
  must continue the same thread. It has no DSH container, so it also exercises the
  "projection unavailable → warn and continue" path. It exits as a no-op when
  `NODE_TEST_CONTEXT` is set, so `node --test` never spends a model call on it.
- `test/index.js` exists only so the documented `node --test test/` command works on Node
  versions that resolve a positional argument as a module instead of searching the
  directory. The equivalent form is `node --test test/*.test.js`.

## License

[MIT](LICENSE) © 2026 Asta Zhao
