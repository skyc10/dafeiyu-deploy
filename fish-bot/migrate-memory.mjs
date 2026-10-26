#!/usr/bin/env node
// 把上一代 DSH 会话的记忆迁移给当前会话（解决「DSH 重启 → 桥接新建会话 → 记忆读不到」）
//
// 背景（实测确认）：
//   - qq-bridge 在 DSH 重启后会丢弃旧会话映射、新建会话
//     （bridge.js:8074 注释：「DSH 重启、异常退出、归档竞态」→ 必须退役重建）
//   - dsh-fish-memory 按 Session.id 一会话一份文件，不跨会话共享
//   => 结果：重启后机器人「失忆」，但旧记忆文件其实还在盘上。
//
// 做法：
//   1. 读桥接当前的 QQ -> 会话映射（sessions.json）
//   2. 找出记忆目录里 **所有** 历史会话的记忆文件
//   3. 把历史记忆按 id 合并进当前会话的文件（复刻插件自己的「按 id 合并」语义）
//   4. 只增不减：不删除任何已有记忆，不覆盖当前会话独有的条目
//
// 幂等：重复运行不会产生重复条目（按 id 去重）。
import fs from 'node:fs';
import path from 'node:path';

const DSH_HOME = process.env.DSH_HOME || '/data/dsh-home';
const MEM_DIR = path.join(DSH_HOME, 'fish-memory');
const STATE = '/opt/qq-bridge/state/sessions.json';

function log(m) { console.log(`[mem-migrate] ${m}`); }

if (!fs.existsSync(MEM_DIR)) {
  log(`记忆目录不存在，跳过：${MEM_DIR}`);
  process.exit(0);
}

// ── 1. 取当前会话 id ────────────────────────────────────────────────────
let currentSids = [];
try {
  const st = JSON.parse(fs.readFileSync(STATE, 'utf8'));
  currentSids = Object.values(st.sessions || {}).filter((v) => typeof v === 'string' && v);
} catch (e) {
  log(`读不到 ${STATE}（${e.message}），跳过`);
  process.exit(0);
}
if (!currentSids.length) {
  log('桥接还没有会话映射（尚未收到 QQ 消息），跳过');
  process.exit(0);
}
log(`当前会话: ${currentSids.join(', ')}`);

// ── 2. 收集所有记忆文件 ─────────────────────────────────────────────────
const files = fs.readdirSync(MEM_DIR).filter((f) => f.endsWith('.json') && f.startsWith('session-'));
const store = (f) => {
  try { return JSON.parse(fs.readFileSync(path.join(MEM_DIR, f), 'utf8')); } catch { return null; }
};

const currentFile = (sid) => `${String(sid).replace(/[^a-zA-Z0-9_-]/g, '_')}.json`;

// ── 3. 逐会话合并 ───────────────────────────────────────────────────────
let migratedAny = false;

for (const sid of currentSids) {
  const targetName = currentFile(sid);
  const targetPath = path.join(MEM_DIR, targetName);
  const cur = fs.existsSync(targetPath) ? store(targetName) : null;

  // 目标文件的结构基线：没有就用空骨架
  const base = cur && Array.isArray(cur.memories)
    ? cur
    : { version: 2, policy: {}, memories: [], traces: [], deleted: [] };

  const seenIds = new Set((base.memories || []).map((m) => m && m.id).filter(Boolean));
  const seenDeleted = new Set(
    (base.deleted || []).map((d) => (typeof d === 'string' ? d : d && d.id)).filter(Boolean)
  );

  // 其它会话的历史记忆（排除自己）
  const others = files.filter((f) => f !== targetName);
  const incoming = [];
  for (const f of others) {
    const s = store(f);
    if (!s || !Array.isArray(s.memories)) continue;
    for (const m of s.memories) {
      if (!m || !m.id) continue;
      if (seenIds.has(m.id)) continue;
      // 已被明确销毁的不复活（与插件 saveStore 的语义一致）
      if (seenDeleted.has(m.id)) continue;
      seenIds.add(m.id);
      // 标注来源，便于日后追溯
      incoming.push({
        ...m,
        source: m.source ? `${m.source}｜会话迁移` : '会话迁移',
      });
    }
    // 继承 policy：目标为空骨架时才用
    if (!cur && s.policy && typeof s.policy === 'object' && Object.keys(base.policy || {}).length === 0) {
      base.policy = s.policy;
    }
  }

  if (!incoming.length) {
    log(`${sid}: 无需迁移（已有 ${(base.memories || []).length} 条）`);
    continue;
  }

  base.memories = [...(base.memories || []), ...incoming];
  fs.mkdirSync(MEM_DIR, { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(base, null, 2), 'utf8');
  migratedAny = true;
  log(`${sid}: 迁入 ${incoming.length} 条，现有 ${base.memories.length} 条`);
}

// ── 4. 同步插件 config 的会话开关 ───────────────────────────────────────
// 插件只给「config.sessions 里为 true」的会话挂 remember 工具。
// 新会话默认不在名单里，会让迁移来的记忆只能读不能写。
const cfgPath = path.join(DSH_HOME, 'fish-memory-config.json');
try {
  if (fs.existsSync(cfgPath)) {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    cfg.sessions = cfg.sessions && typeof cfg.sessions === 'object' ? cfg.sessions : {};
    let changed = [];
    for (const sid of currentSids) {
      if (cfg.sessions[sid] !== true) {
        cfg.sessions[sid] = true;
        changed.push(sid);
      }
    }
    // 旧会话的开关保留（历史留痕），不删
    if (changed.length) {
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
      log(`记忆开关已为新会话打开: ${changed.join(', ')}`);
    }
  }
} catch (e) {
  log(`更新记忆开关失败: ${e.message}`);
}

// ── 5. 同步心情插件的会话绑定 ───────────────────────────────────────────
// 心情插件的会话键会剥掉 `session-` 前缀。
const moodCfg = path.join(DSH_HOME, 'feiyu-mood', 'config.json');
try {
  if (fs.existsSync(moodCfg)) {
    const mc = JSON.parse(fs.readFileSync(moodCfg, 'utf8'));
    const keyOf = (sid) => (sid.startsWith('session-') ? sid.slice('session-'.length) : sid);
    const want = currentSids.map(keyOf);
    let changed = [];
    if (!want.includes(mc.targetSession)) {
      mc.targetSession = want[0];
      changed.push(`targetSession=${want[0]}`);
    }
    if (Array.isArray(mc.slots) && mc.slots.length) {
      if (!want.includes(mc.slots[0].session)) {
        mc.slots[0].session = want[0];
        changed.push(`slots[0].session=${want[0]}`);
      }
    } else {
      mc.slots = [{ session: want[0], label: 'QQ 私聊', selfName: '', ownerName: '' }];
      changed.push('新建 slots[0]');
    }
    if (changed.length) {
      fs.writeFileSync(moodCfg, JSON.stringify(mc, null, 2) + '\n', 'utf8');
      log(`心情绑定已更新: ${changed.join(', ')}`);
    }
  }
} catch (e) {
  log(`更新心情绑定失败: ${e.message}`);
}

log(migratedAny ? '完成（有迁移）' : '完成（无需迁移）');
