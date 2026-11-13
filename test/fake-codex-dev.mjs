#!/usr/bin/env node
/**
 * A stand-in for `codex-dev` used by the unit tests.
 *
 * The plugin always asks for JSON mode and projects Codex's NDJSON stream, so
 * this fixture writes that stream itself. Like the real wrapper it takes
 * `--brief`, `--cwd`, `--mode`, `--session-id`, `--session-dir`, and `--log`,
 * and it reads the brief for its test directives:
 *
 * - `FIXTURE <path>` — JSON knobs: `records` (written verbatim as JSONL),
 *   `stdout` (written verbatim, for the non-JSON degradation path),
 *   `kind` (`success` default, `failed`, `no-answer`), `message`,
 *   `nonFatalError`, `threadId`, `stdoutEarly`, `stderr`, `exitCode`,
 *   `delayMs`, and `ignoreTerm`.
 * - `RECORD <path>` — where to write `{ argv, cwd, brief, codexHome }`, so a
 *   test can see exactly how the plugin invoked the wrapper.
 *
 * `stdoutEarly` is written *before* the delay, so a cancellation test can leave
 * the projection mid-step (an advertised command with no result yet).
 * `ignoreTerm` installs a no-op SIGTERM handler *before* the record file is
 * written, so a test that waits for the record knows the child will survive the
 * first signal and can only be stopped by the SIGKILL escalation.
 *
 * A continuation (`--session-id <thread>`) reports the same thread id in its
 * `thread.started` record, which is what makes the plugin's continuation path
 * observable.
 *
 * This is a test fixture, not a package entry point.
 */
import { readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);

if (args.includes('--help') || args.includes('-h')) {
  process.stdout.write('Usage: codex-dev --brief <file|-> [--mode text|json] [--log <file>]\n');
  process.exit(0);
}

const flagValue = (flag) => {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
};
const briefPath = flagValue('--brief');
const brief = briefPath === undefined ? '' : readFileSync(briefPath, 'utf8');
const directive = (name) => brief
  .split('\n')
  .map((line) => line.trim())
  .find((line) => line.startsWith(`${name} `));
const trimmed = (name) => {
  const line = directive(name);
  return line === undefined ? undefined : line.slice(name.length + 1).trim();
};
const fixturePath = trimmed('FIXTURE');
const recordPath = trimmed('RECORD');
const fixture = fixturePath === undefined || fixturePath === ''
  ? {}
  : JSON.parse(readFileSync(fixturePath, 'utf8'));

if (fixture.ignoreTerm === true) process.on('SIGTERM', () => {});

if (recordPath !== undefined && recordPath !== '') {
  writeFileSync(recordPath, JSON.stringify({
    argv: args,
    cwd: process.cwd(),
    brief,
    codexHome: process.env.CODEX_HOME ?? '',
    mode: flagValue('--mode'),
    log: flagValue('--log'),
  }));
}

if (typeof fixture.stdoutEarly === 'string') process.stdout.write(fixture.stdoutEarly);

/** The Codex thread this run reports: a continuation keeps the caller's id. */
const threadId = flagValue('--session-id') ?? fixture.threadId ?? 'thread-fixture-0001';

/** The command one fixture run executes. */
const COMMAND = "/bin/bash -c 'echo fixture'";

/** The canonical successful event sequence. */
function successRecords() {
  const records = [
    { type: 'thread.started', thread_id: threadId },
  ];
  if (fixture.nonFatalError === true) {
    records.push({
      type: 'item.completed',
      item: {
        id: 'item_0',
        type: 'error',
        message: 'Model metadata not found. Defaulting to fallback metadata.',
      },
    });
  }
  records.push(
    { type: 'turn.started' },
    {
      type: 'item.started',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: COMMAND,
        aggregated_output: '',
        exit_code: null,
        status: 'in_progress',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'item_1',
        type: 'command_execution',
        command: COMMAND,
        aggregated_output: 'fixture\n',
        exit_code: 0,
        status: 'completed',
      },
    },
    {
      type: 'item.completed',
      item: {
        id: 'item_2',
        type: 'agent_message',
        text: typeof fixture.message === 'string' ? fixture.message : '改完了：fixture',
      },
    },
    {
      type: 'turn.completed',
      usage: {
        input_tokens: 43_018,
        cached_input_tokens: 41_856,
        cache_write_input_tokens: 0,
        output_tokens: 1_858,
        reasoning_output_tokens: 1_620,
      },
    },
  );
  return records;
}

/** A run that fails the way `codex exec` does: a top-level error, then turn.failed. */
function failedRecords() {
  const message = typeof fixture.failure === 'string' ? fixture.failure : 'stream error: model metadata missing';
  return [
    { type: 'thread.started', thread_id: threadId },
    { type: 'turn.started' },
    { type: 'item.completed', item: { id: 'item_1', type: 'error', message } },
    { type: 'error', message },
    { type: 'turn.failed', error: { message } },
  ];
}

/** A clean turn that never produced an agent message. */
function noAnswerRecords() {
  return [
    { type: 'thread.started', thread_id: threadId },
    { type: 'turn.started' },
    { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 0 } },
  ];
}

const finish = () => {
  if (typeof fixture.stdout === 'string') {
    process.stdout.write(fixture.stdout);
  } else if (Array.isArray(fixture.records)) {
    process.stdout.write(`${fixture.records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  } else {
    const records = fixture.kind === 'failed'
      ? failedRecords()
      : (fixture.kind === 'no-answer' ? noAnswerRecords() : successRecords());
    process.stdout.write(`${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  }
  if (typeof fixture.stderr === 'string') process.stderr.write(fixture.stderr);
  process.exitCode = typeof fixture.exitCode === 'number' ? fixture.exitCode : 0;
};

const delayMs = typeof fixture.delayMs === 'number' ? fixture.delayMs : 0;
if (delayMs > 0) setTimeout(finish, delayMs);
else finish();
