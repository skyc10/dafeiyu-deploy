// Authorized live test: run inside fish-bot, never posts to a group.
// node /tmp/owner_e2e.mjs --send-owner-test
import fs from 'node:fs';
if (process.argv[2] !== '--send-owner-test') throw new Error('Explicit --send-owner-test required');
const c = JSON.parse(fs.readFileSync('/data/bridge-config.json', 'utf8'));
const owner = String(c.ownerQQ || '');
if (!/^\d+$/.test(owner) || !(c.allow?.private || []).map(String).includes(owner) || (c.deny?.private || []).map(String).includes(owner)) throw new Error('Owner private conversation is not authorized by current config');
const token = c.consoleToken || fs.readFileSync('/data/bridge-state/console-token','utf8').trim();
const base = 'http://127.0.0.1:3100';
const key = 'private:' + owner;
const marker = 'LINKCHECK-' + Date.now();
const expected = `【连通性验收 ${marker}】DSH 与 QQ 桥接已恢复。这是主人授权的单次测试。`;
const headers = { 'x-console-token': token, 'Content-Type': 'application/json', Origin: base };
const message = `主人已明确授权这一次连通性验收。请只调用一次 qq_send_message，key 使用当前私聊会话 ${key}，messages 使用这一条测试文字：${expected}。仅向此主人私聊发送；不要发到任何群或其他联系人。不要输出令牌、后台提醒或其他私密内容。本次无需搜索、等待、记忆写入或修改设置。发送成功后直接结束回合。`;
const response = await fetch(base + '/api/console/notify-ai', {method:'POST', headers, body:JSON.stringify({key,message}), signal:AbortSignal.timeout(20000)});
const result = await response.json();
if (!response.ok || !result.ok) throw new Error('Owner test request rejected (HTTP ' + response.status + ')');
console.log(JSON.stringify({test:'owner-private-model-request',accepted:true,marker}));
let matched = false;
const deadline = Date.now() + 180000;
while (Date.now() < deadline) {
  const r = await fetch(base + '/api/socialV2/recent?key=' + encodeURIComponent(key) + '&limit=20', {headers,signal:AbortSignal.timeout(5000)});
  const body = await r.json();
  if (body.ok && JSON.stringify(body.messages || []).includes(marker)) { matched = true; break; }
  await new Promise(resolve => setTimeout(resolve,2000));
}
if (!matched) throw new Error('Model request accepted but no confirmed private test message within 180s');
console.log(JSON.stringify({test:'model-to-bridge-to-owner-QQ',passed:true,marker}));
