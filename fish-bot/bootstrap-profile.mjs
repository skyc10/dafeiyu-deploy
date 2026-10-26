#!/usr/bin/env node
// 初始化专用 DSH profile：装 qq-bridge 的两个 preset bundle + 记忆/心情插件
//
// 机制依据（_audit/fish-memory-mood-audit.md、_audit/qq-bridge-audit.md）：
//   - DSH 0.2.1 的插件装配 = profile 的 cordis.patch.yml + package.json 的 dsh.profile.bundles
//   - bundle 用 link: 依赖注册，DSH 首次启动需要 node_modules 里能解析到
//     （qq-bridge 的 setup-dsh.mjs:262-268 也是建两层链接的理由）
//   - 记忆/心情插件各有一份 cordis.patch.yml，插一行 loader
//
// 全流程只写 DSH_HOME 下，绝不碰宿主 ~/.dsh（靠 entrypoint 的前置断言保证）。
import fs from 'node:fs';
import path from 'node:path';

const DSH_HOME = process.env.DSH_HOME;
if (!DSH_HOME) {
  console.error('[bootstrap] DSH_HOME 未设置');
  process.exit(1);
}
if (!DSH_HOME.startsWith('/data/')) {
  console.error(`[bootstrap] DSH_HOME=${DSH_HOME} 不在 /data 下，拒绝执行`);
  process.exit(1);
}

const PROFILE = process.env.DSH_PROFILE || 'web';
const profileDir = path.join(DSH_HOME, 'profiles', PROFILE);
const pluginsHome = path.join(DSH_HOME, 'plugins');
const patchFile = path.join(profileDir, 'cordis.patch.yml');

const REPO = '/opt/qq-bridge';
const PLUGIN_SRC = {
  'qq-agent-presets': path.join(REPO, 'plugins', 'qq-agent-presets'),
  'qq-mode-console': path.join(REPO, 'plugins', 'qq-mode-console'),
  'dsh-fish-memory': '/opt/plugins/dsh-fish-memory',
  'dsh-feiyu-mood': '/opt/plugins/dsh-feiyu-mood',
};

// DSH 主包内嵌的基础 bundle。
// 为什么必须单独链接：npm install -g 只把 @deepseek-ai/dsh 装到全局，
// dsh-base / dsh-web-app 作为它的内嵌依赖在 dsh/node_modules 里。
// DSH 从 profile 目录解析 bundle，所以从 profile 解析不到它们（实测 MODULE_NOT_FOUND），
// 结果所有插件都停在 "pending (waiting for service: tools/systemPrompt/...)"。
const DSH_ROOT = '/usr/local/lib/node_modules/@deepseek-ai/dsh';
const BASE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'];
const BASE_SRC = {
  '@deepseek-ai/dsh-base': path.join(DSH_ROOT, 'node_modules', '@deepseek-ai', 'dsh-base'),
  '@deepseek-ai/dsh-web-app': path.join(DSH_ROOT, 'node_modules', '@deepseek-ai', 'dsh-web-app'),
};

function log(m) { console.log(`[bootstrap] ${m}`); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function linkInto(name, srcDir) {
  if (!fs.existsSync(srcDir)) {
    console.warn(`[bootstrap] 跳过 ${name}：源目录不存在 ${srcDir}`);
    return null;
  }
  // 第一层：DSH_HOME/plugins/<name> -> 源码目录
  const linkDir = path.join(pluginsHome, name);
  ensureDir(pluginsHome);
  try {
    if (fs.existsSync(linkDir) || fs.lstatSync(linkDir, { throwIfNoEntry: false })) {
      fs.rmSync(linkDir, { recursive: true, force: true });
    }
    fs.symlinkSync(srcDir, linkDir, 'dir');
  } catch (e) {
    console.error(`[bootstrap] 建链接失败 ${linkDir}: ${e.message}`);
    return null;
  }
  // 第二层：profile/node_modules/<name> -> 第一层（Node 解析裸说明符需要）
  const nmDir = path.join(profileDir, 'node_modules');
  ensureDir(nmDir);
  const nmLink = path.join(nmDir, name);
  try {
    if (fs.existsSync(nmLink) || fs.lstatSync(nmLink, { throwIfNoEntry: false })) {
      fs.rmSync(nmLink, { recursive: true, force: true });
    }
    fs.symlinkSync(linkDir, nmLink, 'dir');
  } catch (e) {
    console.error(`[bootstrap] 建链接失败 ${nmLink}: ${e.message}`);
    return null;
  }
  log(`${name}: 已链接`);
  return linkDir;
}

/**
 * 把基础 bundle 直接链进 profile/node_modules。
 * 用绝对目标（不经过 DSH_HOME/plugins 中转），因为它们不是本项目产物。
 */
function linkBaseBundle(pkgName, srcDir) {
  if (!fs.existsSync(srcDir)) {
    console.error(`[bootstrap] 基础 bundle 源不存在: ${srcDir}`);
    return false;
  }
  const nmDir = path.join(profileDir, 'node_modules');
  ensureDir(nmDir);
  const scopeDir = path.join(nmDir, '@deepseek-ai');
  ensureDir(scopeDir);
  const dest = path.join(scopeDir, pkgName.split('/')[1]);
  try {
    if (fs.existsSync(dest) || fs.lstatSync(dest, { throwIfNoEntry: false })) {
      fs.rmSync(dest, { recursive: true, force: true });
    }
    fs.symlinkSync(srcDir, dest, 'dir');
    log(`${pkgName}: 已链入 profile/node_modules`);
    return true;
  } catch (e) {
    console.error(`[bootstrap] 链接 ${pkgName} 失败: ${e.message}`);
    return false;
  }
}

function main() {
  log(`初始化 profile: ${profileDir}`);
  ensureDir(profileDir);

  // ── 0. 基础 bundle 必须能解析，否则核心服务全都不装载 ────────────────────
  // 依据：主 DSH 的 profile package.json 中 bundles 首位是这两个。
  // 缺了它们，tools / systemPrompt / agents / llm 等核心服务不会装载，
  // 所有插件都会停在 "pending (waiting for service: ...)"（已实测复现）。
  for (const [pkgName, src] of Object.entries(BASE_SRC)) {
    linkBaseBundle(pkgName, src);
  }

  // ── 1. 链接四个 bundle ──────────────────────────────────────────────────
  const links = {};
  for (const [name, src] of Object.entries(PLUGIN_SRC)) {
    const l = linkInto(name, src);
    if (l) links[name] = l;
  }

  // ── 2. 写 profile package.json ─────────────────────────────────────────
  const pkgFile = path.join(profileDir, 'package.json');
  let pkg = {
    name: `dsh-profile-${PROFILE}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: [] } },
  };
  if (fs.existsSync(pkgFile)) {
    try { pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8')); } catch { /* 用默认 */ }
  }
  pkg.name = pkg.name || `dsh-profile-${PROFILE}`;
  pkg.private = pkg.private !== false;
  pkg.dependencies = pkg.dependencies && typeof pkg.dependencies === 'object' ? pkg.dependencies : {};
  pkg.dsh = pkg.dsh || {};
  pkg.dsh.profile = pkg.dsh.profile || {};
  pkg.dsh.profile.bundles = Array.isArray(pkg.dsh.profile.bundles) ? pkg.dsh.profile.bundles : [];

  // 基础 bundle 放最前（被依赖的必须先装载）
  for (const base of BASE_BUNDLES) {
    if (!pkg.dsh.profile.bundles.includes(base)) pkg.dsh.profile.bundles.unshift(base);
  }

  for (const name of Object.keys(links)) {
    pkg.dependencies[name] = `link:${links[name]}`;
    if (!pkg.dsh.profile.bundles.includes(name)) pkg.dsh.profile.bundles.push(name);
  }
  fs.writeFileSync(pkgFile, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');
  log(`package.json 已写：bundles=${pkg.dsh.profile.bundles.join(', ')}`);

  // ── 3. 写 cordis.patch.yml（MCP 三条 + 两插件）────────────────────────
  // 注意：这里刻意不调用 qq-bridge 的 setup-dsh.mjs ——
  // 审计实测它会用 js-yaml 默认 schema 重写整个文件、抹掉注释，
  // 且要求敲 dsh plugin install。这里按它的产物格式手写，语义等价。
  const nodeBin = process.execPath;
  const mcpBlock = [
    '# === qq-bridge MCP BEGIN ===',
    '# 由 bootstrap-profile.mjs 生成；语义等价于 qq-bridge/scripts/setup-dsh.mjs 的产物',
    '- insert:',
    "    - id: mcp-snowluma",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: snowluma',
    '        transport: stdio',
    `        command: '${nodeBin}'`,
    '        args:',
    "          - '/opt/qq-bridge/src/mcp-snowluma-safe.js'",
    '        toolCallTimeoutMs: 725000',
    "    - id: mcp-snowluma-host",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: snowluma-host',
    '        transport: stdio',
    `        command: '${nodeBin}'`,
    '        args:',
    "          - '/opt/qq-bridge/src/mcp-host-server.js'",
    "    - id: mcp-web-search-safe",
    "      name: '@deepseek-ai/dsh-mcp-client'",
    '      config:',
    '        serverName: web-search-safe',
    '        transport: stdio',
    `        command: '${nodeBin}'`,
    '        args:',
    "          - '/opt/qq-bridge/src/mcp-web-search-safe.js'",
    '# === qq-bridge MCP END ===',
    '',
    '# 记忆插件（默认不生效，需在设置页为会话开启）',
    '- insert:',
    '    - id: memory',
    '      name: dsh-fish-memory',
    '',
    '# 心情插件（默认不绑会话，需在设置页绑定）',
    '- insert:',
    '    - id: mood',
    '      name: dsh-feiyu-mood',
    '',
  ].join('\n');

  if (!fs.existsSync(patchFile)) {
    fs.writeFileSync(patchFile, mcpBlock, 'utf8');
    log('cordis.patch.yml 已创建');
  } else {
    const cur = fs.readFileSync(patchFile, 'utf8');
    const needed = ['mcp-snowluma', 'mcp-snowluma-host', 'mcp-web-search-safe', 'id: memory', 'id: mood'];
    const missing = needed.filter((k) => !cur.includes(k));
    if (missing.length) {
      fs.writeFileSync(patchFile, `${cur}\n${mcpBlock}`, 'utf8');
      log(`cordis.patch.yml 已追加缺失条目：${missing.join(', ')}`);
    } else {
      log('cordis.patch.yml 已含全部条目，跳过');
    }
  }

  // ── 4. 写 qq-bridge config.json（若不存在则从模板）───────────────────
  const cfgFile = path.join(REPO, 'config.json');
  const tplFile = '/opt/bridge-config.template.json';
  if (!fs.existsSync(cfgFile) && fs.existsSync(tplFile)) {
    fs.copyFileSync(tplFile, cfgFile);
    log('config.json 已从模板生成（白名单为空，必须人工填写）');
  }

  log('profile 初始化完成');
}

try {
  main();
} catch (e) {
  console.error('[bootstrap] 失败:', e && e.stack ? e.stack : e);
  process.exit(1);
}
