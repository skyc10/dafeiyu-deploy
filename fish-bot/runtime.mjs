import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function atomicJson(file, value) {
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd); }
  finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  fs.chmodSync(file, 0o600);
}
export function readConfig(file) {
  const value = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error('bridge config must be an object');
  if (value.allowAllWhenEmpty !== false) throw new Error('allowAllWhenEmpty must be false');
  for (const kind of ['private', 'groups']) {
    if (!Array.isArray(value.allow?.[kind])) throw new Error('allow lists must be arrays');
  }
  return value;
}
export function concreteIPv4() {
  const found = Object.values(os.networkInterfaces()).flat().find(a => a && a.family === 'IPv4' && !a.internal);
  if (!found) throw new Error('No concrete container IPv4 address');
  return found.address;
}
const pause = ms => new Promise(r => setTimeout(r, ms));
const log = message => console.log(`[runtime] ${message}`);

export async function discoverOneBot(configDir, httpBase, fetcher = fetch) {
  const names = fs.readdirSync(configDir).filter(n => /^onebot.*\.json$/.test(n)).sort();
  const valid = [];
  for (const name of names) {
    let config;
    try { config = JSON.parse(fs.readFileSync(path.join(configDir, name), 'utf8')); } catch { continue; }
    for (const http of config.networks?.httpServers || []) {
      if (http.enable === false || http.enabled === false || Number(http.port) !== new URL(httpBase).port * 1) continue;
      try {
        const res = await fetcher(new URL('get_login_info', httpBase + '/'), {
          headers: { Authorization: `Bearer ${http.accessToken || ''}` }, signal: AbortSignal.timeout(2000),
        });
        const body = await res.json();
        if (res.ok && body.retcode === 0 && body.data?.user_id) {
          const account = String(body.data.user_id);
          if (/^onebot_/.test(name) && name !== `onebot_${account}.json`) continue;
          const ws = (config.networks?.wsServers || []).find(s => s.enable !== false && s.enabled !== false && Number(s.port) === 3001);
          valid.push({ httpToken: String(http.accessToken || ''), wsToken: ws?.accessToken, account, specific: name === `onebot_${account}.json` });
        }
      } catch { /* A logged-out gateway is a degraded state, not a startup crash. */ }
    }
  }
  return valid.sort((a, b) => Number(b.specific) - Number(a.specific))[0] || null;
}

export async function main() {
  for (const name of ['DSH_HOME', 'DSH_AGENTS_HOME']) {
    if (!process.env[name]?.startsWith('/data/')) throw new Error(`${name} must be below /data`);
    fs.mkdirSync(process.env[name], { recursive: true });
  }
  const configFile = process.env.QQ_BRIDGE_CONFIG_FILE || '/data/bridge-config.json';
  const marker = '/data/architecture-v2-migrated.json';
  const legacy = '/data/bridge-config.pre-upgrade-live.json';
  if (!fs.existsSync(configFile)) fs.copyFileSync('/opt/bridge-config.template.json', configFile);
  if (!fs.existsSync(marker)) {
    const backup = `/data/config-backup-${Date.now()}`;
    fs.mkdirSync(backup, { mode: 0o700 });
    fs.copyFileSync(configFile, path.join(backup, 'persistent.json'));
    if (fs.existsSync(legacy)) {
      fs.copyFileSync(legacy, path.join(backup, 'running.json'));
      atomicJson(configFile, readConfig(legacy));
    }
    atomicJson(marker, { version: 2, migratedAt: new Date().toISOString(), backup });
  }
  readConfig(configFile);
  // An old single-file link is retained for read-only legacy tools. All runtime
  // writers are patched to the actual persistent filename (rename-safe).
  const oldConfig = '/opt/qq-bridge/config.json';
  if (fs.existsSync(oldConfig) || fs.lstatSync(oldConfig, { throwIfNoEntry: false })) fs.unlinkSync(oldConfig);
  fs.symlinkSync(configFile, oldConfig);
  for (const [name, target] of [['state', '/data/bridge-state'], ['roles', '/data/roles']]) {
    fs.mkdirSync(target, { recursive: true });
    const dest = `/opt/qq-bridge/${name}`;
    const stat = fs.lstatSync(dest, { throwIfNoEntry: false });
    if (stat && !stat.isSymbolicLink()) {
      for (const entry of fs.readdirSync(dest)) {
        if (!fs.existsSync(path.join(target, entry))) fs.cpSync(path.join(dest, entry), path.join(target, entry), { recursive: true });
      }
      fs.rmSync(dest, { recursive: true });
    } else if (stat) fs.unlinkSync(dest);
    fs.symlinkSync(target, dest);
  }
  const role = '/data/roles/大肥鱼.md';
  if (!fs.existsSync(role)) fs.copyFileSync('/opt/roles-seed/大肥鱼.md', role);
  if (!fs.existsSync('/data/bridge-state/current-role.json')) atomicJson('/data/bridge-state/current-role.json', { role: '大肥鱼' });

  const children = new Set();
  let stopping = false;
  async function shutdown(code) {
    if (stopping) return;
    stopping = true;
    log('Stopping supervised processes');
    for (const child of children) { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
    const deadline = Date.now() + 25000;
    while (children.size && Date.now() < deadline) await pause(100);
    for (const child of children) { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }
    process.exit(code);
  }
  function start(label, command, args, fd = 'inherit') {
    const child = spawn(command, args, { cwd: '/opt/qq-bridge', detached: true, stdio: ['ignore', fd, fd], env: { ...process.env, QQ_BRIDGE_CONFIG_FILE: configFile } });
    children.add(child);
    child.on('error', () => { log(`${label} failed to spawn`); shutdown(1); });
    child.on('exit', (code, signal) => {
      children.delete(child);
      if (!stopping) { log(`${label} exited (${code ?? signal})`); shutdown(1); }
    });
    return child;
  }
  process.on('SIGTERM', () => shutdown(0));
  process.on('SIGINT', () => shutdown(0));
  try {
    const profile = path.join(process.env.DSH_HOME, 'profiles/web/package.json');
    if (!fs.existsSync(profile)) {
      await new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['/opt/bootstrap-profile.mjs'], { stdio: 'inherit' });
        child.on('error', reject); child.on('exit', code => code === 0 ? resolve() : reject(new Error('Profile bootstrap failed')));
      });
    }
    const bind = process.env.DSH_BIND_IP || concreteIPv4();
    const port = process.env.DSH_PORT || '3080';
    const base = `http://fish-bot:${port}`;
    fs.writeFileSync('/data/dsh-url.txt', '', { mode: 0o600 });
    const fd = fs.openSync('/data/dsh.log', 'w', 0o600);
    start('DSH', 'dsh', ['web', '--host', bind, '--port', port, '--trusted-host', `fish-bot:${port}`, '--no-open'], fd);
    fs.closeSync(fd);
    let launch;
    for (let i = 0; i < 90 && !stopping; i++) {
      launch = [...fs.readFileSync('/data/dsh.log', 'utf8').matchAll(/http:\/\/[^\s]*[?&]token=([A-Za-z0-9_-]+)/g)].at(-1);
      if (launch) break;
      await pause(1000);
    }
    if (!launch || stopping) throw new Error('DSH launch token not ready after 90 seconds');
    fs.writeFileSync('/data/dsh-url.txt', launch[0] + '\n', { mode: 0o600 });
    const config = readConfig(configFile);
    config.dsh = { ...config.dsh, baseUrl: base, authToken: launch[1], allowRemote: true };
    config.snowluma = { ...config.snowluma, homeDir: '/snowluma-home', httpUrl: 'http://snowluma:3000', wsUrl: 'ws://snowluma:3001', followDiscoveredEndpoint: false };
    try {
      const discovered = await discoverOneBot('/snowluma-home/config', config.snowluma.httpUrl);
      if (discovered) { config.snowluma.accessToken = discovered.httpToken; log('OneBot active account HTTP token verified; WS discovery retained'); }
      else log('OneBot not ready/logged in; bridge will reconnect in background');
    } catch { log('OneBot config unavailable; bridge will retry'); }
    atomicJson(configFile, config);
    const { NodeApiClient } = await import('/opt/qq-bridge/src/dsh-client.js');
    const api = new NodeApiClient(base, 5000, { token: launch[1], allowRemote: true });
    const result = await api.callUnary('settings/describe', {});
    if (!result.result?.ok) throw new Error('DSH authenticated readiness probe failed');
    log('DSH authenticated via stable service name; starting bridge');
    start('console proxy', process.execPath, ['/opt/console-proxy.mjs']);
    start('qqbridge', process.execPath, ['/opt/qq-bridge/src/bridge.js']);
    // Preserve the existing one-shot memory migration, without changing its policy.
    let attempts = 0;
    const migration = setInterval(() => {
      if (stopping || ++attempts > 120) { clearInterval(migration); return; }
      try {
        const text = fs.readFileSync('/data/bridge-state/sessions.json', 'utf8');
        if (/"(?:private|group):/.test(text)) {
          clearInterval(migration);
          spawn(process.execPath, ['/opt/migrate-memory.mjs'], { stdio: 'inherit' });
        }
      } catch {}
    }, 5000);
    await new Promise(() => {});
  } catch (error) {
    log(`Startup failed: ${error.name} (${String(error.message).replace(/token=[^\s]+/g, 'token=<hidden>')})`);
    await shutdown(1);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error('[runtime]', error.message); process.exit(1); });
}
