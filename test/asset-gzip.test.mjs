// 回归测试：静态大资源按需 gzip（手机 WebView 被 ~16MB 未压缩插件包拖死 → Failed to load plugins）
import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { createGzip, gunzipSync } from 'node:zlib'
import { acceptsGzip, shouldGzipProxyResponse } from '../lib/asset-compression.js'
import { ProxyServer } from '../lib/index.js'
import { AuthManager } from '../lib/auth/manager.js'
import { makeSessionsFile } from './helpers.mjs'

function doRequest(options) {
  return new Promise((resolve, reject) => {
    const req = httpRequest(options, (res) => {
      const chunks = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks)
        resolve({ statusCode: res.statusCode, headers: res.headers, raw, body: raw.toString('utf8') })
      })
    })
    req.on('error', reject)
    req.end()
  })
}

const JS = { 'content-type': 'text/javascript; charset=utf-8', 'transfer-encoding': 'chunked' }

test('acceptsGzip 识别 gzip，忽略 br/identity/缺失', () => {
  assert.equal(acceptsGzip({ 'accept-encoding': 'gzip, deflate, br' }), true)
  assert.equal(acceptsGzip({ 'accept-encoding': 'GZIP' }), true)
  assert.equal(acceptsGzip({ 'accept-encoding': 'br' }), false)
  assert.equal(acceptsGzip({}), false)
  assert.equal(acceptsGzip(undefined), false)
})

test('插件组合包 / assets 会被 gzip（含 ProxyServer 归一化后的 /plugins）', () => {
  // ProxyServer 归一化：/plugins/??... -> '/plugins'
  assert.equal(shouldGzipProxyResponse({ clientAcceptsGzip: true, pathname: '/plugins', statusCode: 200, headers: JS }), true)
  assert.equal(shouldGzipProxyResponse({ clientAcceptsGzip: true, pathname: '/plugins/', statusCode: 200, headers: JS }), true)
  assert.equal(shouldGzipProxyResponse({ clientAcceptsGzip: true, pathname: '/assets/index-5SrrfWpU.js', statusCode: 200, headers: JS }), true)
  assert.equal(shouldGzipProxyResponse({ clientAcceptsGzip: true, pathname: '/assets/index-BPHePDI_.css', statusCode: 200, headers: { 'content-type': 'text/css' } }), true)
  assert.equal(shouldGzipProxyResponse({ clientAcceptsGzip: true, pathname: '/__dsh_bridge__/pwa-icon.svg', statusCode: 200, headers: { 'content-type': 'image/svg+xml' } }), true)
  assert.equal(shouldGzipProxyResponse({ clientAcceptsGzip: true, pathname: '/plugins-other', statusCode: 200, headers: JS }), false)
})

test('HTML / SSE / 非静态路径 / 非 200 / 已压缩 都不压', () => {
  assert.equal(shouldGzipProxyResponse({ clientAcceptsGzip: true, pathname: '/', statusCode: 200, headers: { 'content-type': 'text/html; charset=utf-8' } }), false)
  assert.equal(shouldGzipProxyResponse({ clientAcceptsGzip: true, pathname: '/plugins/events', statusCode: 200, headers: { 'content-type': 'text/event-stream' } }), false)
  assert.equal(shouldGzipProxyResponse({ clientAcceptsGzip: true, pathname: '/api/session.list', statusCode: 200, headers: { 'content-type': 'application/json' } }), false)
  assert.equal(shouldGzipProxyResponse({ clientAcceptsGzip: true, pathname: '/plugins/??x/client.js&rev=1', statusCode: 304, headers: JS }), false)
  assert.equal(shouldGzipProxyResponse({ clientAcceptsGzip: true, pathname: '/plugins/??x/client.js&rev=1', statusCode: 200, headers: { ...JS, 'content-encoding': 'gzip' } }), false)
  assert.equal(shouldGzipProxyResponse({ clientAcceptsGzip: false, pathname: '/plugins/??x/client.js&rev=1', statusCode: 200, headers: JS }), false)
})

test('gzip 管道可还原', async () => {
  const raw = Buffer.alloc(2 * 1024 * 1024)
  for (let i = 0; i < raw.length; i++) raw[i] = (i * 31 + (i >> 8)) & 0xff
  const out = await new Promise((resolve, reject) => {
    const chunks = []
    const z = createGzip()
    z.on('data', (c) => chunks.push(c))
    z.on('end', () => resolve(Buffer.concat(chunks)))
    z.on('error', reject)
    z.end(raw)
  })
  assert.ok(out.length < raw.length)
  assert.ok(gunzipSync(out).equals(raw))
})
test('集成：真实 ProxyServer 压缩 plugins/assets，HTML 仍注入且不压缩', async () => {
  const bigJs = '/* dsh plugin bundle */\n' + 'export const x = 1;\n'.repeat(30000)
  const backend = createServer((req, res) => {
    if (req.url.startsWith('/plugins/') || req.url.startsWith('/assets/')) {
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8' })
      res.end(bigJs)
      return
    }
    if (req.url.startsWith('/api/')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true}')
      return
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><head></head><body>hi</body></html>')
  })
  await new Promise((r) => backend.listen(0, '127.0.0.1', r))
  const backendPort = backend.address().port
  const authManager = new AuthManager({ sessionsFile: makeSessionsFile(), config: { enabled: false } })
  const proxy = new ProxyServer({ localPort: 0, targetPort: backendPort, authManager, logger: { info() {}, warn() {}, error() {} } })
  await proxy.start()
  const proxyPort = proxy.server.address().port
  try {
    const gz = await doRequest({ host: '127.0.0.1', port: proxyPort, path: '/plugins/??a/client.js,b/client.js&rev=abc', method: 'GET', headers: { 'Accept-Encoding': 'gzip' } })
    assert.equal(gz.statusCode, 200)
    assert.equal(gz.headers['content-encoding'], 'gzip')
    assert.ok(gz.raw.length < Buffer.byteLength(bigJs), 'gzip 后应更小')
    assert.equal(gunzipSync(gz.raw).toString('utf8'), bigJs)

    const id = await doRequest({ host: '127.0.0.1', port: proxyPort, path: '/plugins/??a/client.js&rev=abc', method: 'GET', headers: {} })
    assert.equal(id.headers['content-encoding'], undefined)
    assert.equal(id.body, bigJs)

    const html = await doRequest({ host: '127.0.0.1', port: proxyPort, path: '/', method: 'GET', headers: { 'Accept-Encoding': 'gzip' } })
    assert.equal(html.headers['content-encoding'], undefined, 'HTML 不应压缩（注入链路）')
    assert.ok(html.body.includes('data-dsh-bridge-polyfill'), 'HTML 仍应注入 polyfill')

    const api = await doRequest({ host: '127.0.0.1', port: proxyPort, path: '/api/x', method: 'GET', headers: { 'Accept-Encoding': 'gzip' } })
    assert.equal(api.headers['content-encoding'], undefined)

    const asset = await doRequest({ host: '127.0.0.1', port: proxyPort, path: '/assets/index-abc.js', method: 'GET', headers: { 'Accept-Encoding': 'gzip' } })
    assert.equal(asset.headers['content-encoding'], 'gzip')
  } finally {
    await proxy.stop()
    // 代理到后端的 keep-alive 连接会让 close() 挂住，先强制断开
    backend.closeAllConnections?.()
    await new Promise((r) => backend.close(r))
  }
})
