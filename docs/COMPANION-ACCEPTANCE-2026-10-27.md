# Companion 0.1.2 当前实例安装与真实私聊验收

2026-10-27，Asia/Shanghai。详细40项状态、三个low子代理报告与原始证据见插件独立仓库 `docs/acceptance/2026-10-27-fix/REPORT.md`。部分UI视觉/组合场景仍未测，不宣称全40项通过。

当前镜像ID：`sha256:d8f67e0bcc074368febe03670c3a86f90fbc197a401dfbefa49ff0d8790def95`；插件源码 `c1619aecffb4b60a9fd7f19cf9496db569d5faac` / 0.1.2候选；tgz SHA256 `eb22ad1007693d08eaa51359a90998549a5ae9c979077b8d43ec82b6bb82b4e6`。Node24.22.1 / DSH0.2.1-rc.2 / pnpm10.34.9。固定原件→37条companion→runtime，构建/双补丁幂等/指纹通过。部署的companion-source.json与运行镜像一致。

修复镜像工具链、装配预检与失败恢复；测试补修WebUI重试requestId、现存Session绑定及重建版本。真实联调又复现DSH将动态上下文作为runtime-context user消息而非system传输造成记忆用量漏记；已修并用13分支防冒充回归。最终65组合成检查、13项装配矩阵、新包60项逐文件核对通过。

当前授权私聊已验证真实绑定、入站有效材料、5个成功发送message_id、prepare→activate→真实桥接ACK、召回注入及chat/memory计量；绑定version1和active接管在重启后保留。旧fish-memory Loader disabled无active fiber，心情及新插件active。capture/recall=true；learning/trial/autoAdopt=false。旧材料未导入，迁移只保留心情绑定。群为空、allowAllWhenEmpty=false；没有向其它号码或群发主动测试。

真实测试累计模型7/15次、QQ出站5/30条，包括由2条操作者发送触发的3条桥接唤醒提醒。第一条静默探针实际发出，因为既有桥接规则豁免主人私聊；没有将其记成拦截通过。模型请求经临时本机转发按实际请求计数、禁用工具并限输出512，发送则走已有认证桥接发送链。真实模型自行选择/调用发送工具的完整无人值守链未作为通过范围。生产未故障注入或发送无效目标。

临时模型路由已恢复原值，代理已停止，唤醒恢复未暂停，原角色silent保持；临时验收记忆已删除且正文清空、不再召回。DSH历史快照可能仍有旧文本；不回填修复前漏记估算。真实入站测试回复按正常采集保留。两容器healthy且QQ在线。认证检查管理状态/页面/CSS/JS均匿名401、认证200，internal同样401/200。

备份均仅本地：初次四卷一致性备份 `D:\deepseek_flash\backup\memory-0.1.2-20261027-135148`（tar读取/哈希、原镜像save、Compose/现场）；计量修复前追加专用数据卷停机备份 `D:\deepseek_flash\backup\memory-usagefix-20261027-144206`（tar读取/哈希）。第二次不重启QQ，不恢复旧卷。回退先关闭新召回并rollback真实ACK恢复旧桥接通道，再核对profile旧记忆配置；程序优先换保留镜像，不单独companion revert、不自动倒灌卷、不执行down -v。

0.1.2仍为安装候选，未创建正式发行标签，不覆盖0.1.1产物/标签。真实配置/凭据/聊天/数据库/备份均不进入GitHub。管理面板独立仓库未修改。
