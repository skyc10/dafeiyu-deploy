import fs from 'node:fs';
const source = process.argv[2] || '/opt/plugins/dsh-session-header';
const target = '/data/session-header';
const patch = '/data/dsh-home/profiles/web/cordis.patch.yml';
if (!fs.existsSync(`${source}/lib/index.js`)) throw Error('Session header source missing');
if (source !== target) fs.cpSync(source, target, { recursive: true });
const current = fs.readFileSync(patch, 'utf8');
if (!current.includes('id: llm-session-header')) {
  const backup = `${patch}.before-session-header-${Date.now()}`;
  fs.copyFileSync(patch, backup, fs.constants.COPYFILE_EXCL);
  fs.writeFileSync(patch, current + '\n# dsh-session-header 0.1.0, upstream 407ad712c8b11df0d004015bf033bf392d6cc3a0\n- insert:\n    - id: llm-session-header\n      name: file:///data/session-header/lib/index.js\n      config:\n        enabled: true\n        headerName: x-session-id\n');
  console.log('Session header installed; original profile backed up.');
} else console.log('Session header entry already present; preserved.');
