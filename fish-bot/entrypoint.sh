#!/bin/sh
# fish-bot 容器入口：先起专用 DSH，再起 qq-bridge
#
# 隔离要点（计划 §6）：
#   - DSH_HOME / DSH_AGENTS_HOME 必须指向 /data 下，违则拒绝启动
#   - 严禁指向宿主 ~/.dsh、~/.agents
#
# 事实依据：
#   - DSH 拒绝通配监听（startup.js:48 isWildcardHost），必须绑具体 IP
#   - qq-bridge 的 config.json 缺失时直接退出
set -eu

log() { echo "[entrypoint] $*"; }
die() { log "致命: $*"; exit 1; }

# ── 隔离断言：绝不允许落到宿主主 DSH 的默认路径 ──────────────────────────
: "${DSH_HOME:?DSH_HOME 未设置}"
: "${DSH_AGENTS_HOME:?DSH_AGENTS_HOME 未设置}"

case "$DSH_HOME" in
  /data/*) : ;;
  *) die "DSH_HOME=$DSH_HOME 不在 /data 下，拒绝启动（会污染主 DSH）" ;;
esac
case "$DSH_AGENTS_HOME" in
  /data/*) : ;;
  *) die "DSH_AGENTS_HOME=$DSH_AGENTS_HOME 不在 /data 下，拒绝启动（会污染主 DSH）" ;;
esac

mkdir -p "$DSH_HOME" "$DSH_AGENTS_HOME" /opt/qq-bridge/state "$DSH_HOME/profiles/web"

# ── 首次运行：装插件与 preset ─────────────────────────────────────────────
# 这两个插件都是 DSH Cordis bundle，靠 cordis.patch.yml 插 loader 行。
# 用 link: 方式指向镜像内已 clone 的源码，避免每次启动联网。
PROFILE_PKG="$DSH_HOME/profiles/web/package.json"
if [ ! -f "$PROFILE_PKG" ]; then
  log "首次运行：初始化专用 profile"
  node /opt/bootstrap-profile.mjs || die "profile 初始化失败"
fi

# ── 1. 启动专用 DSH Web ────────────────────────────────────────────────────
# DSH 拒绝通配地址（startup.js:48 isWildcardHost）。要让它可被 Docker 端口映射
# 访问，必须绑容器 eth0 的具体 IP —— 绑 127.0.0.1 时宿主侧经映射访问不到
# （Docker 的转发目标不是容器回环）。这正是计划 §9 风险表记录的那条。
BIND_IP="${DSH_BIND_IP:-$(hostname -i 2>/dev/null | awk '{print $1}')}"
if [ -z "${BIND_IP:-}" ]; then
  die "无法确定容器 IP（DSH 不允许通配监听）"
fi
DSH_PORT="${DSH_PORT:-3080}"
log "启动专用 DSH: --host $BIND_IP --port $DSH_PORT"
log "  DSH_HOME=$DSH_HOME"
log "  DSH_AGENTS_HOME=$DSH_AGENTS_HOME"

# 清空上一轮的 DSH 日志。
# 为什么必须清：launch token 是每进程现生成的，而日志是**追加写**的。
# 容器 restart 时旧 token 还在文件里，用 `grep | tail -1` 会拿到上一次启动的
# 旧 token（甚至在新 DSH 写日志之前什么都拿不到），导致桥接 401。
: > /data/dsh.log

dsh web --host "$BIND_IP" --port "$DSH_PORT" --no-open >/data/dsh.log 2>&1 &
DSH_PID=$!
log "DSH pid=$DSH_PID，日志 /data/dsh.log"

i=0
while [ $i -lt 90 ]; do
  if ! kill -0 "$DSH_PID" 2>/dev/null; then
    log "DSH 进程已退出，日志尾部："
    tail -n 80 /data/dsh.log || true
    die "DSH 启动失败"
  fi
  # 就绪判定：DSH 根路径需要 token 鉴权，会返回 401/403。
  # 只要 TCP 能连上、HTTP 有响应（任意状态码）就算端口已监听。
  # 用 curl 不带 -f，并接受任意响应；连接失败才是未就绪。
  if curl -sS -o /dev/null --max-time 2 "http://$BIND_IP:$DSH_PORT/" 2>/dev/null; then
    log "DSH 端口已监听: http://$BIND_IP:$DSH_PORT/"
    break
  fi
  # curl 对 4xx 也返回 0（不带 -f 时），上面已覆盖；这里再做一次端口探测兜底
  if (echo >/dev/tcp/"$BIND_IP"/"$DSH_PORT") 2>/dev/null; then
    log "DSH 端口已监听（TCP 探测）: http://$BIND_IP:$DSH_PORT/"
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ $i -ge 90 ]; then
  log "DSH 就绪超时，日志尾部："
  tail -n 80 /data/dsh.log || true
  die "DSH 就绪超时（90 秒）"
fi

# 打印带 token 的访问地址，方便排查
grep -o 'http://[^ ]*token=[^ ]*' /data/dsh.log 2>/dev/null | head -1 > /data/dsh-url.txt || true
if [ -s /data/dsh-url.txt ]; then
  log "DSH 访问地址已写入 /data/dsh-url.txt"
fi

# ── 2. 确保 bridge config 存在（每次启动都检查，不依赖首次标记）──────────
# 注意：/opt/qq-bridge 在镜像层，容器重建即重置。真正的持久化副本放在 /data。
# 具体挂接方式见 2.05 节（那里解释了为什么不能用单文件软链）。
PERSIST_CFG=/data/bridge-config.json
CONFIG=/opt/qq-bridge/config.json

if [ ! -f "$PERSIST_CFG" ]; then
  if [ -f /opt/bridge-config.template.json ]; then
    log "首次运行：从模板生成 /data/bridge-config.json（白名单为空，需人工填写）"
    cp /opt/bridge-config.template.json "$PERSIST_CFG"
  else
    die "模板 /opt/bridge-config.template.json 不存在"
  fi
fi

# ── 2.1 持久化桥接 state/ 目录 ────────────────────────────────────────────
# state/ 里有会话映射、表情库、token 用量、控制台令牌、角色选择。
# 它在镜像层，容器重建即清空 —— 会话映射丢失意味着每次重建都换新会话，
# 记忆自然接不上。
#
# 为什么用「整个目录替换」而不是逐文件软链：桥接会在运行期**新建**文件
# （sessions.json 等），逐文件链接只能覆盖已存在的，新建的会落在镜像层、
# 下次重建又丢。把 state/ 本身换成指向 /data 的链接才对。
PERSIST_STATE=/data/bridge-state
mkdir -p "$PERSIST_STATE"
# 首次迁移：把镜像层里已有的种子文件搬过去（控制台模板等）
if [ -d /opt/qq-bridge/state ] && [ ! -L /opt/qq-bridge/state ]; then
  for f in /opt/qq-bridge/state/*; do
    [ -e "$f" ] || continue
    base="$(basename "$f")"
    [ -e "$PERSIST_STATE/$base" ] || cp -a "$f" "$PERSIST_STATE/$base" 2>/dev/null || true
  done
  rm -rf /opt/qq-bridge/state
fi
ln -sfn "$PERSIST_STATE" /opt/qq-bridge/state
log "桥接 state 已持久化: /opt/qq-bridge/state -> $PERSIST_STATE"

# ── 2.05 config.json 持久化：修掉「单文件软链被 rename 打断」的缺陷 ────────
# 【2026-10-26 修复】原先的写法是错的，症状就是「配置重启后消失」：
#     ln -s /data/bridge-config.json /opt/qq-bridge/config.json
#
# 机制：桥接保存配置走 atomicWriteText/atomicWriteJson（bridge.js:181/195）——
#   先写 `config.json.<pid>.<rand>.tmp`，再 renameSync 覆盖目标。
#   而 rename **替换的是软链本身**，把它变成普通文件：此后所有写入都落进镜像
#   可写层，/data 里的持久副本再也不更新；下次启动 `rm -f` 又把这堆改动删掉。
#   这就是「改过的白名单重启后消失」的原因。
#
# 已在容器内用真实 Node renameSync 复现：
#   单文件软链 → rename 后类型变成 regular file，持久副本内容没变；整目录软链才安全。
#
# 桥接固定读 <ROOT>/config.json（ROOT=/opt/qq-bridge，bridge.js:59），路径改不了，
# 所以这里改用「真实文件 + 后台同步」：启动时把持久副本铺到工作位置，
# 运行期由后台守护把工作位置的改动同步回持久副本。不再依赖软链。

# 旧部署残留：/opt 下若是被 rename 破坏后的普通文件且比持久副本新，
# 说明那次修改还没落盘，先接管回来，避免丢失用户改过的白名单。
if [ -f "$CONFIG" ] && [ ! -L "$CONFIG" ] && ! cmp -s "$CONFIG" "$PERSIST_CFG"; then
  if node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$CONFIG" 2>/dev/null; then
    cp -p "$PERSIST_CFG" "/data/bridge-config.json.bak-$(date +%Y%m%d-%H%M%S)"
    cp -p "$CONFIG" "$PERSIST_CFG"
    log "已接管 /opt 下较新的 config.json（原持久副本已备份）"
  fi
fi

# 关键：把软链/旧文件清掉，用持久副本铺一个**真实文件**到工作位置。
# 若保留单文件软链，桥接的 rename 会再次把它打散（本次要修的就是这个）。
rm -f "$CONFIG"
cp -p "$PERSIST_CFG" "$CONFIG"
chmod 600 "$CONFIG"
log "config 已展开为真实文件: $CONFIG（持久副本 $PERSIST_CFG）"


# ── 2.2 恢复/持久化角色卡 ──────────────────────────────────────────────────
# 角色在 state/current-role.json 指定，正文在 roles/<名字>.md。
# roles/ 也在镜像层，容器重建即重置，所以正文与选择都放 /data。
#
# 【2026-10-25 修复】原先用的是「逐个文件软链」：ln -s /data/roles/x.md /opt/qq-bridge/roles/x.md。
# 但桥接保存人格走 atomicWriteText()（写临时文件再 rename 覆盖目标，bridge.js:195 / 389），
# 而 rename **会把软链接本身替换成普通文件** —— 新内容落进镜像可写层，/data 里那份原封不动。
# 表现：控制台里改人格 → 当场生效 → 容器一重建就退回旧内容。改动是**静默丢失**的，
# 因为写完再读（读的还是 /opt 那份）看起来完全正常。已实测踩中（改「胖锦鲤→鲸鱼」后重建回退）。
# 改成与 state/ 完全一致的做法：整个 roles 目录指向 /data/roles，保存路径自然落到持久卷上。
ROLE_DIR=/data/roles
mkdir -p "$ROLE_DIR"
# 首次迁移：把镜像层里已有的角色卡搬过去（只补缺，不覆盖用户已改过的）
if [ -d /opt/qq-bridge/roles ] && [ ! -L /opt/qq-bridge/roles ]; then
  for f in /opt/qq-bridge/roles/*.md; do
    [ -f "$f" ] || continue
    base="$(basename "$f")"
    [ -e "$ROLE_DIR/$base" ] || cp -a "$f" "$ROLE_DIR/$base" 2>/dev/null || true
  done
  rm -rf /opt/qq-bridge/roles
fi
ln -sfn "$ROLE_DIR" /opt/qq-bridge/roles
log "角色卡已持久化: /opt/qq-bridge/roles -> $ROLE_DIR"
# 种子兜底：全新部署时上面搬不到 大肥鱼.md，就从镜像内种子播种
if [ -f /opt/roles-seed/大肥鱼.md ] && [ ! -f "$ROLE_DIR/大肥鱼.md" ]; then
  cp /opt/roles-seed/大肥鱼.md "$ROLE_DIR/大肥鱼.md"
  log "角色卡已播种: $ROLE_DIR/大肥鱼.md"
fi

# 角色选择也持久化：state/ 已整体指向 /data/bridge-state，故直接落在那里
ROLE_STATE=/opt/qq-bridge/state/current-role.json
if [ ! -f "$ROLE_STATE" ]; then
  printf '{"role":"大肥鱼"}\n' > "$ROLE_STATE"
  log "角色选择已初始化: 大肥鱼"
else
  log "角色选择已恢复: $(cat "$ROLE_STATE")"
fi

# ── 2.5 把桥接的 dsh 段对齐到实际监听地址与本次 launch token ─────────────
# 为什么必须动态改（而不是写死在 config 里）：
#   1) DSH 绑的是容器 eth0 IP —— 宿主端口映射才能访问它的管理页；
#      容器 IP 每次重建可能变化。
#   2) 桥接的「离线铸造 Cookie」路径只对回环地址成立（dsh-client.js:389
#      canMint = secret !== null && isLoopbackBase(baseUrl)）。baseUrl 是容器 IP 时
#      该路径失效，必须改走 launch token 交换。
#   3) launch token 是每进程现生成、只存在内存里的（dsh-client 注释明写），
#      DSH 每次重启就变，因此每次启动都要从本次日志里重新取。
DSH_ADDR="http://${BIND_IP}:${DSH_PORT}"

# 提取本次 launch token。DSH 打印访问地址与「端口已监听」之间可能有间隙，
# 所以带重试；日志已在启动前清空，因此拿到的必然是本次进程的 token。
LAUNCH_TOKEN=""
n=0
while [ $n -lt 30 ]; do
  LAUNCH_TOKEN="$(grep -o 'token=[A-Za-z0-9_-]*' /data/dsh.log 2>/dev/null | tail -1 | cut -d= -f2)"
  [ -n "$LAUNCH_TOKEN" ] && break
  n=$((n + 1))
  sleep 1
done

if [ -z "$LAUNCH_TOKEN" ]; then
  log "⚠️ 未能从 /data/dsh.log 提取 launch token（重试 30 秒）；桥接将无法鉴权"
  log "   日志尾部："
  tail -n 20 /data/dsh.log || true
fi

node -e '
const fs = require("node:fs");
const p = "/data/bridge-config.json";
const [addr, tok] = process.argv.slice(1);
const cfg = JSON.parse(fs.readFileSync(p, "utf8"));
cfg.dsh = cfg.dsh || {};
let changed = [];
if (cfg.dsh.baseUrl !== addr) { changed.push(`baseUrl ${cfg.dsh.baseUrl} -> ${addr}`); cfg.dsh.baseUrl = addr; }
if (tok && cfg.dsh.authToken !== tok) { changed.push("authToken 已刷新"); cfg.dsh.authToken = tok; }
if (changed.length) {
  fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  console.log(`[entrypoint] 桥接 dsh 配置已更新: ${changed.join("; ")}`);
} else {
  console.log(`[entrypoint] 桥接 dsh 配置无变化（${addr}）`);
}
' "$DSH_ADDR" "$LAUNCH_TOKEN" || die "改写桥接 dsh 配置失败"

# ── 2.6 对齐 SnowLuma 的 OneBot token（HTTP 与 WS 是**两个不同**的值）─────
# 为什么要单独处理：桥接配置里只有一个 snowluma.accessToken 字段，而它只用于
# **HTTP** 调用（bridge.js 里所有 fetch 都拼 `Bearer ${accessToken}`）；WS 连接
# 的 token 由自愈逻辑从 per-account 文件（config/onebot_<uin>.json）发现后写到
# bot.accessToken。若两者错配，症状是：
#   · accessToken 填了 WS 的 → 发消息全 401 unauthorized（实测踩过）
#   · accessToken 填了 HTTP 的但发现不到 WS token → WS code=1006 反复重连（实测踩过）
# 因此这里把 snowluma.homeDir 指向只读挂载点，让桥接自己能发现两份 token。
# 挂载见 docker-compose.yml：qq-gateway-data 的 config 子目录 → /snowluma-home/config。
# ⚠️ 桥接读的是 <homeDir>/config（snowluma-conn.js:46），所以 homeDir 要比挂载点高一层。
SNOWLUMA_CFG_DIR=/snowluma-home/config
if [ -d "$SNOWLUMA_CFG_DIR" ]; then
  node -e '
  const fs = require("node:fs");
  const p = "/data/bridge-config.json";
  const cfgDir = process.argv[1];
  const cfg = JSON.parse(fs.readFileSync(p, "utf8"));

  // 从 per-account 文件里取 HTTP token（httpServers[0].accessToken）
  let httpToken = "";
  try {
    const files = fs.readdirSync(cfgDir).filter((f) => /^onebot.*\.json$/.test(f));
    // 优先 onebot_<uin>.json（当前账号），其次 onebot.json（默认模板）
    files.sort((a, b) => (a === "onebot.json" ? 1 : b === "onebot.json" ? -1 : 0));
    for (const f of files) {
      try {
        const j = JSON.parse(fs.readFileSync(require("node:path").join(cfgDir, f), "utf8"));
        const t = j?.networks?.httpServers?.[0]?.accessToken;
        if (t) { httpToken = String(t); break; }
      } catch {}
    }
  } catch (e) {
    console.log(`[entrypoint] ⚠️ 读取 SnowLuma 配置失败: ${e.message}`);
  }

  const changed = [];
  cfg.snowluma = cfg.snowluma || {};
  // homeDir 让桥接的 discoverSnowLumaConnection() 能发现 WS token。
  // ⚠️ 必须传父目录（/snowluma-home），因为桥接内部会再拼一层 config
  //    （readOneBotTokens: path.join(homeDir, 'config')）。传成 config 本身会读不到。
  const homeDir = require("node:path").dirname(cfgDir);
  if (cfg.snowluma.homeDir !== homeDir) {
    changed.push(`homeDir ${cfg.snowluma.homeDir || "(空)"} -> ${homeDir}`);
    cfg.snowluma.homeDir = homeDir;
  }
  // HTTP token 显式对齐（发现逻辑里的 explicit 优先级最高，但写死更稳）
  if (httpToken && cfg.snowluma.accessToken !== httpToken) {
    changed.push("accessToken 已按 SnowLuma 实际值对齐");
    cfg.snowluma.accessToken = httpToken;
  }
  if (changed.length) {
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2) + "\n", "utf8");
    console.log(`[entrypoint] 桥接 snowluma 配置已更新: ${changed.join("; ")}`);
  } else {
    console.log("[entrypoint] 桥接 snowluma 配置无变化");
  }
  if (!httpToken) console.log("[entrypoint] ⚠️ 未读到 OneBot HTTP accessToken，桥接发消息可能 401");
  ' "$SNOWLUMA_CFG_DIR" || log "⚠️ 对齐 snowluma 配置失败（不阻断启动）"
else
  log "⚠️ $SNOWLUMA_CFG_DIR 未挂载；跳过 OneBot token 对齐（WS 可能需要手工填 token）"
fi

# 安全断言：空白名单 + allowAllWhenEmpty=true 会放行全部，必须拦住
if grep -q '"allowAllWhenEmpty"[[:space:]]*:[[:space:]]*true' "$PERSIST_CFG"; then
  die "config 里 allowAllWhenEmpty=true，会放行所有群/私聊，拒绝启动（计划 §7）"
fi

log "启动 qq-bridge"

# 控制台端口转发：桥接控制台只绑 127.0.0.1 且 Host 校验只认回环，
# 要让它从宿主可达就得在容器内做一层转发（详见 console-proxy.mjs 注释）。
CONSOLE_PROXY_PORT="${CONSOLE_PROXY_PORT:-13100}" \
CONSOLE_TARGET_PORT="${CONSOLE_PORT:-3100}" \
node /opt/console-proxy.mjs >/data/console-proxy.log 2>&1 &

# 记忆迁移守护：桥接在 DSH 重启后会新建会话（bridge.js:8074 注释说明其必然），
# 而记忆插件按 Session.id 一会话一份，导致重启后「失忆」。
# 桥接建立映射需要时间（要等第一条 QQ 消息），所以后台轮询而不是启动前跑一次。
(
  n=0
  while [ $n -lt 120 ]; do
    if [ -s /opt/qq-bridge/state/sessions.json ]; then
      if grep -q '"private:\|"group:' /opt/qq-bridge/state/sessions.json 2>/dev/null; then
        node /opt/migrate-memory.mjs 2>&1 | grep -v '^\s*$' || true
        break
      fi
    fi
    n=$((n + 1))
    sleep 5
  done
) &

# config 同步守护：桥接会用 rename 覆盖 /opt/qq-bridge/config.json，
# 那一步只会改工作位置的**真实文件**，不会自动落到 /data。
# 这里持续比较内容，一旦工作位置变了就写回持久副本（写同一个文件时用 cp 而非 rename，
# 因此不会影响桥接后续的写入；两份都在同一容器内，开销可忽略）。
(
  while true; do
    sleep 3
    if [ -f "$CONFIG" ] && [ -f "$PERSIST_CFG" ]; then
      if ! cmp -s "$CONFIG" "$PERSIST_CFG"; then
        # 只同步合法 JSON，避免把桥接写了一半的内容固化下来
        if node -e "JSON.parse(require('fs').readFileSync(process.argv[1],'utf8'))" "$CONFIG" 2>/dev/null; then
          cp -f "$CONFIG" "$PERSIST_CFG.tmp" 2>/dev/null && mv -f "$PERSIST_CFG.tmp" "$PERSIST_CFG" 2>/dev/null \
            && echo "[entrypoint] config 已同步到持久副本 $(date '+%H:%M:%S')"
        fi
      fi
    fi
  done
) >/data/config-sync.log 2>&1 &

exec node /opt/qq-bridge/src/bridge.js
