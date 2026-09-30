// test/dsh-upgrade.test.mjs
// DSH 一键升级回归用例：prefix 错位、版本核验、预发布版本支持。
import test from 'node:test';
import assert from 'node:assert/strict';
import { BridgeService } from '../lib/index.js';

const quietLogger = { info() {}, warn() {}, error() {}, debug() {} };

const makeService = () => new BridgeService({
  dshPort: 3080,
  proxyPort: 3082,
  home: {},
  logger: quietLogger,
});

// 模拟 npm 成功（退出码 0）的 spawn
const mockSpawnOk = (onCall) => (cmd, args) => {
  onCall?.(cmd, args);
  return {
    stdout: { on: (e, cb) => { if (e === 'data') setTimeout(() => cb(Buffer.from('ok')), 0); } },
    stderr: { on: () => {} },
    on: (event, cb) => {
      if (event === 'close') setTimeout(() => cb(0), 5);
    },
  };
};

test('DSH 升级：--prefix 必须使用探测到的 rootGlobal（npm prefix -g），不能自行再 dirname', async () => {
  // 模拟真实场景：npm root -g 返回 /home/wenbin/.local/node-v24.20.0/lib/node_modules
  // _probeDshUpgrade 已修复为返回 npm prefix -g（/home/wenbin/.local/node-v24.20.0）。
  // upgradeDsh 必须原样使用 probe.rootGlobal，不能再 dirname。
  const service = makeService();

  // 注入探测结果：可升级，且 rootGlobal 是正确的 npm prefix -g 输出
  service._probeDshUpgrade = async () => ({
    upgradable: true,
    rootGlobal: '/home/wenbin/.local/node-v24.20.0', // 这才是 npm prefix -g
    dshRealPath: '/home/wenbin/.local/node-v24.20.0/lib/node_modules/@deepseek-ai/dsh/lib/bin.js',
  });

  // 注入 getDshVersion：模拟升级后版本已变更
  service.getDshVersion = async () => '0.2.0-rc.2';

  let actualArgs = null;
  const result = await service.upgradeDsh({
    version: '0.2.0-rc.2',
    spawnImpl: mockSpawnOk((cmd, args) => { actualArgs = { cmd, args }; }),
  });

  // 断言 1：必须调用了 npm install -g
  assert.ok(actualArgs, '未调用 spawn');
  assert.ok(actualArgs.args.includes('install'), '未调用 npm install');
  assert.ok(actualArgs.args.includes('-g'), '未使用 -g 标志');

  // 断言 2：--prefix 后的值必须是 npm prefix -g 的结果，不能是 npm root -g 的父目录
  const prefixIdx = actualArgs.args.indexOf('--prefix');
  assert.ok(prefixIdx >= 0, '未指定 --prefix');
  const prefixValue = actualArgs.args[prefixIdx + 1];
  assert.equal(
    prefixValue,
    '/home/wenbin/.local/node-v24.20.0',
    `--prefix 值错误：应为 npm prefix -g 的输出，实际为 ${prefixValue}`,
  );
  // 绝不能是错位的 .../lib（旧 bug：dirname(npm root -g)）
  assert.notEqual(prefixValue, '/home/wenbin/.local/node-v24.20.0/lib');

  // 断言 3：升级应该成功
  assert.equal(result.ok, true, `升级失败：${result.error}`);
});

test('DSH 升级：指定具体版本号时，安装后必须校验 dsh --version 匹配', async () => {
  const service = makeService();

  service._probeDshUpgrade = async () => ({ upgradable: true, rootGlobal: '/mock/prefix' });

  // 模拟：npm 命令成功（退出码 0），但 dsh --version 仍返回旧版本
  service.getDshVersion = async () => '0.1.7-rc.2';

  const result = await service.upgradeDsh({
    version: '0.2.0-rc.2',
    spawnImpl: mockSpawnOk(),
  });

  // 断言：必须返回失败，并提示版本不匹配
  assert.equal(result.ok, false, '应检测到版本不匹配并返回失败');
  assert.ok(result.error.includes('实际版本仍为'), `错误信息不明确：${result.error}`);
  assert.ok(result.error.includes('0.1.7-rc.2'), '错误信息应包含实际版本');
  assert.ok(result.error.includes('0.2.0-rc.2'), '错误信息应包含预期版本');
  assert.equal(result.installedButNotActive, true, '应标记"安装成功但未生效"');
});

test('DSH 升级：版本号必须支持预发布标签（如 rc/alpha）', async () => {
  const service = makeService();

  // 1. 合法的预发布版本号应通过校验
  const validVersions = ['0.2.0-rc.2', '1.0.0-alpha.1', '2.3.4-beta', '0.1.5-rc.10'];
  for (const v of validVersions) {
    service._probeDshUpgrade = async () => ({ upgradable: false, reason: 'mock' });
    const r = await service.upgradeDsh({ version: v, spawnImpl: mockSpawnOk() });
    // 只要不是因为"非法版本号"而失败，就说明正则通过了
    assert.ok(
      !r.error || !r.error.includes('非法的版本号格式'),
      `${v} 应被识别为合法版本号，但被拦截：${r.error}`,
    );
  }

  // 2. 非法版本号应被拦截
  const invalidVersions = ['1.0.0; rm -rf', '1.0.0 && whoami', '$(cat /etc/passwd)'];
  for (const v of invalidVersions) {
    const r = await service.upgradeDsh({ version: v, spawnImpl: mockSpawnOk() });
    assert.equal(r.ok, false, `${v} 应被拦截`);
    assert.ok(r.error.includes('非法的版本号格式'), `${v} 应报"非法版本号"，实际：${r.error}`);
  }
});

test('DSH 升级：成功后必须清理版本检查缓存，避免 UI 仍显示旧版本', async () => {
  const service = makeService();

  // 模拟初始状态：版本检查缓存是旧数据
  service._versionCheckCache = { dshVersion: '0.1.7-rc.2', dshLatest: '0.2.0-rc.2' };
  service._versionCheckCachedAt = Date.now();

  service._probeDshUpgrade = async () => ({ upgradable: true, rootGlobal: '/mock' });

  // 升级成功后 getDshVersion 返回新版本（模拟重启后的实际情况）
  let versionCallCount = 0;
  service.getDshVersion = async () => {
    versionCallCount += 1;
    return '0.2.0-rc.2';
  };

  const result = await service.upgradeDsh({
    version: '0.2.0-rc.2',
    spawnImpl: mockSpawnOk(),
  });

  assert.equal(result.ok, true, `升级应成功：${result.error}`);
  // 断言：版本检查缓存必须被清空，下次 checkVersion 重新拉 registry
  assert.equal(service._versionCheckCache, null, '_versionCheckCache 未清理');
  // 断言：升级后必须实际探测过 dsh 版本（核验步骤）
  assert.ok(versionCallCount >= 1, '升级后未调用 getDshVersion 核验实际版本');
});

test('DSH 升级：latest 版本时跳过版本核验（无法预知最新版本号）', async () => {
  const service = makeService();

  service._probeDshUpgrade = async () => ({ upgradable: true, rootGlobal: '/mock' });

  // 即便 getDshVersion 返回旧版本，latest 也应成功（无法预判 latest 对应的具体版本号）
  service.getDshVersion = async () => '0.1.7-rc.2';

  const result = await service.upgradeDsh({ version: 'latest', spawnImpl: mockSpawnOk() });

  assert.equal(result.ok, true, 'latest 升级不应因版本核验失败');
});
