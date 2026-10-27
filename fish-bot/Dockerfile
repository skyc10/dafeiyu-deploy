# fish-bot 镜像：专用 DSH 实例 + qq-bridge
#
# 依据：部署交接计划-v2.md 阶段 5/6、_audit/qq-bridge-audit.md、_audit/fish-memory-mood-audit.md
# 目标：与用户日常使用的主 DSH 完全隔离（独立 DSH_HOME / DSH_AGENTS_HOME）
#
# 说明：本镜像只装 DSH 与桥接，不含 SnowLuma 的任何专有组件（遵守其 EULA §5.4）。
#       qq-bridge 要求 node >= 22.13.0；DSH 0.2.1-rc.2 在 node 24 上验证通过。

FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205

ARG DSH_VERSION=0.2.1-rc.2
ARG PNPM_VERSION=10.34.9

ENV DEBIAN_FRONTEND=noninteractive \
    TZ=Asia/Shanghai

# 基础工具：git 用于克隆插件；ca-certificates 供 HTTPS；tini 做 PID 1 正确转发信号
RUN apt-get -o Acquire::Retries=2 -o Acquire::http::Timeout=30 update && apt-get install -y --no-install-recommends \
        ca-certificates \
        git \
        curl \
        tini \
        procps \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /opt

# 安装指定版本 DSH（不用 latest，保证可复现）
RUN npm install -g @deepseek-ai/dsh@${DSH_VERSION} pnpm@${PNPM_VERSION} \
    && dsh --version \
    && command -v pnpm \
    && test "$(pnpm --version)" = "${PNPM_VERSION}"

# qq-bridge：固定 commit，避免 main 分支漂移
# 审计时 HEAD = a49877f4（2026-10-22），与唯一 tag v0.2.1-r1 同一提交
ARG QQ_BRIDGE_REPO=https://github.com/Derpyu520/qq-bridge
ARG QQ_BRIDGE_REF=a49877f4e58d04e47532d44b803360d0f001160d
RUN git clone ${QQ_BRIDGE_REPO} /opt/qq-bridge \
    && cd /opt/qq-bridge \
    && git checkout ${QQ_BRIDGE_REF}
COPY fish-bot/qq-bridge.package-lock.json /opt/qq-bridge/package-lock.json
RUN cd /opt/qq-bridge && npm ci --omit=dev

# 本部署的本地改动（remember 工具加入 QQ 白名单，已获用户授权 2026-10-25）
# 用 Node 脚本而非 sed：源文件是 CRLF，sed 锚点会静默失败。
# 脚本幂等，并保留 .orig 原始文件以便回溯。
COPY fish-bot/apply-local-patches.mjs /tmp/apply-local-patches.mjs
COPY fish-bot/apply-fakeip-patch.mjs /tmp/apply-fakeip-patch.mjs
RUN cp /opt/qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs \
       /opt/qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs.orig \
    && cp /opt/qq-bridge/src/safe-fetch.js /opt/qq-bridge/src/safe-fetch.js.orig \
    && node /tmp/apply-local-patches.mjs \
    && node /tmp/apply-fakeip-patch.mjs \
    && rm -f /tmp/apply-local-patches.mjs /tmp/apply-fakeip-patch.mjs

# 记忆与心情插件（DSH Cordis bundle 形态，装进专用 profile）
ARG FISH_MEMORY_REPO=https://github.com/Yuuyuko-uu/dsh-fish-memory
ARG FEIYU_MOOD_REPO=https://github.com/Yuuyuko-uu/dsh-feiyu-mood
ARG FISH_MEMORY_REF=eb766be1542ff928a731636dba7e1e79a27f8339
ARG FEIYU_MOOD_REF=7eb89c1bf971bd2255a9e79972328dee59d51f5c
RUN git clone ${FISH_MEMORY_REPO} /opt/plugins/dsh-fish-memory \
    && git -C /opt/plugins/dsh-fish-memory checkout ${FISH_MEMORY_REF} \
    && git clone ${FEIYU_MOOD_REPO} /opt/plugins/dsh-feiyu-mood \
    && git -C /opt/plugins/dsh-feiyu-mood checkout ${FEIYU_MOOD_REF}

# 专用数据根：绝不指向宿主的 ~/.dsh 或 ~/.agents
# 运行期由 compose 用命名卷挂到 /data，并设 DSH_HOME=/data/dsh-home
ENV DSH_HOME=/data/dsh-home \
    DSH_AGENTS_HOME=/data/agents-home

RUN mkdir -p /data/dsh-home /data/agents-home /opt/qq-bridge/state

# 桥接配置模板（运行期若 /opt/qq-bridge/config.json 不存在，entrypoint 复制一份）
COPY config/bridge-config.template.json /opt/bridge-config.template.json

# 角色卡种子：首次运行复制到 /data/roles 持久化
COPY config/role-大肥鱼.md /opt/roles-seed/大肥鱼.md

# profile 引导：装 bundle、建链接、写 cordis.patch.yml
COPY fish-bot/bootstrap-profile.mjs /opt/bootstrap-profile.mjs

# 记忆迁移：DSH 重启后桥接会新建会话，把历史记忆继承给新会话
COPY fish-bot/migrate-memory.mjs /opt/migration-source/migrate-memory.mjs

# 控制台端口转发：桥接控制台只绑回环，靠这个从宿主访问
COPY fish-bot/console-proxy.mjs /opt/console-proxy.mjs

# Candidate is explicitly staged from a source commit; never copy a whole working repository.
COPY .companion-build/plugin.tgz /tmp/companion.tgz
COPY fish-bot/companion-source.json /opt/companion-source.json
RUN node -e "const fs=require('fs'),c=require('crypto'),m=require('/opt/companion-source.json');if(c.createHash('sha256').update(fs.readFileSync('/tmp/companion.tgz')).digest('hex')!==m.sha256)throw Error('companion package hash mismatch')" \
    && mkdir -p /opt/plugins/dsh-qq-companion-memory \
    && tar -xzf /tmp/companion.tgz -C /opt/plugins/dsh-qq-companion-memory --strip-components=1 \
    && test "$(node -p "require('/opt/plugins/dsh-qq-companion-memory/package.json').version")" = "0.1.2" \
    && cp -r /opt/plugins/dsh-qq-companion-memory/integration /opt/qq-bridge/ \
    && node /opt/plugins/dsh-qq-companion-memory/scripts/patch-bridge.mjs --root /opt/qq-bridge --apply \
    && rm /tmp/companion.tgz
RUN node /opt/plugins/dsh-qq-companion-memory/scripts/prepare-migration.mjs --source /opt/migration-source/migrate-memory.mjs --output /opt/migrate-memory.mjs
# Prove the formal manager can install the bundle; this disposable profile is never used at runtime.
RUN DSH_HOME=/tmp/companion-install/dsh-home DSH_AGENTS_HOME=/tmp/companion-install/agents-home \
    dsh plugin --profile web add /opt/plugins/dsh-qq-companion-memory \
    && rm -rf /tmp/companion-install

COPY fish-bot/apply-runtime-patches.mjs /opt/apply-runtime-patches.mjs
COPY fish-bot/record-companion-build.mjs /opt/record-companion-build.mjs
RUN node /opt/apply-runtime-patches.mjs \
    && node /opt/plugins/dsh-qq-companion-memory/scripts/patch-bridge.mjs --root /opt/qq-bridge --check \
    && node /opt/apply-runtime-patches.mjs \
    && node --check /opt/qq-bridge/src/bridge.js \
    && node --check /opt/qq-bridge/src/mcp-host-server.js \
    && node --check /opt/qq-bridge/src/mcp-snowluma-safe.js \
    && node /opt/record-companion-build.mjs
COPY fish-bot/runtime.mjs fish-bot/healthcheck.mjs /opt/
ENV QQ_BRIDGE_CONFIG_FILE=/data/bridge-config.json

COPY fish-bot/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /opt/qq-bridge

# 3100 是 qq-bridge 自己的管理控制台端口（config.example.json 的 consolePort）
EXPOSE 3100

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
