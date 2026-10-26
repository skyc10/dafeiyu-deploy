#!/usr/bin/env node
// 应用本部署对 qq-bridge 的本地改动（幂等、可回溯、换行符无关）
//
// 改动：把 dsh-fish-memory 的 remember 工具加入 QQ 会话执行期白名单。
// 授权：用户于 2026-10-25 明确批准（代价是放宽 QQ 会话工具安全边界）。
// 回退：不执行本脚本；或删除 SAFE_EXACT 中的 'remember' 行后重建镜像。
//
// 为什么不用 sed：源文件可能是 CRLF（git checkout 的 autocrlf 行为），
// sed 锚点会静默匹配失败。Node 拆分正则对 CRLF/LF 都成立。
import fs from 'node:fs';

const TARGET = '/opt/qq-bridge/plugins/qq-agent-presets/qq-tool-restrict.mjs';
const MARKER = '本部署新增';

function fail(msg) {
  console.error(`[patch] 失败: ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(TARGET)) fail(`目标文件不存在: ${TARGET}`);

let src = fs.readFileSync(TARGET, 'utf8');
if (src.includes(MARKER)) {
  console.log('[patch] remember 已在白名单内，跳过（幂等）');
  process.exit(0);
}

// 定位 SAFE_EXACT 的 new Set([ ... ]) 区块
const setRe = /const SAFE_EXACT = new Set\(\[([\s\S]*?)\]\)/;
const m = src.match(setRe);
if (!m) fail('找不到 SAFE_EXACT = new Set([...]) 区块');

const body = m[1];
if (!/['"]todo_write['"]/.test(body)) {
  fail('SAFE_EXACT 区块内找不到 todo_write 锚点，拒绝盲改');
}
if (/['"]remember['"]/.test(body)) {
  console.log('[patch] 白名单已含 remember，无需改动');
  process.exit(0);
}

// 在区块内 todo_write 那一行之后插入，保留原换行风格
const eol = src.includes('\r\n') ? '\r\n' : '\n';
const lines = m[0].split(/\r?\n/);
let insertAt = -1;
for (let i = 0; i < lines.length; i++) {
  if (/['"]todo_write['"]/.test(lines[i])) { insertAt = i; break; }
}
if (insertAt < 0) fail('逐行定位 todo_write 失败');

const indent = (lines[insertAt].match(/^\s*/) || [''])[0];
lines.splice(insertAt + 1, 0, `${indent}'remember', // ← ${MARKER}，见上方说明`);

src = src.replace(m[0], lines.join(eol));
fs.writeFileSync(TARGET, src, 'utf8');

const check = fs.readFileSync(TARGET, 'utf8');
const m2 = check.match(setRe);
if (!m2 || !/['"]remember['"]/.test(m2[1])) fail('补丁写入后校验失败');
if (!/['"]ask_user_question['"]/.test(m2[1]) || !/['"]todo_write['"]/.test(m2[1])) {
  fail('补丁破坏了原有白名单条目');
}
console.log('[patch] remember 已加入 qq-tool-restrict 白名单');
