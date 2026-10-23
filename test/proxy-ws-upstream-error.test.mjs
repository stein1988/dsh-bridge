// test/proxy-ws-upstream-error.test.mjs
// 回归用例：issue #81 —— WebSocket 转发缺少上游 socket 的 'error' 监听。
//
// 复现场景：上游 WS 桩先完成 101 握手，随后 RST（resetAndDestroy）上游连接；
// 代理侧此时仍在把客户端数据 pipe 给上游 socket。Node 中 EventEmitter 的 'error'
// 事件无监听者时会抛出为未捕获异常，dsh 顶层处理器直接退出整个进程。
// 修复：lib/index.js 的升级代理回调里补 `proxySocket.on('error', teardown)`。
//
// 断言：整个窗口内不产生 uncaughtException，且客户端 socket 与代理连接记录被清理。
// 全用例只使用本机回环与临时端口，不依赖外网、不读写 ~/.dsh。
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import net from 'node:net'
import { ProxyServer } from '../lib/index.js'

const NOOP = () => {}
const noopLogger = { info: NOOP, warn: NOOP, error: NOOP, debug: NOOP }

const delay = (ms) => new Promise((r) => setTimeout(r, ms))

/** 轮询等待条件成立；超时则抛出带标签的错误，便于定位卡在哪一步。 */
async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await delay(10)
  }
  throw new Error(`等待超时（${timeoutMs}ms）：${label}`)
}

/**
 * 启动上游 WS 桩。
 * @param {{ rstDelayMs?: number, echo?: boolean }} opts
 *   rstDelayMs: 101 握手后多久 RST 上游连接（模拟上游断开）
 *   echo: 是否把收到的数据原样回写（用于正常转发回归用例）
 */
async function startUpstream({ rstDelayMs = 80, echo = false } = {}) {
  const upstream = createServer((req, res) => res.end('upstream'))
  const sockets = new Set()
  upstream.on('connection', (s) => {
    sockets.add(s)
    s.on('close', () => sockets.delete(s))
  })
  upstream.on('upgrade', (req, socket) => {
    // 上游桩自身也要兜住 error，否则 RST 会把测试进程打死（与被测代码无关）
    socket.on('error', NOOP)
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    if (echo) socket.on('data', (chunk) => { try { socket.write(chunk) } catch {} })
    if (rstDelayMs !== null) {
      setTimeout(() => {
        try { socket.resetAndDestroy() } catch { try { socket.destroy() } catch {} }
      }, rstDelayMs)
    }
  })
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r))
  return {
    port: upstream.address().port,
    close: () => new Promise((r) => {
      for (const s of sockets) { try { s.destroy() } catch {} }
      upstream.close(() => r())
    }),
  }
}

/** 启动真实 ProxyServer（认证恒通过，仅测 WS 转发链路）。 */
async function startProxy(targetPort) {
  const proxy = new ProxyServer({
    localPort: 0,
    targetPort,
    authManager: { verifyRequest: () => ({ authenticated: true }) },
    logger: noopLogger,
    sseKeepalive: false,
  })
  await proxy.start()
  return { proxy, port: proxy.server.address().port }
}

/**
 * 发起原始 WS 升级握手；成功时返回 socket、状态行与握手后残留数据。
 * 注意：socket 的 'data' 监听在握手完成后移除，调用方可自行接管。
 */
function connectUpgrade(port, { timeoutMs = 3000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const socket = net.connect(port, '127.0.0.1', () => {
      socket.write([
        'GET /ws HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
      ].join('\r\n') + '\r\n\r\n')
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { socket.destroy() } catch {}
      reject(new Error('升级握手超时'))
    }, timeoutMs)
    let buf = ''
    const onData = (d) => {
      buf += d.toString('utf8')
      const idx = buf.indexOf('\r\n\r\n')
      if (idx === -1 || settled) return
      settled = true
      clearTimeout(timer)
      socket.off('data', onData)
      resolve({
        socket,
        statusLine: buf.slice(0, buf.indexOf('\r\n')),
        bufferedAfterHandshake: buf.slice(idx + 4),
      })
    }
    socket.on('data', onData)
    socket.on('error', () => {})   // 客户端错误由各用例自行观察，避免二次未捕获
    socket.once('close', () => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      reject(new Error('升级前连接被关闭'))
    })
  })
}

test('issue #81 回归：上游 RST 触发上游 socket error 不产生 uncaughtException，连接被清理', async () => {
  const crashes = []
  const onUncaught = (err) => crashes.push(err)
  process.on('uncaughtException', onUncaught)

  const upstream = await startUpstream({ rstDelayMs: 80 })
  const { proxy, port } = await startProxy(upstream.port)
  let client

  try {
    const handshake = await connectUpgrade(port)
    client = handshake.socket
    assert.equal(handshake.statusLine, 'HTTP/1.1 101 Switching Protocols', '代理应把上游 101 转发给客户端')

    let clientClosed = false
    client.on('close', () => { clientClosed = true })
    // 客户端在上游断开后仍持续写入，制造「写向已重置的上游 socket」窗口
    const writer = setInterval(() => {
      try { client.write('x'.repeat(4096)) } catch {}
    }, 20)
    try {
      await waitFor(() => clientClosed, 3000, '客户端 socket 应被 teardown 关闭')
      // 给可能迟到的 uncaughtException 留出观察窗口
      await delay(200)
      const details = crashes.map((e) => `${e?.code ?? e?.name ?? 'unknown'}: ${e?.message ?? e}`).join('; ')
      assert.equal(crashes.length, 0, `不应产生未捕获异常（实际：${details}）`)
      assert.equal(clientClosed, true, '客户端 socket 应已关闭')
      await waitFor(() => proxy.clientSockets.size === 0, 2000, '代理应清理已断开连接的记录')
    } finally {
      clearInterval(writer)
    }
  } finally {
    try { client?.destroy() } catch {}
    await proxy.stop()
    await upstream.close()
    await delay(100)   // 排空收尾阶段可能迟到的 socket 事件
    process.off('uncaughtException', onUncaught)
  }
})

test('正常上游：101 握手与双向数据转发不受 error 监听影响', async () => {
  const upstream = await startUpstream({ rstDelayMs: null, echo: true })
  const { proxy, port } = await startProxy(upstream.port)
  let client
  try {
    const handshake = await connectUpgrade(port)
    client = handshake.socket
    assert.equal(handshake.statusLine, 'HTTP/1.1 101 Switching Protocols')

    const received = []
    client.on('data', (d) => received.push(d.toString('utf8')))
    client.write('ping-42')
    await waitFor(() => received.join('').includes('ping-42'), 3000, '上游回显的数据应经代理回传给客户端')
  } finally {
    try { client?.destroy() } catch {}
    await proxy.stop()
    await upstream.close()
  }
})
