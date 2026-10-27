import fs from 'node:fs';
try {
  const cfg = JSON.parse(fs.readFileSync(process.env.QQ_BRIDGE_CONFIG_FILE || '/data/bridge-config.json', 'utf8'));
  const token = cfg.consoleToken || fs.readFileSync('/data/bridge-state/console-token', 'utf8').trim();
  const res = await fetch('http://127.0.0.1:13100/api/status', { headers: { 'x-console-token': token }, signal: AbortSignal.timeout(4000) });
  const value = await res.json();
  // QQ login is shown as degraded; it is not a process-liveness requirement.
  if (!res.ok || !value.dshReady || value.dsh?.eventStreamConnected !== true) throw new Error();
  console.log('DSH authenticated and event stream connected');
} catch { console.log('Bridge/DSH not ready'); process.exitCode = 1; }
