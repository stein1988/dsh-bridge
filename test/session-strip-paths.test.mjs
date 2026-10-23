// issue #82 回归：session 投影剥离的路径判定必须覆盖 DSH 真实斜杠 RPC 路径
// （/api/session/list 为当前活端点）与旧点号路径，且不误伤其他端点。
//
// 覆盖面（一次跑全）：
//   1. lib/session-strip.js 函数层：isSessionProjectionPath 谓词 + stripSessionProjections
//   2. CustomTunnelClient（自建隧道入口）真实转发路径
//   3. ProxyServer（局域网 / Cloudflare 隧道 / 外部隧道登记入口）反向代理路径
//
// 关于 session/history：DSH 0.2.1-rc.2 的 20 个 session 端点里没有 history
// （历史读取走 session/page），该路径属**兼容面**而非活端点——测试保留它只为锁住
// 「谓词不因清理而收窄」，不代表当前 DSH 会发该请求。
import test from 'node:test';
import assert from 'node:assert/strict';
import { gzipSync } from 'node:zlib';
import { createServer, request as httpRequest } from 'node:http';
import { stripSessionProjections, isSessionProjectionPath } from '../lib/session-strip.js';
import { ProxyServer } from '../lib/index.js';
import { AuthManager } from '../lib/auth/manager.js';
import { makeSessionsFile } from './helpers.mjs';

const LIST_BODY = Buffer.from(JSON.stringify({
  result: {
    ok: true,
    value: {
      items: [
        { id: 'a', projections: { values: { contextHeaders: 'x'.repeat(64), contextTimeline: 'y'.repeat(32), title: '保留' } } },
        { id: 'b', projections: { values: { contextHeaders: 'big' } } },
        { id: 'c' },
      ],
    },
  },
}));

const HISTORY_BODY = Buffer.from(JSON.stringify({
  result: { ok: true, value: { projections: { values: { contextHeaders: 'big', contextTimeline: 'tl', title: 'h' } } } },
}));

test('isSessionProjectionPath：斜杠（DSH 真实 RPC 路径）与点号（向后兼容）都命中', () => {
  // /api/session/list 是当前活端点；history 两种写法属兼容面（见文件头说明）
  for (const p of ['/api/session/list', '/api/session/history', '/api/session.list', '/api/session.history']) {
    assert.equal(isSessionProjectionPath(p), true, `${p} 应判定为投影端点`);
  }
});

test('isSessionProjectionPath：带 query 判定，剥离 query 后仍命中', () => {
  assert.equal(isSessionProjectionPath('/api/session/list?limit=10'), true);
  assert.equal(isSessionProjectionPath('/api/session/history?sessionId=s1&cursor=abc'), true);
  assert.equal(isSessionProjectionPath('/api/session.list?cursor=z'), true);
  assert.equal(isSessionProjectionPath('/api/session/history/?sessionId=s1'), false, '尾斜杠不是精确端点');
});

test('isSessionProjectionPath：非投影路径不误伤', () => {
  for (const p of [
    '/api/session/prompt',
    '/api/session/page',
    '/api/session/projections',
    '/api/session/create',
    '/api/session/listAll',
    '/api/other',
    '/api/session',
    '/',
    '',
    undefined,
    null,
    '/api/session/listfoo',
  ]) {
    assert.equal(isSessionProjectionPath(p), false, `${String(p)} 不应判定为投影端点`);
  }
});

test('stripSessionProjections：斜杠 session/list 剥离（issue #82 主回归，活端点）', () => {
  const r = stripSessionProjections('/api/session/list', LIST_BODY);
  assert.equal(r.stripped, true);
  assert.notEqual(r.body, LIST_BODY, '剥离后应返回新 Buffer');
  const j = JSON.parse(r.body.toString());
  assert.equal(j.result.value.items[0].projections.values.contextHeaders, undefined);
  assert.equal(j.result.value.items[0].projections.values.contextTimeline, undefined);
  assert.equal(j.result.value.items[0].projections.values.title, '保留', '不应误删其他字段');
  assert.equal(j.result.value.items[1].projections.values.contextHeaders, undefined);
});

test('stripSessionProjections：斜杠 session/history 属兼容面仍在（DSH 0.2.1-rc.2 无此端点，非活路径回归）', () => {
  // 锁定「兼容面不因清理而收窄」：即使 history 已不在 DSH 当前版本，
  // 谓词与剥离逻辑仍按 projections.values 结构工作（旧版本/外部网关可能仍转发）。
  const r = stripSessionProjections('/api/session/history', HISTORY_BODY);
  assert.equal(r.stripped, true);
  const j = JSON.parse(r.body.toString());
  assert.equal(j.result.value.projections.values.contextHeaders, undefined);
  assert.equal(j.result.value.projections.values.contextTimeline, undefined);
  assert.equal(j.result.value.projections.values.title, 'h');
});

test('stripSessionProjections：斜杠路径 + gzip 编码仍能剥离（DSH 默认 gzip）', () => {
  for (const p of ['/api/session/list', '/api/session/history']) {
    const raw = p === '/api/session/list' ? LIST_BODY : HISTORY_BODY;
    const gz = gzipSync(raw);
    const r = stripSessionProjections(p, gz, 'gzip');
    assert.equal(r.stripped, true, `${p} gzip 响应应剥离`);
    const j = JSON.parse(r.body.toString());
    const values = p === '/api/session/list'
      ? j.result.value.items[0].projections.values
      : j.result.value.projections.values;
    assert.equal(values.contextHeaders, undefined);
    assert.equal(values.contextTimeline, undefined);
  }
});

test('stripSessionProjections：带 query 的斜杠路径同样生效', () => {
  const r = stripSessionProjections('/api/session/list?limit=10', LIST_BODY);
  assert.equal(r.stripped, true);
});

test('stripSessionProjections：点号旧路径向后兼容（不回归）', () => {
  const r1 = stripSessionProjections('/api/session.list', LIST_BODY);
  assert.equal(r1.stripped, true, '点号 session.list 仍需剥离');
  const r2 = stripSessionProjections('/api/session.history', HISTORY_BODY);
  assert.equal(r2.stripped, true, '点号 session.history 仍需剥离');
  const gz = gzipSync(LIST_BODY);
  assert.equal(stripSessionProjections('/api/session.list', gz, 'gzip').stripped, true);
});

test('stripSessionProjections：非投影路径不误伤（原样返回同一 Buffer）', () => {
  for (const p of ['/api/session/prompt', '/api/session/page', '/api/other', '/api/session/projections']) {
    const r = stripSessionProjections(p, LIST_BODY);
    assert.equal(r.stripped, false, `${p} 不应剥离`);
    assert.equal(r.body, LIST_BODY, `${p} 应原样返回`);
  }
});

test('CustomTunnelClient：真实斜杠路径 /api/session/list 端到端剥离（issue #82 隧道入口）', async () => {
  const { CustomTunnelClient } = await import('../lib/tunnel-client.mjs');

  const payload = {
    result: {
      ok: true,
      value: {
        items: [{ id: 's1', projections: { values: { title: '会话1', contextHeaders: 'x'.repeat(10000), contextTimeline: 'y'.repeat(1000) } } }],
      },
    },
  };
  const backend = createServer((req, res) => {
    if (req.url.startsWith('/api/session/list') || req.url.startsWith('/api/session/history')) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(payload));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((r) => backend.listen(0, '127.0.0.1', r));
  const backendPort = backend.address().port;

  const sent = [];
  const client = new CustomTunnelClient({
    serverUrl: 'wss://example.com',
    accessToken: 'test-token',
    localPort: backendPort,
    logger: { info: () => {}, error: () => {}, warn: () => {} },
  });
  client._sendMessage = (msg) => sent.push(msg);

  try {
    for (const p of ['/api/session/list?limit=10', '/api/session/history?sessionId=s1']) {
      sent.length = 0;
      client._handleHttpRequest({ requestId: `req-${p}`, method: 'GET', path: p, headers: {} });
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(sent.length, 1, `${p} 应返回一条响应`);
      const resp = sent[0];
      assert.equal(resp.statusCode, 200);
      const body = JSON.parse(Buffer.from(resp.body, 'base64').toString('utf8'));
      const proj = body.result.value.items[0].projections.values;
      assert.equal(proj.title, '会话1', '不应误删其他字段');
      assert.equal(proj.contextHeaders, undefined, `${p} 的 contextHeaders 应被剥离`);
      assert.equal(proj.contextTimeline, undefined, `${p} 的 contextTimeline 应被剥离`);
    }
  } finally {
    backend.close();
  }
});

test('ProxyServer：斜杠 /api/session/list 经局域网/CF/外部隧道入口也剥离（issue #82 第 2 处）', async () => {
  // 与 proxy-auth.test.mjs 的「gzip session.list」用例同构造，但走 DSH 真实斜杠路径
  // /api/session/list；覆盖 lib/index.js ProxyServer 入口（局域网 / Cloudflare 隧道 /
  // 外部隧道登记三处共用同一反向代理分支）。
  const payload = JSON.stringify({
    result: {
      ok: true,
      value: {
        items: [{ id: 'a', projections: { values: { contextHeaders: 'x'.repeat(64), contextTimeline: 'y'.repeat(16), title: 'keep-title' } } }],
      },
    },
  });
  const gz = gzipSync(Buffer.from(payload));

  const backend = createServer((req, res) => {
    if (req.url.startsWith('/api/session/list')) {
      // DSH 默认 gzip：同时验证压缩响应也进入剥离开关
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Content-Encoding': 'gzip',
        'Content-Length': gz.length,
      });
      res.end(gz);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => backend.listen(0, '127.0.0.1', resolve));
  const backendPort = backend.address().port;

  const authManager = new AuthManager({ sessionsFile: makeSessionsFile(), config: { enabled: false } });
  const proxy = new ProxyServer({
    localPort: 0,
    targetPort: backendPort,
    authManager,
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  });
  await proxy.start();
  const proxyPort = proxy.server.address().port;

  const doProxyRequest = (path) => new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port: proxyPort, path, method: 'GET', headers: { Accept: 'application/json' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        statusCode: res.statusCode,
        headers: res.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    req.on('error', reject);
    req.end();
  });

  try {
    // 1) 真实路径 + query：应剥离，且清除 gzip 标记
    const r1 = await doProxyRequest('/api/session/list?limit=10');
    assert.equal(r1.statusCode, 200);
    assert.equal(r1.headers['content-encoding'], undefined, '剥离后应清除 gzip 标记');
    const j1 = JSON.parse(r1.body);
    const v1 = j1.result.value.items[0].projections.values;
    assert.equal(v1.contextHeaders, undefined, 'contextHeaders 应被剥离');
    assert.equal(v1.contextTimeline, undefined, 'contextTimeline 应被剥离');
    assert.equal(v1.title, 'keep-title', '不应误删其他字段');

    // 2) 非投影路径不误伤：backend 对其它路径返回 404，ProxyServer 原样透传
    const r2 = await doProxyRequest('/api/session/page?sessionId=s1');
    assert.equal(r2.statusCode, 404, '非投影路径不得被拦截或改写');
    assert.equal(r2.body, '');
  } finally {
    await proxy.stop();
    authManager.dispose();
    await new Promise((resolve) => backend.close(resolve));
  }
});

test('stripSessionProjections：命中路径但解析失败/无投影时原样返回（不破坏响应）', () => {
  const bad = Buffer.from('not-json');
  for (const p of ['/api/session/list', '/api/session.list']) {
    const r = stripSessionProjections(p, bad);
    assert.equal(r.stripped, false);
    assert.equal(r.body, bad);
  }
  const noProj = Buffer.from(JSON.stringify({ result: { ok: true, value: { items: [{ id: 'c' }] } } }));
  assert.equal(stripSessionProjections('/api/session/list', noProj).stripped, false);
  // 非 Buffer 输入
  assert.equal(stripSessionProjections('/api/session/list', 'text').stripped, false);
});
