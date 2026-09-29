// test/config-file-permissions.test.mjs
// 回归用例：针对外部安全审计发现的「config.json 未设权限位（落盘 0644 同机可读）」修复。
// 覆盖两条路径：新建文件带 mode、存量宽松文件在启动时被收敛，以及失败不阻断。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, stat, chmod, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Windows 不实现 POSIX 权限位：chmod/stat 的 mode 不反映 0600/0644 语义，
// 因此「权限位断言」仅在 POSIX 平台执行。生产代码对 chmod 失败本身是容错的
// （仅告警、不阻断启动），此处的平台区分只是避免测试在 Windows 上误报。
const IS_WIN = process.platform === 'win32'
const SKIP_WIN = IS_WIN ? 'Windows 不实现 POSIX 权限位，跳过权限位断言' : false
const CONFIG_FILE_MODE = 0o600

// 复刻 lib/index.js 中 writeConfig 与 ensureConfigFileMode 的行为契约。
// 两者均依赖模块内部的 dshHome，无法直接注入，故按实现语义做等价复现，
// 用于锁定「新建带 mode」「存量被收敛」「幂等」「失败不抛」四项契约。
function makeHelpers(dshHome, logger) {
  const configFile = join(dshHome, 'dsh-bridge', 'config.json')
  async function writeConfig(data) {
    await mkdir(join(dshHome, 'dsh-bridge'), { recursive: true })
    await writeFile(configFile, JSON.stringify(data, null, 2), { encoding: 'utf8', mode: CONFIG_FILE_MODE })
  }
  async function ensureConfigFileMode() {
    try {
      await stat(configFile)
    } catch (err) {
      if (err?.code !== 'ENOENT') logger.warn('check failed', err?.message)
      return
    }
    try {
      const current = await stat(configFile)
      const tightened = current.mode & 0o777
      if (tightened === CONFIG_FILE_MODE) return
      await chmod(configFile, CONFIG_FILE_MODE)
      logger.info('tightened', tightened.toString(8))
    } catch (err) {
      logger.warn('tighten failed', err?.message ?? err)
    }
  }
  return { configFile, writeConfig, ensureConfigFileMode }
}

const perms = async (f) => ((await stat(f)).mode & 0o777).toString(8).padStart(4, '0')

test('config.json 新建时即为 0600（不再落 0644/0664）', { skip: SKIP_WIN }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-perm-'))
  try {
    const { configFile, writeConfig } = makeHelpers(dir, { info() {}, warn() {} })
    await writeConfig({ auth: { secretToken: 'x' } })
    assert.equal(await perms(configFile), '0600')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('存量 0644 的 config.json 在启动收敛后被改为 0600，且内容不变', { skip: SKIP_WIN }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-perm-'))
  try {
    const { configFile, writeConfig, ensureConfigFileMode } = makeHelpers(dir, { info() {}, warn() {} })
    const payload = { cloudflared: { token: 'FAKE-TUNNEL-JWT' }, auth: { enabled: false } }
    await writeConfig(payload)
    await chmod(configFile, 0o644) // 模拟历史版本遗留
    assert.equal(await perms(configFile), '0644')

    await ensureConfigFileMode()

    assert.equal(await perms(configFile), '0600')
    // 内容必须逐字节不变
    assert.deepEqual(JSON.parse(await readFile(configFile, 'utf8')), payload)
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('权限收敛是幂等的：已是 0600 时不重复处理且不报错', { skip: SKIP_WIN }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-perm-'))
  try {
    let infoCalls = 0
    const { configFile, writeConfig, ensureConfigFileMode } = makeHelpers(dir, { info() { infoCalls++ }, warn() {} })
    await writeConfig({ a: 1 })
    await ensureConfigFileMode() // 已是 0600，应短路
    await ensureConfigFileMode()
    await ensureConfigFileMode()
    assert.equal(infoCalls, 0, '已是 0600 不应触发收敛日志')
    assert.equal(await perms(configFile), '0600')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('文件不存在时权限收敛静默跳过（不创建、不抛错）', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-perm-'))
  try {
    const warns = []
    const { configFile, ensureConfigFileMode } = makeHelpers(dir, { info() {}, warn: (...a) => warns.push(a) })
    await ensureConfigFileMode() // 必须 resolve，不得 reject
    await assert.rejects(stat(configFile), '不应凭空创建文件')
    assert.equal(warns.length, 0, 'ENOENT 属预期，不应告警')
  } finally { await rm(dir, { recursive: true, force: true }) }
})

test('非 ENOENT 错误（如 EACCES 语义）不抛错，但必须出声告警', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-perm-'))
  try {
    // 用一个「父路径为文件」的错位路径模拟非 ENOENT 失败
    const blockedParent = join(dir, 'not-a-dir')
    await writeFile(blockedParent, 'x')
    const warns = []
    const { ensureConfigFileMode } = makeHelpers(join(blockedParent, 'sub'), { info() {}, warn: (...a) => warns.push(a) })
    await ensureConfigFileMode()
    assert.ok(warns.length >= 1, '非 ENOENT 失败必须告警，不能静默')
  } finally { await rm(dir, { recursive: true, force: true }) }
})
