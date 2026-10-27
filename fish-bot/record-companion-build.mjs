import fs from 'node:fs';
import crypto from 'node:crypto';
const root = '/opt/qq-bridge/src/';
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const source = JSON.parse(fs.readFileSync('/opt/companion-source.json', 'utf8'));
const stages = {};
for (const file of ['bridge.js', 'mcp-host-server.js', 'mcp-snowluma-safe.js', 'deployment-config.js']) {
  stages[file] = { final: hash(root + file) };
  for (const [stage, suffix] of [['upstream', '.orig'], ['beforeRuntime', '.runtime-source']]) {
    if (fs.existsSync(root + file + suffix)) stages[file][stage] = hash(root + file + suffix);
  }
}
fs.writeFileSync('/opt/companion-build.json', JSON.stringify({ source, node: process.version, stages }, null, 2) + '\n');
