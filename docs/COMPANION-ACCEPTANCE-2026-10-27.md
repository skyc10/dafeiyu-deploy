# Companion 0.1.2 当前实例安装记录

2026-10-27，Asia/Shanghai。详细40项测试与子代理证据位于插件独立仓库 `docs/acceptance/2026-10-27-fix/REPORT.md`；不把报告复制为另一份测试结果。

当前镜像固定ID：`sha256:9acf0187a7b69ddc383cae5a0ea6832d0b55c69bc902312efaced38160520b8e`。来源为插件提交 `1c8bd8d06eb8f6b4a10f2d79d3f41fce72d5ff95` 的0.1.2候选，包SHA256 `1efc7b563ce0d548d4c3ce8911455726eec0d5c0c0f69dd356c587194b391183`；Node24.22.1 / DSH0.2.1-rc.2 / pnpm10.34.9。固定原件→37条companion补丁→runtime，完整构建、双补丁幂等及阶段指纹通过。

三个low子代理完成后端合成、浏览器、隔离真实宿主测试。正式安装/卸载/重装/重启、SQLite持久化、认证与原生spawn通过；UI冲突重试requestId、现存Session绑定重报与重建版本缺陷均已修复复测。详细未覆盖矩阵以插件报告为准。

当前实例已在新停机备份后通过正式 `dsh plugin --profile web add` 安装。新插件配置capture/recall为true，learning/trial/autoAdopt为false；尚无可信绑定或接管，旧记忆未停用，旧材料未导入。管理状态/页面/CSS/JS未认证401、认证200；内部接口token验证通过。镜像只运行心情绑定迁移，不再全量合并旧记忆。

**未完成：QQ网关重启后等待登录，OneBot不可达，真实私聊联调与ACK受阻。** 两容器healthy不代表QQ在线。主动真实测试累计0次模型、0条QQ出站，上限分别15/30，限原授权私聊，不扩展群或其它号码。已请用户恢复本机QQ登录；登录后继续核对身份、绑定、真实回执，再停旧记忆并prepare/activate，真实ACK完成后才启用新上下文。

备份仅本地：`D:\deepseek_flash\backup\memory-0.1.2-20261027-135148`。四卷tar读取校验通过，SHA256清单、原镜像save及Compose/容器现场已保存。回退标签 `dafeiyu/fish-bot:pre-memory-0.1.2-20261027`。程序失败优先回退镜像与核对后的配置；保全新增聊天，不自动倒灌旧卷，不执行down -v。真实配置、凭据、数据库及备份均未上传。

0.1.2仍为安装候选，未创建正式发行标签，不覆盖0.1.1包或标签。管理面板独立仓库未修改。
