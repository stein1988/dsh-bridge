# QQ Bot 使用指南

本文档介绍如何把 QQ 机器人接入 dsh-bridge：单聊、群聊、C2C 流式输出、按钮交互（审批 / 决策问答）、消息引用与富媒体收发。

> **能力范围**：仅 **单聊 + 群聊**。QQ 频道（guild）与频道私信（dm）不在支持范围——官方 SDK 的高层 facade 不为这两类消息派生 `replyTarget`，`bot.on('message')` 收不到（详见 SDK `USAGE.md` §15.2）；需要时可自行用 `bot.messageApi.sendChannelMessage` 扩展。

> **底层已全面接入腾讯官方 SDK** —— 与飞书侧走官方 Channel SDK 的方式一致：
>
> | 官方包 | 作用 | 在插件中的位置 |
> | --- | --- | --- |
> | [`@tencent-connect/qqbot-nodejs`](https://github.com/tencent-connect/qqbot-nodejs) | 协议层：WebSocket 长连接 + RESUME、access_token 管理、消息/媒体/流式收发、Koa 式中间件链 | `lib/qq/gateway.js` |
> | [`@tencent-connect/qqbot-connector`](https://www.npmjs.com/package/@tencent-connect/qqbot-connector) | 扫码绑定：手机 QQ 扫码后由开放平台回传 AppID + AppSecret | `lib/qq/index.js`（`qrType=bind`） |
>
> 两个包由 `scripts/bundle-qq.mjs` 预打包为 `lib/qq/qqbot-bundled.mjs`（发布物只含 `lib/`，不带 `node_modules`）。
> **本插件不再自研 QQ 协议栈**：心跳、重连退避、关闭码分类、事件归一化、去重、分片上传、流式序列全部由官方 SDK 实现。

## 前置准备

### 方式一：扫码绑定（推荐，免手工复制）

设置页「远程访问」→「IM 机器人」→ 选中「QQ」→ 点 **「扫码绑定机器人」**：

1. 面板渲染二维码（底层是官方 `create_bind_task` 任务）；
2. 手机 QQ 扫码 → 选择要绑定的机器人 → 确认；
3. 插件自动拿到该机器人的 **AppID + AppSecret** 并落盘，随后自动连接；
4. 二维码过期会自动刷新，也可点「🔄 重新生成二维码」立即换新码。

> 扫码页面默认把接入方显示为「第三方机器人」；若希望显示自己的平台名，需联系腾讯 `qq_bot_api@tencent.com`（官方文档：<https://bot.q.qq.com/wiki/agent-qqbot/#第三方-agent-接入>）。

### 方式二：手动填写已有机器人

1. 访问 [QQ 开放平台](https://q.qq.com/) →「机器人管理」→ 创建机器人；
2. 在「开发设置 → 开发信息」取到 **AppID** 与 **AppSecret**；
3. 在设置页填入这两项，点「保存并连接」。

> 旧版本把密钥字段叫 `ClientSecret`，本版已与官方 SDK 统一为 `AppSecret`。
> **旧配置无需手动迁移**：读取时会把 `clientSecret` 自动搬成 `appSecret`，并丢弃自研协议栈时期的
> `accessToken` / `accessTokenExpiresAt` / `gatewayUrl` 残留字段（它们现在由 SDK 内部维护）。

### 机器人权限

- **单聊**：用户加机器人好友即可对话；
- **群聊**：群主把机器人拉进群；默认只处理 `@机器人` 的消息（`GROUP_AT_MESSAGE_CREATE`）；
- **消息类型**：文本 / Markdown / 按钮键盘 / 图片 / 视频 / 语音 / 文件；
- **Markdown 权限**：`msg_type=2` 需要机器人通过内容审核。没有该权限时接口会被平台拒绝，
  插件会自动降级为纯文本（去掉 Markdown 语法），消息仍然可达；
- **IP 白名单**：部分账号要求开放平台后台配置公网 IP 白名单，否则接口调用失败。

## 快速开始

```bash
npm install -g @wenbin_wb/dsh-bridge@latest
dsh web
```

访问 `http://127.0.0.1:3080` → 设置 →「远程访问」→「IM 机器人」→「QQ」→ 扫码绑定或填凭证 → 保存并连接。

连接成功后日志形如：

```
[dsh-bridge qq] 已连接 QQ 开放平台：<bot openid>
[dsh-bridge qq] created c2c command panel: <panel_id>
[dsh-bridge qq] custom menu configured
```

## 白名单

首次对话自动授权：用户私聊发第一条消息，或群聊首次 `@机器人`，该用户/群会自动加入白名单并持久化。

- **私聊**：按 `user_openid` 授权；
- **群聊**：按 `group_openid` 授权（群内任意成员 @机器人 都可驱动 agent）；
- 白名单非空后，白名单外的私聊消息会被忽略（日志 `ignore message from non-allowlisted sender`）。

> `openid` 是**按 AppID 隔离**的：同一用户在两个不同机器人下 openid 不同。换机器人需要重新授权。

## 能力清单与平台限制

| 能力 | 单聊（C2C） | 群聊 |
| --- | --- | --- |
| 文本 / Markdown | ✅ | ✅ |
| 流式输出（`stream_messages`） | ✅ 一条消息原地增长 | ❌ 平台未开放 → 直接发 Markdown |
| 输入状态（`msg_type=6`） | ✅ | ❌ 平台不支持 |
| 按钮键盘（审批 / 问答） | ✅ | ✅ |
| 图片 / 视频 / 语音 / 文件 | ✅ | ✅（≥5MB 自动分片上传） |
| 消息引用上下文 | ✅ | ✅ |
| 被动回复限额 | 每条入站消息 5 次 / 60 分钟 | 5 次 / 5 分钟 |

> 插件按 scope 分别记账（`passiveReplyLimit` 默认 4、`passiveReplyLimitGroup` 默认 5）。
> 注：官方文档对单聊上限的表述不一致——`send.md` 写 5 次，`overview` 与 FAQ 写 4 次；插件默认取**更保守的 4 次**避免触发平台报错，可通过 `passiveReplyLimit` 配置调整。

插件侧行为：

- **被动回复优先**：能挂 `msg_id` 就挂（用户看到的是"回复某条消息"）；超限/过期自动降级为**主动消息**；
- **主动消息有额度**：官方文档写「单聊/群聊每用户（群）**每月 4 条**」，且部分文档标注 **2025-04-21 起主动推送不再提供**（两处表述互相矛盾，以开放平台实际返回为准）。用户也可在 QQ 客户端关闭「允许主动发送」。因此插件的降级路径（被动→主动）**不保证一定送达**；
- **单条上限**：平台约 5000 字符；插件默认按 2000 字符分块（设置页「单条消息上限」可调，最小 200）；
- **撤回**：机器人只能撤回自己发送 2 分钟内的消息。

## 指令与交互

### 指令面板 / 自定义菜单

连接成功后插件自动配置（幂等，已存在则跳过）：

- **指令面板**：c2c 与 group 各一个，含 `/new` `/list` `/resume` `/sessions` `/help`；
- **自定义菜单**：单聊底部三个按钮（新建 / 列表 / 帮助），点击等价于发送对应命令。

> 这两个能力是 QQ 平台 2026-08-12 上线的接口（`/v2/menu`、`/v2/panels`）。官方 SDK 未封装，
> 插件通过 SDK 提供的 REST escape hatch（`bot.api`）调用。若返回成功但客户端不显示，通常是
> **QQ 客户端版本过低**或功能处于灰度阶段——纯文字命令不受影响。

### 斜杠命令

`/new` `/list` `/sessions` `/resume` `/help` `/status` `/model` `/preset` `/diff` `/ask` `/yes` `/no` 等，
与微信 / 飞书 / Telegram 完全一致（见 README 命令速查）。

### 审批按钮

Agent 需要执行敏感工具时，插件发一条 **Markdown + 两个回调按钮**的消息：

- `✅ 允许一次` / `❌ 拒绝`（`button_data` 为 `{"t":"approval","n":<审批编号>,"s":<进程 nonce>,"d":"allow"|"deny"}`）；
  - **`n` 必填**：插件按编号精确定位审批，没有 `n` 的点击一律拒绝（防跨会话误批）；
  - **`s` 为进程 nonce**：进程重启后审批编号会从 1 重来，带 nonce 的旧卡片会失效；
- 归属校验：**单聊**只有发起者本人能点；**群聊**允许群内成员点（与飞书同一模型）；
- 超时（默认 600 秒）自动拒绝；
- 按钮不可用（旧客户端）时，仍可文字回复 `/yes` 或 `/no`。

### 决策问答按钮

`ask_user_question` 单问单选时发卡片：选项全文写进正文，按钮只放短标签（QQ 按钮文字有长度限制），
按钮 `button_data` 为 `{"t":"question","q":<题号>,"i":<选项下标>}`。多选 / 多问 / 自由输入走文字（`/ask`）。

### 消息引用

用户「回复」机器人的某条消息时，官方 SDK 的 `quoteRef` 中间件会从 `msg_elements` 还原被引用原文，
插件把它作为 `[引用消息] …` 前缀交给 agent —— 无需手打命令即可继续上下文。

### 语音消息

QQ 服务端自带语音转文字（ASR）。插件优先用 `asr_refer_text` 作为正文（形如 `[语音] 帮我看看这个报错`），
同时把语音文件下载到会话工作目录。

## 技术实现

### 官方 SDK 承担的部分

| 场景 | 由 SDK 实现 |
| --- | --- |
| 长连接 | HELLO / IDENTIFY / RESUME / 心跳 / 握手超时（30s） |
| 重连 | 按关闭码分类（4004 清 token、4006-4009 重新 IDENTIFY、4008 等 60s、4914/4915 终态不重连）+ 退避 `1s→2s→5s→10s→30s→60s` |
| 鉴权 | `bots.qq.com/app/getAppAccessToken`，缓存 + 提前 5 分钟刷新 + 失效重取 |
| 事件 | C2C / 群@ / 群全量 / 频道 / 频道私信 / INTERACTION_CREATE → 统一 `InboundMessage`（插件只消费前两类 + 互动，见上文「能力范围」） |
| 中间件 | `errorHandler` / `messageFilter`（回声+去重）/ `contentSanitizer` / `rateLimiter` / `quoteRef` / `historyBuffer` / `mentionGate` / `concurrencyGuard` / `typingIndicator` |
| 出站 | 文本 / Markdown / Ark / Embed / 键盘 / 富媒体（<5MB 直传，≥5MB 自动 `upload_prepare → PUT COS → upload_part_finish → complete_upload`） |
| 流式 | `stream_messages`（`input_mode=replace`，节流 ≥300ms，`index` 自增、同一流共享 `msg_seq`） |
| 会话恢复 | `sessionPersistence` 把 `sessionId` + `seq` 落盘，重启后优先 RESUME |

### 插件自己保留的部分

- **会话桥**（`lib/platform/conversation-bridge.js`）：DSH 会话管理、命令路由、审批/问答桥、改动摘要、`[SEND_FILE]` 直发；
- **业务映射**（`lib/qq/gateway.js` + `lib/qq/node.js`）：scope/授权主体映射、被动回复候选与限额、
  附件下载（含 SSRF 防护）、语音 ASR 兜底、流式开关、面板/菜单配置、错误文案；
- **凭证与 UI**：扫码绑定流程、持久化、设置面板、多账号隔离。

### 会话持久化文件

`$DSH_HOME/dsh-bridge/qq-session-<instanceId>.json`（官方 SDK 的 `FileKVStore`）。
删除它不影响凭证，只会让下次启动走一次完整 IDENTIFY 而非 RESUME。

## 排障

| 现象 | 排查点 |
| --- | --- |
| 面板显示「错误」+ `机器人被下线或封禁` | 关闭码 4914/4915：机器人被下线或仅沙箱可用，需到开放平台处理，重启无效 |
| 连不上且日志报 token 失败 | AppID/AppSecret 错误、IP 未加白名单、机器人未上线 |
| 私聊无响应 | 该用户不在白名单（看日志 `ignore message from non-allowlisted sender`）；或用户关闭了主动消息开关 |
| 群聊无响应 | 未 `@机器人`；或群主未授予机器人"接收消息"权限（机器人进群能力需最新版 QQ） |
| 消息发不出、报 markdown 相关错误 | 机器人无 Markdown 权限：插件会自动降级纯文本；若仍失败请看日志中的 `code=` |
| 流式输出变成一条普通消息 | 群聊本来就不支持流式；或本轮的 `msg_id` 已过期（被动回复窗口用完） |
| 按钮点了没反应 | 客户端版本过低（需最新版手机 QQ）；或按钮所属的审批/提问已超时结束 |
| 改了机器人凭证后收不到消息 | 保存后会自动重连；若仍异常，点「重新连接」或检查是否同时开着别的 QQ 插件占用同一 AppID |

日志前缀统一为 `[dsh-bridge qq]`，SDK 内部日志前缀为 `[qq]`。

## 常见错误码

| err_code | 含义 | 处理 |
| --- | --- | --- |
| 40034005 | 回复的 `msg_id` 已过期 | 插件自动降级主动消息，无需处理 |
| 22009 | 消息发送超频 | 降低推送频率 / 等被动窗口恢复 |
| 50056 | 不允许发送 markdown content（**权限**类） | 插件自动降级纯文本后重发，**消息仍可达**；到开放平台申请 Markdown 权限即可恢复富文本 |
| 50055 / 50057 | Markdown **内容/参数**非法（非权限） | **不降级**、原样报错——避免掩盖真正的语法问题；此时消息**不可达**，需修正内容 |
| 304036 / 11253 | 模板权限 / 接口权限缺失 | **不降级**、原样报错；需到开放平台申请对应权限 |
| 304082 / 304083 | 富媒体资源拉取失败 | 重试；检查图片是否可公开访问 |
| 11253 | 应用未获得接口权限 | 到开放平台申请对应接口权限 |
| 11265 | 机器人已被封禁 | 联系平台 |

## 参考

- [QQ 机器人官方文档（API v2）](https://bot.q.qq.com/wiki/develop/api-v2/)
- [Agent 接入（扫码绑定说明）](https://bot.q.qq.com/wiki/agent-qqbot/)
- [官方 Node.js SDK 源码与文档](https://github.com/tencent-connect/qqbot-nodejs)
- [官方扫码绑定包](https://www.npmjs.com/package/@tencent-connect/qqbot-connector)
- [变更记录（域名统一为 api.bot.qq.com 等）](https://bot.q.qq.com/wiki/develop/api-v2/changelog.html)
