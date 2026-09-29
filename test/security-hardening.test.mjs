// test/security-hardening.test.mjs
// 回归用例：针对外部安全审计发现的「WebSocket 升级未校验 Origin」修复。
// 对应 lib/index.js 中 upgrade 处理器的 Origin 纵深防御分支。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import net from 'node:net'
import { ProxyServer } from '../lib/index.js'
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
