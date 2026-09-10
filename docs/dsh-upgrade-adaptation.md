# DSH 宿主升级适配开发（本地联调）

> 本文记录在本地把 dsh-bridge 跑在**当前 DSH 宿主**上做适配开发的方法，以及
> 2026-09-10 针对 DSH `0.1.5-rc.1` 实测到的**宿主 API 不兼容点**（含复现证据与修复方向）。
>
> 版本前提：文中版本号为撰写时的实测值，动手前请先用 `npm view` 复核是否有更新。

## 1. 版本现状（实测）

| 项 | 版本 | 说明 |
|---|---|---|
| 本机全局 DSH 宿主 | `0.1.5-rc.1` | `dsh --version` |
| 本机全局 `@deepseek-ai/cordis` | `4.0.2` | 随宿主内置 |
| 宿主内置 `@deepseek-ai/dsh-llm` | `0.1.5-rc.1` | `dsh/node_modules/` |
| 宿主内置 `@deepseek-ai/dsh-client-connection` | `0.1.5-rc.1` | **本次两个破坏性变更的来源** |
| dsh-bridge `peerDependencies` | `dsh-llm >=0.1.0-rc.6`、`cordis ^4.0.1` | 范围较宽，本身不阻塞 |
| dsh-bridge `devDependencies` | `dsh-llm 0.1.5-rc.1`、`cordis ^4.0.2` | ✅ 已对齐（原为 `0.1.0-rc.6`，落后 6 个版本） |
| npm 上 dsh-llm 最新 | `0.1.5-rc.1`（`next` tag） | `latest` tag 仍是 `0.0.1-rc.1`（历史遗留，勿用） |

复核命令：

```bash
dsh --version
node -e "console.log(require('/home/lonbon/.config/nvm/versions/node/v24.20.0/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-client-connection/package.json').version)"
npm view @deepseek-ai/dsh-llm dist-tags --json
```

## 2. 本地联调环境的搭法

### 2.1 把工作区挂进 web profile（软链，改完即生效）

```bash
cd /home/lonbon/Developer/projects/dsh/dsh-bridge
dsh plugin --profile web add .
```

它会做两件事，缺一不可：

1. 在 `~/.dsh/profiles/web/package.json` 的 `dependencies` 写入
   `"@wenbin_wb/dsh-bridge": "link:/home/lonbon/Developer/projects/dsh/dsh-bridge"`（**软链**，不是拷贝）；
2. 因为 dsh-bridge 的 `package.json` 声明了 `dsh.bundle.patch`，把它追加进
   `dsh.profile.bundles` —— **只有进了 bundles 才会被加载**。

> ⚠️ 只让 `node_modules/@wenbin_wb/dsh-bridge` 出现软链、但 `dsh.profile.bundles`
> 里没有它时，插件**完全不会加载**（`--dump-config` 里没有 `dsh-bridge` 行）。
> 用 `dsh plugin --profile web add .` 而不是手动 `ln -s`。

校验插件确实进了组合树：

```bash
dsh --profile web --dump-config | grep -A2 "dsh-bridge"
# - id: dsh-bridge
#   name: '@wenbin_wb/dsh-bridge'
```

### 2.2 改代码 → 生效方式

| 改动位置 | 生效方式 |
|---|---|
| `lib/**`（Host） | **必须重启 DSH 实例** |
| `client/index.js`（Client 源码） | `node client/build.mjs` 重新构建，然后**刷新浏览器页面** |
| `client/client.js` | 构建产物，**不要手改** |
| `package.json`（版本号等） | 重启 DSH 实例 |

### 2.3 起一个不干扰现有会话的联调实例

当前机器上 `127.0.0.1:3080` 已有一个正在跑的 DSH（本会话所在的宿主），
不要动它。另起一个实例联调：

```bash
cat > /tmp/dsh-dev-overlay.yml <<'EOF'
# 覆盖层：重建 webserver 行（拿默认 config）并把端口挪到 3099
- id: webserver
  name: '@deepseek-ai/dsh-host-webserver'
  inject:
    - webStartup
  config:
    host: '127.0.0.1'
    port: 3099
EOF

cd /home/lonbon/Developer/projects/dsh/dsh-bridge
dsh web --patch /tmp/dsh-dev-overlay.yml --no-open
```

> ⚠️ **`dsh web --port 3099` 会被 profile 自己的 `cordis.patch.yml` 覆盖**。
> 因为 `~/.dsh/profiles/web/cordis.patch.yml` 把 `webserver.port` 写死成 3080，
> 而 `--port` 走的是 `webStartup` 缺省值，优先级低于 profile 用户层，结果仍然
> 去抢 3080 → `EADDRINUSE`。**改端口必须用 `--patch` 覆盖层**（overlay 最后应用，优先级最高）。

联调实例与现有实例的端口分工：

| 端口 | 用途 |
|---|---|
| 3080 | 你正在用的 DSH（不要动） |
| 3099 | 联调实例（`--patch` 覆盖层指定） |
| 3082 | dsh-bridge 自己的局域网代理端口（插件启动后才监听） |

### 2.4 分段定位：先关掉 dsh-bridge 确认宿主本身没问题

```bash
cat >> /tmp/dsh-dev-overlay.yml <<'EOF'
- id: dsh-bridge
  disabled: true
EOF
```

关掉后实例能正常起在 3099（已实测），说明宿主组合树正常，问题出在插件本身。

### 2.5 不需要起实例的快速回归

```bash
npm test          # 193/193 通过（2026-09-10 实测，60650ms）
npm run lint      # 0 error，29 warning（均为既有 warning）
npm run build:client
```

**注意**：`npm test` 是纯单元测试，**不加载真实 DSH 宿主**，
所以它对宿主 API 的破坏性变更**完全不敏感**——本次两个不兼容点全都能通过 193 项测试。
真正的适配验证只能靠 2.3 的真实实例启动 + 浏览器面板。

## 3. 实测到的宿主 API 破坏性变更（DSH 0.1.5-rc.1）

### 3.1 阻塞级：`ctx.connection.rpc.handle()` 直接抛错，插件加载失败

**现象**（用 2.3 的实例启动，日志原文）：

```
Error: dsh: plugin tree failed to load: failed to apply loader entry dsh-bridge
(@wenbin_wb/dsh-bridge): cannot get property "webServer" without inject
    at installBridgeRpc (/home/lonbon/Developer/projects/dsh/dsh-bridge/lib/bridge-rpc.js:90:29)
    at apply (/home/lonbon/Developer/projects/dsh/dsh-bridge/lib/index.js:2054:22)
```

**调用点**：`lib/bridge-rpc.js:90`

```js
return ctx.connection.rpc.handle(
  BRIDGE_RPC_CHANNEL,
  async (endpoint, payload = {}, signal) => { ... },
);
```

**根因**（已用最小 cordis 探针验证，非猜测）：

宿主 `@deepseek-ai/dsh-client-connection@0.1.5-rc.1` 的实现是：

```js
const connection = new HostConnectionService(ctx, trustedHosts, browserAuth); // ← 连接插件自己的 ctx
// ...
get rpc() {
  const owner = this.ctx;                                    // ← 提供方（连接插件）的 ctx
  return { handle: (channel, handler) => this.register(owner, channel, handler) };
}
register(owner, channel, handler) {
  return owner.effect(() => owner.webServer.register(route), ...);  // ← 在提供方 ctx 上取 webServer
}
```

而连接插件的 `inject` 只有 `["credentials"]`，`webServer` 是在它内部
`ctx.inject(["webServer"], (webCtx) => ...)` 的子上下文中才有的。于是
`owner.webServer` 必然抛 `cannot get property "webServer" without inject`。

最小探针（复刻该结构）实测结论：

| 尝试 | 结果 |
|---|---|
| 消费方 `inject: ['connection','webServer']` 后直接 `ctx.connection.rpc.handle()` | ❌ THROW |
| 用 `ctx.inject(['webServer'], (webCtx) => webCtx.connection.rpc.handle())` | ❌ THROW（owner 仍是提供方 ctx，换个包裹层无效） |
| 消费方直接用 `ctx.effect(() => ctx.webServer.register({kind:'prefix', path:'/dsh-bridge', handler}))` | ✅ OK |

即：**`connection.rpc` 的注册归属是"提供方 fiber"，插件无法通过任何 ctx 包装改变它。**

**修复方向**（已按方案 A 落地，见 §4）：

- **方案 A（推荐）**：在 `apply` 里用插件自己的 `ctx`（`webServer` 已在 inject 里）直接
  `ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-bridge', handler }), ...)`
  ，在这个 handler 里**自己实现 connection 的 RPC 信封协议**。需要复刻的信封很小
  （宿主 `dsh-client-connection` 的 `rpcFetchHandler`）：
  - 校验 `content-type: application/json`；
  - 解析 `{ type: 'client-request', rpcId, method, payload }`；
  - `method` 必须等于路径尾部端点名，否则回 `gateway/bad-request`；
  - 回 `Response.json({ type: 'server-response', rpcId, result })`；
  - 客户端**无需改动**：`client/index.js:4980` 仍走 `ctx.connection.rpc.call('/dsh-bridge', ...)`，
    它只关心信封，不关心宿主侧是谁注册的。
  - 旧版本兼容：保留 try/catch，`connection.rpc.handle` 可用时走老路，抛错时回退到直连路由。
- **方案 B**：等上游给 `connection.rpc` 加回通道级注册能力（属上游 API 变更，需提 issue）。
- **方案 C**：`inject` 改对象格式（`{ required: [...], optional: [...] }`）—— 已验证**解决不了**这个问题，
  因为问题不在 dsh-bridge 自己的 inject，而在连接插件的 ctx。

### 3.2 `handle()` 丢掉了 `options.authority === 'loopback'`

| | `dsh-client-connection@0.1.0-rc.6` | `@0.1.5-rc.1` |
|---|---|---|
| `handle` 签名 | `handle(channel, handler, options)` | `handle(channel, handler)` —— **options 参数已删除** |
| loopback 钉死 | `register()` 内 `options.authority === 'loopback'` → 只信回环 | **无此机制** |

**影响评估：不是新的安全缺口。** dsh-bridge 自己
（`lib/bridge-rpc.js` 的 `checkAdminAuth`）本来就不依赖该选项：
`adminToken` 全程服务端校验，并且明确注释了「绝不依赖客户端自称的 isLocalhost」。
丢掉的只是宿主那一层冗余防线。修复时应把这条语义显式写回插件自身（见 3.3）。

### 3.3 建议同时做掉的加固

既然宿主不再提供通道级 loopback 钉死，建议在插件侧补回等价约束：
在 `handler` 入口对管理类端点（`BRIDGE_ENDPOINTS` 里涉及凭据/隧道/升级/重启的那些）
拒绝非回环 `Host`（`isTrustedApiRequest` 那套判定），或直接要求 `adminToken`，
以免以后有人误以为"宿主已经帮我钉了回环"。

## 4. 已落地的修复（方案 A）

改动文件：`lib/bridge-rpc.js`（`installBridgeRpc` 重构 + 新增自注册传输层）。

### 4.1 做法

1. 把原来的端点 dispatcher 抽成 `endpointHandler(endpoint, payload, signal)`，逻辑一行未改；
2. 新增 `createRpcRouteHandler(channel, handler)`：用**插件自己的 `ctx`** 通过
   `ctx.effect(() => ctx.webServer.register({ kind: 'prefix', path: '/dsh-bridge', handler }), ...)`
   注册同名前缀路由，并在其中自行实现 Connection 的信封协议：
   - 仅 `POST`（否则 405）、要求 `application/json`（否则 415）、路径需在 `/dsh-bridge/` 前缀内（否则 404）；
   - 解析 `{ type: 'client-request', rpcId, method, payload }`，`method` 必须等于路径尾部端点名（否则 `gateway/bad-request`）；
   - 回 `{ type: 'server-response', rpcId, result }`；处理函数自身抛错时按宿主约定回 500 文本。
3. 注册策略：优先 `webServer` 直连（新宿主唯一可行），失败或不可用时回退旧的
   `ctx.connection.rpc.handle`（旧宿主），两者都不可用才告警并返回空 disposer。

**客户端零改动**：`client/index.js` 仍调用 `ctx.connection.rpc.call('/dsh-bridge', ...)`，
只关心信封，不关心宿主侧由谁注册。

### 4.2 验证结果（2026-09-10，实例 127.0.0.1:3099）

| 检查项 | 结果 |
|---|---|
| 插件加载 | ✅ 不再报 `without inject`；启动日志仅 3 行、**零 error/warning** |
| dsh-bridge 自身服务起效 | ✅ 局域网代理监听 `0.0.0.0:3082` |
| RPC 通道 | ✅ `POST /dsh-bridge/getStatus` → 200 + 正确信封（含 `dshVersion: 0.1.5-rc.1`） |
| 协议错误分支 | ✅ GET 405、非 JSON 415、前缀外 404、method 不匹配 `gateway/bad-request`、未知端点 `bad-request` |
| 读取类端点回归 | ✅ `listPlatforms` / `listWorkspaces` / `getSystemMetrics` / `diagnoseNetwork` / `checkVersion` / `authGetStatus` 全部 `ok:true` |
| `npm test` | ✅ 193/193 |
| `npm run lint` | ✅ 0 error（29 warning 均为既有） |
| 浏览器 UI 级验收 | ✅ 使用者打开 3099 后确认 **dsh-bridge 设置面板正常显示** |

### 4.3 仍然遗留的两点

1. **loopback 钉死的语义缺口未完全消除（§3.2）**：`webServer` 直连路由是**任何走到宿主 HTTP 服务器
   的请求**（含 `--trusted-host` 放行的隧道/LAN 访客）都能命中 `/dsh-bridge/*`，其"仅本机"
   约束只剩插件自己的 `adminToken` 校验。`adminPolicy==='local_only'` 要求有效 `adminToken`，
   语义仍成立；但**默认 `adminToken` 已经存在，无密码时 `adminProtection` 打开会强制先设密码**。
   如果要把这层防线补回来，需要在 handler 入口加请求 Host/Origin 判定——注意
   **不能**用 `req.socket.remoteAddress` 判断本机，因为 dsh-bridge 自己的代理以回环转发，
   所有远程流量也会显示为 `127.0.0.1`（`lib/bridge-rpc.js` 里对此已有注释）。
2. **单测不覆盖传输层** —— ✅ 已补：`test/bridge-rpc-transport.test.mjs`（15 项）直接构造
   `IncomingMessage`/`ServerResponse` 替身，把信封形状（`server-response` + `rpcId` + `result`）
   与全部分支钉死：合法请求透传、`rpcId` 原样回传、method 不匹配 `gateway/bad-request`、
   405 / 415 / 400 / 404、handler 抛错转 500、超限请求体拒绝、路径穿越不逃出前缀。
   为此 `lib/bridge-rpc.js` 额外导出了 `createRpcRouteHandler` / `isRpcRequestEnvelope` / `writeJson`。
   注意：这些仍是**纯单测**，不加载真实宿主，不能替代 §2.3 的实例启动验证。

## 5. 事故记录：不要在宿主进程内起后台实例（2026-09-10）

### 5.1 现象

联调过程中，**正在使用的 DSH 宿主（`127.0.0.1:3080`）连同当前会话一起被 SIGTERM 杀掉**，
浏览器里正在用的 UI 直接失联。

### 5.2 原因

当时用了这种写法起联调实例：

```bash
# ❌ 危险：绝不要在宿主进程内部这样起实例
(timeout 240 dsh web --patch /tmp/dsh-dev-overlay.yml --no-open > /tmp/dev.log 2>&1 &)
```

`timeout 240` 到点后按进程组收尾，而**这个后台实例与宿主、与执行命令的 shell 处于同一进程组**，
于是宿主被一并带走。

叠加因素：在宿主内部跑了**长耗时的 `npm test`（193 项，约 60 秒）并套 10 分钟超时**，
属于不该从宿主会话里发起的长任务，增加了被中断/连带清理的概率。

### 5.3 规矩（写在这里，避免复犯）

1. **不要在宿主进程内部起任何后台实例**——包括 `... &`、`nohup`、`setsid`，尤其不要套 `timeout`；
2. **联调实例由人在自己的终端前台起**，Ctrl-C 结束；宿主的 3080 与联调实例互不影响；
3. **不要在宿主内部跑 `npm test` / `npm run lint` 这类长任务**，放到自己的终端里跑；
4. 确需在宿主内部起常驻进程时，必须脱离进程组（`setsid`）且**不加 `timeout`** ——
   但首选仍是第 2 条。

### 5.4 事故未造成损失

宿主由使用者重启后恢复正常；仓库改动（`lib/bridge-rpc.js`）、新增文档、profile 注册
（`dsh.profile.bundles` 含 `@wenbin_wb/dsh-bridge`）**全部完好**。

## 6. 状态与后续

| 项 | 状态 |
|---|---|
| 工作区挂进 web profile | ✅ 已配好（`dsh.profile.bundles` 含 `@wenbin_wb/dsh-bridge`） |
| 关掉插件时宿主可正常起在 3099 | ✅ 实测通过 |
| **打开插件时插件可加载** | ✅ 已修复（§4），启动零 error/warning |
| **RPC 通道端到端可用** | ✅ 已用 `curl` 实测（§4.2） |
| `npm test` / `lint` / `build:client` | ✅ **208/208**（193 原有 + 15 新增传输层）、0 error、构建产物哈希稳定 |
| `devDependencies` 对齐到 `0.1.5-rc.1` | ✅ 已对齐：`dsh-llm → 0.1.5-rc.1`、新增 `cordis ^4.0.2`（`package.json` + `package-lock.json`） |
| 写类端点真实操作验证 | ✅ 16/16 通过，见 §8 |
| 浏览器打开 3099 面板做 UI 级验收 | ✅ 使用者确认 dsh-bridge 设置面板正常显示 |
| `createRpcRouteHandler` 单测 | ✅ 已补 15 项（`test/bridge-rpc-transport.test.mjs`，§4.3） |
| **会话链路（sessions/sessionPersistence/workspaceRegistry/agents/approval）静态契约审计** | ✅ 已做，发现并修复 2 处静默失败（§7） |
| **IM 端到端消息链路真实跑通** | ⬜ 未做：需要已绑定的 IM 平台账号（当前 `config.json` 无任何平台凭据），或由使用者扫码登录一次 |
| 其余宿主服务 API 逐项核对 | 🟡 部分覆盖：`workspaceRegistry`（`listWorkspaces`）、`authManager` 全链路读写已验证；`sessions`/`agents`/`approval`/`sessionPersistence` 只在单测里覆盖，**尚未在真实宿主上走到** |

> **验证顺序提示**：插件现在能加载了，所以后续不兼容会以「调用某个端点时返回错误」的形式出现，
> 而不是「插件加载失败」。用 §4.2 的 `curl` 探测法逐个端点打一遍是最快的排查方式。

## 7. 会话链路审计发现的第二类缺陷（静默失败）

§3.1 是**显式**破坏（插件加载失败），好发现。第二类更隐蔽：**调用宿主上并不存在的方法，
但被 `?.` 守卫或 `catch {}` 吞掉**，插件照常加载、UI 照常打开，只是功能悄悄失效。
本节记录已发现并修掉的两处。

### 7.1 `sessionPersistence.load()` / `.update()` 在 0.1.5 下都不存在

宿主 `SessionPersistence` 的真实契约（`dsh-session-persistence/lib/types/index.d.ts`）只有：

```ts
abstract create(header, options?): Promise<SessionHandle>
abstract open(id, access, options?): Promise<SessionHandle>
abstract flush(): Promise<void>
abstract stat(id, options?): Promise<SessionPersistenceSnapshot | undefined>
abstract list(options?): Promise<readonly SessionPersistenceSnapshot[]>
```

**没有 `load()`，也没有 `update()`**。而：
- `session-catalog.js` 用 `sessionPersistence.load(id)` 读事件来折叠标题；
- `commands.js` 的 `/rename` 用 `sessionPersistence.update(id, { title })` 持久化标题。

两处都有 `.catch(() => {})` / 存在性守卫兜着，所以**不报错**，表现为：
IM 里所有「冷会话」（不在内存里的）标题都退化成「新会话」，`/rename` 只改内存、重启即丢。

### 7.2 `list()` 返回的是 snapshot，不是扁平 header

官方 `list()` 返回 `{ header: { id, createdAt, cwd }, revision, ... }`，
**事件内容不在 snapshot 里**（只有 `header` + `revision` + 可选 `eventCount`/`sizeBytes`）。
旧代码按 `h.id` / `h.createdAt` 读，等于全取到 `undefined`；要拿事件必须
`open(id, 'read')` → `handle.read()` → `{ events }` → `close()`。

### 7.3 已落地的修复

| 位置 | 修复 |
|---|---|
| `lib/platform/session-catalog.js` | 新增 `readStoredEvents()`：走官方 `open(id,'read')` + `handle.read()` + `close()`；新增 `normalizeStoredEntry()` 把 snapshot 归一化（同时兼容扁平形态）；两处 `load()` 调用全部替换 |
| `lib/platform/commands.js` | `/rename` 改用官方 `ctx.get('sessionTitle').rename(session, title)` —— 它会把 `session/title` 事件 append 进会话日志，**这才是持久化的正确入口**（`rename` 还会拒绝空标题并 supersede 自动命名） |
| `test/platform-bridge.test.mjs` | 归档过滤用例的持久化替身改成**真实 snapshot 形状 + open/read**，并断言冷会话标题确实折叠出来了 |
| `test/enhanced-features.test.mjs` | `/rename` 用例改用 `sessionTitle` 替身；旧替身提供的 `sessionPersistence.update` 根本不存在，属于**假绿** |

### 7.4 顺带核对通过的宿主契约（静态审计）

| 调用点 | 宿主真实契约 | 结论 |
|---|---|---|
| `ctx.sessions.create(id?, { meta })` | `create(id?, options?)` | ✅ |
| `ctx.agents.create({ sessionId, meta, agentOptions })` | `CreateAgentOptions` 正是这三个字段，工厂读 `options.sessionId`/`options.meta` | ✅ |
| `ctx.agents.resume({ resumeSessionId, agentOptions })` | `ResumeAgentOptions` 同形 | ✅ |
| `ctx.workspaceRegistry.create(path, title)` | 真实方法 `create(path, title)`（旧 `add`/`register` 为兜底） | ✅ |
| `ctx.on('approval/request', (req, next))` | 宿主 `waterfall`，签名 `(req, next)`；**scope-filtered** | ✅ 见下 |
| `inject` 列表 7 项 | `connection`/`webServer`/`sessions`/`agents`/`approval`/`workspaceRegistry`/`sessionPersistence` 均有真实提供者 | ✅ |

**关于 approval 的作用域**：宿主文档写明 `approval/request` 是
`Scoped<Agent>` 且「agent-scoped listeners receive only that agent」。但
**未加作用域过滤的监听器仍会收到全部事件**（`@deepseek-ai/dsh-scope` 的 carrier filter
只在带 scope 的监听器上生效），因此 `conversation-bridge.js` 用不带 scope 的
`ctx.on(..., { prepend: true })` 注册、再自己用 `ownsAgent(req.agent)` / `_turnPeers` 判定归属，
是**正确**设计，不是缺陷。本轮未做真实 IM 端到端验证（见 §6 状态表最后一行）。

### 7.5 教训：这类缺陷怎么提前发现

`?.` 守卫和 `catch {}` 会把「API 已不存在」伪装成「运行时不需要」。排查手段：

1. **凡是对宿主服务的调用，逐个对照宿主的 `.d.ts` 契约**，而不是只看单测是否绿；
2. 单测替身**必须照抄真实契约的形状**（本次两个假绿用例都是替身自己造了一个不存在的 API）；
3. grep 所有 `?.` / `catch {}` 包住的宿主调用，逐个确认「为什么这里需要防抖」——
   如果理由是"不确定这个 API 在不在"，那就是风险点。


## 8. 写类端点验证（可逆往返）

写类端点不能盲测（会改真实配置），采用**可逆往返 + 前置守卫**：

- **前置守卫**：先读 `authGetStatus`，若已存在任何密码则**立即中止且不写入**（避免破坏使用者现有配置）；
- **可逆操作**：只做「设置访问密码 → 校验写入生效 → 清空密码」的闭环，最后复核回到初始状态；
- **顺带覆盖权限守卫**：无 `adminToken` 的敏感写入必须被拒。

实测结果（2026-09-10，16/16 全部通过，配置已还原）：

| 检查 | 结果 |
|---|---|
| 设置访问密码（初始无密码，不需 token） | ✅ |
| 回包 `hasPassword=true` 且**不泄漏明文密码** | ✅ |
| 无 `adminToken` 的敏感写入被拒（`需要管理员权限…`） | ✅ |
| 错误密码解锁失败 | ✅ `管理员密码错误` |
| 正确密码解锁 → 拿到 `adminToken` | ✅ |
| 带 `adminToken` 的敏感写入通过，`scope` 改为 `lan_only` | ✅ |
| `scope` 变更后旧 `adminToken` 失效（**预期语义**，非缺陷） | ✅ |
| 清空密码 / `scope` 还原 `all` / `enabled` 不变 | ✅ |

两个值得记录的坑（都不是适配缺陷）：

1. `scope` 合法值只有 **`all` / `public_only` / `lan_only`**（`lib/auth/manager.js` 的 `setScope` 白名单）。
   传别的值会被**静默忽略**（不报错、不改动）——排查时要留意这种"看似成功实则没生效"。
2. **`setScope` / `setPassword` 会清空 `adminSessions`**，即手里正在用的 `adminToken` 会**立即失效**。
   写类端点如果连续两次敏感写入，第二次会因为 token 被上一步吊销而报「需要管理员权限」，
   需重新解锁。这是既定的安全语义，不是回归。

