// Connection RPC 传输层单测
//
// 回归背景：DSH 0.1.5-rc.1 起，宿主 @deepseek-ai/dsh-client-connection 的
// `connection.rpc.handle()` 会把通道注册挂在「提供方（连接插件）自己的 ctx」上，
// 而该 ctx 没有 inject webServer → 抛 `cannot get property "webServer" without inject`
// → 整个插件加载失败。详见 docs/dsh-upgrade-adaptation.md §3.1。
//
// 修复后 dsh-bridge 改为用自己的 ctx 直连 ctx.webServer.register() 注册
// `BRIDGE_RPC_CHANNEL` 前缀路由，并在 createRpcRouteHandler 里自行实现
// Connection 的 RPC 信封协议。本文件把这层协议的形状与错误分支钉死。
//
// 注意：这些用例是纯单测（不起真实实例），因此**不能**替代真实宿主上的启动验证；
// 它们只保证信封形状与分支判定不被无意改坏。

import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { EventEmitter } from 'node:events';

import {
  createRpcRouteHandler,
  isRpcRequestEnvelope,
  writeJson,
  BRIDGE_RPC_CHANNEL,
} from '../lib/bridge-rpc.js';

const CHANNEL = BRIDGE_RPC_CHANNEL; // '/dsh-bridge'

/** 造一个最小的 IncomingMessage 替身（可读流 + headers + method + url）。 */
function makeReq({ method = 'POST', url = `${CHANNEL}/getStatus`, headers = { 'content-type': 'application/json' }, body = '' } = {}) {
  const stream = Readable.from([Buffer.from(body, 'utf8')]);
  stream.method = method;
  stream.url = url;
  stream.headers = headers;
  return stream;
}

/** 造一个最小的 ServerResponse 替身，记录 writeHead/end 结果。 */
function makeRes() {
  const res = new EventEmitter();
  res.statusCode = undefined;
  res.headers = undefined;
  res.writableEnded = false;
  res.chunks = [];
  res.writeHead = (status, headers) => {
    res.statusCode = status;
    res.headers = headers;
  };
  res.end = (chunk) => {
    if (chunk !== undefined) res.chunks.push(Buffer.from(String(chunk)));
    res.writableEnded = true;
  };
  res.raw = () => Buffer.concat(res.chunks).toString('utf8');
  res.json = () => JSON.parse(res.raw());
  return res;
}

/** 发一次请求，返回 { status, headers, body, raw }。 */
async function invoke(handler, { body, ...reqInit } = {}) {
  const res = makeRes();
  await handler(makeReq({ body: body === undefined ? undefined : JSON.stringify(body), ...reqInit }), res);
  return { status: res.statusCode, headers: res.headers, body: res.json(), raw: res.raw() };
}

/** 标准请求信封。 */
function envelope(overrides = {}) {
  return { type: 'client-request', rpcId: 'rpc-1', method: 'getStatus', payload: {}, ...overrides };
}

test('isRpcRequestEnvelope 只接受合法 client-request 信封', () => {
  assert.equal(isRpcRequestEnvelope(envelope()), true);
  assert.equal(isRpcRequestEnvelope(envelope({ payload: null })), true, 'payload 为 null 也合法（字段存在即可）');

  assert.equal(isRpcRequestEnvelope(undefined), false);
  assert.equal(isRpcRequestEnvelope(null), false);
  assert.equal(isRpcRequestEnvelope('nope'), false);
  assert.equal(isRpcRequestEnvelope({}), false);
  assert.equal(isRpcRequestEnvelope(envelope({ type: 'server-response' })), false, '方向错误');
  assert.equal(isRpcRequestEnvelope(envelope({ rpcId: 1 })), false, 'rpcId 必须是字符串');
  assert.equal(isRpcRequestEnvelope(envelope({ method: undefined })), false);
  assert.equal(isRpcRequestEnvelope({ type: 'client-request', rpcId: 'a', method: 'm' }), false, '缺 payload 字段');
});

test('合法请求：解开信封、透传 method/payload，并包成 server-response', async () => {
  const seen = [];
  const handler = createRpcRouteHandler(CHANNEL, async (endpoint, payload, signal) => {
    seen.push({ endpoint, payload, hasSignal: signal instanceof AbortSignal });
    return { ok: true, value: { echoed: payload } };
  });

  const res = await invoke(handler, { body: envelope({ payload: { hello: 'world' } }) });

  assert.equal(res.status, 200);
  assert.deepEqual(seen, [{ endpoint: 'getStatus', payload: { hello: 'world' }, hasSignal: true }]);

  // 必须是宿主约定的信封形状：type + rpcId + result
  assert.equal(res.body.type, 'server-response');
  assert.equal(res.body.rpcId, 'rpc-1');
  assert.deepEqual(res.body.result, { ok: true, value: { echoed: { hello: 'world' } } });
  assert.match(res.headers['Content-Type'], /application\/json/);
});

test('envelope 的 rpcId 原样回传（客户端据此配对响应）', async () => {
  const handler = createRpcRouteHandler(CHANNEL, async () => ({ ok: true }));
  const res = await invoke(handler, { body: envelope({ rpcId: 'abc-123-xyz' }) });
  assert.equal(res.body.rpcId, 'abc-123-xyz');
});

test('handler 收到的 endpoint 来自路径尾部，可与 method 不同名', async () => {
  const seen = [];
  const handler = createRpcRouteHandler(CHANNEL, async (endpoint) => { seen.push(endpoint); return { ok: true }; });

  await invoke(handler, { url: `${CHANNEL}/platformStart`, body: envelope({ method: 'platformStart' }) });
  await invoke(handler, { url: `${CHANNEL}/listWorkspaces`, body: envelope({ method: 'listWorkspaces' }) });

  assert.deepEqual(seen, ['platformStart', 'listWorkspaces']);
});

test('method 与路径端点不一致 → gateway/bad-request（与宿主行为对齐）', async () => {
  let called = false;
  const handler = createRpcRouteHandler(CHANNEL, async () => { called = true; return { ok: true }; });

  const res = await invoke(handler, { url: `${CHANNEL}/getStatus`, body: envelope({ method: 'stopCloudflared' }) });

  assert.equal(res.status, 200, '与宿主一致：信封合法但 method 不匹配时仍是 200');
  assert.equal(res.body.type, 'server-response');
  assert.equal(res.body.rpcId, 'rpc-1');
  assert.equal(res.body.result.ok, false);
  assert.equal(res.body.result.error.code, 'gateway/bad-request');
  assert.match(res.body.result.error.message, /does not match endpoint/);
  assert.equal(called, false, '不允许把请求转发给 handler');
});

test('非 POST → 405', async () => {
  const handler = createRpcRouteHandler(CHANNEL, async () => ({ ok: true }));
  for (const method of ['GET', 'PUT', 'DELETE']) {
    const res = await invoke(handler, { method, body: envelope() });
    assert.equal(res.status, 405, `${method} 应为 405`);
  }
});

test('content-type 非 application/json → 415（允许带 charset）', async () => {
  const handler = createRpcRouteHandler(CHANNEL, async () => ({ ok: true }));

  const bad = await invoke(handler, { headers: { 'content-type': 'text/plain' }, body: envelope() });
  assert.equal(bad.status, 415);

  const noHeader = await invoke(handler, { headers: {}, body: envelope() });
  assert.equal(noHeader.status, 415);

  const withCharset = await invoke(handler, {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: envelope(),
  });
  assert.equal(withCharset.status, 200, '带 charset 参数应被接受');
});

test('请求体不是 JSON → 400', async () => {
  const handler = createRpcRouteHandler(CHANNEL, async () => ({ ok: true }));
  const res = await invoke(handler, { body: undefined, headers: { 'content-type': 'application/json' } });
  assert.equal(res.status, 400);
});

test('信封结构不合法 → 400 + gateway/bad-request，并保留可用 rpcId', async () => {
  const handler = createRpcRouteHandler(CHANNEL, async () => ({ ok: true }));

  const res = await invoke(handler, { body: { type: 'client-request', rpcId: 'keep-me', method: 'getStatus' } });
  assert.equal(res.status, 400);
  assert.equal(res.body.rpcId, 'keep-me');
  assert.equal(res.body.result.error.code, 'gateway/bad-request');

  const noId = await invoke(handler, { body: { nope: true } });
  assert.equal(noId.body.rpcId, 'invalid-request', '无可用 rpcId 时回退 invalid-request');
});

test('路径不在通道前缀内 → 404', async () => {
  const handler = createRpcRouteHandler(CHANNEL, async () => ({ ok: true }));

  assert.equal((await invoke(handler, { url: CHANNEL, body: envelope() })).status, 404, '裸前缀（无端点）');
  assert.equal((await invoke(handler, { url: '/other/getStatus', body: envelope() })).status, 404, '其他前缀');
  assert.equal((await invoke(handler, { url: `${CHANNEL}/`, body: envelope() })).status, 404, '空端点');
});

test('路径穿越不会逃出通道前缀（URL 归一化后仍在通道内）', async () => {
  const seen = [];
  const handler = createRpcRouteHandler(CHANNEL, async (endpoint) => { seen.push(endpoint); return { ok: true }; });

  // new URL() 会把 a/../b 归一化成 b，因此请求不会跑到通道外；
  // 若 method 与归一化后的端点不符，仍会被 gateway/bad-request 挡掉。
  const res = await invoke(handler, { url: `${CHANNEL}/a/../getStatus`, body: envelope() });
  assert.equal(res.status, 200);
  assert.deepEqual(seen, ['getStatus'], '归一化后端点正确落在通道内，未逃逸');
});

test('handler 抛错 → 500 纯文本（与宿主一致，不吞异常）', async () => {
  const handler = createRpcRouteHandler(CHANNEL, async () => { throw new Error('boom'); });
  const res = makeRes();
  await handler(makeReq({ body: JSON.stringify(envelope()) }), res);
  assert.equal(res.statusCode, 500);
  assert.match(res.raw(), /handler failure: Error: boom/);
});

test('handler 已在响应中结束连接时不再重复写（防 ERR_STREAM_WRITE_AFTER_END）', async () => {
  const handler = createRpcRouteHandler(CHANNEL, async () => ({ ok: true }));
  const res = makeRes();
  res.writableEnded = true; // 模拟已被上层接管
  await handler(makeReq({ body: JSON.stringify(envelope()) }), res);
  assert.equal(res.statusCode, undefined, '不应再写响应头');
});

test('writeJson 写出 JSON + Content-Length + no-store', () => {
  const res = makeRes();
  writeJson(res, 201, { a: 1 });
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.equal(res.headers['Cache-Control'], 'no-store');
  assert.equal(Number(res.headers['Content-Length']), Buffer.byteLength('{"a":1}'));
  assert.equal(res.raw(), '{"a":1}');
});

test('请求体超过上限 → 400（不会无界读入内存）', async () => {
  const handler = createRpcRouteHandler(CHANNEL, async () => ({ ok: true }));
  const huge = JSON.stringify({
    type: 'client-request',
    rpcId: 'r',
    method: 'getStatus',
    payload: { big: 'x'.repeat(9 * 1024 * 1024) }, // 9MiB > 8MiB 上限
  });

  const req = Readable.from([Buffer.from(huge, 'utf8')]);
  req.method = 'POST';
  req.url = `${CHANNEL}/getStatus`;
  req.headers = { 'content-type': 'application/json' };

  const res = makeRes();
  await handler(req, res);

  assert.equal(res.statusCode, 400);
  assert.match(res.raw(), /body is not JSON/);
});
