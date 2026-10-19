// issue #76：桌面窗口（dsh-app://app）取 adminToken 被 CORS 拒 → 管理类操作静默失败。
//
// 修复分两层，本用例锁住"接线与安全边界"，HTTP/WS 行为另见 test/security-hardening.test.mjs：
//   ① 白名单显式放行**字面量** dsh-app://app（浏览器生成、网页无法伪造），
//      同时绝不因它放松 opaque origin（"null"）防线（#62）；
//   ② 客户端在本机却拿不到管理令牌时，给出明确出路提示（改用电脑浏览器打开控制台），
//      不再让管理类操作"点了没反应"。
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DESKTOP_APP_ORIGIN, toHttpOrigin } from '../lib/index.js'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const libSource = readFileSync(resolve(repoRoot, 'lib/index.js'), 'utf8')
const clientSource = readFileSync(resolve(repoRoot, 'client/index.js'), 'utf8')

test('[#76] 桌面来源是固定字面量，且不得走 http(s) 收敛路径（opaque 防线不被放松）', () => {
  assert.equal(DESKTOP_APP_ORIGIN, 'dsh-app://app')
  // 关键：该来源的 URL.origin 是 "null"（opaque），所以**不能**交给 toHttpOrigin，
  // 只能以字面量放进白名单；toHttpOrigin 必须继续丢弃它。
  assert.equal(new URL(DESKTOP_APP_ORIGIN).origin, 'null')
  assert.equal(toHttpOrigin(DESKTOP_APP_ORIGIN), undefined)
  assert.equal(toHttpOrigin('null'), undefined)
})

test('[#76] BridgeService 白名单含桌面来源字面量，且不含 "null"', () => {
  assert.ok(libSource.includes('DESKTOP_APP_ORIGIN,'), 'allowedOrigins() 必须显式加入桌面来源字面量')
  // opaque origin 的消费侧防线仍在（loopback-token 与 WS 升级两处）
  assert.ok(libSource.includes("origin !== OPAQUE_ORIGIN"), 'loopback-token 消费侧仍须跳过 opaque origin')
  assert.ok(libSource.includes("origin === OPAQUE_ORIGIN || !allowed.includes(origin)"), 'WS 升级侧仍须拒绝 opaque origin')
})

test('[#76] 客户端：本机拿不到 adminToken 时必须给明确出路，不得静默', () => {
  assert.match(clientSource, /if \(!token\) setTokenHint\(true\)/, '取令牌失败要置位提示状态')
  // 反向：只在本机且取令牌失败时置位（成功时应清除；渲染必须带 tokenHint 门控，否则所有用户常显）
  assert.match(clientSource, /else setTokenHint\(false\)/, '后续拿到令牌应自动收起提示')
  assert.match(clientSource, /tokenHint && h\('div', \{/, '提示横幅必须受 tokenHint 门控（不得对所有人常显）')
  assert.ok(clientSource.includes('本机访问未能自动获取管理令牌'), '应渲染可读的跨源失败提示（中性措辞）')
  assert.ok(clientSource.includes('打开控制台 ↗'), '应提供在浏览器打开控制台的入口')
  assert.match(clientSource, /http:\/\/127\.0\.0\.1:\$\{status\?\.proxy\?\.port \|\| 3082\}/, '提示里的控制台地址要带真实代理端口')
})
