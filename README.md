# 大肥鱼部署代码

本机 Docker Compose 部署：SnowLuma（QQ 接入端）+ fish-bot（专用 DSH 与桥接）。

> 这里只放**代码与模板**。运行期配置、登录态、聊天与记忆数据都在 Docker 命名卷里，不入库。

## 结构

```
├─ docker-compose.yml              双容器编排
├─ fish-bot/
│  ├─ Dockerfile                   专用 DSH + qq-bridge 镜像
│  ├─ entrypoint.sh / runtime.mjs  容器入口与进程监督、鉴权就绪检查
│  ├─ console-proxy.mjs            桥接控制台端口转发
│  ├─ bootstrap-profile.mjs        专用 DSH profile 初始化
│  ├─ migrate-memory.mjs           会话记忆迁移
│  └─ apply-*.mjs                  本地补丁
├─ config/
│  ├─ bridge-config.template.json  桥接配置模板（已脱敏）
│  └─ role-大肥鱼.md                角色卡种子
└─ scripts/                        PowerShell 运维脚本
```

## 端口（全部只绑 127.0.0.1）

| 用途 | 宿主端口 | 说明 |
| --- | --- | --- |
| noVNC 扫码 | 16081 | 容器内 6081 |
| SnowLuma WebUI | 16082 | 容器内 5099 |
| 桥接控制台 | 13100 | 代理到容器内 3100 |
| 专用 DSH | 18080 | 容器内 3080 |
| OneBot HTTP/WS | 不发布 | 只在 `dafeiyu-net` 私网 |

宿主默认动态端口区间是 1024–15000，SnowLuma 默认的 3000/3001/5099/6081 都落在其中，长时间运行有被临时端口抢占的风险，因此宿主侧改用 16xxx 段。

## 数据卷（不入库）

| 卷 | 挂载点 | 内容 |
| --- | --- | --- |
| `qq-client-config` | `/app/.config` | QQ 客户端配置与**登录态** |
| `qq-client-data` | `/app/.local/share` | QQ 缓存 |
| `qq-gateway-data` | `/app/data` | SnowLuma 配置、消息库 |
| `fish-bot-dsh` | `/data` | 桥接配置、角色、DSH 会话与记忆 |

> 注意：登录态实际落在 `qq-client-config`，`qq-client-data` 基本为空。

## 配置持久化与连接

运行期唯一配置为 `/data/bridge-config.json`。构建补丁将桥接所有配置写入和 MCP 读取指向该文件；保存仍使用同目录临时文件加原子 rename，不再复制两个副本，也不依赖定时同步。

`/opt/qq-bridge/config.json` 仅作旧只读工具的兼容链接。首次升级前将旧运行配置保存为 `/data/bridge-config.pre-upgrade-live.json`，运行管理器先备份旧运行与持久配置，再保留运行配置里的用户设置、刷新本轮连接令牌。迁移由 `/data/architecture-v2-migrated.json` 标记，仅执行一次。

DSH 使用具体容器网卡监听；桥接通过稳定地址 `http://fish-bot:3080` 连接，DSH 原生 `--trusted-host fish-bot:3080` 接受该服务名。OneBot 使用 `snowluma:3000/3001`，分别发现 HTTP 和 WS 令牌；HTTP 候选必须通过当前账号连通验证。宿主全部管理端口仍仅绑定 `127.0.0.1`。

`runtime.mjs` 监督 DSH、桥接和控制台代理：任一关键进程退出即停止其它进程，由 Docker 的 `unless-stopped` 恢复整套服务；收到正常停止信号时转发到进程组并等待退出。两个容器的停止宽限为 35 秒。

健康检查分层：SnowLuma 检查管理服务；fish-bot 检查桥接鉴权、DSH RPC 和事件流连接。QQ 登录/OneBot 异常由面板单独显示，不通过反复重启 QQ 处理。空闲流没有业务帧也可正常在线。

## 构建与回归

Node 基础镜像固定 digest，DSH、qq-bridge、记忆与心情插件固定已用版本或提交。`fish-bot/qq-bridge.package-lock.json` 是本部署审计后的桥接锁文件，通过 `npm ci` 构建；运行配置、登录态和面板 runtime 不进入构建上下文。

```powershell
node --test tests/runtime.test.mjs
docker compose config --quiet
powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1
```

`tests/integration_runtime.py --live-restarts` 会真实启停容器，仅在用户授权的维护窗口执行。`tests/owner_e2e.mjs --send-owner-test` 只能在容器内显式执行，会向配置里的主人私聊发送模型测试消息；不用于日常健康检查。

备份必须停下全部卷写入者后执行 `scripts/backup.ps1`；归档以只读挂载生成、逐一校验并记录 SHA256。任何备份失败都中止升级。版本记录与回滚步骤见 `docs/OPERATIONS-2026-10-27.md`。

## 首次部署

1. 复制模板：`cp config/bridge-config.template.json <卷>/bridge-config.json`
2. 在桥接控制台填入**真实** ownerQQ 与白名单（模板里是占位值 `1000000001`）
3. 确认 `allowAllWhenEmpty` 为 `false`——`entrypoint.sh` 会在启动时断言，为 `true` 直接拒绝启动

## 安全边界

- `SYS_PTRACE` / `seccomp=unconfined` **只给 snowluma**，fish-bot 不给
- noVNC / WebUI / 控制台 / DSH 全部只绑 `127.0.0.1`
- `DSH_HOME`、`DSH_AGENTS_HOME` 必须在容器内 `/data` 下，严禁指向宿主 `~/.dsh`、`~/.agents`
- 桥接白名单显式配置，`allowAllWhenEmpty` 必须 `false`

## 升级后必查

每次升级 Docker Desktop 后，确认 Disk image location 仍在 `D:\deepseek_flash\data`：

```powershell
Get-Content "$env:APPDATA\Docker\settings-store.json" | Select-String "DataFolder|dataRoot"
```

被重置到 C 盘是已知历史问题（docker/for-win#14446、#13345）。

## 配套项目

管理面板（本机网页面板）在另一个仓库：`dafeiyu-control-panel`。

## 下载与问题反馈

- [下载发布包](https://github.com/skyc10/dafeiyu-deploy/releases)（查看对应版本的要求与已知限制）。
- [提交 Bug](https://github.com/skyc10/dafeiyu-deploy/issues/new/choose)：附版本、环境和复现步骤，日志与截图先脱敏。
- [协作说明](CONTRIBUTING.md)。

公开下载包与首次配置详见 [公开构建包说明](docs/PUBLIC-RELEASE.md)。Git 克隆后需先准备插件构建归档，不能直接跳过该步骤。
