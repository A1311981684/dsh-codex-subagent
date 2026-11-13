# Security

This file describes the security-relevant behavior of `dsh-codex-subagent`.
It is a small local plugin: it spawns the `codex` CLI you already have, so its
trust model is "the operator trusts the local Codex installation and the tasks
they delegate to it".

## Supported versions

Security fixes land on the latest minor line. At the time of writing that is
`0.1.x`.

## Credentials

- The wrapper resolves a credential in this order: an existing
  `DEEPSEEK_API_KEY` in the environment, a copied `CODEX_HOME/auth.json` (a
  `codex login`), or the DeepSeek key in `~/.pi/agent/auth.json`.
- The key is exported to the child environment only. It is never printed, never
  written to the profile config, and the tests assert that error paths do not
  echo it.
- When `~/.codex/auth.json` exists it is copied into the private
  `CODEX_HOME` (`<sessionDir>/home`, directory mode `700`) and the copy is
  mode `600`. The user's `~/.codex` is never written to.
- `~/.pi/agent/auth.json` is read only to retrieve the DeepSeek key; it is never
  modified.

## Processes and sandbox

- One local `codex` process per delegation; the plugin itself makes no network
  requests (its only network-adjacent code is the Codex child it spawns).
- The default sandbox policy is `workspace-write`, passed to `codex exec -s`.
  `dangerouslyBypass: true` in the config adds
  `--dangerously-bypass-approvals-and-sandbox` and must be opted into
  explicitly; it is documented as dangerous.
- The Codex child inherits the environment of the DSH host process, exactly as
  `codex` would inherit its parent's environment when run from a terminal.
  If your environment carries credentials you do not want a delegated task to
  see, unset them before starting DSH or run DSH with a scrubbed environment.
  (The official Codex subagent scrubs credential-shaped variables instead; this
  plugin intentionally keeps the native environment so `config.toml` providers
  that read `*_API_KEY` variables keep working.)

## Filesystem

- Writes stay under `$HOME/.dsh` (`codex-logs/`, `codex-sessions/`,
  `codex-delegations.log`) and the delegation's working directory.
- `~/.codex`, `~/.pi`, and `~/.dsh/bin` are read-only to the plugin.
- Task briefs go to a temporary directory removed at the end of the run.
- Logs and the delegation record contain the task text, the answer, and command
  output; treat `$HOME/.dsh/codex-logs` as potentially sensitive and use
  `scripts/cleanup.mjs` to remove old files. Old Codex threads under
  `$HOME/.dsh/codex-sessions` are never deleted automatically.

## Supply chain

- No runtime dependencies: `package.json` has no `dependencies`, and every
  module is a `node:` built-in.
- No install or lifecycle scripts (`preinstall`, `install`, `postinstall`,
  `prepare` are absent), so installing the package does not execute code beyond
  unpacking it.
- CI runs syntax checks and the unit tests on Node 22 and 24; `node --test test/`
  never calls a model or the network. `test/real-codex.mjs` is opt-in, spends
  model calls, and cleans up its temporary directory.

## Reporting

Please report a vulnerability through the repository's **Security → Report a
vulnerability** (GitHub private security advisory) rather than a public issue.
Include the affected version and a minimal reproduction.
