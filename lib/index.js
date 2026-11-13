/**
 * Codex CLI (`codex-dev`) as a DSH subagent backend, with live session
 * projection.
 *
 * One `codex-dev` child per delegation, owned here: the plugin registers its
 * own `codex` tool, so the same call does two things:
 *
 * 1. run the delegation — write the brief, spawn `codex-dev`, and return
 *    Codex's final answer;
 * 2. project the run into a real DSH child session *as it happens* — the child
 *    session is created first (`sessions.prepare` + `sessionPersistence.create`
 *    + `enter`/`announce`), its opening events (`turn/start`, the
 *    `subagent/descriptor`, the task text) and the parent's `subagent/catalog`
 *    row are appended before the child is spawned, and every NDJSON record
 *    `codex exec --json` emits is then projected line by line: one
 *    `step/start`…`step/end` bracket per Codex turn, `assistant/message` with
 *    reasoning/text/tool-call blocks, `tool/call` + `tool/result` for every
 *    `command_execution` item, and a `turn/end` carrying the real end state.
 *    Timestamps are real, long runs do not lose their early events, and the
 *    child row is visible in DSH while Codex works.
 *
 * Projection is strictly a bonus. Every step is guarded: a missing service, a
 * rejected append, or unparseable child output degrades the projection (or the
 * whole child session) with a `ctx.logger.warn`, while the delegation result is
 * returned unchanged. `codex-dev` itself stays the owner of the run
 * environment: a private `CODEX_HOME`, credential handoff, fixed rules, model
 * pin, Codex thread storage, the log, and the delegation record.
 *
 * A delegation can be continued: the tool returns the child session id, and a
 * later call that passes it back appends a new turn to the same child session
 * and lets Codex continue its own thread (same project memory). The in-process
 * registry maps that child session id to the Codex `thread_id` reported by
 * `thread.started`, so a continuation can pass `--session-id <thread_id>` to
 * the wrapper. Those sessions are tracked in-process and kept live until the
 * plugin unloads; a restart loses the mapping, so continuing an unknown id is a
 * clear error instead of a silent fresh run. The default `logMode: "summary"`
 * writes a few-KB log itself instead of having the wrapper tee the whole JSON
 * event stream (`logMode: "full"`).
 *
 * The plugin always asks for JSON mode (`--mode json`): the thread id, the
 * projection, and the final answer all come from Codex's NDJSON event stream.
 * A child that prints plain text anyway is not retried; its whole stdout is
 * projected as one assistant message and used as the answer, which is the same
 * degradation a non-JSON wrapper gets.
 *
 * No `@deepseek-ai/*` import and no runtime dependency: only `node:` built-ins.
 * `@deepseek-ai/cordis` injects `tools`, `sessions`, and `sessionPersistence`;
 * the event/message payloads below are plain JSON objects matching the
 * 0.2.2-rc.1 type declarations (an event log is JSON by contract).
 *
 * @module dsh-codex-subagent
 */

import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';

/** Registry name of this plugin. */
export const name = 'subagent-codex-cli';

/**
 * `tools` to register the `codex` tool; `sessions` + `sessionPersistence` to
 * project each run into a durable, inspectable child session.
 */
export const inject = ['tools', 'sessions', 'sessionPersistence'];

/** Diagnostic prefix, also used for the per-run scratch directory. */
const PREFIX = 'subagent-codex-cli';

/**
 * The wrapper that carries every delegation rule; overridable through config.
 * Built from the current user's home directory so the default works on any
 * machine instead of naming one absolute path.
 */
const DEFAULT_COMMAND = join(homedir(), '.dsh', 'bin', 'codex-dev');

/** Default log directory, relative to `$HOME`. */
const DEFAULT_LOG_SUBDIR = join('.dsh', 'codex-logs');

/** Default directory for Codex's own continuable threads, relative to `$HOME`. */
const DEFAULT_SESSION_SUBDIR = join('.dsh', 'codex-sessions');

/** The sandbox policies `codex exec -s` accepts. */
const SANDBOX_MODES = ['read-only', 'workspace-write', 'danger-full-access'];

/** Default sandbox for a run; `codex-dev` uses the same default. */
const DEFAULT_SANDBOX = 'workspace-write';

/** Longest first line of the task kept in the compact log. */
const SUMMARY_PROMPT_MAX_CHARS = 100;

/** Default SIGTERM → SIGKILL grace for a cancelled child. */
const DEFAULT_GRACE_MS = 5_000;

/** Default in-memory cap for one collected stream. */
const DEFAULT_MAX_OUTPUT_BYTES = 262_144;

/** The model-facing cap for provider-authored diagnostics. */
const MAX_DIAGNOSTIC_BYTES = 4_096;

/** Longest default label (prompt first line plus the configured prefix). */
const LABEL_MAX_CHARS = 60;

/** Default prefix for a newly projected child's label. */
const DEFAULT_LABEL_PREFIX = 'codex · ';

/** Control characters (including newlines) a label prefix may not contain. */
const LABEL_PREFIX_CONTROL_CHARS = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/;

/** The provider name stamped into the child descriptor and messages. */
const PROVIDER = 'codex';

/** The tool name a `command_execution` item is projected as. */
const COMMAND_TOOL_NAME = 'command';

/** Longest `turn/end` error message; Codex's failure payloads are JSON blobs. */
const MAX_TURN_ERROR_BYTES = 1_024;

/** `SUBAGENT_DESCRIPTOR_VERSION` from `@deepseek-ai/dsh-subagent/descriptor`. */
const DESCRIPTOR_VERSION = 3;

/** `SUBAGENT_CATALOG_VERSION` from `@deepseek-ai/dsh-subagent/catalog`. */
const CATALOG_VERSION = 0;

/** Longest NDJSON line kept; a longer line is dropped whole. */
const MAX_LINE_BYTES = 2 * 1024 * 1024;

/** Model-facing text for a tool call that never settled before its step closed. */
const UNSETTLED_TOOL_TEXT = 'The tool call did not return a result before the task ended.';

/** Normalize an unknown thrown value to a message. */
function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

/** Log a projection/run failure without letting the sink break the run. */
function warn(ctx, message, error) {
  try {
    ctx?.logger?.warn?.(`${PREFIX}: ${message}: ${errorMessage(error)}`);
  } catch {
    /* a broken logger must never fail a delegation */
  }
}

/** Whether a value is a plain JSON object. */
function isRecord(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A non-empty string, or undefined. */
function nonEmptyText(value) {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * Keep the last `maxBytes` bytes of `text` without splitting a UTF-8
 * sequence, so the result is still valid text and fits the budget.
 * @param text - the source text.
 * @param maxBytes - the byte budget; non-positive means "nothing fits".
 * @returns the tail, at most `maxBytes` bytes.
 */
function utf8Tail(text, maxBytes) {
  if (typeof text !== 'string' || text === '' || !Number.isFinite(maxBytes) || maxBytes <= 0) return '';
  const bytes = Buffer.from(text, 'utf8');
  if (bytes.length <= maxBytes) return text;
  let start = bytes.length - Math.floor(maxBytes);
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start += 1;
  return bytes.subarray(start).toString('utf8');
}

/**
 * Build a diagnostic that keeps `head` intact and spends the remaining
 * 4096-byte budget on the tail of `detail` (the child's stderr).
 * @param head - the fixed failure line (exit code, or the internal error).
 * @param detail - child-owned detail; only its tail survives.
 * @returns the diagnostic, at most {@link MAX_DIAGNOSTIC_BYTES} bytes.
 */
function diagnosticText(head, detail) {
  const headBytes = Buffer.byteLength(head, 'utf8');
  if (headBytes >= MAX_DIAGNOSTIC_BYTES) return utf8Tail(head, MAX_DIAGNOSTIC_BYTES);
  const tail = utf8Tail(detail ?? '', MAX_DIAGNOSTIC_BYTES - headBytes - 1);
  return tail === '' ? head : `${head}\n${tail}`;
}

/**
 * `YYYYMMDD-HHmmss` in local time, the log-name stamp.
 * @param now - the clock reading.
 * @returns the stamp.
 */
function logStamp(now) {
  const pad = (value) => String(value).padStart(2, '0');
  return [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    '-',
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
  ].join('');
}

/**
 * A fixed-size byte collector: appends every chunk and keeps the tail, so a
 * chatty child cannot grow the plugin's memory without bound and the most
 * relevant diagnostics (usually the end of stderr, or the tail of a plain-text
 * answer) survive.
 */
class TailBuffer {
  /** @type {number} */
  #maxBytes;
  /** @type {Buffer} */
  #buffer = Buffer.alloc(0);

  /**
   * @param maxBytes - positive byte budget.
   */
  constructor(maxBytes) {
    this.#maxBytes = Math.max(1, Math.floor(maxBytes));
  }

  /**
   * @param chunk - the next stream chunk.
   */
  push(chunk) {
    if (chunk === undefined || chunk === null || chunk.length === 0) return;
    const merged = this.#buffer.length === 0 ? chunk : Buffer.concat([this.#buffer, chunk]);
    this.#buffer = merged.length > this.#maxBytes
      ? merged.subarray(merged.length - this.#maxBytes)
      : merged;
  }

  /** @returns the retained text, decoded from a character boundary. */
  text() {
    const buffer = this.#buffer;
    let start = 0;
    while (start < buffer.length && (buffer[start] & 0xc0) === 0x80) start += 1;
    return buffer.subarray(start).toString('utf8');
  }
}

/**
 * Split one byte stream into lines without splitting a UTF-8 sequence.
 *
 * A partial line is buffered until its LF arrives; a line longer than
 * `maxBytes` is discarded whole (and reported once) so one pathological record
 * cannot grow the buffer without bound.
 */
class LineSplitter {
  /** @type {StringDecoder} */
  #decoder = new StringDecoder('utf8');
  /** @type {string} */
  #buffer = '';
  /** @type {boolean} */
  #discarding = false;
  /** @type {number} */
  #maxBytes;

  /**
   * @param maxBytes - positive per-line character budget (an approximation of bytes).
   */
  constructor(maxBytes) {
    this.#maxBytes = Math.max(1, Math.floor(maxBytes));
  }

  /**
   * Feed the next chunk and emit every complete line.
   * @param chunk - the next stream chunk.
   * @param onLine - receives each complete line (CR stripped).
   * @param onOverflow - receives the size of a dropped line.
   */
  push(chunk, onLine, onOverflow) {
    if (chunk === undefined || chunk === null || chunk.length === 0) return;
    this.#buffer += this.#decoder.write(chunk);
    this.#drain(onLine, onOverflow);
  }

  /**
   * Emit the final partial line, if any.
   * @param onLine - receives the trailing line.
   */
  flush(onLine) {
    this.#buffer += this.#decoder.end();
    if (this.#buffer === '') return;
    const line = this.#buffer;
    this.#buffer = '';
    const discarding = this.#discarding;
    this.#discarding = false;
    if (discarding) return;
    if (line.length > this.#maxBytes) return;
    onLine(stripCr(line));
  }

  /**
   * Emit all complete lines currently buffered.
   * @param onLine - receives each complete line.
   * @param onOverflow - receives the size of a dropped line.
   */
  #drain(onLine, onOverflow) {
    let index = this.#buffer.indexOf('\n');
    while (index !== -1) {
      const line = this.#buffer.slice(0, index);
      this.#buffer = this.#buffer.slice(index + 1);
      index = this.#buffer.indexOf('\n');
      if (this.#discarding) {
        this.#discarding = false;
        continue;
      }
      if (line.length > this.#maxBytes) {
        onOverflow(line.length);
        continue;
      }
      onLine(stripCr(line));
    }
    if (this.#buffer.length > this.#maxBytes) {
      const dropped = this.#buffer.length;
      this.#buffer = '';
      if (!this.#discarding) {
        this.#discarding = true;
        onOverflow(dropped);
      }
    }
  }
}

/** Strip one trailing CR from a line. */
function stripCr(line) {
  return line.endsWith('\r') ? line.slice(0, -1) : line;
}

/**
 * Build the child argv. `--brief`, `--cwd`, `--mode json`, and `--session-dir`
 * are always present; `--session-id` only for a continuation (the Codex thread
 * id), `--log` only in `logMode: "full"` (the wrapper then tees the whole
 * output), and model/thinking/sandbox/bypass follow in a fixed order.
 * `config.args` goes last so a profile can append anything `codex-dev` grows
 * later.
 *
 * The session directory is always passed, even for a fresh delegation: the
 * wrapper then keeps that thread's state under `<sessionDir>/home` instead of a
 * throwaway `CODEX_HOME`, which is what makes a later `--session-id` possible.
 *
 * @param config - the resolved plugin config.
 * @param input - brief path, cwd, optional log path, and the Codex thread id.
 * @returns the argv handed to the child.
 */
function childArgv(config, input) {
  const argv = [config.command, '--brief', input.briefPath, '--cwd', input.cwd];
  if (input.logPath !== undefined) argv.push('--log', input.logPath);
  argv.push('--mode', 'json', '--session-dir', config.sessionDir);
  if (input.threadId !== undefined) argv.push('--session-id', input.threadId);
  argv.push('--sandbox', config.sandbox);
  if (config.model !== undefined) argv.push('--model', config.model);
  if (config.thinking !== undefined) argv.push('--thinking', config.thinking);
  if (config.dangerouslyBypass) argv.push('--bypass');
  argv.push(...config.args);
  return argv;
}

/**
 * Project one live Codex run into the already-open child session.
 *
 * The instance is the whole state machine: it owns the open step, the pending
 * command executions, the last agent message, and the run's abort/failure
 * flags. When the session is absent (projection off, or the child session could
 * not be created) every append is a no-op and only the run facts are tracked,
 * so the caller uses one code path for both.
 *
 * Event order is what the durable log's restore-time relationship checks
 * demand: every `assistant/message` (and its `tool/call`s) sits inside the open
 * `step/start`…`step/end` bracket, every advertised `tool/call` is answered by
 * exactly one `tool/result` before that `step/end`, and the single `turn/end`
 * comes after the last step closed.
 *
 * Codex's item stream has no per-message usage and no step boundaries of its
 * own, so one `turn.started`…`turn.completed` pair is one DSH step, and the
 * turn's usage is recorded for the compact log (there is no later assistant
 * message to attach it to).
 */
class ChildProjection {
  /** @type {object|undefined} */
  #ctx;
  /** @type {object|undefined} */
  #session;
  /** @type {number} */
  #turn;
  /** @type {string} */
  #defaultProvider;
  /** @type {string} */
  #defaultModel;
  /** @type {TailBuffer} */
  #raw;
  /** @type {number} */
  #records = 0;
  /** @type {boolean} */
  #turnOpen = false;
  /** @type {number} */
  #step = 0;
  /** @type {number} */
  #nextStep = 1;
  /** @type {Map<string, {callId: string, name: string, arguments: string}>} */
  #pending = new Map();
  /** @type {Map<string, number>} */
  #startedAt = new Map();
  /** @type {{name: string, durationMs: number, isError: boolean}[]} */
  #tools = [];
  /** @type {{input: number, output: number, cacheRead: number, cacheWrite: number, reasoning: number}|undefined} */
  #usage;
  /** @type {string} */
  #finalText = '';
  /** @type {string|undefined} */
  #threadId;
  /** @type {string|undefined} */
  #failure;
  /** @type {string[]} */
  #notes = [];
  /** @type {Set<string>} */
  #warnedItemTypes = new Set();
  /** @type {boolean} */
  #aborted = false;
  /** @type {boolean} */
  #appendFailed = false;
  /** @type {boolean} */
  #finished = false;

  /**
   * @param options - context, the child session (or undefined), the DSH turn
   *   this run appends to, the raw-output budget, and the fallback
   *   provider/model.
   */
  constructor(options) {
    this.#ctx = options.ctx;
    this.#session = options.session;
    this.#turn = Number.isSafeInteger(options.turn) && options.turn > 0 ? options.turn : 1;
    this.#defaultProvider = options.provider;
    this.#defaultModel = options.model;
    this.#raw = new TailBuffer(options.maxOutputBytes);
    // The caller already appended `turn/start`; without a session there is
    // nothing to close.
    this.#turnOpen = options.session !== undefined;
  }

  /** @returns the last agent message seen, the value the parent model gets. */
  get finalText() {
    return this.#finalText;
  }

  /**
   * The answer this run already has, without closing anything: the last
   * agent message, or the whole stdout when the child printed text instead of
   * NDJSON. Used to decide the stop reason before `finish` writes the answer
   * into the projection.
   * @returns the answer text, or '' when the run has none yet.
   */
  get answerText() {
    if (this.#finalText !== '') return this.#finalText;
    return this.#records === 0 ? this.#raw.text().trimEnd() : '';
  }

  /** @returns whether the run itself claimed to be aborted. */
  get aborted() {
    return this.#aborted;
  }

  /** @returns one entry per finished command execution, in order. */
  get tools() {
    return this.#tools;
  }

  /** @returns the summed raw token usage, or undefined when Codex reported none. */
  get usage() {
    return this.#usage;
  }

  /** @returns the Codex thread id from `thread.started`, when it arrived. */
  get threadId() {
    return this.#threadId;
  }

  /** @returns the fatal Codex-side failure message, when the run failed. */
  get failureMessage() {
    return this.#failure;
  }

  /** @returns the non-fatal diagnostics (`item.completed` type `error`). */
  get notes() {
    return this.#notes;
  }

  /**
   * Append one event, degrading instead of throwing.
   *
   * A failed content append stops further content (a half-written step must not
   * gain more references), while structural closers are still attempted so a
   * transient rejection cannot leave an open step or turn behind.
   *
   * @param type - the session event type.
   * @param data - the JSON payload.
   * @param opts - surface options.
   * @param structural - whether this event only closes a bracket.
   * @returns whether the event was appended.
   */
  append(type, data, opts, structural = false) {
    if (this.#session === undefined) return false;
    if (this.#appendFailed && !structural) return false;
    try {
      this.#session.append(type, data, opts);
      return true;
    } catch (error) {
      this.#appendFailed = true;
      warn(this.#ctx, `could not append ${type} to the child session; later content is not projected`, error);
      return false;
    }
  }

  /**
   * Project one stdout line: an NDJSON record, or plain answer text (the
   * fallback when the wrapper printed text instead of events).
   * @param line - one complete line without its LF.
   */
  acceptLine(line) {
    if (line.trim() === '') return;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      record = undefined;
    }
    if (!isRecord(record) || typeof record.type !== 'string') {
      if (this.#records === 0) this.#raw.push(Buffer.from(`${line}\n`, 'utf8'));
      return;
    }
    this.#records += 1;
    this.handleRecord(record);
  }

  /**
   * Project one parsed Codex record.
   * @param record - a JSON object with a string `type`.
   */
  handleRecord(record) {
    switch (record.type) {
      case 'thread.started': {
        const threadId = nonEmptyText(record.thread_id);
        if (threadId !== undefined) this.#threadId = threadId;
        break;
      }
      case 'turn.started':
        // One Codex turn is one step.
        this.#openStep();
        break;
      case 'item.started':
        this.#acceptItemStarted(record.item);
        break;
      case 'item.updated':
        // Progress refinement of an item that already reported its start.
        break;
      case 'item.completed':
        this.#acceptItemCompleted(record.item);
        break;
      case 'turn.completed':
        this.#recordUsage(record.usage);
        this.#closeStep();
        break;
      case 'turn.failed':
        this.#fail(record.error);
        this.#closeStep();
        break;
      case 'error':
        // Top-level error (also emitted right before `turn.failed`).
        this.#fail(record.message === undefined ? record : record.message);
        this.#closeStep();
        break;
      default:
        /* stream/session bookkeeping records: nothing to project */
        break;
    }
  }

  /**
   * Close every bracket and append the turn's real end reason.
   * @param input - the run's stop reason and, for an error, its message.
   * @returns nothing; read {@link finalText} and {@link aborted} afterwards.
   */
  finish(input) {
    if (this.#finished) return;
    this.#finished = true;
    const rawText = this.#records === 0 ? this.#raw.text().trimEnd() : '';
    if (rawText !== '') {
      // Plain-text run, or JSON mode whose output was never JSONL: one
      // assistant message carrying the whole answer.
      this.#openStep();
      if (this.#step !== 0) {
        this.append('assistant/message', {
          turn: this.#turn,
          step: this.#step,
          message: {
            id: randomUUID(),
            role: 'assistant',
            content: [{ type: 'text', text: rawText }],
            source: { kind: 'model', provider: this.#defaultProvider, model: this.#defaultModel },
          },
          stream: [],
        }, { surfaceOp: 'append' });
      }
      this.#finalText = rawText;
    }
    this.#closeStep();
    if (this.#turnOpen) {
      this.append('turn/end', { turn: this.#turn, reason: this.#endReason(input) }, undefined, true);
      this.#turnOpen = false;
    }
  }

  /**
   * The `turn/end` reason for this run.
   * @param input - stop reason and failure message.
   * @returns a `TurnEndReason` shape from `@deepseek-ai/dsh-session`.
   */
  #endReason(input) {
    if (input.stopReason === 'aborted' || this.#aborted) {
      return { kind: 'aborted', reason: { kind: 'user' } };
    }
    if (input.stopReason === 'error') {
      return {
        kind: 'error',
        error: {
          message: utf8Tail(input.failureMessage ?? 'codex-dev failed', MAX_TURN_ERROR_BYTES),
          code: 'UNKNOWN',
        },
      };
    }
    return { kind: 'completed' };
  }

  /**
   * Open the next step, closing an unexpectedly still-open one first.
   */
  #openStep() {
    if (this.#step !== 0) this.#closeStep();
    const step = this.#nextStep;
    if (!this.append('step/start', { turn: this.#turn, step })) return;
    this.#step = step;
    this.#nextStep = step + 1;
  }

  /**
   * Answer any tool call still pending in this step, then close it. The
   * durable log rejects a `step/end` that leaves an advertised call unresolved.
   */
  #closeStep() {
    if (this.#step === 0) return;
    this.#settlePending();
    this.append('step/end', { turn: this.#turn, step: this.#step }, undefined, true);
    this.#step = 0;
  }

  /**
   * Append an error result for every tool call this step advertised but never
   * settled (a crash, a cancel, or a stream that ended mid-command).
   */
  #settlePending() {
    for (const call of this.#pending.values()) {
      this.append('tool/result', {
        turn: this.#turn,
        step: this.#step,
        message: {
          id: randomUUID(),
          role: 'tool',
          content: [{ type: 'text', text: UNSETTLED_TOOL_TEXT }],
          source: { kind: 'tool', callId: call.callId },
          toolCallId: call.callId,
          isError: true,
        },
      }, { surfaceOp: 'append' });
    }
    this.#pending.clear();
  }

  /**
   * Remember a `command_execution` start and advertise it on the surface.
   * @param item - Codex's `item.started` payload.
   */
  #acceptItemStarted(item) {
    if (!isRecord(item)) return;
    if (item.type !== 'command_execution') return;
    const id = nonEmptyText(item.id);
    if (id === undefined) {
      warn(this.#ctx, 'ignoring a command execution without an item id', new Error('missing item id'));
      return;
    }
    if (!this.#startedAt.has(id)) this.#startedAt.set(id, Date.now());
    this.#advertiseCommand(id, item.command);
  }

  /**
   * Advertise one command as an assistant tool-call block plus its `tool/call`,
   * so the matching `tool/result` has something to answer. The two carry the
   * exact same `arguments` string, which is what the durable log expects.
   * @param id - the Codex item id, reused as the DSH call id.
   * @param command - the shell command Codex ran.
   */
  #advertiseCommand(id, command) {
    if (this.#session === undefined) return;
    if (this.#pending.has(id)) return;
    if (this.#step === 0) this.#openStep();
    if (this.#step === 0) return;
    const argumentsText = JSON.stringify({ command: typeof command === 'string' ? command : '' });
    const appended = this.append('assistant/message', {
      turn: this.#turn,
      step: this.#step,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [{ type: 'tool-call', id, name: COMMAND_TOOL_NAME, arguments: argumentsText }],
        source: { kind: 'model', provider: this.#defaultProvider, model: this.#defaultModel },
      },
      stream: [],
    }, { surfaceOp: 'append' });
    if (!appended) return;
    if (!this.append('tool/call', {
      turn: this.#turn,
      step: this.#step,
      callId: id,
      name: COMMAND_TOOL_NAME,
      arguments: argumentsText,
    })) return;
    this.#pending.set(id, { callId: id, name: COMMAND_TOOL_NAME, arguments: argumentsText });
  }

  /**
   * Project one finished item: a command result, an agent message, a reasoning
   * block, or a non-fatal Codex warning.
   * @param item - Codex's `item.completed` payload.
   */
  #acceptItemCompleted(item) {
    if (!isRecord(item)) return;
    switch (item.type) {
      case 'command_execution':
        this.#acceptCommandResult(item);
        return;
      case 'agent_message':
        this.#acceptAgentMessage(item);
        return;
      case 'reasoning':
        this.#acceptReasoning(item);
        return;
      case 'error':
        this.#acceptItemError(item);
        return;
      default:
        // `file_change`, `mcp_tool_call`, and anything Codex adds later: never
        // crash the delegation on an item this projection does not know.
        this.#warnUnknownItem(item.type);
    }
  }

  /**
   * Project one finished command execution against the call that was
   * advertised at its start (re-advertising it when the start line was lost).
   * @param item - the `command_execution` item.
   */
  #acceptCommandResult(item) {
    const id = nonEmptyText(item.id);
    if (id === undefined) {
      warn(this.#ctx, 'ignoring a command result without an item id', new Error('missing item id'));
      return;
    }
    const startedAt = this.#startedAt.get(id);
    this.#startedAt.delete(id);
    const durationMs = startedAt === undefined ? 0 : Math.max(0, Date.now() - startedAt);
    const exitCode = typeof item.exit_code === 'number' ? item.exit_code : undefined;
    const isError = item.status === 'failed' || (exitCode !== undefined && exitCode !== 0);
    // The compact log records every command, whether or not anything is projected.
    this.#tools.push({ name: COMMAND_TOOL_NAME, durationMs, isError });
    if (this.#session === undefined) return;
    this.#advertiseCommand(id, item.command);
    const call = this.#pending.get(id);
    if (call === undefined) return;
    const output = typeof item.aggregated_output === 'string' ? item.aggregated_output : '';
    const appended = this.append('tool/result', {
      turn: this.#turn,
      step: this.#step,
      message: {
        id: randomUUID(),
        role: 'tool',
        content: [{ type: 'text', text: output }],
        source: { kind: 'tool', callId: call.callId },
        toolCallId: call.callId,
        ...(isError ? { isError: true } : {}),
      },
    }, { surfaceOp: 'append' });
    if (appended) this.#pending.delete(id);
  }

  /**
   * Project one `agent_message` as the answer text.
   * @param item - the `agent_message` item.
   */
  #acceptAgentMessage(item) {
    const text = typeof item.text === 'string' ? item.text : '';
    if (text === '') return;
    // The answer is recorded even when the session cannot be written: the
    // delegation result never depends on the projection.
    this.#finalText = text;
    if (this.#session === undefined) return;
    if (this.#step === 0) this.#openStep();
    if (this.#step === 0) return;
    this.append('assistant/message', {
      turn: this.#turn,
      step: this.#step,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [{ type: 'text', text }],
        source: { kind: 'model', provider: this.#defaultProvider, model: this.#defaultModel },
      },
      stream: [],
    }, { surfaceOp: 'append' });
  }

  /**
   * Project one `reasoning` item as a reasoning block. Codex may report the
   * text as `text`, or as `summary`/`content` arrays of `{text}` entries.
   * @param item - the `reasoning` item.
   */
  #acceptReasoning(item) {
    const text = reasoningText(item);
    if (text === '') return;
    if (this.#session === undefined) return;
    if (this.#step === 0) this.#openStep();
    if (this.#step === 0) return;
    this.append('assistant/message', {
      turn: this.#turn,
      step: this.#step,
      message: {
        id: randomUUID(),
        role: 'assistant',
        content: [{ type: 'reasoning', text }],
        source: { kind: 'model', provider: this.#defaultProvider, model: this.#defaultModel },
      },
      stream: [],
    }, { surfaceOp: 'append' });
  }

  /**
   * Record a non-fatal Codex warning (for example the missing model metadata
   * notice). It is logged and kept for the compact log; a successful turn is
   * never turned into a failure by it.
   * @param item - the `error` item.
   */
  #acceptItemError(item) {
    const message = typeof item.message === 'string' ? item.message : 'codex reported an error item';
    if (this.#notes.length < 5) this.#notes.push(message);
    if (!this.#warnedItemTypes.has('item:error')) {
      this.#warnedItemTypes.add('item:error');
      warn(this.#ctx, 'codex reported a non-fatal item error; the run continues', new Error(message));
    }
  }

  /**
   * Warn once per unsupported item type, so a chatty unsupported item cannot
   * flood the log.
   * @param type - the item type Codex reported.
   */
  #warnUnknownItem(type) {
    const key = `item:${String(type)}`;
    if (this.#warnedItemTypes.has(key)) return;
    this.#warnedItemTypes.add(key);
    warn(this.#ctx, `skipping an item of unsupported type "${String(type)}"`, new Error('unsupported item type'));
  }

  /**
   * Mark the run failed from a `turn.failed`/`error` record.
   * @param error - Codex's error object, a message string, or anything else.
   */
  #fail(error) {
    let message;
    if (isRecord(error)) {
      if (typeof error.message === 'string' && error.message !== '') message = error.message;
      else {
        try {
          message = JSON.stringify(error);
        } catch {
          message = undefined;
        }
      }
    } else if (typeof error === 'string' && error !== '') {
      message = error;
    }
    this.#failure ??= message === undefined || message === '' ? 'codex reported a failed turn' : message;
  }

  /**
   * Add one Codex usage report to the run totals kept for the compact log.
   * @param usage - Codex's raw usage object, when present.
   */
  #recordUsage(usage) {
    if (!isRecord(usage)) return;
    const totals = this.#usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
    const sources = {
      input: 'input_tokens',
      output: 'output_tokens',
      cacheRead: 'cached_input_tokens',
      cacheWrite: 'cache_write_input_tokens',
      reasoning: 'reasoning_output_tokens',
    };
    for (const [key, source] of Object.entries(sources)) {
      const value = usage[source];
      if (typeof value === 'number' && Number.isFinite(value) && value >= 0) totals[key] += value;
    }
    this.#usage = totals;
  }
}

/**
 * The text of one Codex `reasoning` item.
 * @param item - the reasoning item.
 * @returns the joined text, trimmed; empty when the item carries none.
 */
function reasoningText(item) {
  if (typeof item.text === 'string' && item.text !== '') return item.text;
  const parts = [];
  for (const key of ['summary', 'content']) {
    const blocks = item[key];
    if (!Array.isArray(blocks)) continue;
    for (const block of blocks) {
      if (isRecord(block) && typeof block.text === 'string' && block.text !== '') parts.push(block.text);
    }
  }
  return parts.join('\n').trimEnd();
}

/**
 * Spawn `codex-dev`, stream its stdout lines to `onLine`, and settle the run
 * facts. Only stderr is retained (bounded) for diagnostics; stdout is not
 * buffered for projection, so a long run cannot lose its early records.
 *
 * Cancellation sends SIGTERM and escalates to SIGKILL after `graceMs`, so the
 * tool call can always reach quiescence. Never rejects: a spawn failure is
 * reported through `error` on the returned facts.
 *
 * @param ctx - the plugin context (diagnostics only).
 * @param config - the resolved plugin config.
 * @param spec - argv, child cwd, the caller's cancellation signal, and the line sink.
 * @returns the child's exit facts and its retained stderr.
 */
function runCodexChild(ctx, config, spec) {
  const { argv, cwd, signal, onLine } = spec;
  return new Promise((resolve) => {
    const stderr = new TailBuffer(config.maxOutputBytes);
    const splitter = new LineSplitter(MAX_LINE_BYTES);
    const safeLine = (line) => {
      try {
        onLine(line);
      } catch (error) {
        warn(ctx, 'could not project a child output line', error);
      }
    };
    const overflow = (bytes) => {
      warn(ctx, `dropping a ${bytes}-character output line (limit ${MAX_LINE_BYTES})`, new Error('oversized line'));
    };
    let settled = false;
    let killTimer;

    const settle = (facts) => {
      if (settled) return;
      settled = true;
      if (killTimer !== undefined) clearTimeout(killTimer);
      if (signal !== undefined) signal.removeEventListener('abort', terminate);
      try {
        splitter.flush(safeLine);
      } catch (error) {
        warn(ctx, 'could not flush the child output stream', error);
      }
      resolve({ ...facts, stderr: stderr.text(), aborted: signal?.aborted === true });
    };

    /** SIGTERM now, SIGKILL after the grace window. */
    const terminate = () => {
      if (settled) return;
      try {
        child.kill('SIGTERM');
      } catch (error) {
        warn(ctx, 'could not signal the codex-dev child', error);
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* already gone */
        }
      }, config.graceMs);
      killTimer.unref?.();
    };

    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: process.env,
      });
    } catch (error) {
      resolve({ exitCode: null, termSignal: null, error, stderr: '', aborted: signal?.aborted === true });
      return;
    }

    child.stdout?.on('data', (chunk) => {
      try {
        splitter.push(chunk, safeLine, overflow);
      } catch (error) {
        warn(ctx, 'could not read the child output stream', error);
      }
    });
    child.stderr?.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => settle({ exitCode: null, termSignal: null, error }));
    child.once('close', (exitCode, termSignal) => settle({ exitCode, termSignal, error: undefined }));

    if (signal !== undefined) {
      if (signal.aborted) terminate();
      else signal.addEventListener('abort', terminate, { once: true });
    }
  });
}

/**
 * Describe a failed run: a spawn error, or a non-zero exit with its stderr.
 * @param run - the child's collected facts.
 * @returns the failure head and its capped diagnostic; or undefined for a
 *   clean or cancelled run.
 */
function failureOf(run) {
  if (run.aborted) return undefined;
  if (run.error !== undefined) {
    const head = `${PREFIX}: could not start the codex-dev child: ${errorMessage(run.error)}`;
    return { message: head, diagnostic: diagnosticText(head, run.stderr) };
  }
  if (run.exitCode === 0) return undefined;
  const term = typeof run.termSignal === 'string' ? ` (${run.termSignal})` : '';
  const head = run.exitCode === null ? `codex-dev exit code null${term}` : `codex-dev exit code ${run.exitCode}`;
  return { message: head, diagnostic: diagnosticText(head, run.stderr) };
}

/** The message-facing description of the `codex` tool. */
const TOOL_DESCRIPTION = [
  'Delegate a development task to the local Codex CLI (`codex-dev`) and get its final answer back.',
  'Codex runs as a separate process with its own context: it reads and edits files, runs commands, and returns one answer, so use it for self-contained implementation, investigation, or review work that does not build on this conversation.',
  'Each delegation also creates a real child session in DSH as the task starts, projected live: the task text, Codex\'s reasoning and replies, its command calls and their output, one step per Codex turn, and the run end state; that child session is read-only history.',
  'The result carries that child session\'s `session` id. To continue the same delegation with Codex\'s own memory of the earlier work, pass the id back as `session`; omit it to start a fresh delegation.',
].join(' ');

/** The model-facing parameter schema of the `codex` tool. */
const TOOL_PARAMETERS = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description: 'The complete, self-contained task for Codex. Codex does not see this conversation, so include everything it needs.',
    },
    cwd: {
      type: 'string',
      description: 'Absolute working directory for the Codex run; it must exist. Omit to use this session\'s working directory.',
    },
    label: {
      type: 'string',
      description: 'Short label for the child session shown in DSH\'s subagent list. Omit to use the first line of `prompt`, at most 60 characters.',
    },
    session: {
      type: 'string',
      description: 'Child session id returned by an earlier `codex` call. When set, the new task is appended to that same child session as a new turn and Codex continues its own earlier thread; omit it to start a fresh delegation.',
    },
  },
  required: ['prompt'],
  additionalProperties: false,
};

/** The canonical successful value of the `codex` tool. */
const TOOL_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    output: { type: 'string' },
    childSessionId: { type: 'string' },
    session: { type: 'string' },
    logPath: { type: 'string' },
    stopReason: { type: 'string' },
    diagnostic: { type: 'string' },
  },
  required: ['output', 'childSessionId', 'session', 'logPath', 'stopReason'],
  additionalProperties: false,
};

/**
 * Render the tool value for the model: the answer, an optional diagnostic, and
 * the pointers it needs afterwards (the child session, the log, and how to
 * continue the same delegation).
 * @param _args - the (frozen) tool arguments.
 * @param value - the validated canonical value.
 * @returns one text block.
 */
function renderCodexResult(_args, value) {
  const lines = [value.output.trim() === '' ? '(codex produced no text)' : value.output];
  if (value.diagnostic !== undefined) lines.push(value.diagnostic);
  if (value.stopReason !== 'completed') lines.push(`codex run status: ${value.stopReason}`);
  const sessionId = value.session ?? value.childSessionId;
  lines.push(`subagent session: ${sessionId === '' ? '(not projected)' : sessionId}`);
  if (sessionId !== '') {
    lines.push(`to continue this delegation, pass session: ${sessionId}`);
  }
  lines.push(`full output: ${value.logPath === '' ? '(none)' : value.logPath}`);
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Validate one required string tool argument.
 * @param value - the raw argument.
 * @param field - the field name, for the diagnostic.
 * @returns the non-empty string.
 */
function requiredToolText(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${PREFIX}: \`${field}\` is required and must be a non-empty string`);
  }
  return value;
}

/**
 * Validate one optional string tool argument.
 * @param value - the raw argument.
 * @param field - the field name, for the diagnostic.
 * @returns the string, or undefined when absent/empty.
 */
function optionalToolText(value, field) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new Error(`${PREFIX}: \`${field}\` must be a string`);
  return value;
}

/**
 * The default child label: the first non-empty line of the prompt. The length
 * cap is applied after {@link prefixedLabel} adds the configured prefix, so the
 * two together stay within {@link LABEL_MAX_CHARS}.
 * @param prompt - the task text.
 * @returns the untruncated first line.
 */
function defaultLabel(prompt) {
  return prompt.split('\n').map((part) => part.trim()).find((part) => part !== '') ?? '';
}

/**
 * Compose the label written to the child descriptor and the parent catalog row.
 * A prompt-derived label is capped at {@link LABEL_MAX_CHARS} including the
 * prefix; an explicit `label` argument keeps its previous uncapped behavior.
 * @param prefix - the configured `labelPrefix` (may be empty).
 * @param label - the parsed label (explicit argument or prompt first line).
 * @param cap - whether to apply the default-label length cap.
 * @returns the final label.
 */
function prefixedLabel(prefix, label, cap) {
  const composed = `${prefix}${label}`;
  return cap && composed.length > LABEL_MAX_CHARS ? composed.slice(0, LABEL_MAX_CHARS) : composed;
}

/**
 * Assert `cwd` can host the child: absolute (it doubles as the workspace
 * identity) and an existing directory (fail here with a clear message instead
 * of as an ambiguous spawn error).
 * @param cwd - the working directory.
 * @returns `cwd`, validated.
 */
async function assertUsableCwd(cwd) {
  if (typeof cwd !== 'string' || cwd === '') throw new Error(`${PREFIX}: child cwd is required`);
  if (!isAbsolute(cwd)) throw new Error(`${PREFIX}: child cwd must be absolute, got "${cwd}"`);
  let info;
  try {
    info = await stat(cwd);
  } catch (error) {
    throw new Error(`${PREFIX}: child cwd is not accessible: "${cwd}" (${errorMessage(error)})`);
  }
  if (!info.isDirectory()) throw new Error(`${PREFIX}: child cwd is not a directory: "${cwd}"`);
  return cwd;
}

/**
 * The calling agent, which owns the parent session this tool records into.
 * @param exec - the tool run context.
 * @returns the parent agent.
 */
function parentAgentOf(exec) {
  const agent = exec?.agent;
  if (agent === undefined || agent === null || agent.session === undefined || agent.session === null) {
    throw new Error(`${PREFIX}: the codex tool needs the calling parent agent (exec.agent) to record the child session; it is unavailable in this call`);
  }
  return agent;
}

/**
 * The parent's working directory, used when the call omits `cwd`.
 * @param agent - the parent agent.
 * @returns an absolute path.
 */
function parentWorkingDirectory(agent) {
  const cwd = agent?.session?.header?.cwd;
  return typeof cwd === 'string' && cwd !== '' ? cwd : process.cwd();
}

/**
 * Delegation depth for the child: the parent's own depth plus one. The
 * persisted header is the monotone floor; runtime options may deepen it.
 * @param agent - the parent agent.
 * @returns the child's non-negative depth.
 */
function delegationDepthOf(agent) {
  const persisted = agent?.session?.header?.delegationDepth;
  const runtime = agent?.options?.subagentDepth;
  const floor = Number.isSafeInteger(persisted) && persisted >= 0 ? persisted : 0;
  const extra = Number.isSafeInteger(runtime) && runtime >= 0 ? runtime : 0;
  return Math.max(floor, extra) + 1;
}

/**
 * Resolve one injected service without assuming the service exists.
 * @param ctx - the plugin context.
 * @param key - the context property name.
 * @returns the service, or undefined.
 */
function serviceOf(ctx, key) {
  const direct = ctx?.[key];
  if (direct !== undefined && direct !== null) return direct;
  return typeof ctx?.get === 'function' ? ctx.get(key) : undefined;
}

/** An identified user message on the child's surface. */
function userMessageData(text) {
  return {
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  };
}

/**
 * Append the child's opening events, before its process exists: the turn
 * bracket, the descriptor, and the task text. Throws on a rejected append so
 * the caller can abandon the whole child session.
 * @param session - the live child session.
 * @param input - label and task text.
 */
function appendOpening(session, input) {
  session.append('turn/start', { turn: 1 });
  session.append('subagent/descriptor', {
    version: DESCRIPTOR_VERSION,
    mode: 'one-shot',
    provider: PROVIDER,
    ...(input.label === '' ? {} : { label: input.label }),
  });
  session.append('user/message', userMessageData(input.prompt), { surfaceOp: 'append' });
}

/**
 * Append the parent's discovery row for a child that is about to start work.
 * @param parent - the parent session.
 * @param session - the child session.
 * @param label - the child's label.
 */
function appendCatalog(parent, session, label) {
  parent.append('subagent/catalog', {
    version: CATALOG_VERSION,
    childId: session.id,
    childCreatedAt: session.header.createdAt,
    mode: 'one-shot',
    label,
  });
}

/**
 * Create the durable child session for one run and publish it, before the
 * child process starts, so the task (and its catalog row) is visible while
 * Codex works.
 *
 * Order follows `dsh-agent-loop`: `prepare` → `sessionPersistence.create` →
 * `enter` → `announce` → append. The child stays live and detachable, and its
 * write handle stays open after the run too, so a later call can append another
 * turn to the same durable log; the handle is released when the plugin unloads.
 *
 * @param ctx - the plugin context.
 * @param input - child identity, parent agent, cwd, label, and task text.
 * @returns the live child session plus the resources needed to release it.
 */
async function openChildSession(ctx, input) {
  const { childId, parentAgent, cwd, label, prompt } = input;
  const sessions = serviceOf(ctx, 'sessions');
  const persistence = serviceOf(ctx, 'sessionPersistence');
  if (sessions === undefined || typeof sessions.prepare !== 'function') {
    throw new Error(`${PREFIX}: the sessions service is unavailable`);
  }
  if (persistence === undefined || typeof persistence.create !== 'function') {
    throw new Error(`${PREFIX}: the sessionPersistence service is unavailable`);
  }
  const parent = parentAgent.session;
  const session = sessions.prepare(childId, {
    meta: {
      cwd,
      parentSession: parent.id,
      origin: 'subagent',
      delegationDepth: delegationDepthOf(parentAgent),
    },
  });
  const handle = await persistence.create(session.header, { inheritedEventCount: 0 });
  let detach;
  try {
    // Events the constructor produced before publication (the session boundary
    // marker) never fire `session/event`, so the persistence backend's live
    // routing cannot see them. `dsh-agent-loop` writes the same suffix through
    // `appendUnstoredSuffix`; without it the stored log would start at a later
    // seq and the backend's contiguity check would reject the first routed
    // event.
    const unstored = session.snapshotEvents();
    if (unstored.length > 0) await handle.append(unstored);
    detach = sessions.enter(session);
    sessions.announce(session);
    appendOpening(session, { label, prompt });
    appendCatalog(parent, session, label);
  } catch (error) {
    try {
      detach?.();
    } catch {
      /* the detach is best-effort once the projection is being abandoned */
    }
    try {
      await handle.close();
    } catch {
      /* the handle is best-effort once the projection is being abandoned */
    }
    throw error;
  }
  return { sessions, session, parent, detach, handle };
}

/**
 * Flush both sessions. Flushing is idempotent: it is the whole post-run step
 * for a retained child session (the write handle stays open for the next turn)
 * and the first half of {@link closeChildSession}.
 * @param ctx - the plugin context.
 * @param opened - the live sessions.
 */
async function flushChildSessions(ctx, opened) {
  const { sessions, session, parent } = opened;
  try {
    await sessions.flush(session);
  } catch (error) {
    warn(ctx, 'could not flush the child session', error);
  }
  try {
    await sessions.flush(parent);
  } catch (error) {
    warn(ctx, 'could not flush the parent session', error);
  }
}

/**
 * Flush both sessions and release the child: detach first, then close the write
 * handle, so the store does not keep a live session behind. Called when the
 * plugin unloads, and when a session that was just opened cannot be used.
 * @param ctx - the plugin context.
 * @param opened - what {@link openChildSession} (or a retained entry) returned.
 */
async function closeChildSession(ctx, opened) {
  await flushChildSessions(ctx, opened);
  const { detach, handle } = opened;
  try {
    detach?.();
  } catch (error) {
    warn(ctx, 'could not detach the child session', error);
  }
  try {
    await handle.close();
  } catch (error) {
    warn(ctx, 'could not close the child session log', error);
  }
}

/**
 * The in-process registry of continuable child sessions: `childId → entry`.
 *
 * Reuse only works for a session this host process opened, so the entry keeps
 * the live session, its write handle, the parent session, the next free turn
 * number, the working directory, the label, and the Codex thread id the wrapper
 * continues from. An entry stays claimed while its run is in flight, which is
 * what makes a concurrent reuse fail fast instead of interleaving two runs.
 */
class SessionRegistry {
  /** @type {Map<string, object>} */
  #entries = new Map();

  /**
   * Reserve one retained session for a run.
   * @param sessionId - the requested child session id, when the call supplied one.
   * @returns the entry, or undefined for a fresh delegation.
   */
  claim(sessionId) {
    if (sessionId === undefined) return undefined;
    const entry = this.#entries.get(sessionId);
    if (entry === undefined) {
      throw new Error(`session ${sessionId} is not continuable in this host process; omit session to start a new one`);
    }
    if (entry.running) {
      throw new Error(`session ${sessionId} is already running; wait for it to finish or start a new one`);
    }
    if (typeof entry.threadId !== 'string' || entry.threadId === '') {
      throw new Error(`${PREFIX}: session ${sessionId} never reported a Codex thread id, so it cannot be continued; omit session to start a new one`);
    }
    entry.running = true;
    return entry;
  }

  /**
   * Remember a freshly opened child session so a later call can continue it.
   * @param entry - the session resources plus the continuation state.
   * @returns `entry`.
   */
  retain(entry) {
    this.#entries.set(entry.session.id, entry);
    return entry;
  }

  /**
   * Forget one session (the entry itself must be released separately).
   * @param sessionId - the child session id.
   */
  release(sessionId) {
    this.#entries.delete(sessionId);
  }

  /** @returns every retained entry. */
  all() {
    return [...this.#entries.values()];
  }
}

/**
 * Append a new turn to an already-open child session. The descriptor and the
 * parent's catalog row describe the delegation as a whole, so a continuation
 * adds only the turn bracket and the new task text.
 * @param ctx - the plugin context.
 * @param entry - the retained session.
 * @param input - the turn number and the new task text.
 * @returns the live session, or undefined when even `turn/start` was rejected.
 */
function resumeChildSession(ctx, entry, input) {
  try {
    entry.session.append('turn/start', { turn: input.turn });
  } catch (error) {
    warn(ctx, 'could not open a new turn on the reused child session; this run is not projected', error);
    return undefined;
  }
  try {
    entry.session.append('user/message', userMessageData(input.prompt), { surfaceOp: 'append' });
  } catch (error) {
    warn(ctx, 'could not append the reused task text to the child session', error);
  }
  return entry;
}

/**
 * The first line of the task, trimmed and cut for the compact log header.
 * @param prompt - the task text.
 * @returns at most {@link SUMMARY_PROMPT_MAX_CHARS} characters.
 */
function promptFirstLine(prompt) {
  const first = prompt.split('\n')[0].trim();
  const line = first === ''
    ? (prompt.split('\n').map((part) => part.trim()).find((part) => part !== '') ?? '')
    : first;
  return line.length > SUMMARY_PROMPT_MAX_CHARS ? line.slice(0, SUMMARY_PROMPT_MAX_CHARS) : line;
}

/**
 * Render the compact log written in `logMode: "summary"`: the task's first
 * line, the final answer, one line per command, and one line of run facts
 * (including the Codex thread id that a human can resume with).
 * @param input - answer, tool records, usage totals, stop reason, ids.
 * @returns the file contents.
 */
function summaryLogText(input) {
  const lines = [input.firstLine];
  const answer = input.answer.trimEnd();
  if (answer !== '') lines.push(answer);
  for (const tool of input.tools) {
    lines.push(`tool ${tool.name.replace(/\s+/g, ' ')} ${tool.durationMs}ms ${tool.isError ? 'error' : 'ok'}`);
  }
  const usage = input.usage === undefined
    ? 'usage none'
    : `usage input=${input.usage.input} output=${input.usage.output} cacheRead=${input.usage.cacheRead} cacheWrite=${input.usage.cacheWrite} reasoning=${input.usage.reasoning}`;
  const thread = input.threadId === undefined ? '(unknown)' : input.threadId;
  lines.push(`${usage} stopReason=${input.stopReason} session=${input.sessionId === '' ? '(not projected)' : input.sessionId} thread=${thread}`);
  for (const note of input.notes) lines.push(`note ${note.replace(/\s+/g, ' ').slice(0, 200)}`);
  return `${lines.join('\n')}\n`;
}

/**
 * Write the compact log, degrading to a warning like every other bonus step.
 * @param ctx - the plugin context.
 * @param logPath - the target file.
 * @param input - what {@link summaryLogText} needs.
 * @returns whether the file was written.
 */
async function writeSummaryLog(ctx, logPath, input) {
  try {
    await writeFile(logPath, summaryLogText(input), 'utf8');
    return true;
  } catch (error) {
    warn(ctx, 'could not write the summary log', error);
    return false;
  }
}

/**
 * Run one delegation and stream its projection into a child session.
 *
 * Without `session` this opens a fresh child session (and a fresh Codex thread,
 * which is still stored under `sessionDir` so it can be continued). With
 * `session` it appends a new turn to the same child session and asks Codex to
 * continue the same thread, keeping Codex's own conversation memory.
 *
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config.
 * @param registry - the in-process continuable-session registry.
 * @param args - the model's tool arguments.
 * @param exec - the tool run context (`agent` and `signal`).
 * @returns the canonical tool value.
 */
async function executeCodex(ctx, config, registry, args, exec) {
  const input = isRecord(args) ? args : {};
  const prompt = requiredToolText(input.prompt, 'prompt');
  const requestedLabel = optionalToolText(input.label, 'label');
  const requestedCwd = optionalToolText(input.cwd, 'cwd');
  const requestedSession = optionalToolText(input.session, 'session');
  const parentAgent = parentAgentOf(exec);
  const signal = exec?.signal;

  // Claim before the first await, so a concurrent call for the same id sees
  // `running` and fails instead of interleaving two runs in one log.
  let entry = registry.claim(requestedSession);
  let openedHere = false;
  let projection;
  let projector;
  let run;
  // A continuation keeps its id even when this turn's projection is rejected,
  // so the caller can still pass it back later.
  let childSessionId = entry?.session.id ?? '';
  let logPath = '';
  let scratch;
  const turn = entry?.nextTurn ?? 1;
  const threadId = entry?.threadId;

  try {
    const cwd = await assertUsableCwd(requestedCwd ?? entry?.cwd ?? parentWorkingDirectory(parentAgent));
    const childId = entry?.session.id ?? randomUUID();
    const parsedLabel = requestedLabel ?? entry?.label ?? defaultLabel(prompt);
    // A continuation adds no descriptor or catalog row, so its retained label
    // is left untouched; a new row gets the configured prefix once.
    const label = entry === undefined
      ? prefixedLabel(config.labelPrefix, parsedLabel, requestedLabel === undefined)
      : parsedLabel;
    logPath = join(config.logDir, `${logStamp(new Date())}-${childId.slice(0, 8)}.log`);
    scratch = await mkdtemp(join(tmpdir(), `${PREFIX}-`));
    const briefPath = join(scratch, 'brief.md');

    try {
      await writeFile(briefPath, prompt, 'utf8');
      try {
        await mkdir(config.logDir, { recursive: true });
      } catch (error) {
        warn(ctx, 'could not create the log directory', error);
      }

      if (entry !== undefined) {
        // Continuation: the child session and Codex's own thread stay the same.
        projection = resumeChildSession(ctx, entry, { turn, prompt });
      } else if (config.projection) {
        // The child session exists (and the parent can list it) before the
        // child process does; a rejected opening append abandons it entirely.
        try {
          projection = await openChildSession(ctx, { childId, parentAgent, cwd, label, prompt });
          openedHere = true;
          entry = registry.retain({
            sessions: projection.sessions,
            session: projection.session,
            parent: projection.parent,
            detach: projection.detach,
            handle: projection.handle,
            nextTurn: turn + 1,
            cwd,
            label,
            threadId: undefined,
            running: true,
          });
        } catch (error) {
          warn(ctx, 'session projection failed; the delegation result is unaffected', error);
        }
      }
      if (projection !== undefined) childSessionId = projection.session.id;

      projector = new ChildProjection({
        ctx,
        session: projection?.session,
        turn,
        maxOutputBytes: config.maxOutputBytes,
        provider: PROVIDER,
        model: config.model ?? 'codex',
      });

      run = await runCodexChild(ctx, config, {
        argv: childArgv(config, {
          briefPath,
          cwd,
          logPath: config.logMode === 'full' ? logPath : undefined,
          threadId,
        }),
        cwd,
        signal,
        onLine: (line) => projector.acceptLine(line),
      });
    } catch (error) {
      // A session opened by this call must not stay live if the run never
      // started; a retained one is left untouched for a later attempt.
      if (projection !== undefined && openedHere) {
        await closeChildSession(ctx, projection);
        registry.release(projection.session.id);
        entry = undefined;
      }
      throw error;
    } finally {
      if (scratch !== undefined) {
        await rm(scratch, { recursive: true, force: true }).catch(() => {});
      }
    }

    const failure = failureOf(run);
    const aborted = run.aborted === true || projector.aborted === true;
    const codexFailure = projector.failureMessage;
    const answered = projector.answerText.trim() !== '';

    let stopReason;
    let failureHead;
    if (aborted) {
      stopReason = 'aborted';
    } else if (failure !== undefined) {
      stopReason = 'error';
      failureHead = failure.message;
    } else if (codexFailure !== undefined) {
      stopReason = 'error';
      failureHead = `codex turn failed: ${codexFailure}`;
    } else if (!answered) {
      // A clean exit is not a successful delegation when Codex never produced
      // the final answer this tool promises to return.
      stopReason = 'error';
      failureHead = 'codex finished without an agent_message answer';
    } else {
      stopReason = 'completed';
    }
    const diagnostic = failureHead === undefined
      ? undefined
      : diagnosticText(failureHead, run.stderr);
    projector.finish({ stopReason, failureMessage: diagnostic ?? failureHead });

    if (projection !== undefined) {
      await flushChildSessions(ctx, projection);
      if (entry !== undefined) entry.nextTurn = Math.max(entry.nextTurn, turn + 1);
    }
    if (entry !== undefined) {
      if (projector.threadId !== undefined) entry.threadId = projector.threadId;
      else if (entry.threadId === undefined) {
        warn(
          ctx,
          'the run reported no Codex thread id; this delegation cannot be continued from this process',
          new Error('no thread.started record'),
        );
      }
    }

    let reportedLogPath = logPath;
    if (config.logMode === 'summary') {
      const written = await writeSummaryLog(ctx, logPath, {
        firstLine: promptFirstLine(prompt),
        answer: projector.finalText,
        tools: projector.tools,
        usage: projector.usage,
        stopReason,
        sessionId: childSessionId,
        threadId: projector.threadId,
        notes: projector.notes,
      });
      // `logPath` must name a file that was actually written.
      if (!written) reportedLogPath = '';
    }

    return {
      output: projector.finalText,
      childSessionId,
      session: childSessionId,
      logPath: reportedLogPath,
      stopReason,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    };
  } finally {
    if (entry !== undefined) entry.running = false;
  }
}

/**
 * Build the `codex` tool definition. Registered as a plain object (not through
 * `defineTool`) so the plugin keeps its zero-dependency surface.
 * @param ctx - the plugin context.
 * @param config - the resolved plugin config.
 * @param registry - the in-process continuable-session registry.
 * @returns the registry-ready definition.
 */
function createCodexTool(ctx, config, registry) {
  return {
    name: 'codex',
    description: TOOL_DESCRIPTION,
    parameters: TOOL_PARAMETERS,
    output: {
      schema: TOOL_OUTPUT_SCHEMA,
      render: renderCodexResult,
    },
    execute: (args, exec) => executeCodex(ctx, config, registry, args, exec),
  };
}

/**
 * Validate one optional string config value.
 * @param field - the config field name, for the diagnostic.
 * @param value - the raw value; `undefined`, `null`, and `''` mean "absent".
 * @returns the value, or `undefined` when absent.
 */
function optionalText(field, value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new TypeError(`${PREFIX}: ${field} must be a string`);
  return value;
}

/**
 * Validate one required string config value.
 * @param field - the config field name, for the diagnostic.
 * @param value - the raw value; `undefined` and `null` select the fallback.
 * @param fallback - the default.
 * @returns the configured value or the fallback.
 */
function requiredText(field, value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${PREFIX}: ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Validate one boolean config value.
 * @param field - the config field name, for the diagnostic.
 * @param value - the raw value; `undefined` and `null` select the fallback.
 * @param fallback - the default.
 * @returns the configured value or the fallback.
 */
function booleanValue(field, value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'boolean') throw new TypeError(`${PREFIX}: ${field} must be a boolean`);
  return value;
}

/**
 * Validate one numeric config value: it bounds a teardown or drain wait, so
 * zero, negative, or non-finite would skip or wedge it.
 * @param field - the config field name, for the diagnostic.
 * @param value - the raw value; `undefined` and `null` select the fallback.
 * @param fallback - the default.
 * @returns the configured value or the fallback.
 */
function positiveNumber(field, value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${PREFIX}: ${field} must be a positive finite number`);
  }
  return value;
}

/**
 * Validate one sandbox config value. `codex exec -s` only accepts these three,
 * so anything else is a load error rather than a failed delegation.
 * @param value - the raw value; `undefined` and `null` select the fallback.
 * @param fallback - the default.
 * @returns the configured sandbox mode.
 */
function sandboxValue(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || !SANDBOX_MODES.includes(value)) {
    throw new TypeError(`${PREFIX}: sandbox must be one of ${SANDBOX_MODES.join(', ')}`);
  }
  return value;
}

/**
 * Apply defaults and validate the plugin config. Throws at mount time, so a
 * bad value is a load error rather than a surprise on the first delegation.
 * @param config - the raw config object from the profile.
 * @returns the resolved config.
 */
function resolveConfig(config) {
  const raw = isRecord(config) ? config : {};

  let args = [];
  if (raw.args !== undefined && raw.args !== null) {
    if (!Array.isArray(raw.args)) throw new TypeError(`${PREFIX}: args must be an array of strings`);
    args = raw.args.map((arg, index) => {
      if (typeof arg !== 'string') throw new TypeError(`${PREFIX}: args[${index}] must be a string`);
      return arg;
    });
  }

  const logMode = raw.logMode === undefined || raw.logMode === null ? 'summary' : raw.logMode;
  if (logMode !== 'summary' && logMode !== 'full') {
    throw new TypeError(`${PREFIX}: logMode must be "summary" or "full"`);
  }

  const labelPrefix = raw.labelPrefix === undefined || raw.labelPrefix === null
    ? DEFAULT_LABEL_PREFIX
    : raw.labelPrefix;
  if (typeof labelPrefix !== 'string') throw new TypeError(`${PREFIX}: labelPrefix must be a string`);
  if (LABEL_PREFIX_CONTROL_CHARS.test(labelPrefix)) {
    throw new TypeError(`${PREFIX}: labelPrefix must not contain control characters`);
  }

  const home = typeof process.env.HOME === 'string' && process.env.HOME !== '' ? process.env.HOME : homedir();

  return {
    command: requiredText('command', raw.command, DEFAULT_COMMAND),
    args,
    model: optionalText('model', raw.model),
    thinking: optionalText('thinking', raw.thinking),
    projection: booleanValue('projection', raw.projection, true),
    labelPrefix,
    logMode,
    logDir: requiredText('logDir', raw.logDir, join(home, DEFAULT_LOG_SUBDIR)),
    sessionDir: requiredText('sessionDir', raw.sessionDir, join(home, DEFAULT_SESSION_SUBDIR)),
    graceMs: positiveNumber('graceMs', raw.graceMs, DEFAULT_GRACE_MS),
    maxOutputBytes: positiveNumber('maxOutputBytes', raw.maxOutputBytes, DEFAULT_MAX_OUTPUT_BYTES),
    sandbox: sandboxValue(raw.sandbox, DEFAULT_SANDBOX),
    dangerouslyBypass: booleanValue('dangerouslyBypass', raw.dangerouslyBypass, false),
  };
}

/**
 * Close every retained child session at unload: flush, detach, and close the
 * write handle. A failed flush or close is only a warning; unloading must not
 * throw.
 * @param ctx - the plugin context.
 * @param registry - the in-process continuable-session registry.
 */
async function closeRetainedSessions(ctx, registry) {
  for (const entry of registry.all()) {
    registry.release(entry.session.id);
    await closeChildSession(ctx, entry);
  }
}

/**
 * Register the `codex` tool with the tool registry.
 * @param ctx - the plugin context; `tools`, `sessions`, and
 *   `sessionPersistence` are injected.
 * @param config - the profile config (see README for the table).
 */
export function apply(ctx, config = {}) {
  const resolved = resolveConfig(config);
  const registry = new SessionRegistry();
  ctx.tools.register(createCodexTool(ctx, resolved, registry));
  // Retained child sessions stay live between delegations so a later call can
  // append a turn; release them when the plugin unloads.
  if (typeof ctx.effect === 'function') {
    ctx.effect(
      () => () => closeRetainedSessions(ctx, registry),
      `${PREFIX}: retained child sessions`,
    );
  }
}
