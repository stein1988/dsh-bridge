// test/session-projcache-layout.test.mjs
// 回归用例：DSH 0.1.7 把 session_projcache 从「单文件」改为「per-record 目录」后，
// 会话标题全部退化为「新会话」。
//
// 旧布局（0.1.6-）: <DSH_HOME>/storages/session_projcache.json
//                    { tables: { sessions: { <id>: { identity, rows } } } }
// 新布局（0.1.7+）: <DSH_HOME>/storages/session_projcache/sessions/<id>.json
//                    { version, record: { identity, rows } }
//
// 两种布局都必须能读出 rows.title.val——这是 /sessions 标题的唯一数据源。
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSessionProjCache } from '../lib/platform/dsh-storage.js'

/** 在隔离的 DSH_HOME 下运行 fn，避免读到真实用户目录。 */
function withHome(fn) {
  const prev = process.env.DSH_HOME
  const root = mkdtempSync(join(tmpdir(), 'dsh-projc-'))
  const home = join(root, '.dsh')
  mkdirSync(join(home, 'storages'), { recursive: true })
  process.env.DSH_HOME = home
  try {
    return fn(home, root)
  } finally {
    if (prev === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = prev
    rmSync(root, { recursive: true, force: true })
  }
}

const recordOf = (title, extra = {}) => ({
  version: 7,
  record: { identity: { createdAt: 111 }, rows: { title: { ver: 1, seq: 1, val: title }, ...extra } },
})

test('新布局（0.1.7+ per-record）：标题可读出，形状与消费方一致', () => {
  withHome((home) => {
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sess-new.json'), JSON.stringify(recordOf('新布局标题', {
      sessionListMetadata: { ver: 1, seq: 1, val: { blank: false } },
    })))

    const cache = getSessionProjCache({})
    const row = cache['sess-new']
    // 消费方读取路径（session-catalog.js）：cache[sid].rows.title.val
    assert.equal(row?.rows?.title?.val, '新布局标题')
    assert.equal(row?.rows?.sessionListMetadata?.val?.blank, false)
    assert.equal(row?.identity?.createdAt, 111)
  })
})

test('旧布局（0.1.6- 单文件）：仍可读出（向后兼容，不回归旧用户）', () => {
  withHome((home) => {
    writeFileSync(join(home, 'storages', 'session_projcache.json'), JSON.stringify({
      tables: { sessions: { 'sess-old': { identity: { createdAt: 222 }, rows: { title: { val: '旧布局标题' } } } } },
    }))

    const cache = getSessionProjCache({})
    assert.equal(cache['sess-old']?.rows?.title?.val, '旧布局标题')
    assert.equal(cache['sess-old']?.identity?.createdAt, 222)
  })
})

test('两种布局并存时旧布局优先（不与既有行为冲突）', () => {
  withHome((home) => {
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(home, 'storages', 'session_projcache.json'), JSON.stringify({
      tables: { sessions: { both: { rows: { title: { val: 'legacy' } } } } },
    }))
    writeFileSync(join(dir, 'both.json'), JSON.stringify(recordOf('new')))

    assert.equal(getSessionProjCache({})['both']?.rows?.title?.val, 'legacy')
  })
})

test('两种布局均缺失：返回空且不抛错（宿主存储属可丢弃的派生数据）', () => {
  withHome(() => {
    const cache = getSessionProjCache({})
    assert.equal(cache['nonexistent'], undefined)
    assert.doesNotThrow(() => cache['another'])
  })
})

test('不存在的会话 id 返回 undefined（不得抛错中断整个 /sessions 列表）', () => {
  withHome((home) => {
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'exists.json'), JSON.stringify(recordOf('t')))

    const cache = getSessionProjCache({})
    assert.equal(cache['exists']?.rows?.title?.val, 't')
    assert.equal(cache['missing'], undefined)
  })
})

test('损坏的 per-record 文件视为无缓存，不影响其它会话', () => {
  withHome((home) => {
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'broken.json'), '{ this is not json')
    writeFileSync(join(dir, 'ok.json'), JSON.stringify(recordOf('好会话')))

    const cache = getSessionProjCache({})
    assert.equal(cache['broken'], undefined)
    assert.equal(cache['ok']?.rows?.title?.val, '好会话')
  })
})

test('内存注入优先于磁盘（ctx.sessionProjCache 存在时不读文件）', () => {
  withHome((home) => {
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 's.json'), JSON.stringify(recordOf('来自磁盘')))

    const injected = { s: { rows: { title: { val: '来自注入' } } } }
    assert.equal(getSessionProjCache({ sessionProjCache: injected })['s']?.rows?.title?.val, '来自注入')
  })
})

test('惰性读取：构造 cache 不遍历全部 per-record 文件', () => {
  withHome((home) => {
    const dir = join(home, 'storages', 'session_projcache', 'sessions')
    mkdirSync(dir, { recursive: true })
    for (let i = 0; i < 200; i++) {
      writeFileSync(join(dir, `s${i}.json`), JSON.stringify(recordOf(`标题${i}`)))
    }
    const t0 = performance.now()
    const cache = getSessionProjCache({})
    const constructMs = performance.now() - t0
    // 全量读取 200 个文件通常需数十毫秒；惰性构造应远快于此
    assert.ok(constructMs < 20, `构造耗时 ${constructMs.toFixed(2)}ms，疑似全量读取`)
    // 按 id 取值仍然正确
    assert.equal(cache['s7']?.rows?.title?.val, '标题7')
  })
})
