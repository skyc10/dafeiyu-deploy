// Stage only a reviewed release archive; the private plugin repository remains separate.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
const [archive, commit] = process.argv.slice(2);
if (!archive || !/^[a-f0-9]{40}$/.test(commit ?? '')) throw new Error('Usage: node fish-bot/stage-companion.mjs <0.1.2.tgz> <source-commit>');
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const data = fs.readFileSync(archive);
const sha256 = crypto.createHash('sha256').update(data).digest('hex');
fs.mkdirSync(path.join(root, '.companion-build'), { recursive: true });
fs.writeFileSync(path.join(root, '.companion-build/plugin.tgz'), data);
const manifest = { repository: 'https://github.com/skyc10/dsh-qq-companion-memory', commit, version: '0.1.2', sha256 };
fs.writeFileSync(path.join(root, 'fish-bot/companion-source.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify(manifest));
