# 容器架构修复交接 · 2026-10-27（Asia/Shanghai）

## 根因与实现

旧入口先把持久配置复制到 `/opt/qq-bridge/config.json`，随后只更新持久副本的 DSH launch token，后台同步又用旧工作副本覆盖持久副本。只读复现：旧令牌 HTTP 401；本轮令牌可交换 Cookie 并调用 DSH RPC。

现在桥接 12 处配置读写、SnowLuma MCP 与 host MCP 均使用 `QQ_BRIDGE_CONFIG_FILE=/data/bridge-config.json`；补丁对固定源码锚点与次数进行构建检查。上游配置保存仍走原子写入。迁移先本地备份，以实际运行配置保留用户设置，再更新连接字段。

DSH `0.2.1-rc.2` 与 SnowLuma `v2.2.0` 未升级；QQ 桥接源码固定 `a49877f4e58d04e47532d44b803360d0f001160d`。DSH 允许服务名 `fish-bot:3080`，内部私网鉴权允许非回环目的地；管理端口仍绑定宿主回环。没有修改 QQ 白名单或现有 profile。

进程监督覆盖 DSH、桥接、控制台代理。正常停止等待 25 秒，Docker 外层宽限 35 秒；关键进程异常退出触发容器重启。健康检查区分服务就绪与 QQ 登录，登录失效不会自动重启 QQ。

## 新增状态接口

桥接管理端 `/api/status` 新增 `dsh`：`connected`、`eventStreamConnected`、`errorKind`、`httpStatus`、`lastConnectedAt`、`lastErrorAt`。错误只使用预定义类别，不返回原始异常、令牌或聊天内容。会话级 agent 响应不增加管理诊断字段。原有 `dshReady` 等字段保留。

事件流连接以客户端原生 onOpen 回调判断，不能要求空闲流收到业务帧；关闭时清除状态。`connected` 表示最近 RPC 探测成功，`lastConnectedAt` 是最近一次成功探测时间。

## 验证记录

- 本地 runtime 单测 2 项；上游 inbox 投影纯函数回归 12 项通过。
- 构建锚点与 JavaScript 语法、Compose 配置、PowerShell 语法检查通过。
- 隔离容器实测非法配置被拒绝，未启动 DSH。
- 稳定服务名鉴权、RPC、事件流、OneBot HTTP/WS、QQ 在线及面板状态一致。当前令牌可用、升级前旧令牌返回 401；管理控制台缺令牌返回 401，外部 Host/Origin 返回 403，keep-alive 复用及正常本机 Origin 通过。
- 原子写配置后立即重启保留；DSH、桥接、代理分别退出后容器恢复；单独重启网关恢复；整套优雅停止退出码均为 0；第一轮整套启停及容器重建通过。
- 第二轮重复 QQ 启停后，QQ 客户端提示“用户身份已失效”，需用户重新登录；没有通过删除登录态或反复重启绕过。用户重新登录后已确认恢复，并再次完成 fish-bot 重建验收。
- 主人私聊模型测试已通过：一次控制台投递，模型调用发送工具，桥接记录实际发送成功；未向群聊发送测试消息。验收标识 `LINKCHECK-1793076968683`，不记录主人账号或私聊内容。
- 与升级前实际运行配置比对，owner、allow/deny、模型、角色和其它用户设置保留；profile package 与 patch 文件 SHA256 保持一致。
- 桥接 production 锁文件审计为 0 项漏洞，范围仅为桥接依赖树，不扩大为镜像或全机安全结论。

## 当前产物

已部署 fish-bot 镜像标识 `sha256:cb36dbf12ff0a23e83a2718eb00bd8e373258eb1671445207090e1b1fdf0625b`；SnowLuma 使用原 `v2.2.0`。桥接锁文件和构建定义随本次源码提交，未创建或覆盖上游发行标签。

## 本地回滚材料（不上传 GitHub）

完整停机备份位于 `D:\deepseek_flash\backup\volumes\20261027-architecture-v2`，含四卷 tar.gz、SHA256 manifest、升级前工作/持久配置以及旧容器 rootfs。

旧镜像摘要无法再次标记或 commit，因此从旧容器导出 rootfs 后导入为 `dafeiyu/fish-bot:rollback-20261027`；已验证 node/dsh 和原入口文件可解析。该镜像和备份含本地配置，禁止推送镜像仓库或源码仓库。

回滚应先停止 fish-bot；如仅回退运行程序，恢复备份中的 bridge-config 与原配置位置，使用回滚镜像、原 Compose（Git 中升级前提交 `43d69c5`），保留同名卷。完整数据回退必须先离线备份当前卷，再按 manifest 将四卷归档恢复到对应卷；恢复会回到备份时间点，之后新增的聊天与设置需单独保留。不得使用 `down -v`、强制覆盖用户源码或删除卷解决问题。

QQ 登录由腾讯侧决定；本地卷保留不能保证服务端永不要求重新扫码。恢复 QQ 身份应由用户完成。
