// Deployment-only patch; refuse upstream drift instead of silently missing readers.
import fs from 'node:fs';
import path from 'node:path';
const root = process.argv[2] || '/opt/qq-bridge';
const pending = [];
function change(file, edit) {
  const p = path.join(root, 'src', file);
  const current = fs.readFileSync(p, 'utf8').replace(/\r\n/g, '\n');
  const backup = `${p}.runtime-source`;
  const marked = current.includes('// DAFEIYU_RUNTIME_V2');
  if (marked && !fs.existsSync(backup)) throw new Error(`${file}: runtime source backup missing; rebuild from fixed upstream`);
  const source = marked ? fs.readFileSync(backup, 'utf8').replace(/\r\n/g, '\n') : current;
  if (source.includes('// DAFEIYU_RUNTIME_V2')) throw new Error(`${file}: invalid runtime source backup`);
  const expected = '// DAFEIYU_RUNTIME_V2\n' + edit(source);
  if (marked && current !== expected) throw new Error(`${file}: runtime marker/content mismatch`);
  if (!marked && fs.existsSync(backup) && fs.readFileSync(backup, 'utf8').replace(/\r\n/g, '\n') !== source) throw new Error(`${file}: runtime source backup mismatch`);
  if (!marked) pending.push([backup, source], [p, expected]);
}
function replaceOne(text, from, to) {
  if (text.split(from).length !== 2) throw new Error('Patch anchor changed: ' + from.slice(0, 70));
  return text.replace(from, to);
}
for (const [file, expected] of [['bridge.js', 12], ['mcp-snowluma-safe.js', 1], ['mcp-host-server.js', 1]]) {
  change(file, text => {
    const from = "path.join(ROOT, 'config.json')";
    const count = text.split(from).length - 1;
    if (count !== expected) throw new Error(`${file}: expected ${expected} config readers, got ${count}`);
    text = "import { bridgeConfigPath } from './deployment-config.js';\n" + text.replaceAll(from, 'bridgeConfigPath');
    if (file !== 'bridge.js') return text;
    text = replaceOne(text, '  let dshReady = false;', `  let dshReady = false;
  const dshHealth = { connected: false, eventStreamConnected: false, errorKind: null, httpStatus: null, lastConnectedAt: null, lastErrorAt: null };
  function recordDshError(error, stream = false) {
    const message = String(error?.message ?? error ?? '');
    const code = Number(message.match(/HTTP (\\d{3})/)?.[1]) || null;
    dshHealth.errorKind = code === 401 ? 'authentication_failed' : code === 403 ? 'host_rejected' : stream ? 'event_stream_disconnected' : 'unreachable';
    dshHealth.httpStatus = code;
    dshHealth.lastErrorAt = new Date().toISOString();
    if (stream) dshHealth.eventStreamConnected = false;
    else dshHealth.connected = false;
  }`);
    text = replaceOne(text, '      ok = true;\n    } catch {}\n    if (ok)', `      ok = true;
      dshHealth.connected = true;
      dshHealth.lastConnectedAt = new Date().toISOString();
      if (dshHealth.eventStreamConnected) { dshHealth.errorKind = null; dshHealth.httpStatus = null; }
    } catch (error) { recordDshError(error); }
    if (ok)`);
    // Only the operator response receives diagnostics, never the agent response.
    text = replaceOne(text, '            dshReady,\n            ownerQQ:', '            dshReady,\n            dsh: { ...dshHealth },\n            ownerQQ:');
    text = replaceOne(text, "        log('事件流中断:', error?.message ?? error);", "        recordDshError(error, true);\n        log('事件流中断:', error?.message ?? error);");
    text = replaceOne(text, '        for await (const envelope of api.events.mux({})) {', `        for await (const envelope of api.events.mux({}, undefined, () => {
          dshHealth.eventStreamConnected = true;
          dshHealth.errorKind = null;
          dshHealth.httpStatus = null;
        })) {`);
    // A quiet connected stream may have no session frames; use onOpen above.
    text = replaceOne(text, '          framesThisStream += 1;', `          framesThisStream += 1;
          dshHealth.eventStreamConnected = true;
          dshHealth.errorKind = null;
          dshHealth.httpStatus = null;`);
    text = replaceOne(text, '        collectors.clear(); //', '        dshHealth.eventStreamConnected = false;\n        collectors.clear(); //');
    return text;
  });
}
const deploymentConfig = `import path from 'node:path';
import { fileURLToPath } from 'node:url';
export const bridgeConfigPath = process.env.QQ_BRIDGE_CONFIG_FILE || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../config.json');
`;
const configPath = path.join(root, 'src/deployment-config.js');
if (fs.existsSync(configPath) && fs.readFileSync(configPath, 'utf8') !== deploymentConfig) throw new Error('deployment-config.js content mismatch');
if (!fs.existsSync(configPath)) pending.push([configPath, deploymentConfig]);
// All anchors and existing outputs are checked before the first filesystem write.
const saved = pending.map(([file]) => [file, fs.existsSync(file) ? fs.readFileSync(file) : null]);
try {
  for (const [file, content] of pending) {
    fs.writeFileSync(`${file}.runtime-tmp`, content, 'utf8');
    fs.renameSync(`${file}.runtime-tmp`, file);
  }
} catch (error) {
  for (const [file, content] of saved.reverse()) {
    if (content === null) fs.rmSync(file, { force: true });
    else fs.writeFileSync(file, content);
    fs.rmSync(`${file}.runtime-tmp`, { force: true });
  }
  throw error;
}
console.log('[patch] single persistent config + operator connection diagnostics applied');
