// CloudflaredManager 自愈（issue #34 修复）回归测试
// 用假 cloudflared 二进制（/tmp 下，行为由 FAKE_CF_MODE 环境变量驱动）验证进程生命周期：
//   - 就绪后意外退出 → 退避自动重启（reconnecting → ready）
//   - 用户 stop() 后不再自愈
//   - 启动秒退 → 退避重试
//   - 握手超时 → 只杀进程、不置 _stopped（可重试）
//   - 版本解析 / 版本钉死校验
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { CloudflaredManager, parseCloudflaredVersion } from '../lib/cloudflared-manager.mjs';

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), 'fixtures');
const FAKE_SCRIPT = join(FIXTURES, 'fake-cloudflared.mjs');

// 跨平台"可执行入口"：
// - Linux/macOS：直接 spawn node 脚本（需可执行位，git 已存 mode 755）
// - Windows：child_process 无法直接 spawn 无 shebang 支持的 .mjs，生成 .cmd 包装
//   （@node "%~dp0fake-cloudflared.mjs" %*），配合 shell:true 注入让进程测试同样跑通。
const IS_WIN = process.platform === 'win32';
const FAKE_BIN = IS_WIN ? join(FIXTURES, 'fake-cloudflared.cmd') : FAKE_SCRIPT;
if (IS_WIN) {
  writeFileSync(FAKE_BIN, '@echo off\r\nnode "%~dp0fake-cloudflared.mjs" %*\r\n');
}
// Windows 下 spawn .cmd 需 shell:true；manager 通过 spawnOptions 注入（生产不传）。
const FAKE_SPAWN_OPTS = IS_WIN ? { shell: true } : null;

const noopLogger = { info: () => {}, error: () => {}, warn: () => {}, debug: () => {} };

// 状态历史记录器
function stateRecorder() {
  const states = [];
  return {
    states,
    onState: (s) => states.push(s),
    lastPhase: () => states.at(-1)?.phase,
    waitForPhase: (phase, timeoutMs = 8000) => new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        if (states.some((s) => s.phase === phase)) return resolve();
        if (Date.now() > deadline) return reject(new Error(`等待 phase=${phase} 超时。历史: ${JSON.stringify(states)}`));
        setTimeout(check, 20);
      };
      check();
    }),
    // 等待某 phase 的累计出现次数达到 n（避免"历史已含旧 ready，新 ready 未到"的竞态）
    waitForPhaseCount: (phase, n, timeoutMs = 8000) => new Promise((resolve, reject) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        if (states.filter((s) => s.phase === phase).length >= n) return resolve();
        if (Date.now() > deadline) return reject(new Error(`等待 phase=${phase} 计数≥${n} 超时。当前=${states.filter((s) => s.phase === phase).length} 历史: ${JSON.stringify(states)}`));
        setTimeout(check, 20);
      };
      check();
    }),
    countPhase: (phase) => states.filter((s) => s.phase === phase).length,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('parseCloudflaredVersion 解析标准 --version 输出', () => {
  assert.equal(parseCloudflaredVersion('cloudflared version 2024.10.0 (built 2024-10-01)'), '2024.10.0');
  assert.equal(parseCloudflaredVersion('cloudflared version 2026.8.3 (built 2026-08-03)'), '2026.8.3');
  assert.equal(parseCloudflaredVersion('garbage output'), null);
});

test('就绪后意外退出（如崩溃/误杀）→ 退避自动重启并恢复 ready', async () => {
  const rec = stateRecorder();
  const mgr = new CloudflaredManager({
    port: 3082,
    token: 'fake-token',
    hostname: 'dsh.example.com',
    binaryPath: FAKE_BIN,
    spawnOptions: FAKE_SPAWN_OPTS,
    retryPolicy: { baseDelayMs: 50, maxDelayMs: 200, maxRetries: 5 }, // 测试用小退避
    handshakeTimeoutMs: 2000,
    onStateChange: rec.onState,
    logger: noopLogger,
  });

  // 模式 1：就绪后 800ms 崩溃一次
  process.env.FAKE_CF_MODE = 'crash-after-ready';
  process.env.FAKE_CF_READY_MS = '50';
  process.env.FAKE_CF_CRASH_MS = '600';

  try {
    mgr.start();
    // 首次就绪
    await rec.waitForPhaseCount('ready', 1, 4000);

    // 崩溃后应进入 reconnecting，随后再次 ready（累计 2 次）
    await rec.waitForPhase('reconnecting', 6000);
    await rec.waitForPhaseCount('ready', 2, 6000);
    assert.ok(rec.countPhase('reconnecting') >= 1, '应经过 reconnecting 态');
  } finally {
    // 清理：停止 manager，防止残留进程/定时器导致事件循环不退
    mgr.stop();
    delete process.env.FAKE_CF_MODE;
    delete process.env.FAKE_CF_READY_MS;
    delete process.env.FAKE_CF_CRASH_MS;
  }
});

test('用户 stop() 后意外退出不再自愈', async () => {
  const rec = stateRecorder();
  const mgr = new CloudflaredManager({
    port: 3082,
    token: 'fake-token',
    binaryPath: FAKE_BIN,
    spawnOptions: FAKE_SPAWN_OPTS,
    retryPolicy: { baseDelayMs: 50, maxDelayMs: 200, maxRetries: 5 },
    handshakeTimeoutMs: 2000,
    onStateChange: rec.onState,
    logger: noopLogger,
  });

  process.env.FAKE_CF_MODE = 'crash-after-ready';
  process.env.FAKE_CF_READY_MS = '50';
  process.env.FAKE_CF_CRASH_MS = '600';

  try {
    mgr.start();
    await rec.waitForPhase('ready', 4000);

    // 用户主动 stop
    mgr.stop();
    await sleep(150); // 等 stop 生效、状态落 idle

    // 即便进程随后退出（模拟 stop 后残留 exit），也不得进入 reconnecting
    await sleep(300);
    assert.notEqual(rec.lastPhase(), 'reconnecting', 'stop 后不得自愈');
    assert.equal(rec.lastPhase(), 'idle', 'stop 后应停在 idle');
  } finally {
    mgr.stop();
    delete process.env.FAKE_CF_MODE;
    delete process.env.FAKE_CF_READY_MS;
    delete process.env.FAKE_CF_CRASH_MS;
  }
});

test('启动秒退（如 token 错误）→ 退避重试直至成功或超限', async () => {
  const rec = stateRecorder();
  const mgr = new CloudflaredManager({
    port: 3082,
    token: 'bad-token',
    binaryPath: FAKE_BIN,
    spawnOptions: FAKE_SPAWN_OPTS,
    retryPolicy: { baseDelayMs: 30, maxDelayMs: 120, maxRetries: 4 },
    handshakeTimeoutMs: 2000,
    onStateChange: rec.onState,
    logger: noopLogger,
  });

  process.env.FAKE_CF_MODE = 'exit-fast';
  process.env.FAKE_CF_EXIT_MS = '20';

  try {
    mgr.start();
    // 秒退会不断触发 reconnecting（每次退避后重试）
    await rec.waitForPhase('reconnecting', 4000);
    assert.ok(rec.countPhase('reconnecting') >= 1, '启动失败应进入退避重试');

    // 超限后进入 error（不再无限重试）
    await rec.waitForPhase('error', 8000);
    assert.equal(rec.lastPhase(), 'error', '超过最大重试次数应转 error');
  } finally {
    mgr.stop();
    delete process.env.FAKE_CF_MODE;
    delete process.env.FAKE_CF_EXIT_MS;
  }
});

test('握手超时只杀进程不置 _stopped：之后可成功重试', async () => {
  const rec = stateRecorder();
  const mgr = new CloudflaredManager({
    port: 3082,
    token: 'fake-token',
    binaryPath: FAKE_BIN,
    spawnOptions: FAKE_SPAWN_OPTS,
    retryPolicy: { baseDelayMs: 50, maxDelayMs: 200, maxRetries: 5 },
    handshakeTimeoutMs: 150, // 注入极小超时
    onStateChange: rec.onState,
    logger: noopLogger,
  });

  // 先用 hang 模式：不打印就绪 → 触发握手超时
  process.env.FAKE_CF_MODE = 'hang';
  try {
    mgr.start();
    await rec.waitForPhase('reconnecting', 4000); // 超时后应进退避重试而非 error/停止

    // 说明：hang 模式会持续挂起，退避期间再 spawn 还是 hang —— 最终仍会重试。
    // 关键断言：超时后走的是 reconnecting（可重试），而不是直接 idle/死透。
    assert.ok(rec.countPhase('reconnecting') >= 1, '握手超时应进入退避重试');
  } finally {
    mgr.stop();
    delete process.env.FAKE_CF_MODE;
  }
});

test('manager 意外退出与 stop 生命周期：stop 后 exit 事件不清新进程（无双跑残留引用）', async () => {
  const rec = stateRecorder();
  const mgr = new CloudflaredManager({
    port: 3082,
    token: 'fake-token',
    binaryPath: FAKE_BIN,
    spawnOptions: FAKE_SPAWN_OPTS,
    retryPolicy: { baseDelayMs: 50, maxDelayMs: 200, maxRetries: 5 },
    handshakeTimeoutMs: 2000,
    onStateChange: rec.onState,
    logger: noopLogger,
  });

  process.env.FAKE_CF_MODE = 'ready-then-hold';
  try {
    mgr.start();
    await rec.waitForPhase('ready', 4000);

    // stop 后 process 引用应被清空（引用置 null）
    mgr.stop();
    assert.equal(mgr.process, null, 'stop 后不应残留进程引用');
    assert.equal(mgr.url, null, 'stop 后 url 应清空');
  } finally {
    mgr.stop();
    delete process.env.FAKE_CF_MODE;
  }
});

// 版本钉死校验：autoupdate 自替换后的二进制（版本不符）必须被拒绝并触发重下
test('_checkManagedBinaryVersion 拒绝与钉死版本不符的自管理二进制', () => {
  process.env.FAKE_CF_MODE = 'version'; // fake 打印 cloudflared version 2024.10.0
  try {
    const mgrMatch = new CloudflaredManager({
      port: 3082, token: 't', binaryPath: FAKE_BIN, binaryVersion: '2024.10.0', logger: noopLogger,
    });
    const ok = mgrMatch._checkManagedBinaryVersion(FAKE_BIN);
    assert.equal(ok.ok, true);
    assert.equal(ok.version, '2024.10.0');

    // 期望版本为 2026.8.3 而实际是 2024.10.0 → 拒绝
    const mgrMismatch = new CloudflaredManager({
      port: 3082, token: 't', binaryPath: FAKE_BIN, binaryVersion: '2026.8.3', logger: noopLogger,
    });
    const bad = mgrMismatch._checkManagedBinaryVersion(FAKE_BIN);
    assert.equal(bad.ok, false);
    assert.match(bad.reason, /版本不匹配/);
  } finally {
    delete process.env.FAKE_CF_MODE;
  }
});

// issue #35 回归：token 固定域名模式下 --no-autoupdate 必须位于 run 之前。
// fake cloudflared 在 FAKE_CF_STRICT=1 时模拟真实 CLI 的 flag 解析——若 flag 位置
// 错误（run 之后）会打印 Incorrect Usage 退出，manager 将无法 ready。
test('token 固定域名模式：--no-autoupdate 位于 run 前，隧道可正常就绪 (issue #35)', async () => {
  const rec = stateRecorder();
  const mgr = new CloudflaredManager({
    port: 3082,
    token: 'cf-fixed-domain-token',
    hostname: 'dsh.example.com',
    binaryPath: FAKE_BIN,
    spawnOptions: FAKE_SPAWN_OPTS,
    retryPolicy: { baseDelayMs: 50, maxDelayMs: 200, maxRetries: 2 },
    handshakeTimeoutMs: 3000,
    noAutoupdate: true, // 显式：默认即 true，回归 #35 的场景
    onStateChange: rec.onState,
    logger: noopLogger,
  });

  process.env.FAKE_CF_MODE = 'ready-then-hold';
  process.env.FAKE_CF_STRICT = '1';
  try {
    mgr.start();
    // 若 flag 顺序错误（#35），fake 会秒退 → 退避重试到 maxRetries → error，永不 ready
    await rec.waitForPhase('ready', 4000);
    assert.equal(rec.lastPhase(), 'ready', '固定域名隧道应就绪');
    assert.equal(mgr.url, 'https://dsh.example.com', '固定域名应作为 URL');
  } finally {
    mgr.stop();
    delete process.env.FAKE_CF_MODE;
    delete process.env.FAKE_CF_STRICT;
  }
});

// 确定性配置错误（Incorrect Usage / 无效 Token 等）应直接 error 提示用户，
// 而不是误判成"意外退出"退避重连 N 次（issue #35 作者建议 2）。
test('确定性配置错误（Incorrect Usage）→ 直接 error，不进入退避重连循环', async () => {
  const rec = stateRecorder();
  const mgr = new CloudflaredManager({
    port: 3082,
    token: 'fake-token',
    binaryPath: FAKE_BIN,
    spawnOptions: FAKE_SPAWN_OPTS,
    retryPolicy: { baseDelayMs: 30, maxDelayMs: 120, maxRetries: 5 },
    handshakeTimeoutMs: 2000,
    onStateChange: rec.onState,
    logger: noopLogger,
  });

  process.env.FAKE_CF_MODE = 'fatal'; // fake 打印 Incorrect Usage 后退出
  try {
    mgr.start();
    // 应直接进入 error（不经过 reconnecting）
    await rec.waitForPhase('error', 4000);
    assert.ok(rec.countPhase('reconnecting') === 0, '确定性错误不应进入重连循环');
    const errState = rec.states.find((s) => s.phase === 'error');
    assert.match(errState.detail, /配置错误/, 'error 应说明是配置错误');
  } finally {
    mgr.stop();
    delete process.env.FAKE_CF_MODE;
  }
});
