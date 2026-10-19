// test/security-hardening.test.mjs
// 回归用例：针对外部安全审计发现的「WebSocket 升级未校验 Origin」修复。
// 对应 lib/index.js 中 upgrade 处理器的 Origin 纵深防御分支。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import net from 'node:net'
import { request as httpRequest } from 'node:http'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BridgeService, ProxyServer, toHttpOrigin, DESKTOP_APP_ORIGIN } from '../lib/index.js'
import { AuthManager } from '../lib/auth/manager.js'
import { makeSessionsFile } from './helpers.mjs'

/** 发起原始 WebSocket 升级握手，返回状态行（如 'HTTP/1.1 101 Switching Protocols'）。 */
function rawUpgrade(port, headers) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => {
      const lines = [
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
      ]
      for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)
      socket.write(lines.join('\r\n') + '\r\n\r\n')
    })
    let buf = ''
    const done = (fn) => { try { socket.destroy() } catch {} ; fn() }
    socket.on('data', (d) => {
      buf += d.toString('utf8')
      const idx = buf.indexOf('\r\n\r\n')
      if (idx !== -1) done(() => resolve(buf.slice(0, buf.indexOf('\r\n'))))
    })
    socket.on('error', (e) => done(() => reject(e)))
    setTimeout(() => { if (!buf) done(() => resolve('(timeout)')) }, 3000)
  })
}

/** 构造一个已启动的 ProxyServer 及其上游 WS 桩。 */
async function makeProxy({ authenticated = true, allowedOrigins } = {}) {
  const upstream = createServer()
  upstream.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))

  // authenticated=false 时用真实 AuthManager 且关闭回环豁免，令握手被 401 拦下
  let authManager
  if (authenticated) {
    authManager = { verifyRequest: () => ({ authenticated: true }) }
  } else {
    authManager = new AuthManager({
      sessionsFile: makeSessionsFile(),
      config: { enabled: true, mode: 'password_only', allowLoopback: false },
    })
    await authManager.setPassword('pw')
  }

  const proxy = new ProxyServer({
    localPort: 0,
    targetPort: upstream.address().port,
    authManager,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
    allowedOrigins,
  })
  await proxy.start()
  const port = proxy.server.address().port
  return {
    port,
    close: async () => {
      await proxy.stop?.()
      try { proxy.server.close() } catch {}
      upstream.close()
    },
  }
}

test('WS 升级：无 Origin 头一律放行（兼容 IM 机器人 / ws 库 / 隧道等非浏览器客户端）', async () => {
  const { port, close } = await makeProxy({ allowedOrigins: () => ['http://127.0.0.1:3082'] })
  try {
    const status = await rawUpgrade(port, {})
    assert.match(status, /^HTTP\/1\.1 101/, `无 Origin 应放行，实际: ${status}`)
  } finally { await close() }
})

test('WS 升级：白名单内的 Origin 放行', async () => {
  const { port, close } = await makeProxy({ allowedOrigins: () => ['http://127.0.0.1:3082', 'http://192.168.1.5:3082'] })
  try {
    for (const origin of ['http://127.0.0.1:3082', 'http://192.168.1.5:3082']) {
      const status = await rawUpgrade(port, { Origin: origin })
      assert.match(status, /^HTTP\/1\.1 101/, `${origin} 应放行，实际: ${status}`)
    }
  } finally { await close() }
})

test('WS 升级：白名单外的 Origin 被拒绝（防 CSWSH）', async () => {
  const { port, close } = await makeProxy({ allowedOrigins: () => ['http://127.0.0.1:3082'] })
  try {
    const status = await rawUpgrade(port, { Origin: 'http://evil.test' })
    assert.match(status, /^HTTP\/1\.1 403/, `恶意 Origin 应被拒，实际: ${status}`)
  } finally { await close() }
})

test('WS 升级：Origin: null 被拒绝（沙箱 iframe / file:// 场景）', async () => {
  const { port, close } = await makeProxy({ allowedOrigins: () => ['http://127.0.0.1:3082'] })
  try {
    const status = await rawUpgrade(port, { Origin: 'null' })
    assert.match(status, /^HTTP\/1\.1 403/, `Origin:null 应被拒，实际: ${status}`)
  } finally { await close() }
})

test('WS 升级：认证优先于 Origin 校验（未认证时返回 401 而非 403）', async () => {
  const { port, close } = await makeProxy({ authenticated: false, allowedOrigins: () => ['http://127.0.0.1:3082'] })
  try {
    const status = await rawUpgrade(port, { Origin: 'http://evil.test' })
    assert.match(status, /^HTTP\/1\.1 401/, `未认证应返回 401，实际: ${status}`)
  } finally { await close() }
})

test('WS 升级：allowedOrigins 抛异常时降级为拒绝（不崩溃）', async () => {
  const { port, close } = await makeProxy({ allowedOrigins: () => { throw new Error('boom') } })
  try {
    const status = await rawUpgrade(port, { Origin: 'http://127.0.0.1:3082' })
    assert.match(status, /^HTTP\/1\.1 (403|401|500)/, `异常时应拒绝而非挂起，实际: ${status}`)
    // 关键：进程仍存活，且无 Origin 的请求依旧放行
    const ok = await rawUpgrade(port, {})
    assert.match(ok, /^HTTP\/1\.1 101/, `异常后无 Origin 仍应放行，实际: ${ok}`)
  } finally { await close() }
})

// ---------------------------------------------------------------------------
// opaque origin（字面量 "null"）防线
//
// 背景：隧道地址由外部提供（隧道服务器下发的 ready.publicUrl、cloudflared URL 等）。
// `new URL('dsh-app://app').origin` 返回的是字符串 "null"；这种值一旦进入
// loopback-token 的 CORS 白名单，就等于放行**所有** opaque origin——任意网页用
// sandboxed iframe（Origin: null）即可跨域读走回环领取的 adminToken 响应。
// 修复分两层：白名单生成侧按协议收敛（toHttpOrigin），消费侧永不授权 "null"。
// ---------------------------------------------------------------------------

test('toHttpOrigin：非 http(s) 来源一律丢弃（不再产出 "null" 进白名单）', () => {
  // 前提：opaque origin 的字面量就是字符串 "null"
  assert.equal(new URL('dsh-app://app').origin, 'null')

  assert.equal(toHttpOrigin('https://panel.example.com'), 'https://panel.example.com')
  assert.equal(toHttpOrigin('http://192.168.1.5:3082'), 'http://192.168.1.5:3082')

  for (const bad of ['dsh-app://app', 'file:///etc/passwd', 'javascript:alert(1)', 'data:text/html,x', 'app://evil.example', 'not a url', '', null, undefined]) {
    assert.equal(toHttpOrigin(bad), undefined, `${String(bad)} 不得进入 CORS 白名单`)
  }
})

test('BridgeService 白名单：隧道地址非 http(s) 时不产生 "null"', async () => {
  const service = new BridgeService({
    dshPort: 3080,
    proxyPort: 0,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
  })
  // 直接注入外部可控的隧道地址（真实链路里来自隧道服务器消息与配置）
  service.customTunnel = { publicUrl: 'dsh-app://app' }
  service.cloudflared = { url: 'javascript:alert(1)' }
  service.externalTunnelConfig = { url: 'file:///etc/passwd' }

  const proxy = await service.startProxy()
  try {
    const origins = proxy.allowedOrigins()
    assert.equal(origins.includes('null'), false, `白名单不得含 "null"，实际: ${JSON.stringify(origins)}`)
    // 白名单只允许 http(s) origin **加上**官方桌面版固定来源 dsh-app://app（issue #76）。
    // 后者是浏览器生成的字面量、网页无法伪造，且绝不等于 opaque 的 "null"。
    assert.ok(origins.includes(DESKTOP_APP_ORIGIN), `白名单应含官方桌面版来源，实际: ${JSON.stringify(origins)}`)
    for (const origin of origins) {
      assert.ok(origin === DESKTOP_APP_ORIGIN || /^https?:\/\//.test(origin),
        `白名单只允许 http(s) origin 与 ${DESKTOP_APP_ORIGIN}，实际: ${origin}`)
    }
    // http(s) 的隧道地址仍应正常放行（修复不得削弱既有能力）。
    // 用严格相等比对而非子串匹配：CodeQL js/incomplete-url-substring-sanitization
    // 会把「URL 字面量 + includes/startsWith」判成不完整的 URL 校验。
    service.customTunnel = { publicUrl: 'https://tunnel.example.com' }
    const httpsOrigins = proxy.allowedOrigins().filter((origin) => origin === 'https://tunnel.example.com')
    assert.equal(httpsOrigins.length, 1, `合法 https 隧道来源应放行，实际: ${JSON.stringify(proxy.allowedOrigins())}`)
  } finally {
    await proxy.stop()
  }
})

test('CORS：白名单里混入 "null" 也不回显 ACAO（opaque origin 永不授权）', async () => {
  const proxy = new ProxyServer({
    localPort: 0, targetPort: 1, authManager: null,
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    allowedOrigins: () => ['null', 'http://127.0.0.1:30882'],
  })
  await proxy.start()
  try {
    const port = proxy.server.address().port
    const call = (method, origin) => new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path: '/__dsh_bridge__/loopback-token',
        headers: origin ? { origin } : {} }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers }))
      })
      req.on('error', reject)
      req.end()
    })

    const preflightNull = await call('OPTIONS', 'null')
    assert.equal(preflightNull.headers['access-control-allow-origin'], undefined, 'Origin: null 不得获得 ACAO 回显')
    assert.equal(preflightNull.headers.vary, 'Origin')

    const postNull = await call('POST', 'null')
    assert.equal(postNull.headers['access-control-allow-origin'], undefined, 'Origin: null 不得获得 ACAO 回显')

    // 对照：合法的回环来源不受影响
    const good = await call('OPTIONS', 'http://127.0.0.1:30882')
    assert.equal(good.headers['access-control-allow-origin'], 'http://127.0.0.1:30882')
  } finally {
    await proxy.stop()
  }
})

test('WS 升级：白名单被污染出 "null" 时仍拒绝 Origin: null', async () => {
  const { port, close } = await makeProxy({ allowedOrigins: () => ['null', 'http://127.0.0.1:3082'] })
  try {
    const status = await rawUpgrade(port, { Origin: 'null' })
    assert.match(status, /^HTTP\/1\.1 403/, `白名单含 "null" 时仍应拒绝，实际: ${status}`)
    const ok = await rawUpgrade(port, { Origin: 'http://127.0.0.1:3082' })
    assert.match(ok, /^HTTP\/1\.1 101/, `合法回环来源仍应放行，实际: ${ok}`)
  } finally { await close() }
})

test('issue #76：官方桌面版来源 dsh-app://app 可跨源读取 loopback-token，且仍拒绝 null', async () => {
  const proxy = new ProxyServer({
    localPort: 0, targetPort: 1,
    authManager: { createAdminSession: () => 'admin-token-xyz', internalTunnelSecret: 'secret' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    allowedOrigins: () => [DESKTOP_APP_ORIGIN, 'http://127.0.0.1:30882'],
  })
  await proxy.start()
  try {
    const port = proxy.server.address().port
    // origin === undefined 表示「完全不带 Origin 头」（curl / Electron 主进程）；
    // 传 '' 才是真正的空 Origin 头。两者语义不同（空头必须 fail-closed），
    // 因此不能用 `origin ? ... : ...` 真值判断，否则空头会被误当成"无头"而测不到目标行为。
    const call = (method, origin) => new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path: '/__dsh_bridge__/loopback-token',
        headers: origin === undefined ? {} : { origin } }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }))
      })
      req.on('error', reject)
      req.end()
    })

    // 预检与实际请求都必须回显该来源（否则桌面窗口的 fetch 会被浏览器拦下）
    const preflight = await call('OPTIONS', DESKTOP_APP_ORIGIN)
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers['access-control-allow-origin'], DESKTOP_APP_ORIGIN)
    const post = await call('POST', DESKTOP_APP_ORIGIN)
    assert.equal(post.status, 200)
    assert.equal(post.headers['access-control-allow-origin'], DESKTOP_APP_ORIGIN)
    assert.equal(post.headers['cache-control'], 'no-store')
    assert.equal(JSON.parse(post.body).adminToken, 'admin-token-xyz', '桌面来源应能读到令牌响应体')

    // 对照组：opaque origin 与不在白名单的来源，不仅拿不到 ACAO，而且**直接 403 且不签发
    // 令牌**（纵深防御，不再依赖浏览器 CORS 实现细节）——不得因放行桌面来源而放松 #62 防线
    const nullPre = await call('OPTIONS', 'null')
    assert.equal(nullPre.headers['access-control-allow-origin'], undefined)
    assert.equal(nullPre.status, 403)
    const nullPost = await call('POST', 'null')
    assert.equal(nullPost.headers['access-control-allow-origin'], undefined)
    assert.equal(nullPost.status, 403)
    assert.equal(nullPost.body.includes('admin-token'), false, '未授权来源不得拿到令牌响应体')

    const evilPre = await call('OPTIONS', 'http://evil.example')
    assert.equal(evilPre.headers['access-control-allow-origin'], undefined)
    assert.equal(evilPre.status, 403)
    const evilPost = await call('POST', 'http://evil.example')
    assert.equal(evilPost.headers['access-control-allow-origin'], undefined)
    assert.equal(evilPost.status, 403)
    assert.equal(evilPost.body.includes('admin-token'), false, '未授权来源不得拿到令牌响应体')

    // 空 Origin 头（`Origin: `）：语义上同样是「浏览器给了来源但未获授权」→ 必须 fail-closed。
    // 回归断言：判定若退回真值判断（空串为假 → 走免 CORS 分支），本组必须失败。
    const emptyPre = await call('OPTIONS', '')
    assert.equal(emptyPre.status, 403, '空 Origin 头的预检也必须拒绝')
    assert.equal(emptyPre.headers['access-control-allow-origin'], undefined)
    const emptyPost = await call('POST', '')
    assert.equal(emptyPost.status, 403, '空 Origin 头不得签发令牌')
    assert.equal(emptyPost.headers['access-control-allow-origin'], undefined)
    assert.equal(emptyPost.body.includes('admin-token'), false, '空 Origin 头不得拿到令牌响应体')

    // 反向对照：完全不带 Origin 头（curl / Electron 主进程）仍走免 CORS 签发路径，行为不变
    const noOrigin = await call('POST', undefined)
    assert.equal(noOrigin.status, 200, '无 Origin 头的非浏览器客户端应照常签发')
    assert.equal(JSON.parse(noOrigin.body).adminToken, 'admin-token-xyz')
  } finally {
    await proxy.stop()
  }
})

test('issue #76：WebSocket 升级同样放行 dsh-app://app、拒绝 null', async () => {
  const { port, close } = await makeProxy({ allowedOrigins: () => [DESKTOP_APP_ORIGIN] })
  try {
    const ok = await rawUpgrade(port, { Origin: DESKTOP_APP_ORIGIN })
    assert.match(ok, /^HTTP\/1\.1 101/, `桌面来源应放行，实际: ${ok}`)
    const bad = await rawUpgrade(port, { Origin: 'null' })
    assert.match(bad, /^HTTP\/1\.1 403/, `opaque origin 仍应拒绝，实际: ${bad}`)
  } finally { await close() }
})

test('loopback-token 响应带 Cache-Control: no-store（响应体含 adminToken）', async () => {
  const proxy = new ProxyServer({
    localPort: 0, targetPort: 1,
    // 仅需 createAdminSession 即可走通"回环直发"分支；internalTunnelSecret 用于判定隧道来源
    authManager: { createAdminSession: () => 'test-only-token', internalTunnelSecret: 'secret' },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    allowedOrigins: () => ['http://127.0.0.1:30882'],
  })
  await proxy.start()
  try {
    const port = proxy.server.address().port
    const call = (method) => new Promise((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method, path: '/__dsh_bridge__/loopback-token',
        headers: { origin: 'http://127.0.0.1:30882' } }, (res) => {
        const chunks = []
        res.on('data', (c) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }))
      })
      req.on('error', reject)
      req.end()
    })

    const post = await call('POST')
    assert.equal(post.status, 200)
    assert.match(post.body, /adminToken/, '前置条件：该响应体确实携带令牌')
    assert.equal(post.headers['cache-control'], 'no-store', 'Vary: Origin 只影响缓存键，不禁缓存')
    assert.equal(post.headers['access-control-allow-origin'], 'http://127.0.0.1:30882')

    const preflight = await call('OPTIONS')
    assert.equal(preflight.status, 204)
    assert.equal(preflight.headers['cache-control'], 'no-store')
  } finally {
    await proxy.stop()
  }
})

// 结构不变式：getStatus 的默认视图是"访客"，管理员专属分支必须显式声明 adminAuthValid，
// 否则会把仅限管理员可见的字段（外部隧道 URL/二维码、cloudflared token）误掩码。
test('bridge-rpc：状态查询必须显式声明视图（不得出现无参 service.getStatus()）', () => {
  const src = readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), '..', 'lib/bridge-rpc.js'), 'utf8')
  const bare = src.match(/service\.getStatus\(\s*\)/g) ?? []
  assert.equal(
    bare.length,
    0,
    '无参 getStatus 默认访客视图；管理员分支请用 adminStatus() 或显式传 { adminAuthValid: true }',
  )
})
