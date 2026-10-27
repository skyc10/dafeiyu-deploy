# DSH 会话请求头插件

用户授权安装 https://github.com/QuanhuZeYu/dsh-session-header 并进行一次“你好”测试。
版本 0.1.0，上游提交 407ad712c8b11df0d004015bf033bf392d6cc3a0；MIT 源码及编译产物保存在 fish-bot/vendor/dsh-session-header，未修改上游代码，无运行时依赖，无新增依赖锁文件。

运行插件位于 /data/session-header，profile 插入 llm-session-header，模块地址 file:///data/session-header/lib/index.js，启用 x-session-id，其余默认。原 profile 备份为同目录 cordis.patch.yml.before-session-header-时间戳；真实配置不入 Git。

新增条目未观察到实时加载，已仅重启 fish-bot，未重启 SnowLuma。现有运行容器已安装；Dockerfile 与 runtime 安装步骤供下次构建复现，本次未执行镜像重建，当前镜像本身仍是旧镜像。

容器内直接运行上游编译产物测试：node --test tests/*.test.mjs，23/23 通过，含本地 HTTP 会话头注入和鉴权保持。运行管理器、安装器语法检查通过。

上海时间 2026-10-27 16:27，通过现有控制台 notify-ai 向主人私聊对应 DSH 会话投递“你好”测试。模型 deepseek-v4.1-flash 调用 qq_send_message；工具结果 sent=1、failed=0，桥接日志确认成功 1/1；随后 qq_mark_read 收尾，turn 13 最终 completed。本测试未向群聊或其他联系人发送。此前三次 422，安装后本轮未出现；这证明本轮恢复，不能单凭一次结果认定所有 422 根因已排除。未检查或修改网关头转发设置。模型回复中对旧故障的自行解释不作为诊断证据。

回退：将 llm-session-header 配置 enabled 改为 false 并重启 fish-bot；或在核对其它新设置后恢复本地备份。不要覆盖新增聊天数据或凭据。
