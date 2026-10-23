// DSH Bridge - 会话响应投影剥离（共享逻辑）
//
// contextHeaders / contextTimeline 是 DSH 会话投影里的两个大字段：每轮完整系统提示
// + 工具定义（单会话 4.8MB+，session/list 数百会话可达 60MB+），但没有客户端 UI
// 读取它们（会话打开时通过 WebSocket 实时获取，见 dsh-session-projection-cache 注释）。
// 剥离后大幅降低传输体积（历史记录：session.history gzip 1.2MB -> ~150KB，约 8 倍；
// 该端点已不在 DSH 0.2.1-rc.2 中，数字仅作收益量级参考）。
//
// 本模块被两个转发层复用：
//   - tunnel-client.mjs（自建隧道）
//   - index.js ProxyServer（局域网 / Cloudflare 隧道 / 外部隧道登记 —— 所有公网入口）
// 命中失败（非 200 / 解析失败 / 结构不符）时原样返回，绝不破坏响应。
//
// DSH web 服务器默认开启 gzip 压缩（compression: gzip, level 1, threshold 1KB），
// 所以 API 响应可能是 gzip 编码的。必须先解压才能 JSON.parse，否则解析失败，
// catch {} 静默跳过剥离 → 完整 58MB+ 响应原样传输 → 隧道慢。

import { gunzipSync } from 'node:zlib';

// DSH 真实 RPC 路径是斜杠形式：dsh-client-connection 用 `${channel}/${endpoint}`
// 拼 URL（channel=/api、endpoint=session/list），服务端 endpointFromPath 也按斜杠解析。
// 点号形式可能是旧版/外部 REST 端点，保留以向后兼容（issue #82：此前只写点号，
// 导致真实流量上剥离从未生效）。
//
// 关于 session/history（已核实，2026-10，DSH 0.2.1-rc.2）：
//   该版本 dsh-api-session-controller 枚举出的 20 个 session 端点（见
//   dsh-api-session-controller/lib/typert.remote-client.d.ts 与
//   dsh-api-remotes/lib/client.js）只有 session/list、session/page、session/projections
//   等，**没有 session/history**——会话历史读取走 session/page。
//   因此斜杠 /api/session/history 在当前 DSH 版本上大概率是死路径；这里仍保留该分支
//   作为兼容面（旧版本可能用过该端点，且外部/自定义网关可能仍以该路径转发），
//   不因「当前版本无此端点」而删除。它只扩大命中集，不会误伤 session/page 等端点。
const STRIP_PATHS = new Set([
  '/api/session/list',
  '/api/session/history', // 当前 DSH 0.2.1-rc.2 无此端点，保留兼容（见上）
  '/api/session.list',
  '/api/session.history',
]);

/**
 * 判断请求路径是否属于需要剥离会话投影的端点集合。
 * 同时兼容斜杠（DSH RPC 真实路径）与点号（历史 REST 路径）两种写法。
 * 注：session/list 是当前 DSH 版本的真实活端点；session/history 属兼容面
 * （DSH 0.2.1-rc.2 已无该端点，历史读取走 session/page），保留不删。
 * @param {string} pathname 请求路径，可带 query
 * @returns {boolean}
 */
export function isSessionProjectionPath(pathname) {
  const cleanPath = String(pathname || '').split('?')[0];
  return STRIP_PATHS.has(cleanPath);
}

/**
 * 剥离 session/list（活端点）响应中的 contextHeaders 与 contextTimeline。
 * session/history 分支为兼容面（当前 DSH 0.2.1-rc.2 无该端点），结构同
 * projections.values，命中才会删除。
 * @param {string} pathname 请求路径（不含 query）
 * @param {Buffer} bodyBuf 原始响应体
 * @param {string} [contentEncoding] 响应的 content-encoding 头值（用于判断是否 gzip）
 * @returns {{ body: Buffer, stripped: boolean }} stripped=true 表示发生了剥离（调用方需更新 content-length 和 content-encoding）
 */
export function stripSessionProjections(pathname, bodyBuf, contentEncoding) {
  if (!isSessionProjectionPath(pathname) || !Buffer.isBuffer(bodyBuf)) {
    return { body: bodyBuf, stripped: false };
  }
  try {
    // 如果 DSH 服务器 gzip 压缩了响应，先解压再解析
    const isGzipped = String(contentEncoding ?? '').toLowerCase() === 'gzip';
    const parseBuf = isGzipped ? gunzipSync(bodyBuf) : bodyBuf;
    const json = JSON.parse(parseBuf.toString('utf8'));
    if (json?.result?.ok) {
      const v = json.result.value;
      let changed = false;
      // session.list: items[].projections.values
      if (v?.items) {
        for (const item of v.items) {
          const proj = item?.projections?.values;
          if (proj && (proj.contextHeaders !== undefined || proj.contextTimeline !== undefined)) {
            delete proj.contextHeaders;
            delete proj.contextTimeline;
            changed = true;
          }
        }
      }
      // session.history: projections.values
      if (v?.projections?.values) {
        const proj = v.projections.values;
        if (proj.contextHeaders !== undefined || proj.contextTimeline !== undefined) {
          delete proj.contextHeaders;
          delete proj.contextTimeline;
          changed = true;
        }
      }
      if (changed) {
        return { body: Buffer.from(JSON.stringify(json), 'utf8'), stripped: true };
      }
    }
  } catch { /* 解析/解压失败则原样发送 */ }
  return { body: bodyBuf, stripped: false };
}
