# 飞书 Agent 官方能力 · 本地留档（docs/dev/lark-sdk）

> 目的：把「飞书官方 SDK / 官方文档」的**事实**固化在仓库里，供后续开发与评审直接引用，
> 避免凭记忆或猜测写飞书相关代码。本目录只放**下载的原文**与**核实后的结论**，
> 不改写官方语义；`lib/feishu/` 的实现必须能在此逐条对应。

---

## 1. 文件清单

| 文件 | 内容 | 来源 |
| :--- | :--- | :--- |
| `official-agent-capabilities-overview.md` | 飞书 Agent 三层能力概览（凭据层 / 交互层 / 执行层） | `https://open.feishu.cn/document/mcp_open_tools/overview-of-lark-agent-integration-capabilities.md` |
| `official-1click-create-overview.md` | 一键创建飞书智能体应用（含**预置权限 / 事件 / 回调清单**附录） | `.../integrating-agents-with-feishu/overview.md` |
| `official-1click-create-nodejs.md` | `registerApp` NodeJS 用法、参数表、返回值、错误码 | `.../scan-to-create-an-app-in-one-click-nodejs.md` |
| `official-channel-integration.md` | Channel SDK 能力边界（不覆盖 Agent runtime / 多用户隔离 / 会话持久化 / 凭据存储） | `.../integrate-feishu-channel.md` |
| `README.zh.md` / `README.en.md` | Channel SDK 完整 README（API 全表、策略、错误码、卡片回调语义） | `https://github.com/larksuite/channel-sdk-node` |
| `channel-sdk-0.7.1-types.d.mts` | Channel SDK 0.7.1 类型定义（**最权威的 API 快照**） | npm `@larksuite/channel@0.7.1` 包内 `dist/index.d.mts` |
| `examples/*.ts` | 官方示例（连接 / 出站 / 流式 / 入站 / 策略 / 一键注册） | 官方仓库 `examples/` |
| `official-message-content.md` | **发送消息内容结构**：`post` 的 `md` 标签语法清单（含表格、任务列表、引用等**空行分隔硬要求**） | `.../reference/im-v1/message/message-content-description` / `.../im-v1/message/create_json` |
| `official-slash-command.md` | **飞书智能体 Slash Command（斜杠指令）官方文档**：增删改查接口、权限、限制、缓存与 icon 列表 | `.../mcp_open_tools/agent-best-practices/agent-supports-slash-commands.md` |

### 刷新方式

```bash
# 官方文档（加 .md 后缀拿到纯 Markdown；否则返回 SPA 空壳）
curl -sL "https://open.feishu.cn/document/mcp_open_tools/integrating-agents-with-feishu/overview.md" -o official-1click-create-overview.md
# SDK README / 示例
base=https://raw.githubusercontent.com/larksuite/channel-sdk-node/main
curl -sL "$base/README.zh.md" -o README.zh.md
# 类型定义（最权威）
npm pack @larksuite/channel@<version> && tar -xzf larksuite-channel-*.tgz && \
  cp package/dist/index.d.mts channel-sdk-<version>-types.d.mts
```

## 2. 版本与依赖事实

| 项 | 值 | 说明 |
| :--- | :--- | :--- |
| `@larksuite/channel` | **0.7.1**（最新） | 官方 Channel SDK，MIT，Node ≥18 |
| `@larksuiteoapi/node-sdk` | **1.75.0**（最新） | channel 依赖 `^1.73.1`；`registerApp` 需 ≥1.61.1 |
| 打包方式 | `scripts/bundle-lark.mjs` → `lib/feishu/lark-bundled.mjs`（约 6.4MB，提交入库） | 插件发布物只含 `lib/`，不带 `node_modules`；`gateway.js` 是本目录导出符号的唯一使用方 |
| 导出符号 | `createLarkChannel` / `registerApp` / `LarkChannelError` / `Domain` / `LoggerLevel` | 其他 SDK 能力暂不需要，不导出；`LoggerLevel.warn = 2`（SDK 日志只放行告警与错误） |

`Domain` 枚举值（**必须传枚举，不能传 `'feishu'` 字符串**）：
`Domain.Feishu = 0`、`Domain.Lark = 1`。node-sdk 的 `formatDomain()` 对非枚举值走 `default: return domain`，
传字符串会得到无效域名（如 `https://feishu/...`）。

## 3. 入站事实（`channel.on('message')`）

`NormalizedMessage` 关键字段：`messageId` / `chatId` / `chatType('p2p'|'group')` / `senderId`（open_id）/
`content` / `rawContentType` / `resources[]` / `mentions[]` / `mentionedBot` / `threadId` / `createTime`。

- **`chatId` 单聊也是 `oc_…`**：出站目标一律用它（见第 6 节 230101）。
- **纯媒体消息的 `content` 是占位标记**：图片 `![image](image_key)`、文件 `<file key="…" name="…"/>`；
  可用信息在 `resources[]`（`{ type, fileKey, fileName }`）。`lib/feishu/node.js` 对
  `image|file|audio|video|media|sticker` 这类消息**不把占位标记当正文**。
- 机器人自身的 @ 提及会被剥离（`stripBotMentions` 默认 true），其他人提及替换为 `@名字`。
- 内建防护：消息去重、过期丢弃（`staleMessageWindowMs` 默认 30 分钟）、按 chat 串行（`chatQueue.enabled` 默认 true）。

入站策略（`policy`）默认值——**与文档表述不同，以源码为准**：

| 配置 | 默认 | 影响 |
| :--- | :--- | :--- |
| `requireMention` | **true** | 群聊必须 @ 机器人才响应；dsh-bridge 显式声明为 true |
| `dmMode` | `'open'` | 单聊全部投递；白名单仍由会话桥 `allowFrom` 负责（避免双重门禁破坏"首条消息自动授权"） |
| `respondToMentionAll` | false | @所有人 不触发 |
| `groupAllowlist` / `dmAllowlist` | 未设置 | 不使用 SDK 白名单，保持与微信/QQ 一致的桥内授权模型 |

## 4. 出站事实（`channel.send` / `stream`）

- `send(to, input)`：`to` 前缀决定 `receive_id_type`（`oc_`→chat_id、`ou_`→open_id、`on_`→union_id、含 `@`→email、其余→user_id）。
- `{ markdown }` → 飞书**富文本 post**（`tag: 'md'`，原生渲染 markdown），按 `outbound.textChunkLimit` 分片
  （默认 3500，按代码块边界安全切分），格式错误自动降级纯文本，限流自动重试。
- 媒体源 `MediaSource = string | Buffer`：**本地路径必须先在 `outbound.allowedFileDirs` 里声明**，
  否则抛 `upload_failed`；`Buffer` / `http(s)` URL 无此限制。
- 流式卡片 `stream(to, { markdown: producer })`：
  - SDK 用 CardKit `streaming_mode` 原生打字机（`print_frequency_ms: 70`），**不用自己 patch 卡片**；
  - `MarkdownStreamController`：`append(chunk)` 追加、`setContent(full)` 覆盖（`setContent` 内部 `throttle.note(MAX_SAFE_INTEGER)`＝**立即下发**，故 `streamThrottleMs` 对覆盖式更新无实际作用）；
  - producer 返回即收尾（关闭 streaming_mode）；内容超过 `streamMaxElementChars`（默认 30000）自动换卡续写；
  - 建卡/更新失败 → `channel.stream()` 返回 rejected promise，或经 `channel.on('error')` 上报，**不会静默**。
- `LarkChannelError.code`：`format_error` / `target_revoked` / `rate_limited` / `permission_denied` /
  `upload_failed` / `ssrf_blocked` / `send_timeout` / `not_connected` / `unknown` 等。
- 其他可用方法（当前未使用）：`reply` / `updateCard` / `createCard` / `updateCardById` / `editMessage` /
  `recallMessage` / `addReaction` / `getChatInfo` / `getChatMembers` / `fetchMessage` / `listChats` / `createChat` /
  `downloadResource` / `downloadResourceWithMeta` / `downloadResourceToFile` / `comments`（文档评论）/ 会议通道 / `onRawEvent`。

## 5. 一键创建应用（`registerApp`）

- 协议：OAuth 2.0 Device Authorization Grant（RFC 8628）；`onQRCodeReady({ url, expireIn })` 给出链接（10 分钟有效、仅一人可用）。
- **轮询由 SDK 负责且有时限**：`expireTimer = setTimeout(() => fail(createError('expired_token', 'Polling timed out')), (expires_in ?? 600) * 1000)`，
  即 10 分钟后自动终止并抛 `expired_token`；`signal`（AbortSignal）可随时取消并抛 `abort`。
- **设备码一次性**：所以"刷新二维码"必须是 `abort` 当前流程 + 重新 `registerApp`（换新 device_code），
  不能复用旧码；刷新后旧流程的 `onQRCodeReady` / 成功结果 / 错误都必须被丢弃（本仓库用 run 对象 + `isCurrent()` 守卫实现）。
- 返回值：`{ client_id, client_secret, user_info?: { open_id, tenant_brand: 'feishu'|'lark' } }`。
- 错误码：`access_denied`（用户拒绝）、`expired_token`（二维码过期/轮询超时）、`abort`（AbortSignal 取消）。
- 可选项：`appPreset`（名称/描述/头像预填）、`addons`（增量权限/事件/回调；`preset:false` 走最小基座）、
  `appId`（改为给已有应用增量开通）、`createOnly`、`signal`、`source`。
- **dsh-bridge 的取舍**：不传 `addons`，使用平台默认模板（官方"智能体应用配置清单"）——清单已覆盖本项目全部所需
  （`im.message.receive_v1` 事件、`card.action.trigger` 回调、WebSocket 订阅方式、`im:message:send_as_bot`、
  `im:resource`、`cardkit:card:write`（流式卡片）、`im:message:update`、`application:bot.basic_info:read` 等）。
  自定义 `addons` 需要平台灰度开关，漏写权限会静默失败，风险高于收益。

## 5.3 云文档评论（@机器人）

- **SDK 契约**：`CommentEvent { fileToken, fileType, commentId, replyId?, operator{openId}, mentionedBot }`；
  `FetchedComment { commentId, replies[{ reply_id?, content?.elements[] }], quote?, isWhole }`；
  `CommentReplyContentElement = text_run | docs_link | person`（**纯文本**，没有卡片/流式/按钮）；
  `comments.reply(target, commentId, text, { topLevel })`——整篇文档评论（`isWhole`）直接发顶层，避免 SDK 先探一次 in-thread 拿到 1069302。
- **本仓库实现**（`lib/feishu/comment.js` + `gateway.fetchComment/sendCommentReply` + `node._handleComment`）：
  - 合成 peer `comment:<fileToken>:<commentId>` 绑定会话；出站 `sendText` 检测到评论 peer 就改走 `comments.reply`（**不做 Markdown 归一化**，原样纯文本）；
  - 评论轮次**缓冲输出、turn/end 合并一条**（评论里没有流式卡片可原地刷新）、**跳过心跳摘要**（`outboundPeer.comment` 标志，共享桥 2 行判断）、**审批不拦截**（交回宿主 GUI）、`[SEND_FILE]` 在评论会话被拒绝；
  - 同一评论线程的后续回复**免 @**（进程内记住 peer）；未 @ 的无关评论忽略；
  - 已知限制：评论回复是纯文本（Markdown 语法按字面显示）、不能流式、不能发文件/卡片、超长回复未分片（失败会有告警日志）。

## 5.35 宿主服务：每轮改动清单（workspaceChanges）

IM 侧的「本轮改动摘要」与 `/diff` 用的是 **DSH 宿主**的服务（与 Web 端"改动/交付物"面板同源），不是飞书 SDK 能力，但同样必须按文档/类型事实使用：

```ts
// @deepseek-ai/dsh-workspace-changes（宿主已挂到 cordis Context）
ctx.workspaceChanges.summary(sessionId, seq): {
  turn: number; cwd: string;
  total: number; added: number; deleted: number;          // 含被 cap 掉的文件
  files: { path: string; display: string; added: number; deleted: number; binary?: true; oversized?: true }[];
  snapshot?: { before: string; after: string };
} | undefined
ctx.workspaceChanges.diff(sessionId, seq, index, signal): Promise<
  { kind: 'text'; hunks: { oldStart; oldLines; newStart; newLines; lines: string[] }[] }
  | { kind: 'binary' | 'oversized'; path; display } | undefined
>
// 会话事件（每轮完成的顶层 turn 之后追加）：session/event → { type: 'workspace/changes', data: { turn } }
```

关键语义（实测/类型均确认）：
- 摘要**留在宿主**，用 `(sessionId, event.seq)` 取；事件本身只带 `turn`；
- **同一轮可能追加多次事件**（新的替换旧的）→ 播报侧按 turn 去重；
- `files` 已按 `display` 排序且受宿主 `maxFiles` 限制，`total/added/deleted` 是**全量**统计；
- 会话被销毁后 `summary()` 返回 undefined（要做空判）；
- 老宿主可能没有该服务 → 一律 `ctx.workspaceChanges?.summary` 守卫，缺失即静默跳过。

本仓库实现：
- 播报：`conversation-bridge._announceChanges()` → `lib/platform/changes-digest.js:formatChangesDigest()`（默认开启，`changesDigest` 开关）；
- 导出：`conversation-bridge.sendSessionDiff()`（挂到 `/diff` 指令）→ `buildUnifiedPatch()` 生成 `.patch` 写临时文件后走 `platform.sendMediaFile()`；
- 出站目标：`resolveSendTarget(opts)`（基类默认 `outboundPeer.peerId ?? this.peerId ?? allowFrom[0]`，飞书覆盖为 `chat_id` 优先），`sendMediaFile` 支持透传 `{ replyTo, replyInThread }`，话题群里的附件也留在话题内。

## 5.4 出站 Markdown 的硬要求（表格/引用必须空行分隔）

官方「发送消息内容结构」原文要点：`md` 标签支持 CommonMark 0.31 + GFM（**含表格**），但
- **表格前后必须使用 `\n\n` 与其他块级元素分隔**；"如果只使用单个 `\n`，后续内容可能被解析为表格的续行"；
- **引用块后面如需接其他块级元素，必须使用 `\n\n` 分隔**。

**实测现象（用户反馈截图，2026-10）**：`/help` 在**鸿蒙版飞书**里只显示 4 个标题、**表格整块不渲染**；同一会话换 **iOS 版飞书**即正常显示表格 → 属**客户端渲染差异**（鸿蒙端更严格/未支持），不是服务端或内容错误。**后续复验**：更新飞书 HAP 版本 + 含表格内容改走交互卡片后，用户在鸿蒙端确认显示正常。

不过我们的文本确实**不满足官方硬要求**（`helpText()` 里有 3 处"标题后紧跟表格、只有一个 `\n`"，实测统计过），而 SDK 的 `optimizeMarkdownStyle` 只在 cardVersion≥2（卡片）分支补表格空行、`post` 路径（v1）不补 → 因此本插件自己归一化，让输出合规（对严格客户端更稳，iOS/PC 上无视觉差异）。

**本仓库实现**：`lib/feishu/markdown.js` 的 `normalizeFeishuMarkdown()`——表格前后、引用块后按需补空行；跳过围栏代码块；幂等。
调用点：`gateway.sendText()`（post 路径）与 `gateway.openStream()` 的 `setContent()`（流式卡片路径，agent 输出也可能含表格）。

**含表格内容的渲染选择**：`gateway.sendText()` 判定内容是否含表格——
- **无表格** → SDK 的 `post` 路径（保留其分片 / 重试 / 格式错误降级）；
- **含表格** → **交互卡片**（`{ card }`，结构同重构前：`schema 2.0` + markdown 元素）——卡片走另一套渲染器，实测 iOS/PC 正常、且是鸿蒙端**可能**更兼容的路径（待真机复验）；分片按 `maxMessageChars`，**表格跨片自动补表头**、围栏代码块跨片自动补 ```，卡片通道失败则回退 `post`。

## 5.5 Slash Command（斜杠指令 / 快捷指令）

**平台支持 ✅**（一键创建应用预置权限已含 `application:app_slash_command:read` + `:write`）：

| 操作 | 方法 | 路径 | 权限 |
| :--- | :--- | :--- | :--- |
| 创建 | POST | `/open-apis/application/v7/app_slash_commands` | `application:app_slash_command:write` |
| 列表 | GET | `/open-apis/application/v7/app_slash_commands` | `application:app_slash_command:read` |
| 更新 | PATCH | `/open-apis/application/v7/app_slash_commands/:command_id` | write |
| 删除 | DELETE | `/open-apis/application/v7/app_slash_commands/:command_id` | write |

请求体（创建）：`{ "command": "greet"(不带斜杠), "description": { "default_value": "必填兜底文案", "i18n": { "en_us": ..., "zh_cn": ... }, "icon": { "icon_key": "skill_outlined" } } }`
→ 响应 `data.command_id`（更新/删除的唯一标识，需持久化）。

关键约束（官方文档原文要点）：
- 客户端版本：**PC ≥ 7.70 / 移动端 ≥ 7.71** 才会出现指令面板；
- 每应用上限 **100 条**；`command` 名称唯一（重复创建 → `code 40000000 / command already exists`，POST 非幂等但服务端有唯一约束）；
- 删除后同名可重建（生成新 `command_id`）；PATCH/DELETE 幂等；
- 生效延迟：服务端约 **5 分钟** + 客户端缓存约 **3 分钟**（删除后最多残留 3 分钟）；
- 必填 Header：`Authorization: Bearer <tenant_access_token>`，POST/PATCH 还需 `Content-Type: application/json; charset=utf-8`；
- 典型错误码：`99991661` 缺 Token、`99991663` Token 无效、`99992402` 参数校验失败、`9499` 请求体格式错误、`40000000` 业务错误、`40000031` `icon_key` 非法、`99991640` 缺权限；
- `icon_key` 默认 `skill_outlined`，可用列表见文档（`ai-agent_outlined` / `search-ai_outlined` / `home_outlined` …）。

**SDK 覆盖 ❌（已逐个 grep 验证）**：`@larksuite/channel@0.7.1` = 0 命中；`@larksuiteoapi/node-sdk@1.75.0`（最新）= 0 命中（无 `app_slash_commands` / `appSlashCommand`）；
官方 Java SDK 只有数据模型 `AppSlashCommand`，无 service 方法；Go / Python SDK 亦无 → **只能直连 HTTP**。

**可直接复用的逃生通道**（已在本地 bundle 中验证可用，无需自己管 token）：
```js
const client = channel.rawClient            // Channel SDK 文档化的逃生通道
client.domain                               // 'https://open.feishu.cn'
await client.tokenManager.getTenantAccessToken()   // 复用 SDK 的 tenant token 缓存（过期前 3 分钟刷新）
client.httpInstance.request({ url, method, headers, data })
```

**⚠️ 卡片 JSON 2.0 的能力坑（实测）**：CardKit / 卡片 JSON 2.0 **不支持 `note` 元素**——整卡更新（`cardkit.v1.card.update` / SDK `updateCardById`）会返回
`200861 ErrPath: ROOT -> elements -> [1](tag: note); ErrMsg: cards of schema V2 no longer support this capability`。
审批卡片曾用 `note` 写“本次审批已结束”，导致结果态更新失败、卡片停在待办态；现统一把这类提示并入 `markdown` 元素。
写入/更新卡片前，元素 tag 只应使用 2.0 支持的类型（`markdown` / `div` / `column_set` / `button` / `img` / `hr` / 表单类等）。

**本仓库实现**（`lib/feishu/slash-commands.js`，默认开启）：
- 期望清单 `DESIRED_SLASH_COMMANDS` 与 `lib/platform/commands.js` 的文本指令一一对应（10 条，`command` 不带斜杠，icon 取文档清单内取值）；
- 同步策略：缺失→POST、描述/图标不一致→PATCH、一致→采用（只读一次列表）、**只删除本插件创建过且已下线的**——记录形如 `slashCommandIds[command] = { id, ours }`：自己创建的记 `ours: true`；同名冲突被认领的记 `ours: false`（后续只更新、**永不删除**）；字符串旧值保守按 `ours: false` 处理；
- `command already exists`（code 40000000）→ 重新列表认领 `command_id`，不报错；
- 权限类错误（`99991640` / `99991661` / `99991663`）→ 只记一条 warn 并停止本次连接内的重试，不影响消息收发；
- token：经 SDK 生成的 `client.auth.v3.tenantAccessToken.internal()` 获取（本地缓存、提前 3 分钟过期），不自己实现 token 协议；
- **图标实测结论（生产验证）**：创建/更新时传入文档清单内的非默认 `icon_key` 会被服务端**静默忽略**（PATCH 返回 code 0，但 GET 列表始终回 `skill_outlined`）。因此本仓库统一使用默认图标，并把图标纳入是否需要更新的比较——否则每次同步都会误判为有变更、白 PATCH 10 次；
- **生产验证记录**：以真实应用跑 `syncSlashCommands()` 的结果为 `adopted: 10 / created: 0 / updated: 0`，HTTP 调用序列仅 `GET`（完全幂等）；服务端 10 条指令与本地 `slashCommandIds` 记录逐条一致。
- 触发：连接成功后异步执行一次（不阻塞连接）；设置页「重新连接」会重跑同步。

**⚠️ 文档缺口（不要凭想象）**：该页只描述**管理接口**，**未说明用户触发指令时飞书下发什么事件**（是普通 `im.message.receive_v1` 文本，还是专门事件）。本仓库依赖"指令以文本消息下发"这一形态被现有 `/xxx` 路由处理，
**该点仍需真机验证**（PC ≥7.70 / 移动端 ≥7.71 的账号，创建后等待约 8 分钟）：若实测为专门事件，则需用 `channel.onRawEvent` 再补一条接入。

## 6. 与 dsh-bridge 的集成映射（`lib/feishu/`）

| dsh-bridge 需求 | 使用的官方能力 |
| :--- | :--- |
| 长连接 / 重连 / 看门狗 | `createLarkChannel({ transport:'websocket', keepalive:{enabled:true} })` + `connect()` / `disconnect()` |
| 入站消息 | `channel.on('message')` → `ctx.emit('feishu/message')` |
| 审批按钮 | `channel.on('cardAction')` → `ctx.emit('feishu/action')`，handler 返回 `{ toast }` 作为点击反馈 |
| 普通回复 / 指令输出 | `channel.send(chatId, { markdown })` |
| 轮次内流式输出 | `channel.stream(chatId, { markdown })`（`lib/feishu/node.js` 持控制器，`turn/end` 收尾） |
| 审批卡片 | `channel.createCard(cardJson)` → `channel.send(chatId, { cardId })` → `channel.updateCardById(cardId, cardJson, sequence++)`（**卡片实体 + 原地更新**：决议/超时/取消后原地变结果态；`sequence` 必须严格递增）；卡片实体不可用时回退 `channel.send({ card })` + 文字确认 |
| 附件下载 | `channel.downloadResourceToFile(messageId, fileKey, type, destPath)`（流式落盘） |
| 附件发送 | `channel.send(chatId, { image|file })`，源为 `Buffer`（见下） |
| 一键创建应用 | `registerApp()`（`FeishuService.startRegisterApp()` 管理状态机与持久化） |
| 连接状态 | `reconnecting` / `reconnected` 事件 + `keepalive.onUnrecoverable` → 面板状态 |
| 话题群回复落位 | 入站 `msg.threadId` → 出站 `SendOptions { replyTo, replyInThread }`（非流式 / 流式 / 审批卡片三条路径） |
| 引用消息上下文 | `channel.fetchMessage(replyToMessageId)`（仅普通会话引用；话题群跳过以免每条多一次调用） |
| 策略拒绝留痕 | `channel.on('reject')` → debug 日志（未 @ / 白名单外 / bot 回环） |
| 发送者昵称 | `resolveSenderNames: true`（每会话一次缓存 roster 查询）→ `NormalizedMessage.senderName` |
| 本地文件流式上传 | `outbound.allowedFileDirs`（白名单内传路径，SDK 流式读盘；白名单外回退 `Buffer`） |
| **云文档评论 @机器人** | `channel.on('comment')` + `comments.resolveTarget(fileToken, fileType)`（wiki→obj_token）+ `comments.fetch(target, commentId)` + `comments.reply(target, commentId, text, { topLevel })`；合成 peer `comment:<fileToken>:<commentId>`，出站分流到评论回复 |
| 机器人回环防护 | `policy.botLoopGuard { enabled, windowMs, maxBotMentions, scope, onTrip: 'reject' }` |
| SDK 日志 | `logger` + `loggerLevel: LoggerLevel.warn`（LoggerProxy 要求 logger 具备 error/warn/info/debug/trace 五个方法） |

### 关键设计决定（改动前请先读）

1. **出站一律用 `chat_id`（`oc_…`）**：飞书已限制按用户 `open_id` 主动发消息（HTTP 200 + `code=230101
   Sending messages to users is temporarily unavailable`，见 issue #72 与同类项目实证）。`open_id` 仅用于
   身份（白名单、审批决议者校验）。回归用例见 `test/feishu-service.test.mjs`（"出站目标用 chat_id"）。
2. **媒体用 `Buffer` 而不是本地路径**：`allowedFileDirs` 只能在构造期设定，而工作区目录运行期可变；
   `Buffer` 是 SDK 文档支持的等价源，路径安全由会话桥的 `SEND_FILE` 白名单负责。
3. **`safety.chatQueue.cardActions: 'separate'`**：审批卡片点击与消息处理共用一条会话队列时，
   官方 README 明确会在"消息处理等待卡片点击"场景互锁；独立队列后由应用负责决议者校验（本仓库已在
   `_handleAction` 中按发起者校验）。
4. **不使用 SDK 白名单（`dmAllowlist`/`groupAllowlist`）**：桥内 `allowFrom` 有"首条消息自动授权 + 群聊
   可配自动授权"语义，交给 SDK 门禁会在桥看到消息前就丢弃首条消息，破坏该语义。
5. **不使用 `includeRawEvent` / `resolveChatMode` / `resolveSenderNames`**：不需要原始载荷、话题区分与昵称解析，
   保持载荷精简、不产生额外 `chat.get` 调用。
6. **`sendChunkDelayMs` 仍是「首片打字机步进」**：SDK 的 `streamThrottleMs` 对 `setContent` 无效
   （覆盖式更新立即下发），因此首片仍由桥按配置逐段覆盖，保持既有观感且不产生"配置无效"的死字段。

## 7. 已知边界 / 后续可选项

- `registerApp` 创建的应用**权限、事件订阅随确认页一次性生效**，但可用范围（可见成员）由用户在确认页决定。
- 执行层能力（飞书 CLI：文档 / 日历 / 表格 / 邮件 / 任务）与"远程访问桥"定位无关，未接入。
- 视频/音频消息目前按"文件"下载并投喂本地路径；如需转写需另行接入官方能力。
- `channel.onRawEvent` 可用于未来接入审批、日历等未封装事件（注意它会绕过 SDK 的入站防护）。
