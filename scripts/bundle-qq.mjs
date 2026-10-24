// dsh-bridge QQ SDK 打包：把官方 @tencent-connect/qqbot-nodejs（协议层）打成单文件
// lib/qq/qqbot-bundled.mjs。
//
// 为什么和飞书一样预打包：插件发布物只包含 lib/ 目录（见 package.json files），
// 不携带 node_modules。运行时用到的官方 SDK 必须进产物，否则用户装完插件
// 启动时 `import '@tencent-connect/qqbot-nodejs'` 会直接找不到模块。
//
// ⚠️ 许可边界（重要）：
//   - `@tencent-connect/qqbot-nodejs` 是 **MIT**（有 LICENSE 文件），可以安全内联进 MIT 产物；
//   - `@tencent-connect/qqbot-connector` 是 **UNLICENSED**（无 LICENSE 文件），
//     **不内联**，改为运行时 `import()` 可选加载：用户自行 `npm i @tencent-connect/qqbot-connector`
//     才能用「扫码绑定」，缺失时自动降级为"手动填写 AppID/AppSecret"。
//     这样既尊重其许可，也避免把未授权代码分发进本仓产物。
//
// 导出的符号即 lib/qq/ 允许使用的全部官方能力：
//   - QQBot                 高层 facade（WS 长连接 / 收发 / 媒体 / 流式 / API escape hatch）
//   - MsgType / MediaFileType  消息与媒体类型枚举
//   - ApiError / GatewayError / GatewayErrorCode  结构化错误
//   - 内置中间件（去重/清洗/限流/白名单/@门控/引用/历史/命令/typing/错误兜底…）
//   - ReplyLimiter          被动回复限额
//   - FileKVStore / kvSessionPersistence  RESUME 会话落盘（跨进程恢复）
import esbuild from 'esbuild'

/** 腾讯 SDK 的 MIT 版权声明（内联产物必须保留，否则违反许可条款） */
const MIT_BANNER = `/*!
 * @tencent-connect/qqbot-nodejs — MIT License
 * Copyright (c) Tencent
 * https://github.com/tencent-connect/qqbot-nodejs
 *
 * This bundle inlines the official Tencent QQ Bot Node.js SDK (MIT).
 * The full upstream license text: https://github.com/tencent-connect/qqbot-nodejs/blob/main/LICENSE
 */
`

await esbuild.build({
  stdin: {
    contents: `
      export {
        QQBot,
        MsgType,
        MediaFileType,
        ApiError,
        GatewayError,
        GatewayErrorCode,
        // 中间件
        errorHandler,
        messageFilter,
        contentSanitizer,
        rateLimiter,
        concurrencyGuard,
        accessPolicy,
        mentionGate,
        quoteRef,
        historyBuffer,
        envelopeFormatter,
        slashCommand,
        typingIndicator,
        // 存储 / 会话恢复
        MemoryKVStore,
        FileKVStore,
        kvSessionPersistence,
        // 工具
        getMaxUploadSize,
        sanitizeFileName,
        formatErrorMessage,
        formatFileSize,
      } from '@tencent-connect/qqbot-nodejs'
      export { ReplyLimiter, GatewayConnection, FULL_INTENTS, TEXT_CHUNK_LIMIT } from '@tencent-connect/qqbot-nodejs/protocol'
    `,
    resolveDir: process.cwd(),
    sourcefile: 'qqbot-bundled-entry.mjs',
    loader: 'js',
  },
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  // 可选 peer（语音转 SILK 用）：SDK 内部用 import() 懒加载，缺失时自动降级为 null。
  // 打成 external 才能保持"缺了也不报错"的语义（内联会让 esbuild 直接构建失败）。
  external: ['silk-wasm', 'mpg123-decoder'],
  // 保留内联依赖的 license/legal 注释（esbuild 默认会去掉）
  legalComments: 'inline',
  banner: {
    js: `${MIT_BANNER}
import { createRequire as __createRequire } from 'node:module';
import { fileURLToPath as __fileURLToPath } from 'node:url';
import { dirname as __dirnameFunc } from 'node:path';
const require = __createRequire(import.meta.url);
const __filename = __fileURLToPath(import.meta.url);
const __dirname = __dirnameFunc(__filename);
`,
  },
  outfile: 'lib/qq/qqbot-bundled.mjs',
})

console.log('Bundled successfully!')
