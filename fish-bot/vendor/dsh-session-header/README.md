# dsh-session-header

给 **DeepSeek Harness 的每一次模型请求**自动补上一个稳定的会话头，让自建网关能把
「真正的会话 id」转发给上游。

## 为什么需要它

Harness 的 pi-ai 路由没有留任何请求头注入口：

- `GenerateOptions`（`packages/llm/llm/src/types.ts`）里没有 `headers` 字段；
- `compat` 里唯一能造会话头的两个开关 `sendSessionAffinityHeaders` /
  `sessionAffinityFormat` 在 DSH 的门表（`llm-pi-ai/src/catalog.ts`）对
  **全部协议**都是 `withhold`：写在 route 级静默丢弃，写在模型级直接报错。

所以在配置层做不到。本插件用运行时两件套补上，**不修改 harness 一行源码**：

1. 监听 `llm/stream`（`global` + `prepend`），把本次调用的 `sessionId` 放进
   `AsyncLocalStorage` 作用域；
2. 包一层 `globalThis.fetch`，在请求真正发出的那一刻取回该值写成请求头。

值取自同一条异步链，所以主会话、subagent、`compaction` / `session-title`
辅助调用各带各的会话 id，不会互相串。

> 不能用 provider 配置里的 `headers:` 代替：那是**路由级单值**，并行 subagent
> 会互相覆盖，等于所有会话共用一个 id。

## 启用：热挂载，不重启（推荐）

`patchReload: live` 的 profile 会把用户补丁层里的**新增条目**当场重组进来：不装依赖、
不改 `bundles`、不重启宿主。本仓库把编译产物 `lib/` 一并提交，所以 `git clone` 下来
直接就能挂。

```yaml
# %USERPROFILE%\.dsh\profiles\web\cordis.patch.yml
- insert:
    - id: llm-session-header
      name: file:///D:/Code/dsh-session-header/lib/index.js
      config:
        enabled: true
        headerName: x-session-id
```

`name` 是相对 loader 的 `baseUrl`（= profile 目录）解析的，但相对写法只在插件与
profile 同盘时成立（实测：profile 在 `C:`、插件在 `D:` 时 `../../../` 跨不过去，
报 `Cannot find module ...profiles\web\..\..\..\Code\...`）。所以**一律写绝对
`file:///` specifier** 最省心；POSIX 上换成 `file:///home/you/dsh-session-header/lib/index.js`。

改之前先备份该文件。补丁写坏会被 HMR 拒绝并保留上一个好状态（事务性），
不会打断正在跑的会话；之后把 `enabled` 改成 `false` 就是热卸载注入
（还原 `globalThis.fetch`、摘掉监听）。

## 启用：登记成 bundle（要安装 + 重启，非必要）

只有希望插件随 profile 自动启动（无人值守机器）才走这条路：

```powershell
# 1) 让包可解析（profile 用 hoisted nodeLinker）
notepad $env:USERPROFILE\.dsh\profiles\web\package.json
#   dsh.profile.bundles 追加  "dsh-session-header"
#   dependencies 追加      "dsh-session-header": "link:D:/Code/dsh-session-header"

# 2) 在 profile 目录安装依赖（只装本仓库，不联网取包）
pnpm install --dir $env:USERPROFILE\.dsh\profiles\web

# 3) 重启 dsh（改 bundles / dependencies 必须重启）
```

bundle 自带的 `cordis.patch.yml` 会插入 fiber `llm-session-header`，默认
`headerName: x-session-id`、`enabled: true`。

## 在配置里关闭

编辑 `profiles\web\cordis.patch.yml`（`patchReload: live`，**不用重启**）：

```yaml
# 只关注入，插件仍在场（可看计数）
- id: llm-session-header
  config:
    enabled: false

# 或者整个 fiber 摘掉
- id: llm-session-header
  disabled: true
```

## 配置项

| 键 | 默认 | 含义 |
| --- | --- | --- |
| `enabled` | `true` | 总开关；关掉时既不注册监听也不包 fetch |
| `headerName` | `x-session-id` | 要补的头名（小写、连字符） |
| `extraHeaders` | `[]` | 同一个值再复制到其它头名（直连上游、中间没有网关改名时用） |
| `overwrite` | `false` | 请求里已有同名头时是否覆盖；默认尊重原值 |
| `bodyFallback` | `true` | 作用域丢失时改从请求体 `prompt_cache_key` 取值 |
| `debug` | `false` | 每次 stamp 打一行 debug（只打 host 与路由，不打请求体与鉴权） |

未知键、类型不符、非法头名会在加载期**直接拒绝启动插件**（宁可整个不装，也不要半生效）。

### 刻意拒绝的头名

- 鉴权与传输层：`authorization`、`cookie`、`content-type`、`host` 等；
- `x-deepseek-harness-*`：官方 provider 路由是**成套**发送这个归因头族的
  （`user-id` + `session-id` + `compact`，见 `llm-deepseek/src/adapter.ts`），
  第三方只补其中一个会留下「半套归因」的畸形流量，并可能冒领不属于它的信任。

## 网关侧要配对的一步（以 new-api 为例）

本插件只影响 **DSH → 网关** 这一跳。上游看到的是**网关 → 上游**：网关会自己新建
一条出站请求，客户端头默认不搬运（new-api 的 UA 就是 `Go-http-client/1.1`）。所以
要在渠道上改名转发（渠道设置 → 请求头覆盖 / `header_override`）：

```json
{ "x-opencode-session": "{client_header:x-session-id}" }
```

两个坑：

- `{client_header:x}` 必须是**整个值**，不能拼接（`relay/channel/api_request.go`）；
- 渠道「测试」会跳过 `{client_header:}` 占位符（同文件 `if !info.IsChannelTest`）
  → **别拿测试通过当证据**，要看真实请求之后上游的反应。

换别的网关就找等价能力：把某个客户端头改名转发到上游。网关没有这类能力的话，
插件补的头只能到网关为止。

若客户端某次没带 `x-session-id`，占位符取不到值 → 该头**整个不发**（也不报错）。
所以这条链路依赖本插件「必带」。opencode CLI 自己发的也是 `X-Session-Id`
（HTTP 头名不分大小写），因此这一行同时覆盖 DSH 与 CLI 两类客户端；代价是网关侧
分不出来源，需要区分时给插件配一个自有名的 `extraHeaders`。

## 已知边界

- 只贴「像模型请求」的出口：必须在 `llm/stream` 作用域内，或请求体同时带
  `model: string` 与 `messages`/`input` 数组。同进程里的 GitHub、npm、遥测等
  出口不会被盖章（`seen` 计数会涨，`injected` 不涨）。
- `Request` 形态（openai SDK 走这条）丢了作用域时**不猜**：它的 body 是流，
  同步路径里读不到 `prompt_cache_key`。
- 不走 fetch 的传输（`transport: websocket`）拦不到。
- 卸载时若发现别的补丁已经盖在我们外面，只告警不拆链；重复挂载由 `PATCH_MARKER`
  识别并退让。
- 会话 id 含控制字符时宁可不加（防头部注入）。

## 自检

```powershell
npm run link-dsh -- <本地 DSH checkout 路径>   # 借它的 typescript 与包类型；仓库零运行时依赖
npm test                                          # 编译 + node --test（23 例，含真发 HTTP 的 e2e）
```

日志前缀 `session-header:`；卸载时打一次计数摘要
`seen / injected / already / fromBody / missing / errors`，`errors` 应恒为 0。

## 与「缓存命中」那条改动的关系

把 provider 配成 `cacheRetention: long` 且模型开 `supportsLongCacheRetention`
之后，pi-ai 会把会话 id 写进请求体 `prompt_cache_key`
（`pi-ai/dist/api/openai-completions.js`）。那是**身体里的会话 id**，透传渠道
原样送达上游；本插件是**头上的会话 id**。两者互为兜底，正常情况下取值相同，
可以用 `fromBody` 计数是否增长来判断作用域有没有丢。
