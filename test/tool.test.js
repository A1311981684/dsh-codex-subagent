/**
 * Unit tests for the `codex` tool and its live session projection.
 *
 * Every delegation spawns a real child process — `test/fake-codex-dev.mjs`,
 * copied into the scratch root and executed as the configured `command`. The
 * fixture reads the brief for its `FIXTURE`/`RECORD` directives, so one generic
 * script covers structured runs, early partial output, plain-text runs,
 * failures, slow runs, and SIGTERM-ignoring runs while every test can inspect
 * the exact argv the plugin built and the `CODEX_HOME` it handed over.
 *
 * DSH is never loaded: the fake `ctx` below records what the plugin asks of
 * `tools`, `sessions`, and `sessionPersistence`, and the assertions check the
 * payloads against the 0.2.2-rc.1 event shapes by hand (no `@deepseek-ai/*`
 * import, exactly like the plugin).
 *
 * `HOME` is redirected at module scope, *before* the plugin is imported, so the
 * HOME-derived defaults (`$HOME/.dsh/bin/codex-dev`, `$HOME/.dsh/codex-logs`,
 * `$HOME/.dsh/codex-sessions`) point into the scratch root and a
 * default-command test can never execute the real wrapper.
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, before, test } from 'node:test';

const homeRoot = await mkdtemp(join(tmpdir(), 'dsh-codex-subagent-home-'));
const previousHome = process.env.HOME;
process.env.HOME = homeRoot;

const { apply, inject, name } = await import('../lib/index.js');

/** The default command the plugin resolves from the redirected HOME. */
const DEFAULT_COMMAND = join(homeRoot, '.dsh', 'bin', 'codex-dev');

/** The test-owned wrapper that writes Codex-style NDJSON. */
let FAKE_CODEX = '';

/** Scratch root for fixtures, logs, and the copied wrapper. */
let root = '';

let sequence = 0;

/** One fake DSH session: an id, a header, and the appended events in order. */
function fakeSession(id, meta, log, owner, appendError) {
  const events = [];
  const header = { version: 4, id, createdAt: 1_760_000_000_000, isSeeded: false, ...meta };
  return {
    id,
    header,
    events,
    snapshotEvents() {
      // The constructor boundary marker a real Session holds before publication.
      return [{ type: 'session/end-seed', data: {}, seq: 0 }];
    },
    append(type, data, opts) {
      log.push(`append:${owner}:${type}`);
      if (appendError !== undefined && appendError.type === type) throw appendError.error;
      events.push({
        type,
        data: structuredClone(data),
        ...(opts === undefined ? {} : { opts: structuredClone(opts) }),
      });
      return { type, data, seq: events.length - 1 };
    },
  };
}

/** The injected session store, recording every call in the shared order log. */
class FakeSessions {
  constructor(options = {}) {
    this.log = options.log ?? [];
    this.prepareError = options.prepareError;
    this.enterError = options.enterError;
    this.appendError = options.appendError;
    this.flushes = [];
    this.prepared = [];
    this.entered = [];
    this.announced = [];
    this.detached = [];
  }

  prepare(id, options) {
    this.log.push('sessions:prepare');
    if (this.prepareError !== undefined) throw this.prepareError;
    const session = fakeSession(id, options?.meta, this.log, 'child', this.appendError);
    this.prepared.push({ id, options, session });
    return session;
  }

  enter(session) {
    this.log.push('sessions:enter');
    if (this.enterError !== undefined) throw this.enterError;
    this.entered.push(session);
    return () => {
      this.log.push('sessions:detach');
      this.detached.push(session);
    };
  }

  announce(session) {
    this.log.push('sessions:announce');
    this.announced.push(session);
  }

  async flush(session) {
    this.log.push(`sessions:flush:${session.id}`);
    this.flushes.push(session);
    return true;
  }
}

/** The injected persistence service: `create` hands back an appendable handle. */
class FakePersistence {
  constructor(options = {}) {
    this.log = options.log ?? [];
    this.createError = options.createError;
    this.created = [];
    this.appended = [];
    this.closed = [];
  }

  async create(header, options) {
    this.log.push('persistence:create');
    if (this.createError !== undefined) throw this.createError;
    this.created.push({ header, options });
    const log = this.log;
    const appended = this.appended;
    const closed = this.closed;
    return {
      id: header.id,
      header,
      inheritedEventCount: 0,
      access: 'write',
      async append(events) {
        log.push('persistence:append');
        appended.push(events.map((event) => structuredClone(event)));
      },
      async flush() {},
      async read() {
        return { eventState: 'detached', events: [] };
      },
      async close() {
        log.push('persistence:close');
        closed.push(header.id);
      },
    };
  }
}

/**
 * Mount the plugin on a fake context.
 * @param options - `config` overrides, `noSessions`/`noPersistence` to omit a
 *   service, and `sessionsOptions`/`persistenceOptions` for the fakes.
 */
function mount(options = {}) {
  const log = [];
  const sessions = options.noSessions === true
    ? null
    : new FakeSessions({ log, ...(options.sessionsOptions ?? {}) });
  const persistence = options.noPersistence === true
    ? null
    : new FakePersistence({ log, ...(options.persistenceOptions ?? {}) });
  const warned = [];
  const registered = [];
  const disposers = [];
  const ctx = {
    logger: { warn: (...parts) => warned.push(parts.join(' ')) },
    tools: {
      register(definition) {
        registered.push(definition);
        return () => {};
      },
    },
    effect(callback) {
      disposers.push(callback());
    },
    ...(sessions === null ? {} : { sessions }),
    ...(persistence === null ? {} : { sessionPersistence: persistence }),
  };
  apply(ctx, { command: FAKE_CODEX, logDir: join(root, 'logs'), ...(options.config ?? {}) });
  assert.equal(registered.length, 1, 'apply must register exactly one tool');
  return { definition: registered[0], ctx, sessions, persistence, warned, log, disposers };
}

/** The parent session the fake agent drives. */
function fakeParent(meta = { cwd: root, delegationDepth: 2 }, log = []) {
  return fakeSession('parent-1', meta, log, 'parent');
}

/** A parent agent exposing what the plugin reads from `exec.agent`. */
function fakeAgent(parent, options = {}) {
  return { id: parent.id, session: parent, options };
}

/** Write one fixture file. */
async function writeFixture(fixture) {
  sequence += 1;
  const path = join(root, `fixture-${sequence}.json`);
  await writeFile(path, JSON.stringify(fixture), 'utf8');
  return path;
}

/** Reserve a record-file path. */
function recordPath() {
  sequence += 1;
  return join(root, `record-${sequence}.json`);
}

/** A brief carrying the test directives the fake wrapper reads. */
function briefWith(prompt, fixturePath, recorded) {
  return `${prompt}\n\nFIXTURE ${fixturePath}\nRECORD ${recorded}`;
}

/** JSONL framing for a list of records. */
function ndjson(records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

/** One `item.started` command record. */
function commandStarted({ id = 'item_1', command = "/bin/bash -c 'echo hi'", status = 'in_progress' } = {}) {
  return {
    type: 'item.started',
    item: { id, type: 'command_execution', command, aggregated_output: '', exit_code: null, status },
  };
}

/** One `item.completed` command record. */
function commandCompleted({
  id = 'item_1',
  command = "/bin/bash -c 'echo hi'",
  output = 'hi\n',
  exitCode = 0,
  status = 'completed',
} = {}) {
  return {
    type: 'item.completed',
    item: {
      id,
      type: 'command_execution',
      command,
      aggregated_output: output,
      exit_code: exitCode,
      status,
    },
  };
}

/** One `item.completed` agent message record. */
function agentMessage(text, id = 'item_2') {
  return { type: 'item.completed', item: { id, type: 'agent_message', text } };
}

/** One `turn.completed` record with the usage shape the real CLI reports. */
function turnCompleted(usage = {
  input_tokens: 30,
  cached_input_tokens: 10,
  cache_write_input_tokens: 2,
  output_tokens: 7,
  reasoning_output_tokens: 3,
}) {
  return { type: 'turn.completed', usage };
}

/** A thread.started record. */
function threadStarted(threadId = 'thread-1') {
  return { type: 'thread.started', thread_id: threadId };
}

/** Invoke the registered tool with a parent agent and a fresh signal. */
async function runTool(mounted, parent, args, execOptions = {}) {
  const controller = new AbortController();
  return mounted.definition.execute(args, {
    agent: execOptions.agent ?? fakeAgent(parent, execOptions.agentOptions ?? {}),
    signal: execOptions.signal ?? controller.signal,
    callId: 'call-1',
  });
}

/** Wait until `path` exists (the fake wrapper writes its record on startup). */
async function waitForFile(path, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${path}`);
}

/** Wait until `predicate()` is truthy (a streamed event has landed). */
async function waitFor(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('timed out waiting for the projection to reach a state');
}

/** The canonical run: one command execution, then the answer. */
function successRecords({ text = '改完了：lib/index.js', threadId = 'thread-1' } = {}) {
  return [
    threadStarted(threadId),
    { type: 'turn.started' },
    commandStarted(),
    commandCompleted(),
    agentMessage(text),
    turnCompleted(),
  ];
}

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-subagent-test-'));
  FAKE_CODEX = join(root, 'fake-codex-dev.mjs');
  const fixture = await readFile(new URL('./fake-codex-dev.mjs', import.meta.url), 'utf8');
  await writeFile(FAKE_CODEX, fixture, 'utf8');
  await chmod(FAKE_CODEX, 0o755);
});

after(async () => {
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
  await rm(root, { recursive: true, force: true });
  await rm(homeRoot, { recursive: true, force: true });
});

test('导出契约：name 与 inject', () => {
  assert.equal(name, 'subagent-codex-cli');
  assert.deepEqual(inject, ['tools', 'sessions', 'sessionPersistence']);
});

test('工具注册：名字、面向模型的描述、参数与输出声明', () => {
  const { definition } = mount();
  assert.equal(definition.name, 'codex');
  assert.match(definition.description, /Codex CLI/);
  assert.match(definition.description, /child session/);
  assert.match(definition.description, /command calls/);
  assert.match(definition.description, /pass the id back as `session`/);
  assert.deepEqual(Object.keys(definition.parameters.properties), ['prompt', 'cwd', 'label', 'session']);
  assert.deepEqual(definition.parameters.required, ['prompt']);
  assert.equal(definition.parameters.properties.prompt.type, 'string');
  assert.equal(definition.parameters.properties.cwd.type, 'string');
  assert.equal(definition.parameters.properties.label.type, 'string');
  assert.equal(definition.parameters.properties.session.type, 'string');
  assert.deepEqual(definition.output.schema.required, ['output', 'childSessionId', 'session', 'logPath', 'stopReason']);
  assert.equal(typeof definition.output.render, 'function');
  assert.equal(typeof definition.execute, 'function');
});

test('完成的运行：会话先建后跑，事件序列、flush 顺序、返回值与模型文本', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const recorded = recordPath();
  const mounted = mount();
  const parent = fakeParent(undefined, mounted.log);
  const prompt = briefWith('修一个 bug', fixturePath, recorded);

  const value = await runTool(mounted, parent, { prompt });
  const [{ id, options, session }] = mounted.sessions.prepared;
  const record = JSON.parse(await readFile(recorded, 'utf8'));

  // prepare: the child's durable identity, parent lineage, and depth.
  assert.deepEqual(options.meta, {
    cwd: root,
    parentSession: 'parent-1',
    origin: 'subagent',
    delegationDepth: 3,
  });
  assert.equal(mounted.persistence.created.length, 1);
  assert.deepEqual(mounted.persistence.created[0].options, { inheritedEventCount: 0 });
  assert.equal(mounted.persistence.created[0].header, session.header);
  assert.equal(value.childSessionId, id);
  assert.equal(value.session, id);
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.output, '改完了：lib/index.js');
  assert.equal(value.diagnostic, undefined);
  assert.deepEqual(mounted.warned, []);

  // The wrapper is asked for JSON mode with the plugin's own session dir, and
  // (fresh delegation) without a thread id.
  assert.equal(record.mode, 'json');
  assert.equal(record.argv[record.argv.indexOf('--session-dir') + 1], join(homeRoot, '.dsh', 'codex-sessions'));
  assert.equal(record.argv.includes('--session-id'), false);
  assert.equal(record.argv[record.argv.indexOf('--sandbox') + 1], 'workspace-write');
  assert.equal(record.argv.includes('--log'), false, 'summary mode must not ask the wrapper to tee the JSON stream');
  assert.match(value.logPath, /\d{8}-\d{6}-[0-9a-f]{8}\.log$/);

  // Event sequence: the turn opens, the descriptor sits inside it, the prompt
  // lands, the Codex turn becomes one step holding the command call/result and
  // the answer, then the turn closes.
  assert.deepEqual(session.events.map((event) => event.type), [
    'turn/start',
    'subagent/descriptor',
    'user/message',
    'step/start',
    'assistant/message',
    'tool/call',
    'tool/result',
    'assistant/message',
    'step/end',
    'turn/end',
  ]);

  // Order around the projection: create → persist the pre-publication marker
  // → enter → announce → append. The opening events and the parent catalog row
  // exist before the child process starts; flush comes last.
  assert.equal(mounted.persistence.appended.length, 1, 'the constructor marker must be persisted first');
  assert.deepEqual(mounted.persistence.appended[0].map((event) => event.type), ['session/end-seed']);
  const position = (entry) => mounted.log.indexOf(entry);
  assert.ok(position('persistence:create') < position('persistence:append'));
  assert.ok(position('persistence:append') < position('sessions:enter'));
  assert.ok(position('sessions:enter') < position('sessions:announce'));
  assert.ok(position('sessions:announce') < position('append:child:turn/start'));
  assert.ok(position('append:child:user/message') < position('append:parent:subagent/catalog'));
  assert.ok(position('append:parent:subagent/catalog') < position('append:child:step/start'));
  assert.ok(position('append:child:turn/end') < position(`sessions:flush:${id}`));
  assert.ok(position(`sessions:flush:${id}`) < position('sessions:flush:parent-1'));
  // Retained for reuse: no detach and no close after the run, only a flush.
  assert.equal(mounted.sessions.detached.length, 0, 'the projected child stays live so a later call can continue it');
  assert.deepEqual(mounted.persistence.closed, []);

  // Model-facing text: answer first, then the session, the continuation hint,
  // and the log pointer.
  assert.deepEqual(mounted.definition.output.render({ prompt }, value), [{
    type: 'text',
    text: [
      '改完了：lib/index.js',
      `subagent session: ${id}`,
      `to continue this delegation, pass session: ${id}`,
      `full output: ${value.logPath}`,
    ].join('\n'),
  }]);
});

test('投影细节：descriptor、step 括号、command 调用与输出、错误退出码、turn/end', async () => {
  const fixturePath = await writeFixture({
    records: [
      threadStarted('thread-9'),
      { type: 'turn.started' },
      commandStarted({ id: 'item_7', command: "/bin/bash -c 'false'" }),
      commandCompleted({
        id: 'item_7',
        command: "/bin/bash -c 'false'",
        output: 'boom\n',
        exitCode: 3,
        status: 'failed',
      }),
      agentMessage('命令失败了，但任务继续'),
      turnCompleted(),
    ],
  });
  const recorded = recordPath();
  const mounted = mount();
  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('投影细节', fixturePath, recorded),
  });
  const session = mounted.sessions.prepared[0].session;
  const events = session.events;

  assert.deepEqual(events[1].data, { version: 3, mode: 'one-shot', provider: 'codex', label: 'codex · 投影细节' });
  assert.deepEqual(events[2].data.content[0].type, 'text');
  assert.match(events[2].data.content[0].text, /^投影细节/);
  assert.deepEqual(events[2].opts, { surfaceOp: 'append' });

  assert.deepEqual(
    events.filter((event) => event.type === 'step/start').map((event) => event.data),
    [{ turn: 1, step: 1 }],
  );
  assert.deepEqual(
    events.filter((event) => event.type === 'step/end').map((event) => event.data),
    [{ turn: 1, step: 1 }],
  );

  const assistants = events.filter((event) => event.type === 'assistant/message');
  assert.equal(assistants.length, 2);
  assert.deepEqual(assistants[0].data.message.content, [{
    type: 'tool-call',
    id: 'item_7',
    name: 'command',
    arguments: JSON.stringify({ command: "/bin/bash -c 'false'" }),
  }]);
  assert.deepEqual(assistants[0].data.message.source, { kind: 'model', provider: 'codex', model: 'codex' });
  assert.deepEqual(assistants[1].data.message.content, [{ type: 'text', text: '命令失败了，但任务继续' }]);

  const call = events.find((event) => event.type === 'tool/call');
  assert.deepEqual(call.data, {
    turn: 1,
    step: 1,
    callId: 'item_7',
    name: 'command',
    arguments: assistants[0].data.message.content[0].arguments,
  });
  const result = events.find((event) => event.type === 'tool/result');
  assert.deepEqual(result.data.message.content, [{ type: 'text', text: 'boom\n' }]);
  assert.equal(result.data.message.toolCallId, 'item_7');
  assert.equal(result.data.message.isError, true);
  assert.deepEqual(result.data.message.source, { kind: 'tool', callId: 'item_7' });
  assert.deepEqual(result.opts, { surfaceOp: 'append' });

  assert.deepEqual(events[events.length - 1].data, { turn: 1, reason: { kind: 'completed' } });
  assert.equal(value.output, '命令失败了，但任务继续');
});

test('多轮：两个 Codex turn → 两个 step，编号 1、2，只有一个 DSH turn', async () => {
  const fixturePath = await writeFixture({
    records: [
      threadStarted('thread-2'),
      { type: 'turn.started' },
      agentMessage('第一步', 'item_1'),
      turnCompleted({ input_tokens: 1, output_tokens: 1 }),
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_2', type: 'reasoning', text: '内部推理' } },
      agentMessage('第二步', 'item_3'),
      turnCompleted({ input_tokens: 2, output_tokens: 2 }),
    ],
  });
  const mounted = mount();
  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('多轮', fixturePath, recordPath()),
  });
  const session = mounted.sessions.prepared[0].session;

  assert.deepEqual(
    session.events.filter((event) => event.type === 'turn/start').map((event) => event.data),
    [{ turn: 1 }],
    'Codex turns are DSH steps, so the log has one DSH turn',
  );
  assert.deepEqual(
    session.events.filter((event) => event.type === 'step/start').map((event) => event.data),
    [{ turn: 1, step: 1 }, { turn: 1, step: 2 }],
  );
  const assistants = session.events.filter((event) => event.type === 'assistant/message');
  // Codex reports reasoning and the agent message as separate items, so each
  // becomes its own assistant message inside the same step.
  assert.deepEqual(assistants.map((event) => [event.data.step, event.data.message.content]), [
    [1, [{ type: 'text', text: '第一步' }]],
    [2, [{ type: 'reasoning', text: '内部推理' }]],
    [2, [{ type: 'text', text: '第二步' }]],
  ]);
  assert.equal(session.events.filter((event) => event.type === 'user/message').length, 1, '任务只投影一次');
  assert.equal(value.output, '第二步', '最终回答取最后一条 agent_message');
});

test('非致命 item error：只 warn、不判失败，摘要日志留一条 note', async () => {
  const fixturePath = await writeFixture({
    records: [
      threadStarted('thread-3'),
      {
        type: 'item.completed',
        item: {
          id: 'item_0',
          type: 'error',
          message: 'Model metadata for `deepseek-flash` not found. Defaulting to fallback metadata.',
        },
      },
      { type: 'turn.started' },
      agentMessage('照常完成'),
      turnCompleted(),
    ],
  });
  const mounted = mount();
  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('非致命告警', fixturePath, recordPath()),
  });

  assert.equal(value.stopReason, 'completed');
  assert.equal(value.output, '照常完成');
  assert.equal(mounted.warned.length, 1);
  assert.match(mounted.warned[0], /non-fatal item error/);
  const log = await readFile(value.logPath, 'utf8');
  assert.match(log, /note .*Model metadata/);
});

test('未知 item 类型：跳过并 warn 一次，运行照常完成', async () => {
  const fixturePath = await writeFixture({
    records: [
      threadStarted('thread-4'),
      { type: 'turn.started' },
      {
        type: 'item.completed',
        item: { id: 'item_1', type: 'file_change', changes: [{ path: 'a.txt', kind: 'update' }] },
      },
      {
        type: 'item.completed',
        item: { id: 'item_2', type: 'mcp_tool_call', server: 'x', tool: 'y' },
      },
      agentMessage('未知类型也能继续'),
      turnCompleted(),
    ],
  });
  const mounted = mount();
  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('未知类型', fixturePath, recordPath()),
  });

  assert.equal(value.stopReason, 'completed');
  assert.equal(value.output, '未知类型也能继续');
  const skipped = mounted.warned.filter((line) => line.includes('unsupported type'));
  assert.equal(skipped.length, 2, 'one warning per unsupported item type');
  assert.ok(skipped.some((line) => line.includes('file_change')));
  assert.ok(skipped.some((line) => line.includes('mcp_tool_call')));
});

test('失败：turn.failed → stopReason error、turn/end error、诊断带 Codex 的消息', async () => {
  const failure = 'stream error: model unavailable';
  const fixturePath = await writeFixture({ kind: 'failed', failure });
  const mounted = mount();
  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('失败', fixturePath, recordPath()),
  });
  const session = mounted.sessions.prepared[0].session;

  assert.equal(value.stopReason, 'error');
  assert.equal(value.output, '');
  assert.match(value.diagnostic, /^codex turn failed: stream error: model unavailable/);
  const turnEnd = session.events.find((event) => event.type === 'turn/end');
  assert.equal(turnEnd.data.reason.kind, 'error');
  assert.match(turnEnd.data.reason.error.message, /stream error: model unavailable/);
  // The non-fatal error item in the same run does not become the failure.
  assert.ok(mounted.warned.some((line) => line.includes('non-fatal item error')));
  const rendered = mounted.definition.output.render({}, value)[0].text;
  assert.match(rendered, /codex run status: error/);
  assert.match(rendered, /subagent session: [0-9a-f-]{36}/);
});

test('失败：非零退出 → error，诊断带退出码和 stderr，未闭合的 step 仍收尾', async () => {
  const fixturePath = await writeFixture({
    stdout: ndjson([threadStarted('thread-5'), { type: 'turn.started' }]),
    stderr: 'codex-dev: 找不到固定规矩',
    exitCode: 2,
  });
  const mounted = mount();
  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('退出码失败', fixturePath, recordPath()),
  });
  const session = mounted.sessions.prepared[0].session;

  assert.equal(value.stopReason, 'error');
  assert.match(value.diagnostic, /^codex-dev exit code 2\n/);
  assert.match(value.diagnostic, /找不到固定规矩/);
  const types = session.events.map((event) => event.type);
  assert.ok(types.includes('step/start'));
  assert.ok(types.indexOf('step/end') < types.indexOf('turn/end'));
  assert.equal(session.events.find((event) => event.type === 'turn/end').data.reason.kind, 'error');
});

test('失败：turn 成功但没有 agent_message → 不算完成', async () => {
  const fixturePath = await writeFixture({ kind: 'no-answer' });
  const mounted = mount();
  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('没有答案', fixturePath, recordPath()),
  });

  assert.equal(value.stopReason, 'error');
  assert.equal(value.output, '');
  assert.match(value.diagnostic, /codex finished without an agent_message answer/);
});

test('降级：stdout 不是 NDJSON → 全部当最终文本，只有一条助手消息', async () => {
  const fixturePath = await writeFixture({ stdout: '改完了\n加了一行注释\n' });
  const mounted = mount();
  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('纯文本', fixturePath, recordPath()),
  });
  const session = mounted.sessions.prepared[0].session;

  assert.equal(value.output, '改完了\n加了一行注释');
  assert.equal(value.stopReason, 'completed');
  assert.deepEqual(session.events.map((event) => event.type), [
    'turn/start',
    'subagent/descriptor',
    'user/message',
    'step/start',
    'assistant/message',
    'step/end',
    'turn/end',
  ]);
  assert.deepEqual(session.events[4].data.message.content, [{ type: 'text', text: '改完了\n加了一行注释' }]);
  assert.deepEqual(session.events[4].data.message.source, { kind: 'model', provider: 'codex', model: 'codex' });
  // No thread id means this delegation cannot be continued from this process.
  assert.ok(mounted.warned.some((line) => line.includes('no Codex thread id')));
});

test('参数校验：prompt 必填、cwd/label 必须是字符串、缺 exec.agent 报清楚', async () => {
  const { definition } = mount();
  const parent = fakeParent();
  const exec = { agent: fakeAgent(parent), signal: new AbortController().signal };

  await assert.rejects(() => definition.execute({}, exec), /`prompt` is required/);
  await assert.rejects(() => definition.execute({ prompt: '   ' }, exec), /`prompt` is required/);
  await assert.rejects(() => definition.execute({ prompt: 'x', cwd: 1 }, exec), /`cwd` must be a string/);
  await assert.rejects(() => definition.execute({ prompt: 'x', label: 1 }, exec), /`label` must be a string/);
  await assert.rejects(
    () => definition.execute({ prompt: 'x' }, { signal: new AbortController().signal }),
    /needs the calling parent agent \(exec\.agent\)/,
  );
});

test('cwd 校验：相对路径 / 不存在的目录都在建会话和 spawn 之前失败', async () => {
  const mounted = mount();
  const parent = fakeParent();
  await assert.rejects(
    () => runTool(mounted, parent, { prompt: 'x', cwd: 'relative/dir' }),
    /child cwd must be absolute/,
  );
  await assert.rejects(
    () => runTool(mounted, parent, { prompt: 'x', cwd: join(root, 'nope') }),
    /child cwd is not accessible/,
  );
  assert.deepEqual(mounted.sessions.prepared, []);
});

test('取消：运行中 abort → 未结算调用补 result、step 关闭、turn/end 是 aborted', async () => {
  const early = ndjson([
    threadStarted('thread-6'),
    { type: 'turn.started' },
    commandStarted({ id: 'item_1', command: "/bin/bash -c 'sleep 30'" }),
  ]);
  const fixturePath = await writeFixture({ stdoutEarly: early, delayMs: 30_000 });
  const recorded = recordPath();
  const mounted = mount();
  const controller = new AbortController();

  const running = runTool(mounted, fakeParent(), {
    prompt: briefWith('长任务', fixturePath, recorded),
  }, { signal: controller.signal });
  await waitForFile(recorded);
  const session = mounted.sessions.prepared[0].session;
  await waitFor(() => session.events.some((event) => event.type === 'tool/call'));
  controller.abort();
  const value = await running;

  assert.equal(value.stopReason, 'aborted');
  assert.deepEqual(session.events.map((event) => event.type), [
    'turn/start',
    'subagent/descriptor',
    'user/message',
    'step/start',
    'assistant/message',
    'tool/call',
    'tool/result',
    'step/end',
    'turn/end',
  ]);
  const result = session.events.find((event) => event.type === 'tool/result');
  assert.equal(result.data.message.toolCallId, 'item_1');
  assert.equal(result.data.message.isError, true);
  assert.match(result.data.message.content[0].text, /did not return a result/);
  const turnEnd = session.events.find((event) => event.type === 'turn/end');
  assert.deepEqual(turnEnd.data, { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } });
});

test('取消升级：忽略 SIGTERM 的子进程在 graceMs 后被 SIGKILL', async () => {
  const fixturePath = await writeFixture({ delayMs: 30_000, ignoreTerm: true });
  const recorded = recordPath();
  const mounted = mount({ config: { graceMs: 100 } });
  const controller = new AbortController();
  const startedAt = Date.now();

  const running = runTool(mounted, fakeParent(), {
    prompt: briefWith('顽固任务', fixturePath, recorded),
  }, { signal: controller.signal });
  await waitForFile(recorded);
  controller.abort();
  const value = await running;
  const elapsed = Date.now() - startedAt;

  assert.equal(value.stopReason, 'aborted');
  assert.ok(elapsed < 5_000, `SIGKILL escalation should end the run quickly, took ${elapsed}ms`);
});

test('降级：sessions.prepare 抛错 → 派活结果照常返回，只 warn 一次', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const mounted = mount({ sessionsOptions: { prepareError: new Error('store is closed') } });

  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('任务', fixturePath, recordPath()),
  });
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.output, '改完了：lib/index.js');
  assert.equal(value.childSessionId, '');
  assert.equal(mounted.warned.length, 1);
  assert.match(mounted.warned[0], /session projection failed; the delegation result is unaffected: store is closed/);
});

test('降级：sessionPersistence 缺失 → 结果照常，不建子会话', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const mounted = mount({ noPersistence: true });

  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('任务', fixturePath, recordPath()),
  });
  assert.equal(value.output, '改完了：lib/index.js');
  assert.equal(value.childSessionId, '');
  assert.match(mounted.warned[0], /sessionPersistence service is unavailable/);
});

test('降级：运行中 append 被拒 → 只 warn，结构仍收尾，结果照常', async () => {
  const fixturePath = await writeFixture({
    records: [
      threadStarted('thread-7'),
      { type: 'turn.started' },
      agentMessage('改完了'),
      turnCompleted(),
    ],
  });
  const mounted = mount({
    sessionsOptions: { appendError: { type: 'assistant/message', error: new Error('surface append rejected') } },
  });

  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('任务', fixturePath, recordPath()),
  });
  const session = mounted.sessions.prepared[0].session;

  assert.equal(value.output, '改完了');
  assert.equal(value.stopReason, 'completed');
  assert.equal(value.childSessionId, session.id);
  assert.match(mounted.warned[0], /surface append rejected/);
  // Content after the rejected append is skipped, but the step and turn still
  // close so the stored log is not left structurally open.
  assert.deepEqual(session.events.map((event) => event.type), [
    'turn/start',
    'subagent/descriptor',
    'user/message',
    'step/start',
    'step/end',
    'turn/end',
  ]);
  assert.equal(mounted.sessions.detached.length, 0);
  assert.deepEqual(mounted.persistence.closed, []);
});

test('超长行：丢弃单行并 warn，后续记录照常投影', async () => {
  const oversized = `${'x'.repeat(2 * 1024 * 1024 + 16)}\n`;
  const fixturePath = await writeFixture({
    stdoutEarly: oversized,
    records: successRecords(),
  });
  const mounted = mount();
  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('超长行', fixturePath, recordPath()),
  });

  assert.equal(value.stopReason, 'completed');
  assert.equal(value.output, '改完了：lib/index.js');
  assert.ok(mounted.warned.some((line) => /dropping a \d+-character output line/.test(line)));
});

test('并发 run：不同 fixture 的结果与子会话互不串', async () => {
  const fixtureA = await writeFixture({
    records: successRecords({ text: 'run-A', threadId: 'thread-a' }),
    delayMs: 50,
  });
  const fixtureB = await writeFixture({
    records: successRecords({ text: 'run-B', threadId: 'thread-b' }),
    delayMs: 50,
  });
  const parent = fakeParent();
  const mounted = mount();

  const [valueA, valueB] = await Promise.all([
    runTool(mounted, parent, { prompt: briefWith('A', fixtureA, recordPath()) }),
    runTool(mounted, parent, { prompt: briefWith('B', fixtureB, recordPath()) }),
  ]);

  assert.equal(valueA.output, 'run-A');
  assert.equal(valueB.output, 'run-B');
  assert.notEqual(valueA.childSessionId, valueB.childSessionId);
  const sessions = mounted.sessions.prepared.map((entry) => entry.session);
  assert.equal(sessions.length, 2);
  const texts = sessions.map((session) => {
    const assistants = session.events.filter((event) => event.type === 'assistant/message');
    return assistants[assistants.length - 1].data.message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('');
  });
  assert.deepEqual(texts.sort(), ['run-A', 'run-B']);
  assert.equal(parent.events.filter((event) => event.type === 'subagent/catalog').length, 2, 'each run appends its own catalog row');
});

test('默认值：command 指向 $HOME/.dsh/bin/codex-dev，logDir 与 sessionDir 在 $HOME/.dsh 下', async () => {
  // The default command does not exist under the redirected HOME, so the run
  // fails by name and the real wrapper is never executed.
  const registered = [];
  const ctx = {
    logger: { warn: () => {} },
    tools: { register(definition) { registered.push(definition); } },
    sessions: new FakeSessions({}),
    sessionPersistence: new FakePersistence({}),
  };
  apply(ctx, {});
  assert.equal(registered.length, 1);
  const value = await registered[0].execute({ prompt: '任务' }, {
    agent: fakeAgent(fakeParent()),
    signal: new AbortController().signal,
  });
  assert.equal(value.stopReason, 'error');
  assert.match(value.diagnostic, new RegExp(DEFAULT_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
});

test('配置：model/thinking/sandbox/bypass/args 都进 argv，projection=false 时不动会话服务', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const recorded = recordPath();
  const mounted = mount({
    noSessions: true,
    noPersistence: true,
    config: {
      projection: false,
      model: 'deepseek-flash',
      thinking: 'high',
      sandbox: 'read-only',
      dangerouslyBypass: true,
      args: ['--extra', '1'],
    },
  });

  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('任务', fixturePath, recorded),
  });
  const record = JSON.parse(await readFile(recorded, 'utf8'));

  assert.deepEqual(record.argv.slice(record.argv.indexOf('--sandbox')), [
    '--sandbox', 'read-only',
    '--model', 'deepseek-flash',
    '--thinking', 'high',
    '--bypass',
    '--extra', '1',
  ]);
  assert.equal(value.output, '改完了：lib/index.js');
  assert.equal(value.childSessionId, '');
  const rendered = mounted.definition.output.render({ prompt: '任务' }, value);
  assert.match(rendered[0].text, /subagent session: \(not projected\)/);
});

test('默认日志目录：logDir 未配置时写在 $HOME/.dsh/codex-logs', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const mounted = mount({ config: { logDir: undefined } });
  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('默认日志', fixturePath, recordPath()),
  });
  assert.equal(dirname(value.logPath), join(homeRoot, '.dsh', 'codex-logs'));
});

test('配置校验：数值项必须正有限、command 非空、布尔项、sandbox 与 logMode 白名单', () => {
  const logDir = join(root, 'logs');
  assert.throws(() => mount({ config: { logDir, graceMs: 0 } }), /graceMs must be a positive finite number/);
  assert.throws(
    () => mount({ config: { logDir, maxOutputBytes: Number.POSITIVE_INFINITY } }),
    /maxOutputBytes must be a positive finite number/,
  );
  assert.throws(() => mount({ config: { logDir, command: '' } }), /command must be a non-empty string/);
  assert.throws(() => mount({ config: { logDir, projection: 'yes' } }), /projection must be a boolean/);
  assert.throws(() => mount({ config: { logDir, args: [1] } }), /args\[0\] must be a string/);
  assert.throws(() => mount({ config: { logDir, logMode: 'verbose' } }), /logMode must be "summary" or "full"/);
  assert.throws(() => mount({ config: { logDir, sessionDir: '' } }), /sessionDir must be a non-empty string/);
  assert.throws(
    () => mount({ config: { logDir, sandbox: 'open' } }),
    /sandbox must be one of read-only, workspace-write, danger-full-access/,
  );
  assert.throws(
    () => mount({ config: { logDir, dangerouslyBypass: 'yes' } }),
    /dangerouslyBypass must be a boolean/,
  );
  assert.throws(() => mount({ config: { logDir, model: 1 } }), /model must be a string/);
  assert.throws(() => mount({ config: { logDir, labelPrefix: 1 } }), /labelPrefix must be a string/);
  assert.throws(
    () => mount({ config: { logDir, labelPrefix: 'codex\n· ' } }),
    /labelPrefix must not contain control characters/,
  );
  assert.throws(
    () => mount({ config: { logDir, labelPrefix: 'codex\u0007· ' } }),
    /labelPrefix must not contain control characters/,
  );
});

test('labelPrefix 默认：descriptor 与父 catalog 的 label 都带 "codex · " 前缀', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  await runTool(mounted, parent, { prompt: briefWith('修一个 bug', fixturePath, recorded) });

  const descriptor = mounted.sessions.prepared[0].session.events
    .find((event) => event.type === 'subagent/descriptor');
  assert.equal(descriptor.data.label, 'codex · 修一个 bug');
  const catalog = parent.events.find((event) => event.type === 'subagent/catalog');
  assert.equal(catalog.data.label, 'codex · 修一个 bug');
});

test('labelPrefix 自定义：用配置的前缀替换默认值', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount({ config: { labelPrefix: '[Codex] ' } });

  await runTool(mounted, parent, { prompt: briefWith('自定义前缀', fixturePath, recorded) });

  const catalog = parent.events.find((event) => event.type === 'subagent/catalog');
  assert.equal(catalog.data.label, '[Codex] 自定义前缀');
});

test('labelPrefix 空字符串：label 保持解析结果，不加前缀', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount({ config: { labelPrefix: '' } });

  await runTool(mounted, parent, { prompt: briefWith('无前缀', fixturePath, recorded) });

  const catalog = parent.events.find((event) => event.type === 'subagent/catalog');
  assert.equal(catalog.data.label, '无前缀');
});

test('labelPrefix 作用于显式 label：显式 label 也加前缀', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  await runTool(mounted, parent, {
    prompt: briefWith('任务首行', fixturePath, recorded),
    label: '显式标签',
  });

  const catalog = parent.events.find((event) => event.type === 'subagent/catalog');
  assert.equal(catalog.data.label, 'codex · 显式标签');
});

test('labelPrefix 计入 60 字上限：prompt 首行加前缀后不超 60 字', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const recorded = recordPath();
  const parent = fakeParent();
  const mounted = mount();

  await runTool(mounted, parent, { prompt: briefWith('首'.repeat(100), fixturePath, recorded) });

  const catalog = parent.events.find((event) => event.type === 'subagent/catalog');
  assert.equal(catalog.data.label.length, 60);
  assert.equal(catalog.data.label, `codex · ${'首'.repeat(52)}`);
});

test('labelPrefix 续接：entry 已存在时沿用原 label，不重复加前缀', async () => {
  const firstFixture = await writeFixture({ records: successRecords({ text: '第一轮', threadId: 'thread-prefix' }) });
  const secondFixture = await writeFixture({ records: successRecords({ text: '第二轮', threadId: 'thread-prefix' }) });
  const mounted = mount();
  const parent = fakeParent();

  const first = await runTool(mounted, parent, {
    prompt: briefWith('第一次派活', firstFixture, recordPath()),
  });
  await runTool(mounted, parent, {
    prompt: briefWith('第二次派活', secondFixture, recordPath()),
    session: first.session,
  });

  const descriptor = mounted.sessions.prepared[0].session.events
    .find((event) => event.type === 'subagent/descriptor');
  assert.equal(descriptor.data.label, 'codex · 第一次派活');
  const catalogRows = parent.events.filter((event) => event.type === 'subagent/catalog');
  assert.equal(catalogRows.length, 1, 'a continuation adds no catalog row');
  assert.equal(catalogRows[0].data.label, 'codex · 第一次派活');
});

test('临时目录清理：brief 目录在 run 结束后不存在', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const recorded = recordPath();
  const mounted = mount();

  await runTool(mounted, fakeParent(), { prompt: briefWith('清理', fixturePath, recorded) });
  const record = JSON.parse(await readFile(recorded, 'utf8'));
  const briefPath = record.argv[record.argv.indexOf('--brief') + 1];
  assert.equal(existsSync(dirname(briefPath)), false, 'brief 写在独立临时目录里，run 结束后删除');
});

test('日志 summary：不传 --log，精简日志含首行、回答、工具行、usage、thread 与 stopReason', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const recorded = recordPath();
  const mounted = mount();

  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('修一个 bug', fixturePath, recorded),
  });
  const record = JSON.parse(await readFile(recorded, 'utf8'));

  assert.equal(record.argv.includes('--log'), false, 'summary mode must not tee the JSON event stream');
  const lines = (await readFile(value.logPath, 'utf8')).trimEnd().split('\n');
  assert.equal(lines[0], '修一个 bug');
  assert.equal(lines[1], '改完了：lib/index.js');
  assert.ok(lines.some((line) => /^tool command \d+ms ok$/.test(line)), `missing tool line in ${JSON.stringify(lines)}`);
  assert.match(
    lines.find((line) => line.startsWith('usage ')) ?? '',
    /^usage input=30 output=7 cacheRead=10 cacheWrite=2 reasoning=3 stopReason=completed session=[0-9a-f-]{36} thread=thread-1$/,
  );
  assert.deepEqual(mounted.warned, []);
});

test('日志 full：argv 带 --log，logPath 就是交给封装的那个文件', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const recorded = recordPath();
  const mounted = mount({ config: { logMode: 'full' } });

  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('全量日志', fixturePath, recorded),
  });
  const record = JSON.parse(await readFile(recorded, 'utf8'));

  const index = record.argv.indexOf('--log');
  assert.ok(index > -1);
  assert.equal(record.argv[index + 1], value.logPath);
  assert.equal(dirname(value.logPath), join(root, 'logs'));
});

test('复用：传 session → 同一个子会话追加 turn 2，不重复 descriptor/catalog，thread id 通过 --session-id 续接', async () => {
  const firstFixture = await writeFixture({ records: successRecords({ text: '第一轮', threadId: 'thread-resume' }) });
  const secondFixture = await writeFixture({ records: successRecords({ text: '第二轮', threadId: 'thread-resume' }) });
  const firstRecord = recordPath();
  const secondRecord = recordPath();
  const mounted = mount();
  const parent = fakeParent(undefined, mounted.log);

  const first = await runTool(mounted, parent, {
    prompt: briefWith('第一轮', firstFixture, firstRecord),
  });
  assert.equal(typeof first.session, 'string');
  assert.notEqual(first.session, '');
  const second = await runTool(mounted, parent, {
    prompt: briefWith('第二轮', secondFixture, secondRecord),
    session: first.session,
  });

  assert.equal(second.childSessionId, first.childSessionId);
  assert.equal(second.session, first.session);
  assert.equal(mounted.sessions.prepared.length, 1, 'a continuation must not prepare another child session');
  assert.equal(mounted.persistence.created.length, 1, 'a continuation must not create another log');

  const session = mounted.sessions.prepared[0].session;
  const types = session.events.map((event) => event.type);
  assert.equal(types.filter((type) => type === 'subagent/descriptor').length, 1);
  assert.equal(types.filter((type) => type === 'user/message').length, 2, 'each turn carries its own task text');
  assert.deepEqual(
    session.events.filter((event) => event.type === 'turn/start').map((event) => event.data),
    [{ turn: 1 }, { turn: 2 }],
  );
  assert.deepEqual(
    session.events.filter((event) => event.type === 'turn/end').map((event) => event.data),
    [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'completed' } }],
  );
  assert.deepEqual(
    session.events.filter((event) => event.type === 'step/start').map((event) => event.data),
    [
      { turn: 1, step: 1 },
      { turn: 2, step: 1 },
    ],
  );
  assert.equal(
    parent.events.filter((event) => event.type === 'subagent/catalog').length,
    1,
    'the catalog row belongs to the delegation, not to each turn',
  );

  const firstArgv = JSON.parse(await readFile(firstRecord, 'utf8')).argv;
  const secondArgv = JSON.parse(await readFile(secondRecord, 'utf8')).argv;
  assert.equal(firstArgv.includes('--session-id'), false, 'the first run starts a fresh Codex thread');
  assert.equal(secondArgv[secondArgv.indexOf('--session-id') + 1], 'thread-resume');
  assert.equal(secondArgv[secondArgv.indexOf('--session-dir') + 1], join(homeRoot, '.dsh', 'codex-sessions'));

  // Both runs flushed child and parent, and neither released the child.
  assert.equal(mounted.sessions.flushes.length, 4);
  assert.deepEqual(mounted.persistence.closed, []);
  assert.equal(mounted.sessions.detached.length, 0);

  const secondLog = await readFile(second.logPath, 'utf8');
  assert.match(secondLog, /^第二轮/);
  assert.match(secondLog, new RegExp(`session=${second.childSessionId}`));
  assert.match(secondLog, /thread=thread-resume/);
});

test('复用未知 session：抛清楚错误，不建新会话也不起进程', async () => {
  const recorded = recordPath();
  const mounted = mount();

  await assert.rejects(
    () => runTool(mounted, fakeParent(), {
      prompt: briefWith('未知', join(root, 'no-fixture.json'), recorded),
      session: 'session-not-here',
    }),
    /session session-not-here is not continuable in this host process; omit session to start a new one/,
  );
  assert.deepEqual(mounted.sessions.prepared, []);
  assert.equal(existsSync(recorded), false);
});

test('复用无 thread id 的 session：说明不能续接，不静默当新任务跑', async () => {
  const fixturePath = await writeFixture({
    records: [
      { type: 'turn.started' },
      agentMessage('没有 thread id 的运行'),
      turnCompleted(),
    ],
  });
  const mounted = mount();
  const first = await runTool(mounted, fakeParent(), {
    prompt: briefWith('没有 thread id', fixturePath, recordPath()),
  });
  assert.equal(first.stopReason, 'completed');

  await assert.rejects(
    () => runTool(mounted, fakeParent(), {
      prompt: briefWith('接着干', fixturePath, recordPath()),
      session: first.session,
    }),
    /never reported a Codex thread id/,
  );
});

test('复用并发：同一 session 正在跑时再次调用直接报错', async () => {
  const fixturePath = await writeFixture({ records: successRecords(), delayMs: 30_000 });
  const recorded = recordPath();
  const mounted = mount();
  const controller = new AbortController();

  const running = runTool(mounted, fakeParent(), {
    prompt: briefWith('长任务', fixturePath, recorded),
  }, { signal: controller.signal });
  await waitForFile(recorded);
  await waitFor(() => mounted.sessions.prepared.length === 1);
  const id = mounted.sessions.prepared[0].session.id;

  await assert.rejects(
    () => runTool(mounted, fakeParent(), { prompt: '接着干', session: id }),
    new RegExp(`session ${id} is already running`),
  );
  controller.abort();
  const value = await running;
  assert.equal(value.stopReason, 'aborted');
});

test('卸载：ctx.effect 释放保留的 handle，之后该 session 不再可续', async () => {
  const fixturePath = await writeFixture({ records: successRecords() });
  const mounted = mount();

  const value = await runTool(mounted, fakeParent(), {
    prompt: briefWith('卸载', fixturePath, recordPath()),
  });
  const session = mounted.sessions.prepared[0].session;
  assert.equal(mounted.disposers.length, 1, 'apply must register one unload effect');
  assert.equal(mounted.sessions.detached.length, 0);

  await mounted.disposers[0]();

  assert.deepEqual(mounted.sessions.detached.map((entry) => entry.id), [session.id]);
  assert.deepEqual(mounted.persistence.closed, [session.id]);
  assert.ok(mounted.log.indexOf(`sessions:flush:${session.id}`) < mounted.log.indexOf('sessions:detach'));
  assert.ok(mounted.log.indexOf('sessions:detach') < mounted.log.indexOf('persistence:close'));

  await assert.rejects(
    () => runTool(mounted, fakeParent(), { prompt: '再来', session: value.session }),
    /is not continuable in this host process/,
  );
});
