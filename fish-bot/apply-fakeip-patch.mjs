#!/usr/bin/env node
// 本部署改动：允许 Clash TUN 的 fake-ip 段 198.18.0.0/15 通过 SSRF 检查。
//
// 授权：用户于 2026-10-25 明确批准（代价：放宽 qq-bridge 的 SSRF 防护）。
//
// 背景（实测）：
//   本机 Clash Verge 以 TUN 模式运行，容器内 DNS 把 QQ 媒体域名解析到
//   198.18.0.x（fake-ip）。qq-bridge 的 safe-fetch.js:82 把它判为内网地址，
//   于是「域名解析到内网/本机地址，已阻止」，机器人看不到用户发的图片/表情。
//   198.18.0.0/15 本是 RFC 2544 bench 测试段，不是真实内网，放行风险有限。
//
// 回退：不执行本脚本，或删除 target 中 `__TUN_FAKEIP_ALLOWED` 标记块后重建镜像。
import fs from 'node:fs';

const TARGET = '/opt/qq-bridge/src/safe-fetch.js';
const MARKER = '__TUN_FAKEIP_ALLOWED';

if (!fs.existsSync(TARGET)) {
  console.error(`[patch] 目标文件不存在: ${TARGET}`);
  process.exit(1);
}

let src = fs.readFileSync(TARGET, 'utf8');
if (src.includes(MARKER)) {
  console.log('[patch] fake-ip 放行补丁已在，跳过（幂等）');
  process.exit(0);
}

// 精确替换那条 198.18/15 判定，改为受环境变量控制的放行。
const OLD = '    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) return true;';
const NEW = [
  '    // __TUN_FAKEIP_ALLOWED：本部署允许 Clash TUN 的 fake-ip 段（用户授权 2026-10-25）',
  "    // 198.18.0.0/15 是 RFC 2544 bench 测试段，非真实内网；本机 TUN 模式把它当 fake-ip 用。",
  "    // 设为 QQBRIDGE_ALLOW_TUN_FAKEIP=0 可恢复上游默认（判为内网并阻止）。",
  '    if (parts[0] === 198 && parts[1] >= 18 && parts[1] <= 19) {',
  "      if (process.env.QQBRIDGE_ALLOW_TUN_FAKEIP !== '0') return false;",
  '      return true;',
  '    }',
].join('\n');

if (!src.includes(OLD)) {
  console.error('[patch] 找不到目标行，拒绝盲改。实际内容：');
  const m = src.match(/.*198.*/g);
  if (m) m.slice(0, 5).forEach((l) => console.error('   ', l));
  process.exit(1);
}

const count = src.split(OLD).length - 1;
if (count !== 1) {
  console.error(`[patch] 目标行出现 ${count} 次（期望 1），拒绝盲改`);
  process.exit(1);
}

src = src.replace(OLD, NEW);
fs.writeFileSync(TARGET, src, 'utf8');

// 校验
const after = fs.readFileSync(TARGET, 'utf8');
if (!after.includes(MARKER)) {
  console.error('[patch] 写入后校验失败');
  process.exit(1);
}
if (!/parts\[0\] === 10\) return true/.test(after)) {
  console.error('[patch] 警告：其它内网判定似乎被破坏');
  process.exit(1);
}
console.log('[patch] fake-ip 段 198.18.0.0/15 已放行（可用 QQBRIDGE_ALLOW_TUN_FAKEIP=0 关闭）');
