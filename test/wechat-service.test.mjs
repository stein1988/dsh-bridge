// dsh-bridge WechatService construction smoke test
// Verifies the gateway (Service subclass) + conversation node construct and
// register 'wechat' on a mock Cordis context without throwing.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WechatService } from '../lib/wechat/index.js'
import { WechatGateway } from '../lib/wechat/gateway.js'
import { PlatformManager } from '../lib/platform/manager.js'

function makeMockCordisCtx() {
  const events = {}
  const ctx = {
    on(event, fn) { (events[event] ??= []).push(fn); return () => { events[event] = (events[event] ?? []).filter(f => f !== fn) } },
    emit(event, ...args) { (events[event] ?? []).forEach((fn) => fn(...args)) },
    effect(fn) { return fn() },
    logger: { info() {}, warn() {}, error() {} },
    // Services that DSH provides to plugins
    sessions: { list: () => [], get: () => undefined },
    agents: { create: async () => ({}), get: () => undefined },
    // Cordis reflection surface needed by Service base
    reflect: { provide(name, value) { ctx['__provided__' + name] = value; return () => {} } },
  }
  return ctx
}

test('WechatGateway is a Service and registers as ctx.wechat', () => {
  const ctx = makeMockCordisCtx()
  const gw = new WechatGateway({ ctx, logger: ctx.logger, config: {} })
  try {
    assert.equal(gw.name, 'wechat')
    assert.equal(gw.status, 'idle')
    assert.equal(gw.configured, false)
    assert.ok(ctx.__provided__wechat === gw, 'gateway registered as ctx.wechat')
  } finally {
    gw.dispose()
  }
})

test('WechatService constructs gateway + node and wires allowlist', async () => {
  const ctx = makeMockCordisCtx()
  const persisted = {}
  const svc = new WechatService({
    ctx,
    logger: ctx.logger,
    config: { allowFrom: ['u1@im.wechat'] },
    onPersist: async (patch) => Object.assign(persisted, patch),
  })
  assert.equal(svc.gateway.configured, false) // no credentials yet
  assert.deepEqual(svc.node.config.allowFrom, ['u1@im.wechat'])
  // not configured → no polling started
  assert.equal(svc.gateway.status, 'idle')
  await svc.destroy()
})

test('WechatService setAllowFrom persists and updates node', async () => {
  const ctx = makeMockCordisCtx()
  const persisted = {}
  const svc = new WechatService({
    ctx,
    logger: ctx.logger,
    config: {},
    onPersist: async (patch) => Object.assign(persisted, patch),
  })
  await svc.setAllowFrom(['a', ' a ', 'b', '', 'a'])
  assert.deepEqual(svc.node.config.allowFrom, ['a', 'b'])
  assert.deepEqual(persisted.allowFrom, ['a', 'b'])
  await svc.destroy()
})

test('WechatService getStatus includes login state', async () => {
  const ctx = makeMockCordisCtx()
  const svc = new WechatService({ ctx, logger: ctx.logger, config: {}, onPersist: async () => {} })
  const s = svc.getStatus()
  assert.equal(typeof s.status, 'string')
  assert.ok('login' in s)
  assert.ok(Array.isArray(s.allowFrom))
  await svc.destroy()
})

test('WechatService is a Platform instance with id/name/capabilities', async () => {
  const ctx = makeMockCordisCtx()
  const svc = new WechatService({ ctx, logger: ctx.logger, config: {}, onPersist: async () => {} })
  assert.equal(svc.id, 'wechat')
  assert.equal(svc.name, '微信')
  assert.equal(svc.configured, false)
  assert.ok(svc.capabilities.maxMessageChars > 0)
  assert.equal(svc.capabilities.supportsTyping, true)
  const s = svc.getStatus()
  assert.equal(s.id, 'wechat')
  assert.ok(s.capabilities)
  await svc.destroy()
})

test('WechatService registers into PlatformManager and aggregates status', async () => {
  const ctx = makeMockCordisCtx()
  const svc = new WechatService({ ctx, logger: ctx.logger, config: {}, onPersist: async () => {} })
  const manager = new PlatformManager({ logger: ctx.logger })
  try {
    manager.register(svc)
    assert.equal(manager.get('wechat'), svc)
    const status = manager.getStatus()
    assert.ok('wechat' in status)
    assert.equal(status.wechat.id, 'wechat')
    assert.equal(status.wechat.name, '微信')
  } finally {
    await svc.destroy()
    manager.dispose()
  }
})

test('issue #78: WechatService 支持 instanceId / displayName 与备注名回显持久化', async () => {
  const ctx = makeMockCordisCtx()
  const persisted = []
  const svc = new WechatService({
    ctx,
    logger: ctx.logger,
    config: { name: '老备注' },
    instanceId: 'wechat:2',
    onPersist: async (patch) => { persisted.push(patch) },
  })
  try {
    svc.displayName = 'wechat 2'
    const status = svc.getStatus()
    assert.equal(status.instanceId, 'wechat:2')
    assert.equal(status.platformId, 'wechat')
    assert.equal(status.displayName, 'wechat 2')
    assert.equal(status.config.name, '老备注', '备注名必须可回显')

    await svc.setConfig({ name: '  新备注  ' })
    assert.equal(svc.getStatus().config.name, '新备注', '备注名应 trim 后回显')
    assert.equal(persisted.at(-1).name, '新备注', '备注名应随 setConfig 持久化到该 account')
  } finally {
    await svc.destroy?.()
  }
})
