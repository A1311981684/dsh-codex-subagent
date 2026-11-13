/**
 * Unit tests for `scripts/cleanup.mjs`.
 *
 * Each case builds its own `$HOME` under a scratch root and runs the script in
 * a child process with `HOME` overridden, so the real `~/.dsh` is never touched.
 * Old files are simulated with `utimes` instead of waiting. Codex threads are
 * fixture rollout files under the same layout the wrapper produces
 * (`<sessionDir>/home/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread>.jsonl`).
 */
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const SCRIPT = fileURLToPath(new URL('../scripts/cleanup.mjs', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;

/** Scratch root shared by the tests; each test makes its own HOME below it. */
let root = '';

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-subagent-cleanup-'));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/** A fresh fake HOME. */
async function makeHome(name) {
  return mkdtemp(join(root, `${name}-`));
}

/** Write one Codex log with a chosen age (in days). */
async function makeLog(home, name, ageDays, size = 128) {
  const dir = join(home, '.dsh', 'codex-logs');
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, 'x'.repeat(size), 'utf8');
  const when = new Date(Date.now() - ageDays * DAY_MS);
  await utimes(path, when, when);
  return path;
}

/**
 * Write one Codex rollout file with a chosen age (in days).
 * @param sessionsRoot - the `<sessionDir>` whose `home/sessions` holds it.
 */
async function makeThread(sessionsRoot, name, ageDays, size = 256) {
  const dir = join(sessionsRoot, 'home', 'sessions', '2026', '01', '02');
  await mkdir(dir, { recursive: true });
  const path = join(dir, name);
  await writeFile(path, '{"type":"session_meta"}\n'.repeat(Math.ceil(size / 25)), 'utf8');
  const when = new Date(Date.now() - ageDays * DAY_MS);
  await utimes(path, when, when);
  return path;
}

/** Run the script with `HOME` pointed at the fake home. */
function run(args, home, env = {}) {
  return spawnSync(process.execPath, [SCRIPT, ...args], {
    env: { ...process.env, HOME: home, ...env },
    encoding: 'utf8',
  });
}

test('cleanup --dry-run：只列不删，按 --days 筛选', async () => {
  const home = await makeHome('dry');
  const oldPath = await makeLog(home, 'old.log', 30, 4096);
  const freshPath = await makeLog(home, 'fresh.log', 0, 16);

  const result = run(['--days', '14', '--dry-run'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /old\.log/);
  assert.match(result.stdout, /would delete 1 file/);
  assert.match(result.stdout, /dry run/i);
  assert.doesNotMatch(result.stdout, /fresh\.log/);
  assert.equal(existsSync(oldPath), true, '--dry-run must not delete');
  assert.equal(existsSync(freshPath), true);
});

test('cleanup：删除过期日志、保留新日志并报出数量', async () => {
  const home = await makeHome('delete');
  const oldPath = await makeLog(home, 'old.log', 30, 2048);
  const newPath = await makeLog(home, 'new.log', 0, 16);

  const result = run(['--days', '14'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /deleted 1 file/);
  assert.match(result.stdout, /freed/);
  assert.equal(existsSync(oldPath), false);
  assert.equal(existsSync(newPath), true);
});

test('cleanup --days：0 天把所有文件都算作候选', async () => {
  const home = await makeHome('days');
  await makeLog(home, 'a.log', 30);
  await makeLog(home, 'b.log', 5);

  const older = run(['--days', '10', '--dry-run'], home);
  assert.match(older.stdout, /would delete 1 file/);
  assert.match(older.stdout, /a\.log/);

  const everything = run(['--days', '0', '--dry-run'], home);
  assert.match(everything.stdout, /would delete 2 file/);
});

test('cleanup --sessions：列出默认 $HOME/.dsh/codex-sessions 下的旧 thread，只列不删', async () => {
  const home = await makeHome('sessions');
  const rollout = await makeThread(
    join(home, '.dsh', 'codex-sessions'),
    'rollout-2026-01-02T03-04-05-01a1d3d0-bf7f-7aa0-b66a-727aae1176a2.jsonl',
    30,
  );

  const result = run(['--days', '14', '--sessions'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /rollout-2026-01-02/);
  assert.match(result.stdout, /candidate\(s\) older than 14 day\(s\) \(not deleted\)/);
  assert.match(result.stdout, /breaks the continuation/);
  assert.equal(existsSync(rollout), true, '--sessions must never delete');
  assert.equal(existsSync(join(home, '.dsh', 'codex-sessions', 'home', 'sessions')), true);
});

test('cleanup --sessions：CODEX_DEV_SESSION_DIR 覆盖默认目录', async () => {
  const home = await makeHome('sessions-env');
  const custom = join(root, 'custom-codex-sessions');
  const rollout = await makeThread(custom, 'rollout-2026-01-02T03-04-05-thread-custom.jsonl', 30);

  const result = run(['--days', '14', '--sessions'], home, { CODEX_DEV_SESSION_DIR: custom });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /thread-custom/);
  assert.equal(existsSync(rollout), true);
});

test('cleanup --sessions：新 thread 不算候选', async () => {
  const home = await makeHome('sessions-fresh');
  const rollout = await makeThread(
    join(home, '.dsh', 'codex-sessions'),
    'rollout-2026-01-02T03-04-05-thread-new.jsonl',
    0,
  );

  const result = run(['--days', '14', '--sessions'], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /nothing older than 14 day\(s\)/);
  assert.doesNotMatch(result.stdout, /thread-new/);
  assert.equal(existsSync(rollout), true);
});

test('cleanup：缺少目录时正常退出，参数错误时报错', async () => {
  const home = await makeHome('missing');
  const result = run([], home);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /not found/);

  const sessions = run(['--sessions'], home);
  assert.equal(sessions.status, 0, sessions.stderr);
  assert.match(sessions.stdout, /codex threads: .* not found; nothing to list/);

  const bad = run(['--days', 'soon'], home);
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /--days needs a non-negative integer/);

  const unknown = run(['--nope'], home);
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /unknown argument/);
});
