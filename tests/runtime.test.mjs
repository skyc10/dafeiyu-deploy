import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { atomicJson, readConfig, discoverOneBot } from '../fish-bot/runtime.mjs';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fish-runtime-'));
process.on('exit', () => fs.rmSync(dir, { recursive: true, force: true }));
test('atomic config survives replacement; invalid shapes and unsafe allow policy rejected', () => {
  const file = path.join(dir, 'bridge.json');
  atomicJson(file, { allowAllWhenEmpty: false, allow: { private: ['owner'], groups: [] }, dsh: { authToken: 'old' } });
  const cfg = readConfig(file); cfg.dsh.authToken = 'new'; atomicJson(file, cfg);
  assert.equal(readConfig(file).dsh.authToken, 'new');
  assert.deepEqual(readConfig(file).allow.private, ['owner']);
  assert.equal(fs.readdirSync(dir).some(n => n.endsWith('.tmp')), false);
  atomicJson(file, []); assert.throws(() => readConfig(file));
  atomicJson(file, { allowAllWhenEmpty: true }); assert.throws(() => readConfig(file));
  fs.writeFileSync(file, '{bad'); assert.throws(() => readConfig(file));
});
test('OneBot chooses the live account, preserves separate WS token, ignores wrong account and invalid files', async () => {
  const configDir = path.join(dir, 'config'); fs.mkdirSync(configDir);
  for (const [name, token] of [['onebot_100.json', 'old'], ['onebot_200.json', 'current'], ['onebot.json', 'default']]) {
    atomicJson(path.join(configDir, name), { networks: { httpServers: [{ port: 3000, accessToken: token }], wsServers: [{ port: 3001, accessToken: 'ws-' + token }] } });
  }
  fs.writeFileSync(path.join(configDir, 'onebot_broken.json'), '{');
  const fetcher = async (_url, options) => ({ ok: true, json: async () => options.headers.Authorization === 'Bearer old' ? { retcode: 1401 } : { retcode: 0, data: { user_id: 200 } } });
  const found = await discoverOneBot(configDir, 'http://snowluma:3000', fetcher);
  assert.equal(found.httpToken, 'current'); assert.equal(found.wsToken, 'ws-current');
  assert.equal(await discoverOneBot(configDir, 'http://snowluma:3000', async () => { throw new Error('offline'); }), null);
});
