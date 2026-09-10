// DSH Bridge - RPC Interface (server side)
// Loopback-only RPC methods for browser UI

import QRCode from 'qrcode';
import { BRIDGE_RPC_CHANNEL, BRIDGE_ENDPOINTS } from './bridge-rpc-constants.js';
import { RateLimiter } from './security/rate-limiter.js';

export {
  BRIDGE_RPC_CHANNEL,
  BRIDGE_ENDPOINTS,
  // 以下为传输层内部构件，导出仅供单测直接校验信封协议（见 test/bridge-rpc-transport.test.mjs）
  createRpcRouteHandler,
  isRpcRequestEnvelope,
  writeJson,
};

const rpcRateLimiter = new RateLimiter({ maxRequests: 30, windowMs: 60000 });

function ok(value) {
  return { ok: true, value };
}

function fail(code, message, details = {}) {
  const allowedCodes = new Set([
    'bad-request', 'cancelled', 'internal', 'settings-rejected', 'command-error'
  ]);
  const safeCode = allowedCodes.has(code) ? code : 'bad-request';
  return {
    ok: false,
    error: {
      code: safeCode,
      message,
      details: { issues: [{ message }], ...details },
    },
  };
}

// 把登录态里的二维码载荷渲染成浏览器可展示的 dataURL（带缓存，避免重复生成）
async function renderQr(loginState) {
  if (!loginState?.qrPayload) return null;
  const cacheKey = `${loginState.qrKind}:${loginState.qrPayload.slice(0, 80)}`;
  if (renderQr.cache && renderQr.cache.key === cacheKey) return renderQr.cache.url;
  let url;
  const payload = loginState.qrPayload;
  if (loginState.qrKind === 'img') {
    url = /^data:/i.test(payload) ? payload : `data:image/png;base64,${payload}`;
  } else {
    try {
      url = await QRCode.toDataURL(payload, {
        width: 300, margin: 2, color: { dark: '#1F2421', light: '#FFFFFF' },
      });
    } catch { url = null; }
  }
  renderQr.cache = { key: cacheKey, url };
  return url;
}

function checkAdminAuth(authManager, payload, { requireConfigured = false } = {}) {
  if (!authManager) return null;
  // local_only 最严格：即使关闭管理保护，也绝不远程放行（本机经 loopback-token 天然持有 adminToken）
  // 注意：RPC 层无法区分本机/远程（代理以回环转发），local_only 的防线是 unlockAdmin 拒绝
  // 远程解锁——因此这里管理保护关闭时也不放行 local_only，保持"仅本机可管理"的语义。
  if (authManager.adminPolicy === 'local_only') {
    // local_only 下必须持有有效 adminToken（只有本机 loopback-token / 本机解锁能拿到）
    if (payload?.adminToken && authManager.validateAdminSession(payload.adminToken)) {
      return null;
    }
    return fail('bad-request', '操作已被拦截：当前策略为仅限电脑本机管理');
  }
  // 管理保护独立开关：用户明确关闭后，管理操作免 adminToken（与访问认证 enabled 解耦）
  if (authManager.adminProtection === false) return null;
  if (authManager.adminPolicy === 'open') return null;
  // 若系统尚未设置任何管理密码或访客密码，允许免密管理
  const hasAnyPassword = authManager.hasAdminPassword || authManager.hasPassword;
  // T2.9：高危操作（备份导出/导入、隧道配置与启动、目录浏览、添加工作区、升级、重启）
  // 在系统从未设置任何密码时不再静默放行，强制先完成一次密码设置，
  // 杜绝"未设密码 = 局域网/隧道内任何人都可导出全部凭证"的裸奔状态被直接利用
  if (requireConfigured && !hasAnyPassword) {
    return fail('bad-request', '该操作涉及敏感配置：请先在「安全认证」中设置访问密码或管理密码后再执行');
  }
  if (!hasAnyPassword) {
    return null;
  }
  // 已设置密码时，必须提供经服务端校验有效的 adminToken（绝不依赖客户端自称的 isLocalhost）
  if (payload?.adminToken && authManager.validateAdminSession(payload.adminToken)) {
    return null;
  }
  return fail('bad-request', '操作已被拦截：需要管理员权限，请先在控制台输入管理密码解锁');
}

// ---- Connection RPC 自注册传输层 ----------------------------------------
//
// 背景（DSH 0.1.5-rc.1 起）：宿主 @deepseek-ai/dsh-client-connection 的
// `connection.rpc.handle()` 把通道注册挂在**提供方（连接插件）自己的 ctx** 上：
//
//   get rpc() { const owner = this.ctx; return { handle: (c, h) => this.register(owner, c, h) }; }
//   register(owner, channel, handler) { return owner.effect(() => owner.webServer.register(route)); }
//
// 而连接插件的 inject 只有 ["credentials"]，webServer 只存在于它内部的子上下文，
// 于是 owner.webServer 必然抛 `cannot get property "webServer" without inject`，
// 导致整个插件的 apply 失败、加载不进组合树。用任何 ctx 包装（含
// ctx.inject(['webServer'], ...)）都无效，因为 owner 不是调用方。
//
// 因此这里改为：**由插件自己的 ctx 直连 webServer 注册同名前缀路由**，并自行
// 实现 Connection 的 RPC 信封协议（client-request / server-response）。
// 客户端无需改动：它仍然走 ctx.connection.rpc.call(channel, endpoint, payload)，
// 只关心信封，不关心宿主侧由谁注册。
// 旧版本宿主（connection.rpc.handle 可用）保留回退路径。

/** Connection RPC 请求信封（见宿主 dsh-client-connection 的 clientRequestSchema）。 */
function isRpcRequestEnvelope(body) {
  return Boolean(
    body
    && typeof body === 'object'
    && body.type === 'client-request'
    && typeof body.rpcId === 'string'
    && typeof body.method === 'string'
    && 'payload' in body
  );
}

/** 读取完整请求体（Node 原生路由拿到的是 IncomingMessage 流）。 */
function readRequestBody(req, limitBytes = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limitBytes) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('请求已中断')));
  });
}

/** 写回 JSON 响应（Node 原生路由形态）。 */
function writeJson(res, status, body) {
  if (res.writableEnded) return;
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

/**
 * 按宿主信封协议实现一个 Connection RPC 通道的 Node 原生路由处理器。
 * 与宿主 rpcFetchHandler 行为对齐：仅 POST、要求 application/json、
 * method 必须等于路径尾部端点名，响应统一包成 server-response 信封。
 */
function createRpcRouteHandler(channel, handler) {
  return async function bridgeRouteHandler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const pathname = url.pathname;
      if (!pathname.startsWith(`${channel}/`)) {
        writeJson(res, 404, { error: 'not found' });
        return;
      }
      const endpoint = pathname.slice(channel.length + 1);
      if (!endpoint || endpoint.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) {
        writeJson(res, 404, { error: 'not found' });
        return;
      }
      if (req.method !== 'POST') {
        writeJson(res, 405, { error: 'method not allowed' });
        return;
      }
      const contentType = String(req.headers?.['content-type'] ?? '').split(';', 1)[0].trim().toLowerCase();
      if (contentType !== 'application/json') {
        writeJson(res, 415, { error: 'content type must be application/json' });
        return;
      }

      let body;
      try {
        body = JSON.parse(await readRequestBody(req));
      } catch (err) {
        writeJson(res, 400, { error: `body is not JSON: ${err.message}` });
        return;
      }
      if (!isRpcRequestEnvelope(body)) {
        writeJson(res, 400, {
          type: 'server-response',
          rpcId: typeof body?.rpcId === 'string' ? body.rpcId : 'invalid-request',
          result: { ok: false, error: { code: 'gateway/bad-request', message: 'invalid client-request message', details: { issues: [] } } },
        });
        return;
      }
      if (body.method !== endpoint) {
        writeJson(res, 200, {
          type: 'server-response',
          rpcId: body.rpcId,
          result: {
            ok: false,
            error: {
              code: 'gateway/bad-request',
              message: `method ${JSON.stringify(body.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
              details: { issues: [] },
            },
          },
        });
        return;
      }

      const signal = AbortSignal.any?.([AbortSignal.timeout(120000)]) ?? undefined;
      const result = await handler(endpoint, body.payload, signal);
      writeJson(res, 200, { type: 'server-response', rpcId: body.rpcId, result });
    } catch (err) {
      // 与宿主一致：处理函数自身抛错 → 500，便于定位而非被吞掉
      if (!res.writableEnded) {
        res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end(`handler failure: ${String(err)}`);
      }
    }
  };
}

export function installBridgeRpc(ctx, deps) {
  const { service, authManager, platformManager, logger, saveCustomTunnelConfig, exportBackup, importBackup } = deps;

  // 端点 dispatcher：逻辑与重构前逐字一致。
  //
  // 这里刻意用「对象方法」形态：方法体保持原来的缩进层级，
  // 从而把本次改动的 diff 收敛为真实逻辑变更（不产生几百行缩进噪音）。
  const rpcMethods = {
  async endpointHandler(endpoint, payload = {}, signal) {
      if (signal?.aborted) return fail('cancelled', 'Request was cancelled');

      try {
        if (endpoint === BRIDGE_ENDPOINTS.getStatus) {
          const isAdmin = checkAdminAuth(authManager, payload) === null;
          const status = await service.getStatus({ adminAuthValid: isAdmin });
          return ok(status);
        }

        // ---- 访问安全认证 ----

        if (endpoint === BRIDGE_ENDPOINTS.authGetStatus) {
          if (!authManager) return fail('bad-request', 'AuthManager 未初始化');
          const isAdmin = checkAdminAuth(authManager, payload) === null;
          return ok(authManager.getStatus({ masked: !isAdmin }));
        }

        if (endpoint === BRIDGE_ENDPOINTS.authUpdateConfig) {
          if (!authManager) return fail('bad-request', 'AuthManager 未初始化');
          const { enabled, mode, scope, adminPolicy, adminProtection, password, adminPassword } = payload;
          // 仅切换 enabled（访问认证开关）不需要管理权限：用户应能自由决定是否开放访问，
          // 否则"关闭访问认证"这个动作本身会被管理保护锁死（死锁：关闭要先解锁，解锁要过认证）。
          // 其余字段（模式/范围/策略/密码/管理保护）均涉及安全配置，仍需管理权限。
          const sensitive = mode !== undefined || scope !== undefined || adminPolicy !== undefined
            || adminProtection !== undefined || password !== undefined || adminPassword !== undefined;
          if (sensitive) {
            const adminErr = checkAdminAuth(authManager, payload);
            if (adminErr) return adminErr;
          }

          // 防自我锁死守卫（v2.10.5）：
          // password_only（仅密码）模式下若从未设置任何密码，开启防护或维持该模式会把
          // 管理员锁在登录墙外（无哈希可校验、密码登录被拒 → 进不去面板设密码 → 死锁）。
          // 因此：无任何密码时禁止单独开启 enabled（除非本次同请求携带 password），
          // 也禁止单独切换到 password_only（除非已设密码或本次带 password）。
          const willHaveNoPassword = !authManager.hasPassword && !authManager.hasAdminPassword
            && (password === undefined || !password);
          const nextMode = mode ?? authManager.mode;
          const nextEnabled = enabled ?? authManager.enabled;
          if (willHaveNoPassword && nextMode === 'password_only') {
            if (nextEnabled) {
              return fail('bad-request', '仅密码模式需要先设置访问密码：请先在下方「设置外部访客访问密码」处设置密码，再开启安全防护');
            }
            if (mode !== undefined) {
              return fail('bad-request', '仅密码模式需要先设置访问密码：请先在下方「设置外部访客访问密码」处设置密码后再切换');
            }
          }

          if (enabled != null) await authManager.setEnabled(enabled);
          if (mode != null) await authManager.setMode(mode);
          if (scope != null) await authManager.setScope(scope);
          if (adminPolicy != null) await authManager.setAdminPolicy(adminPolicy);
          if (adminProtection != null) await authManager.setAdminProtection(adminProtection);
          if (password !== undefined) await authManager.setPassword(password);
          if (adminPassword !== undefined) await authManager.setAdminPassword(adminPassword);
          return ok(authManager.getStatus({ masked: false }));
        }

        if (endpoint === BRIDGE_ENDPOINTS.authRegenerateToken) {
          if (!authManager) return fail('bad-request', 'AuthManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          await authManager.regenerateSecretToken();
          return ok(authManager.getStatus({ masked: false }));
        }

        if (endpoint === BRIDGE_ENDPOINTS.authAdminUnlock) {
          if (!authManager) return fail('bad-request', 'AuthManager 未初始化');
          const { password } = payload;
          const res = await authManager.unlockAdmin(password);
          if (res.ok) return ok({ adminToken: res.adminToken });
          return fail('bad-request', res.error || '管理员密码错误');
        }

        if (endpoint === BRIDGE_ENDPOINTS.authAdminLock) {
          if (!authManager) return fail('bad-request', 'AuthManager 未初始化');
          if (payload?.adminToken) authManager.revokeAdminSession(payload.adminToken);
          return ok({ locked: true });
        }

        if (endpoint === BRIDGE_ENDPOINTS.saveCustomTunnelConfig) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          // 未提供的字段保持 undefined 透传：服务端视为"保留现值"
          const { serverUrl, accessToken, sseStreaming } = payload;
          await saveCustomTunnelConfig(serverUrl, accessToken, sseStreaming);
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.saveCloudflaredConfig) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          const { token, hostname } = payload;
          await service.saveCloudflaredConfig({ token, hostname });
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.saveExternalTunnel) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          const { url } = payload;
          await service.saveExternalTunnel({ url });
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.setTunnelAutoStart) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          const { tunnel, autoStart } = payload;
          await service.setTunnelAutoStart({ tunnel, autoStart });
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.setLanIp) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { ip } = payload;
          const status = await service.setLanIp({ ip });
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.startCustomTunnel) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          try {
            await service.startCustomTunnel();
            const status = await service.getStatus();
            return ok(status);
          } catch (err) {
            logger.error('Failed to start custom tunnel: %s', err.message);
            return fail('bad-request', err.message);
          }
        }

        if (endpoint === BRIDGE_ENDPOINTS.stopCustomTunnel) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          service.stopCustomTunnel();
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.startCloudflared) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          try {
            await service.startCloudflared();
            const status = await service.getStatus();
            return ok(status);
          } catch (err) {
            logger.error('Failed to start cloudflared: %s', err.message);
            return fail('bad-request', err.message);
          }
        }

        if (endpoint === BRIDGE_ENDPOINTS.stopCloudflared) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          service.stopCloudflared();
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.resetCloudflared) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          await service.resetCloudflared();
          const status = await service.getStatus();
          return ok(status);
        }

        if (endpoint === BRIDGE_ENDPOINTS.checkVersion) {
          const result = await service.checkVersion();
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.upgradePlugin) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          const result = await service.upgradePlugin(payload);
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.upgradeDsh) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          const result = await service.upgradeDsh(payload);
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.restartDsh) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          const result = await service.restartDsh();
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.exportBackup) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          if (!exportBackup) return fail('bad-request', '备份导出服务不可用');
          const backup = await exportBackup();
          return ok(backup);
        }

        if (endpoint === BRIDGE_ENDPOINTS.importBackup) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          if (!importBackup) return fail('bad-request', '备份导入服务不可用');
          const result = await importBackup(payload?.backup);
          const status = await service.getStatus({ adminAuthValid: true });
          return ok({ result, status });
        }

        if (endpoint === BRIDGE_ENDPOINTS.diagnoseNetwork) {
          const result = await service.diagnoseNetwork();
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.getSystemMetrics) {
          const metrics = service.getSystemMetrics();
          return ok(metrics);
        }

        // ---- 远程工作区管理与目录浏览 ----

        if (endpoint === BRIDGE_ENDPOINTS.listRemoteDirectories) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          const clientKey = payload?.clientIp || payload?.adminToken || 'default';
          const rateCheck = rpcRateLimiter.check(clientKey, 30);
          if (!rateCheck.allowed) {
            return fail('bad-request', `请求过于频繁，请等待 ${rateCheck.retryAfterSec} 秒后再试`);
          }

          const result = await service.listRemoteDirectories(payload?.path);
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.addRemoteWorkspace) {
          const adminErr = checkAdminAuth(authManager, payload, { requireConfigured: true });
          if (adminErr) return adminErr;

          const clientKey = payload?.clientIp || payload?.adminToken || 'default';
          const rateCheck = rpcRateLimiter.check(clientKey, 20);
          if (!rateCheck.allowed) {
            return fail('bad-request', `添加工作区请求过于频繁，请等待 ${rateCheck.retryAfterSec} 秒后再试`);
          }

          const result = await service.addWorkspace(payload?.path);
          return ok(result);
        }

        if (endpoint === BRIDGE_ENDPOINTS.listWorkspaces) {
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const result = await service.getWorkspaces();
          return ok(result);
        }

        // ---- 平台管理器（多 IM 平台）----

        if (endpoint === BRIDGE_ENDPOINTS.listPlatforms) {
          if (!platformManager) return ok({});
          // 每个平台的 login.qrPayload 渲染为 dataURL 后返回
          const raw = platformManager.getStatus();
          const out = {};
          for (const [id, status] of Object.entries(raw)) {
            let qr = null;
            try { qr = await renderQr(status.login).catch(() => null); } catch { /* ignore */ }
            out[id] = { ...status, login: { ...(status.login ?? {}), qr, qrPayload: undefined, qrKind: undefined } };
          }
          return ok(out);
        }

        // ---- 平台操作（统一接口）----

        if (endpoint === BRIDGE_ENDPOINTS.platformLogin) {
          if (!platformManager) return fail('bad-request', 'PlatformManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { platformId, qrType } = payload;
          if (!platformId) return fail('bad-request', '缺少 platformId 参数');
          const platform = platformManager.get(platformId);
          if (!platform) return fail('bad-request', `平台未注册: ${platformId}`);
          const result = await platform.login({ qrType });
          if (!result.ok) return fail('bad-request', result.error ?? '登录启动失败');
          const status = platform.getStatus();
          const qr = await renderQr(status.login).catch(() => null);
          return ok({ ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } });
        }

        if (endpoint === BRIDGE_ENDPOINTS.platformSetAllowFrom) {
          if (!platformManager) return fail('bad-request', 'PlatformManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { platformId, allowFrom } = payload;
          if (!platformId) return fail('bad-request', '缺少 platformId 参数');
          const platform = platformManager.get(platformId);
          if (!platform) return fail('bad-request', `平台未注册: ${platformId}`);
          await platform.setAllowFrom(allowFrom);
          const status = platform.getStatus();
          const qr = await renderQr(status.login).catch(() => null);
          return ok({ ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } });
        }

        if (endpoint === BRIDGE_ENDPOINTS.platformSetConfig) {
          if (!platformManager) return fail('bad-request', 'PlatformManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { platformId, ...config } = payload;
          if (!platformId) return fail('bad-request', '缺少 platformId 参数');
          const platform = platformManager.get(platformId);
          if (!platform) return fail('bad-request', `平台未注册: ${platformId}`);
          await platform.setConfig(config);
          const status = platform.getStatus();
          const qr = await renderQr(status.login).catch(() => null);
          return ok({ ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } });
        }

        if (endpoint === BRIDGE_ENDPOINTS.platformStop) {
          if (!platformManager) return fail('bad-request', 'PlatformManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { platformId } = payload;
          if (!platformId) return fail('bad-request', '缺少 platformId 参数');
          const platform = platformManager.get(platformId);
          if (!platform) return fail('bad-request', `平台未注册: ${platformId}`);
          await platform.stop();
          const status = platform.getStatus();
          const qr = await renderQr(status.login).catch(() => null);
          return ok({ ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } });
        }

        if (endpoint === BRIDGE_ENDPOINTS.platformStart) {
          if (!platformManager) return fail('bad-request', 'PlatformManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { platformId } = payload;
          if (!platformId) return fail('bad-request', '缺少 platformId 参数');
          const platform = platformManager.get(platformId);
          if (!platform) return fail('bad-request', `平台未注册: ${platformId}`);
          await platform.start();
          const status = platform.getStatus();
          const qr = await renderQr(status.login).catch(() => null);
          return ok({ ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } });
        }

        if (endpoint === BRIDGE_ENDPOINTS.platformUnbind) {
          if (!platformManager) return fail('bad-request', 'PlatformManager 未初始化');
          const adminErr = checkAdminAuth(authManager, payload);
          if (adminErr) return adminErr;

          const { platformId } = payload;
          if (!platformId) return fail('bad-request', '缺少 platformId 参数');
          const platform = platformManager.get(platformId);
          if (!platform) return fail('bad-request', `平台未注册: ${platformId}`);
          await platform.unbind();
          const status = platform.getStatus();
          const qr = await renderQr(status.login).catch(() => null);
          return ok({ ...status, login: { ...status.login, qr, qrPayload: undefined, qrKind: undefined } });
        }

        return fail('bad-request', `Unknown endpoint: ${endpoint}`);
      } catch (err) {
        logger.error('RPC endpoint %s failed: %s', endpoint, err.message);
        return fail('bad-request', err.message);
      }
  },
  };
  const endpointHandler = rpcMethods.endpointHandler;

  // 方案 1（DSH >= 0.1.5-rc.1 唯一可用）：插件自己的 ctx 直连 webServer 注册前缀路由。
  // webServer 已在插件 inject 中声明；用 ctx.get 读取可避免未部署时直接抛错。
  const webServer = ctx.get?.('webServer');
  if (webServer?.register) {
    const handler = createRpcRouteHandler(BRIDGE_RPC_CHANNEL, endpointHandler);
    try {
      const disposeRoute = ctx.effect(
        () => webServer.register({ kind: 'prefix', path: BRIDGE_RPC_CHANNEL, handler }),
        'dsh-bridge: connection RPC channel'
      );
      logger.info('dsh-bridge: RPC 通道已注册到 webServer (%s)', BRIDGE_RPC_CHANNEL);
      return disposeRoute;
    } catch (err) {
      logger.warn('dsh-bridge: webServer RPC 路由注册失败，回退到 connection.rpc：%s', err.message);
    }
  }

  // 方案 2（旧版本宿主回退）：connection.rpc.handle。
  // 注意：0.1.5-rc.1 起该方法把注册挂在提供方 ctx 上且已删除 options 参数，
  // 直接调用会抛 `cannot get property "webServer" without inject`，故必须 try/catch。
  if (ctx.connection?.rpc?.handle) {
    try {
      return ctx.connection.rpc.handle(BRIDGE_RPC_CHANNEL, endpointHandler);
    } catch (err) {
      logger.warn('dsh-bridge: connection.rpc.handle 不可用：%s', err.message);
    }
  }

  logger.warn('dsh-bridge: 无可用 RPC 注册通道（webServer / connection.rpc 均不可用）— UI 将无法工作');
  return () => {};
}

