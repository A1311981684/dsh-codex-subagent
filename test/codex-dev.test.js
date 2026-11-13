/**
 * Unit tests for the bundled `bin/codex-dev` wrapper.
 *
 * The wrapper is executed with `bash`, and `CODEX_BIN` points at a tiny fake
 * that records the argv Codex would have seen (NUL-separated, so a multi-line
 * prompt stays one argument), the `CODEX_HOME` it was given, and whether a
 * DeepSeek key reached its environment. `HOME` is a scratch directory, so the
 * delegation record, the credential file the wrapper may read, and the
 * ephemeral state directories all stay inside the test.
 */
import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const WRAPPER = fileURLToPath(new URL('../bin/codex-dev', import.meta.url));

let root = '';
let fakeCodex = '';
let brief = '';
let sessionsDir = '';
let srcWithLogin = '';
let srcWithoutLogin = '';
let sequence = 0;

/**
 * The fake Codex: records its argv and state directory, prints one banner line
 * on stderr, and prints a minimal NDJSON success stream on stdout.
 */
const FAKE_CODEX = `#!/bin/sh
printf '%s\\0' "$@" > "$CODEX_ARGS_FILE"
{
  printf 'home=%s\\n' "\${CODEX_HOME:-}"
  printf 'has_key=%s\\n' "\${DEEPSEEK_API_KEY:+yes}"
  printf 'key_chars=%s\\n' "\${#DEEPSEEK_API_KEY}"
} > "$CODEX_INFO_FILE"
printf 'banner: session id: thread-from-banner\\ntokens used: 1\\n' >&2
printf '{"type":"thread.started","thread_id":"thread-abc"}\\n'
printf '{"type":"turn.completed","usage":{"input_tokens":3,"output_tokens":1}}\\n'
exit "\${FAKE_CODEX_EXIT:-0}"
`;

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-codex-subagent-wrapper-'));
  fakeCodex = join(root, 'fake-codex');
  await writeFile(fakeCodex, FAKE_CODEX, 'utf8');
  await chmod(fakeCodex, 0o755);
  brief = join(root, 'brief.md');
  await writeFile(brief, '写一行文字\n', 'utf8');
  sessionsDir = join(root, 'codex-sessions');
  // A provider config to copy, so the test can assert the copy happened.
  srcWithLogin = join(root, 'home-src');
  await mkdir(srcWithLogin, { recursive: true });
  await writeFile(join(srcWithLogin, 'config.toml'), 'model = "deepseek-flash"\n', 'utf8');
  await writeFile(join(srcWithLogin, 'auth.json'), '{"deepseek":{"key":"copied-secret"}}\n', 'utf8');
  // The same provider config without a Codex login, for the credential cases.
  srcWithoutLogin = join(root, 'home-src-nologin');
  await mkdir(srcWithoutLogin, { recursive: true });
  await writeFile(join(srcWithoutLogin, 'config.toml'), 'model = "deepseek-flash"\n', 'utf8');
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * Run the wrapper with the given extra arguments and environment overrides.
 * @param extra - wrapper arguments after the mandatory ones.
 * @param env - environment overrides; `DEEPSEEK_API_KEY` defaults to a dummy.
 * @returns `{status, stdout, stderr, argv, info, home, argsFile}`.
 */
async function runWrapper(extra = [], env = {}) {
  sequence += 1;
  const argsFile = join(root, `codex-args-${sequence}.nil`);
  const infoFile = join(root, `codex-info-${sequence}.txt`);
  const home = await mkdtemp(join(root, 'home-'));
  const result = spawnSync('bash', [WRAPPER, '--brief', brief, '--cwd', root, ...extra], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME_SRC: join(root, 'home-src'),
      CODEX_BIN: fakeCodex,
      CODEX_ARGS_FILE: argsFile,
      CODEX_INFO_FILE: infoFile,
      CODEX_DEV_RECORD_DIR: join(root, 'records'),
      DEEPSEEK_API_KEY: 'test-key-not-real',
      ...env,
    },
  });
  const argv = existsSync(argsFile)
    ? (await readFile(argsFile, 'utf8')).split('\0').slice(0, -1)
    : [];
  const info = existsSync(infoFile)
    ? Object.fromEntries(
      (await readFile(infoFile, 'utf8')).trimEnd().split('\n').map((line) => {
        const index = line.indexOf('=');
        return [line.slice(0, index), line.slice(index + 1)];
      }),
    )
    : {};
  return { ...result, argv, info, home, argsFile };
}

/** The value following `flag` in an argv, or undefined. */
function valueOf(argv, flag) {
  const index = argv.indexOf(flag);
  return index === -1 ? undefined : argv[index + 1];
}

test('新会话：argv 是 exec --json --skip-git-repo-check --cd <cwd> -s workspace-write -- <prompt>', async () => {
  const { status, stderr, argv } = await runWrapper(['--mode', 'json']);
  assert.equal(status, 0, stderr);

  assert.equal(argv[0], 'exec');
  assert.deepEqual(argv.slice(0, 7), [
    'exec',
    '--json',
    '--skip-git-repo-check',
    '--cd',
    root,
    '-s',
    'workspace-write',
  ]);
  assert.equal(argv[7], '--');
  assert.match(argv[8], /^# 固定规矩/);
  assert.match(argv[8], /\n\n---\n\n# 本次任务\n\n写一行文字$/);
  assert.equal(argv.includes('--session-id'), false, 'a fresh run must not claim a thread');
  assert.equal(argv.includes('--session-dir'), false, 'no state directory was given');
  assert.equal(argv.includes('resume'), false);
  assert.equal(argv.includes('-m'), false, 'no model is pinned by default');
  assert.equal(argv.includes('--bypass'), false);
});

test('续接：argv 是 exec resume <id> --json --skip-git-repo-check -- <prompt>，没有 -s / --cd', async () => {
  const { status, stderr, argv } = await runWrapper([
    '--mode', 'json',
    '--session-id', 'thread-abc',
    '--session-dir', sessionsDir,
  ]);
  assert.equal(status, 0, stderr);

  assert.deepEqual(argv.slice(0, 5), [
    'exec',
    'resume',
    'thread-abc',
    '--json',
    '--skip-git-repo-check',
  ]);
  const separator = argv.indexOf('--');
  assert.ok(separator > 5);
  assert.match(argv[separator + 1], /# 本次任务/);
  assert.equal(argv.includes('-s'), false, 'codex exec resume has no -s');
  assert.equal(argv.includes('--cd'), false, 'codex exec resume has no --cd');
  // Measured against codex-cli 0.168.0: the config override does change the
  // sandbox of a continuation, so resume gets it as `-c sandbox_mode=...`.
  const configIndex = argv.indexOf('-c');
  assert.ok(configIndex > -1);
  assert.equal(argv[configIndex + 1], 'sandbox_mode=workspace-write');
});

test('模型与思考等级：--model 传 -m，--thinking 传 -c model_reasoning_effort=，--bypass 追加绕过参数', async () => {
  const { status, stderr, argv } = await runWrapper([
    '--model', 'deepseek-flash',
    '--thinking', 'high',
    '--sandbox', 'read-only',
    '--bypass',
  ]);
  assert.equal(status, 0, stderr);

  const modelIndex = argv.indexOf('-m');
  assert.ok(modelIndex > -1);
  assert.equal(argv[modelIndex + 1], 'deepseek-flash');
  const configIndex = argv.indexOf('-c');
  assert.ok(configIndex > -1);
  assert.equal(argv[configIndex + 1], 'model_reasoning_effort=high');
  assert.ok(argv.includes('--dangerously-bypass-approvals-and-sandbox'));
  assert.equal(valueOf(argv, '-s'), 'read-only');
});

test('--mode text：不传 --json，stdout 只有 Codex 的输出', async () => {
  const { status, stderr, argv } = await runWrapper(['--mode', 'text']);
  assert.equal(status, 0, stderr);
  assert.equal(argv.includes('--json'), false);
});

test('CODEX_HOME：在 --session-dir/home，config.toml 与 auth.json 被复制且 auth.json 权限 600', async () => {
  const { status, stderr, info } = await runWrapper(['--session-dir', sessionsDir]);
  assert.equal(status, 0, stderr);
  assert.equal(info.home, join(sessionsDir, 'home'));
  assert.match(await readFile(join(sessionsDir, 'home', 'config.toml'), 'utf8'), /deepseek-flash/);
  const auth = await stat(join(sessionsDir, 'home', 'auth.json'));
  assert.equal(auth.mode & 0o777, 0o600);
});

test('默认会话目录：只给 --session-id 时用 $HOME/.dsh/codex-sessions', async () => {
  const { status, stderr, info, home } = await runWrapper(['--session-id', 'thread-abc']);
  assert.equal(status, 0, stderr);
  assert.equal(info.home, join(home, '.dsh', 'codex-sessions', 'home'));
});

test('临时 CODEX_HOME：既没有 --session-dir 也没有 CODEX_DEV_SESSION_DIR 时运行结束即删除', async () => {
  const { status, stderr, info } = await runWrapper([], { CODEX_DEV_SESSION_DIR: '' });
  assert.equal(status, 0, stderr);
  assert.match(info.home, /codex-dev-state\./);
  assert.equal(existsSync(info.home), false, 'the throwaway state directory must be removed');
});

test('CODEX_DEV_SESSION_DIR：没有显式目录时也持久化，并可用作续接', async () => {
  const dir = join(root, 'env-sessions');
  const { status, stderr, info } = await runWrapper([], { CODEX_DEV_SESSION_DIR: dir });
  assert.equal(status, 0, stderr);
  assert.equal(info.home, join(dir, 'home'));
  assert.equal(existsSync(join(dir, 'home')), true);
});

test('凭据：已设置 DEEPSEEK_API_KEY 时原样保留，不读 auth.json', async () => {
  const { status, stderr, info } = await runWrapper([], { DEEPSEEK_API_KEY: 'test-key-not-real' });
  assert.equal(status, 0, stderr);
  assert.equal(info.has_key, 'yes');
  assert.equal(stderr.includes('test-key-not-real'), false);
});

test('凭据：未设置且无 CODEX_HOME/auth.json 时从 $HOME/.pi/agent/auth.json 的 .deepseek.key 读，不打印', async () => {
  const home = await mkdtemp(join(root, 'home-auth-'));
  await mkdir(join(home, '.pi', 'agent'), { recursive: true });
  const fakeKey = 'key-from-auth-json-1234567890';
  await writeFile(join(home, '.pi', 'agent', 'auth.json'), JSON.stringify({ deepseek: { key: fakeKey } }), 'utf8');
  const { status, stdout, stderr, info } = await runWrapper([], {
    HOME: home,
    CODEX_HOME_SRC: srcWithoutLogin,
    DEEPSEEK_API_KEY: '',
  });
  assert.equal(status, 0, stderr);
  assert.equal(info.has_key, 'yes');
  assert.equal(info.key_chars, String(fakeKey.length));
  assert.equal(stdout.includes(fakeKey), false, 'the key must never be printed');
  assert.equal(stderr.includes(fakeKey), false, 'the key must never be printed');
});

test('凭据：既无 DEEPSEEK_API_KEY 也无 CODEX_HOME/auth.json 时退出码 2，错误信息说清三条路，且不回显任何 key', async () => {
  const home = await mkdtemp(join(root, 'home-noauth-'));
  const { status, stdout, stderr } = await runWrapper([], {
    HOME: home,
    CODEX_HOME_SRC: srcWithoutLogin,
    DEEPSEEK_API_KEY: '',
  });
  assert.equal(status, 2);
  assert.match(stderr, /DEEPSEEK_API_KEY/);
  assert.match(stderr, /codex login/);
  assert.match(stderr, /pi auth login deepseek/);
  assert.equal(stdout, '');
  assert.equal(stderr.includes('test-key-not-real'), false);
});

test('凭据：没有 DEEPSEEK_API_KEY 但 CODEX_HOME/auth.json 已复制时直接跑，走 Codex 原生登录', async () => {
  // A fake `codex login` credential: the wrapper only checks that the copy
  // exists, so the value never matters and is never read or printed.
  const src = join(root, 'home-src-codelogin');
  await mkdir(src, { recursive: true });
  await writeFile(join(src, 'config.toml'), 'model = "deepseek-flash"\n', 'utf8');
  await writeFile(join(src, 'auth.json'), '{"OPENAI_API_KEY":null,"tokens":{"id_token":"fake"}}\n', 'utf8');
  const home = await mkdtemp(join(root, 'home-codelogin-'));
  const argsFile = join(root, `codex-args-login-${sequence}.nil`);
  const infoFile = join(root, `codex-info-login-${sequence}.txt`);

  // `DEEPSEEK_API_KEY: undefined` deletes the variable from the child
  // environment, so this really is the codex-login-only path.
  const result = spawnSync('bash', [WRAPPER, '--brief', brief, '--cwd', root, '--session-dir', sessionsDir], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      CODEX_HOME_SRC: src,
      CODEX_BIN: fakeCodex,
      CODEX_ARGS_FILE: argsFile,
      CODEX_INFO_FILE: infoFile,
      CODEX_DEV_RECORD_DIR: join(root, 'records'),
      DEEPSEEK_API_KEY: undefined,
    },
  });

  assert.equal(result.status, 0, result.stderr);
  assert.equal(existsSync(argsFile), true, 'the fake codex must have been called');
  const argv = (await readFile(argsFile, 'utf8')).split('\0').slice(0, -1);
  assert.equal(argv[0], 'exec');
  const info = Object.fromEntries(
    (await readFile(infoFile, 'utf8')).trimEnd().split('\n').map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), line.slice(index + 1)];
    }),
  );
  assert.equal(info.has_key, '', 'no DeepSeek key is invented for a codex-login run');
  assert.equal(info.home, join(sessionsDir, 'home'));
  assert.match(await readFile(join(info.home, 'auth.json'), 'utf8'), /tokens/);
  assert.equal(result.stdout.includes('fake'), false, 'the credential is never printed');
  assert.equal(result.stderr.includes('id_token'), false, 'the credential is never printed');
});

test('--log：stdout 与 stderr 都写进日志，stdout 仍是干净 JSON', async () => {
  const log = join(root, 'logs', 'run.log');
  const { status, stderr, stdout } = await runWrapper(['--log', log]);
  assert.equal(status, 0, stderr);

  // stdout stays exactly Codex's NDJSON; the banner never leaks into it.
  const lines = stdout.trimEnd().split('\n');
  assert.equal(lines.length, 2);
  for (const line of lines) {
    const record = JSON.parse(line);
    assert.equal(typeof record.type, 'string');
  }
  assert.equal(stdout.includes('banner'), false);

  const logged = await readFile(log, 'utf8');
  assert.match(logged, /"thread\.started"/);
  assert.match(logged, /banner: session id: thread-from-banner/);
});

test('派活记录：追加一行，未指定模型时写 default，退出码透传', async () => {
  const recordDir = join(root, 'records');
  await rm(recordDir, { recursive: true, force: true });
  const { status } = await runWrapper([], { CODEX_DEV_RECORD_DIR: recordDir, CODEX_DEV_MODEL: '' });
  assert.equal(status, 0);

  const record = (await readFile(join(recordDir, 'codex-delegations.log'), 'utf8')).trimEnd();
  const fields = record.split('\t');
  assert.equal(fields.length, 6);
  assert.equal(fields[0], '0');
  assert.equal(fields[1], 'default');
  assert.equal(fields[2], root);
  assert.match(fields[3], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.match(fields[4], /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(fields[5], '写一行文字');
});

test('派活记录：--model 生效时记下模型名；退出码非零也照记', async () => {
  const recordDir = join(root, 'records-fail');
  await rm(recordDir, { recursive: true, force: true });
  const { status } = await runWrapper(['--model', 'deepseek-pro'], {
    CODEX_DEV_RECORD_DIR: recordDir,
    FAKE_CODEX_EXIT: '3',
  });
  assert.equal(status, 3, 'the wrapper must pass the Codex exit code through');
  const fields = (await readFile(join(recordDir, 'codex-delegations.log'), 'utf8')).trimEnd().split('\t');
  assert.equal(fields[0], '3');
  assert.equal(fields[1], 'deepseek-pro');
});

test('CODEX_DEV_MODEL：环境变量作为默认模型，--model 优先', async () => {
  const first = await runWrapper([], { CODEX_DEV_MODEL: 'deepseek-from-env' });
  assert.equal(valueOf(first.argv, '-m'), 'deepseek-from-env');
  const second = await runWrapper(['--model', 'deepseek-flag'], { CODEX_DEV_MODEL: 'deepseek-from-env' });
  assert.equal(valueOf(second.argv, '-m'), 'deepseek-flag');
});

test('参数校验：缺 --brief、坏 --mode、坏 --sandbox、缺固定规矩、工作目录不存在都退出 2', async () => {
  const noBrief = spawnSync('bash', [WRAPPER, '--cwd', root], {
    encoding: 'utf8',
    env: { ...process.env, HOME: root, CODEX_BIN: fakeCodex, DEEPSEEK_API_KEY: 'x' },
  });
  assert.equal(noBrief.status, 2);
  assert.match(noBrief.stderr, /missing --brief/);

  const badMode = await runWrapper(['--mode', 'yaml']);
  assert.equal(badMode.status, 2);
  assert.match(badMode.stderr, /--mode must be text or json/);

  const badSandbox = await runWrapper(['--sandbox', 'open']);
  assert.equal(badSandbox.status, 2);
  assert.match(badSandbox.stderr, /--sandbox must be read-only, workspace-write or danger-full-access/);

  const noRules = await runWrapper([], { CODEX_DEV_RULES: join(root, 'nope.md') });
  assert.equal(noRules.status, 2);
  assert.match(noRules.stderr, /fixed rules not found/);

  const badCwd = await runWrapper(['--cwd', join(root, 'missing-dir')]);
  assert.equal(badCwd.status, 2);
  assert.match(badCwd.stderr, /working directory does not exist/);

  const unknown = await runWrapper(['--nope']);
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown argument/);
});

test('--brief -：从 stdin 读任务说明，规矩仍拼在前面', async () => {
  const result = spawnSync('bash', [WRAPPER, '--brief', '-', '--cwd', root], {
    cwd: root,
    encoding: 'utf8',
    input: '从标准输入来的任务\n',
    env: {
      ...process.env,
      HOME: root,
      CODEX_HOME_SRC: join(root, 'home-src'),
      CODEX_BIN: fakeCodex,
      CODEX_ARGS_FILE: join(root, 'stdin-args.nil'),
      CODEX_INFO_FILE: join(root, 'stdin-info.txt'),
      CODEX_DEV_RECORD_DIR: join(root, 'records'),
      DEEPSEEK_API_KEY: 'test-key-not-real',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  const argv = (await readFile(join(root, 'stdin-args.nil'), 'utf8')).split('\0').slice(0, -1);
  assert.match(argv[argv.length - 1], /# 本次任务\n\n从标准输入来的任务$/);
});

test('CODEX_BIN 缺失：明确报错并按封装层错误退出 2', async () => {
  const result = spawnSync('bash', [WRAPPER, '--brief', brief, '--cwd', root], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: root,
      CODEX_BIN: join(root, 'no-such-codex'),
      DEEPSEEK_API_KEY: 'test-key-not-real',
    },
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Codex CLI not found/);
});
