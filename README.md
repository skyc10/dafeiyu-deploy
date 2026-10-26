# 大肥鱼部署代码

本机 Docker Compose 部署：SnowLuma（QQ 接入端）+ fish-bot（专用 DSH 与桥接）。

> 这里只放**代码与模板**。运行期配置、登录态、聊天与记忆数据都在 Docker 命名卷里，不入库。

## 结构

```
├─ docker-compose.yml              双容器编排
├─ fish-bot/
│  ├─ Dockerfile                   专用 DSH + qq-bridge 镜像
│  ├─ entrypoint.sh                容器入口（含隔离断言、持久化挂接）
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
| 桥接控制台 | 13100 | 容器内 3100 |
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

## 配置持久化要点

**`/opt/qq-bridge/config.json` 不能用单文件软链指向卷内文件。**

桥接保存配置走「写临时文件 + rename 覆盖」。rename 替换的是**软链本身**，会把它变成普通文件，此后写入全部落进镜像可写层，卷里的持久副本不再更新——表现为「控制台改过白名单，重启后回到旧值」。

当前 `entrypoint.sh` 的做法：启动时把持久副本铺成**真实文件**到工作位置，后台守护每 3 秒比对并把变化同步回 `/data/bridge-config.json`；并会接管旧部署下 `/opt` 里较新的残留内容。

同类问题也存在于 `roles/`：必须整目录指向 `/data/roles`，不能逐个文件软链。

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
