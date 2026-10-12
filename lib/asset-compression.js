// 静态大资源的按需 gzip（响应侧）—— dsh-bridge
//
// 背景：桥为了稳定注入 HTML，会在 loopbackHeaders() 里删除请求的 Accept-Encoding，
// 上游（DSH web）因此对一切响应都返回 identity。客户端插件组合包 plugins/??* 可达
// 10 MB 级（本机两个包合计约 15.9 MB），手机 WebView 在隧道上会直接放弃下载
// （cloudflared 记为 "stream canceled by remote"），前端随后显示
// "Failed to load plugins"。
//
// 这里只负责"该不该压"的纯判定；实际的 createGzip() 管道在 lib/index.js 的直通分支。
// HTML 注入与 session 投影剥离仍走原来的缓冲分支，完全不受影响；这些资源 URL 是
// 内容寻址的（rev），压缩后可被浏览器长期缓存。

/** 客户端是否接受 gzip。 */
export function acceptsGzip(headers) {
  return /\bgzip\b/i.test(String(headers?.['accept-encoding'] ?? ''));
}

/**
 * 静态资源路径：插件组合包 / 前端 assets / 桥自身 PWA 资源。
 *
 * 注意 ProxyServer 会把请求 URL 归一化为 pathname（去掉 query 与尾斜杠）：
 * 插件组合包 /plugins/??a/client.js&rev=1 归一化后是 '/plugins'，所以这里不能要求尾斜杠。
 */
export const COMPRESSIBLE_ASSET_PATH = /^\/(?:plugins|assets)(?:\/|$)|^\/__dsh_bridge__\//;

/** 可压缩内容类型（显式排除 text/html 与 SSE）。 */
export const COMPRESSIBLE_CONTENT_TYPE =
  /(?:javascript|ecmascript|text\/css|application\/json|image\/svg\+xml|application\/wasm|application\/xml|text\/xml|text\/plain)/i;

/**
 * 该响应是否应该在桥这一跳 gzip。
 * @param {{ clientAcceptsGzip?: boolean, pathname?: string, statusCode?: number, headers?: Record<string, unknown> }} input
 */
export function shouldGzipProxyResponse({ clientAcceptsGzip, pathname, statusCode, headers } = {}) {
  if (!clientAcceptsGzip) return false;
  if (statusCode !== 200) return false;
  if (!COMPRESSIBLE_ASSET_PATH.test(String(pathname ?? ''))) return false;
  const contentType = String(headers?.['content-type'] ?? '');
  if (/text\/html|text\/event-stream/i.test(contentType)) return false;
  const encoding = String(headers?.['content-encoding'] ?? '').trim();
  if (encoding && !/^identity$/i.test(encoding)) return false;
  if (headers?.['content-range'] !== undefined) return false;
  return COMPRESSIBLE_CONTENT_TYPE.test(contentType);
}
