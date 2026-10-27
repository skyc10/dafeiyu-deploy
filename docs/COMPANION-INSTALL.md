# Companion 0.1.2 安装候选

镜像固定Node24、DSH 0.2.1-rc.2、pnpm 10.34.9。源码、部署和管理面板是独立仓库；不将插件工作区整体复制到部署仓库。

## 可复现构建

1. 在插件指定提交的干净检出中构建并运行 `npm run pack:release`，保留提交号、源码和lib指纹。不要使用dist/0.1.1旧包。
2. 在部署根运行 `node fish-bot/stage-companion.mjs <0.1.2.tgz绝对路径> <40位源码提交>`。`.companion-build/plugin.tgz`仅本地暂存，`fish-bot/companion-source.json`记录来源与SHA256并提交。
3. `docker build -t dafeiyu/fish-bot:memory-0.1.2-candidate -f fish-bot/Dockerfile .`。构建核对包SHA256，按固定原件→companion→runtime装配，正式管理器安装到一次性profile，最后复核两套补丁幂等。阶段指纹保存在镜像`/opt/companion-build.json`。
4. runtime已有标记必须同时有完整`.runtime-source`，并与确定性重算结果一致；旧镜像不能原地热补丁升级，应从固定原件重新构建。所有文件预检通过才写入，写入失败恢复现场。

## 当前实例切换

先记录现场并新建一致性停机备份；正式安装新bundle仍用`dsh plugin --profile web add /opt/plugins/dsh-qq-companion-memory`，不手写新bundle条目。安装后检查加载、卸载、重启、侧栏、同源认证和资源。

新镜像只保留心情绑定迁移，不运行旧记忆跨会话合并。正式接管前在DSH停用旧记忆工具/上下文/采集，再经prepare/activate和真实桥接ACK启用召回。旧材料不自动导入。

目标私聊3300174019，群为空且allowAllWhenEmpty=false；capture/recall启用，learning/trial/autoAdopt关闭。真实测试总上限15次模型请求、30条主动QQ出站消息，重试计入。

程序回退优先恢复旧镜像与经过核对的配置；不要单独执行companion revert抹掉runtime补丁，不用旧卷快照覆盖新增聊天。恢复/导入/故障注入只在隔离数据上验收。安装/源码推送不代表发行通过，实际状态看本轮验收报告。
