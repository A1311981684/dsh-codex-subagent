/**
 * Opt-in end-to-end check: two real `codex-dev` runs against the local Codex
 * CLI and its DeepSeek provider.
 *
 * Run it directly — `node test/real-codex.mjs`. It is NOT part of
 * `node --test`: the guard below exits as a no-op when the Node test runner is
 * the parent (`NODE_TEST_CONTEXT` is set for every test child), so a bare
 * `node --test` never spends a model call.
 *
 * The first run works in a throwaway directory, executes
 * `echo REAL-OK > real.txt && cat real.txt`, and reports the command output.
 * The `thread.started` record of its NDJSON stream names the Codex thread. The
 * second run passes that thread back as `--session-id`, so it must continue the
 * same thread (same id, same stored memory) in a new process.
 *
 * Only the wrapper's own state inside the scratch directory is written: its
 * private `CODEX_HOME` under `--session-dir`, the log, and the brief. The
 * delegation record goes to the scratch `CODEX_DEV_RECORD_DIR` as well, so
 * nothing in `$HOME` is touched.
 */

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const WRAPPER = fileURLToPath(new URL('../bin/codex-dev', import.meta.url));

/** How long one real run may take before it is cancelled. */
const RUN_TIMEOUT_MS = 10 * 60_000;

/** The first task: run a command, report its output. */
const FIRST_BRIEF = [
  '这是一次端到端自测，工作目录是一个临时目录。',
  '请执行这条命令：echo REAL-OK > real.txt && cat real.txt',
  '然后用一句话回复命令的输出。',
].join('\n');

/** The continuation task: prove Codex still remembers the thread. */
const SECOND_BRIEF = [
  '继续刚才那次自测。',
  '请先确认上一轮创建的文件 real.txt 还在，然后只回复一行文字：RESUMED-OK',
].join('\n');

/**
 * Run the wrapper once, capturing stdout, stderr, and the exit code.
 * @param args - wrapper arguments.
 * @param env - environment overrides.
 * @returns `{status, stdout, stderr, elapsedMs}`.
 */
function runWrapper(args, env) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(WRAPPER, args, { env, stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    }, RUN_TIMEOUT_MS);
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.once('error', (error) => {
      clearTimeout(timer);
      resolve({
        status: null,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: `${Buffer.concat(stderr).toString('utf8')}\n${error.message}`,
        elapsedMs: Date.now() - startedAt,
      });
    });
    child.once('close', (status, termSignal) => {
      clearTimeout(timer);
      resolve({
        status: timedOut ? null : status,
        termSignal,
        stdout: Buffer.concat(stdout).toString('utf8'),
        stderr: Buffer.concat(stderr).toString('utf8'),
        elapsedMs: Date.now() - startedAt,
      });
    });
  });
}

/**
 * Parse the NDJSON event stream for the facts this check needs.
 * @param stdout - the wrapper's stdout.
 * @returns `{threadIds, answers, events}`.
 */
function parseEvents(stdout) {
  const threadIds = [];
  const answers = [];
  let events = 0;
  for (const line of stdout.split('\n')) {
    if (line.trim() === '') continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (typeof record.type !== 'string') continue;
    events += 1;
    if (record.type === 'thread.started' && typeof record.thread_id === 'string') {
      threadIds.push(record.thread_id);
    }
    if (record.type === 'item.completed' && record.item?.type === 'agent_message'
      && typeof record.item.text === 'string') {
      answers.push(record.item.text);
    }
  }
  return { threadIds, answers, events };
}

/** Print one failure line and remember it. */
const failures = [];
function check(condition, message) {
  if (condition) {
    console.log(`PASS ${message}`);
    return;
  }
  console.log(`FAIL ${message}`);
  failures.push(message);
}

async function main() {
  if (process.env.NODE_TEST_CONTEXT !== undefined) {
    console.log('real-codex: 当前在 node --test 下运行，跳过（直接跑 node test/real-codex.mjs）');
    return;
  }

  const root = await mkdtemp(join(tmpdir(), 'dsh-codex-subagent-real-'));
  const sessionDir = join(root, 'sessions');
  const logDir = join(root, 'logs');
  const env = {
    ...process.env,
    // Keep the wrapper's own bookkeeping inside the scratch directory; the
    // credential and the provider config still come from HOME (read-only).
    CODEX_DEV_SESSION_DIR: sessionDir,
    CODEX_DEV_RECORD_DIR: root,
  };

  try {
    const firstBrief = join(root, 'first.md');
    const secondBrief = join(root, 'second.md');
    await writeFile(firstBrief, FIRST_BRIEF, 'utf8');
    await writeFile(secondBrief, SECOND_BRIEF, 'utf8');

    console.log(`工作目录: ${root}`);
    const first = await runWrapper([
      '--brief', firstBrief,
      '--cwd', root,
      '--mode', 'json',
      '--log', join(logDir, 'first.log'),
    ], env);
    const firstEvents = parseEvents(first.stdout);
    console.log(`第一次退出码: ${first.status}, 耗时: ${Math.round(first.elapsedMs / 1000)}s, 事件数: ${firstEvents.events}`);
    console.log(`第一次 thread id: ${firstEvents.threadIds[0] ?? '(none)'}`);
    if (first.status !== 0) console.error(first.stderr.slice(-2000));

    check(first.status === 0, '第一次运行退出码为 0');
    check(firstEvents.threadIds.length === 1, '第一次运行的 NDJSON 里有一个 thread.started');
    const threadId = firstEvents.threadIds[0] ?? '';
    check(threadId !== '', '拿到了 Codex thread id');

    let fileText = '';
    try {
      fileText = await readFile(join(root, 'real.txt'), 'utf8');
    } catch {
      fileText = '';
    }
    console.log(`real.txt: ${JSON.stringify(fileText)}`);
    check(fileText.includes('REAL-OK'), 'real.txt 里有 REAL-OK');
    check(firstEvents.answers.some((answer) => answer.includes('REAL-OK')), '第一次回答里提到 REAL-OK');

    const second = await runWrapper([
      '--brief', secondBrief,
      '--cwd', root,
      '--mode', 'json',
      '--session-id', threadId,
      '--session-dir', sessionDir,
      '--log', join(logDir, 'second.log'),
    ], env);
    const secondEvents = parseEvents(second.stdout);
    console.log(`第二次退出码: ${second.status}, 耗时: ${Math.round(second.elapsedMs / 1000)}s, 事件数: ${secondEvents.events}`);
    console.log(`第二次 thread id: ${secondEvents.threadIds[0] ?? '(none)'}`);
    if (second.status !== 0) console.error(second.stderr.slice(-2000));

    check(second.status === 0, '续接运行退出码为 0');
    check(secondEvents.threadIds.length === 1, '续接运行的 NDJSON 里有一个 thread.started');
    check(secondEvents.threadIds[0] === threadId, '两次运行的 thread id 相同');
    check(secondEvents.answers.some((answer) => answer.includes('RESUMED-OK')), '续接回答了 RESUMED-OK');

    console.log(`thread id: ${threadId}`);
    console.log(`real.txt: ${fileText.trim()}`);
    console.log(`退出码: first=${first.status} second=${second.status}`);
    console.log(`日志目录: ${logDir}`);

    if (failures.length > 0) {
      console.error(`real-codex: ${failures.length} 项未通过`);
      process.exitCode = 1;
      return;
    }
    console.log('real-codex: OK');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

await main();
