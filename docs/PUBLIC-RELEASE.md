# 公开构建包 2026.10.27

适用 Windows + Docker Desktop（Linux 容器模式，支持 Compose 的 volume.subpath），架构 linux/amd64；需要联网拉取 Node、DSH、qq-bridge 与其它上游依赖。本包不是完全离线安装器。

## 使用下载包

1. 从本仓库 Releases 下载 dafeiyu-deploy-2026.10.27-build-kit.zip 和 SHA256SUMS，核对 SHA256 后解压到自选目录。
2. 包内包含当前部署源码与经校验的记忆插件 0.1.3 构建归档 .companion-build/plugin.tgz；不包含登录态、凭据、数据库、备份或运行容器数据。
3. 在解压目录运行 `powershell -ExecutionPolicy Bypass -File scripts/build-release.ps1`。脚本先校验插件哈希，再执行 `docker compose build fish-bot`，不启动或重启容器。
4. 初次部署由用户执行 `docker compose up -d`。打开 http://127.0.0.1:16081/ 完成 QQ 登录；打开专用 DSH http://127.0.0.1:18080/ 配置模型（认证链接按运行日志/控制面板取得）。桥接控制台为 http://127.0.0.1:13100/。
5. 首次启动的 QQ 账号与白名单是占位值；在桥接控制台填写自己的 ownerQQ、私聊/群白名单，保持 allowAllWhenEmpty=false。记忆插件新实例默认关闭，按需显式启用。不要直接复用他人配置。
6. Windows 控制面板为独立下载，见 https://github.com/skyc10/dafeiyu-control-panel/releases 。它只操作已有容器。

已有同名容器/卷的机器不要直接作为全新安装：先阅读 OPERATIONS-2026-10-27.md 并备份。此包不会携带本机已有角色卡或覆盖已有持久角色；更新角色种子只影响新建实例。

## 从 Git 源码构建

Git 不跟踪 .companion-build。下载 https://github.com/skyc10/dsh-qq-companion-memory/releases/tag/v0.1.3 中的 dsh-qq-companion-memory-0.1.3.tgz，核对与 fish-bot/companion-source.json 的 sha256 一致，复制为 .companion-build/plugin.tgz，然后运行上述脚本。

## 反馈与边界

向对应项目 Issues 提交版本、环境、最小复现与脱敏错误。不要上传 Docker 卷、完整日志、聊天/记忆库、账号、凭据。构建包与上游 SnowLuma 镜像分开发放，SnowLuma 按其原渠道下载并遵守各组件许可；公开源码并不改变上游许可。

本次不进行 QQ 发言、模型调用、生产容器重启或用户数据导出。构建检查与业务实测的区别见 Release 说明。
