# 0.1.3 全功能启用与管理入口

2026-10-27，Asia/Shanghai。用户要求启用全部功能，已升级至源码b22b76466ca99fe5c7762dd065bd0cd2d726757d，版本0.1.3。镜像sha256:86c76f1684c926b90ff2450257f8693abcef0a41e48d34106bfae98ef0a10ee9；包SHA256 8d8b0cd0b5d97fce3a122452ee9a19eef38dcd6154b108ae0bcee0b0f1611b06。来源记录在fish-bot/companion-source.json。

当前profile五项features全部true，角色无关闭覆盖；backup启用，上海03:00保留14天，首份daily快照已生成。学习引擎closed=false且周期运行，无失败，目前等待正常首条4小时间隔。保留原学习配额、证据和试用/采纳门槛，不强制跑模型、不发送额外QQ测试。

白名单、接管及旧插件状态保留：仅原授权私聊，群空，allowAllWhenEmpty=false；takeover active/acknowledged/legacyDisabled；旧memory disabled，mood/companion active。新装包模板默认全关不变。镜像构建内正式安装、37补丁及runtime幂等和语法通过。

独立管理面板1.1.0 /969d6e7增加“陪伴记忆管理”卡片，Edge实际点击认证打开0.1.3页面，目标URL无令牌；13后端/4前端检查通过。面板仓库独立提交，部署仓库不包含面板源码。

本机升级前停止fish-bot保存专用卷一致性备份：D:\deepseek_flash\backup\companion-all-features-20261027（tar读取与SHA256通过）。QQ容器未停，未还原旧库。回退镜像保留dafeiyu/fish-bot:pre-0.1.3-20261027，profile原配置有本地副本。版本包/ZIP和脱敏验证在插件仓库docs/releases/0.1.3；真实配置/备份/数据库不上传GitHub。

本次用户授权覆盖此前仅开采集召回的运行选择；历史0.1.2验收记录保留，不能用其“其它功能关闭”描述当前状态。历史剩余UI视觉/组合测试未伪造通过，正式0.1.3发布说明明确限制。
