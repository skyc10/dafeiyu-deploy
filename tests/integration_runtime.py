"""Explicit live recovery acceptance; stops/restarts existing production containers.
Run only with user authorization: python tests/integration_runtime.py --live-restarts
"""
import hashlib
import json
from pathlib import Path
import subprocess
import sys
import time

PROJECT = Path(__file__).resolve().parents[1]

def docker(*args, stdin=None, timeout=120):
    result = subprocess.run(['docker', *args], input=stdin, capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=timeout)
    if result.returncode:
        raise RuntimeError('Docker operation failed: ' + ' '.join(args[:3]))
    return result.stdout

def node(source):
    return json.loads(docker('exec', '-i', 'fish-bot', 'node', '--input-type=module', stdin=source))

STATUS = """import fs from 'node:fs';
const c=JSON.parse(fs.readFileSync('/data/bridge-config.json','utf8'));
const t=c.consoleToken||fs.readFileSync('/data/bridge-state/console-token','utf8').trim();
const r=await fetch('http://127.0.0.1:3100/api/status',{headers:{'x-console-token':t},signal:AbortSignal.timeout(3000)});
const s=await r.json();
console.log(JSON.stringify({ready:s.dshReady,stream:s.dsh?.eventStreamConnected,snow:s.snowluma?.connected,online:s.snowluma?.accountOnline,error:s.dsh?.errorKind}));"""

def wait_ready(label):
    deadline = time.monotonic() + 130
    while time.monotonic() < deadline:
        try:
            value = node(STATUS)
            if all(value.get(k) for k in ['ready', 'stream', 'snow', 'online']):
                print(json.dumps({'test': label, 'passed': True}, ensure_ascii=False), flush=True)
                return value
        except (RuntimeError, ValueError):
            pass
        time.sleep(2)
    raise RuntimeError('Readiness timeout: ' + label)

def config():
    return json.loads(docker('exec', 'fish-bot', 'cat', '/data/bridge-config.json'))

def profile_hashes():
    return docker('exec', 'fish-bot', 'sha256sum', '/data/dsh-home/profiles/web/package.json', '/data/dsh-home/profiles/web/cordis.patch.yml')

def main():
    if sys.argv[1:] != ['--live-restarts']:
        raise SystemExit('Requires explicit --live-restarts and user authorization')
    initial = config()
    profile = profile_hashes()
    wait_ready('initial authenticated service name and connections')
    # Real atomic-save path, then immediate restart: no 3-second copy daemon.
    node("""import fs from 'node:fs'; import {atomicJson} from '/opt/runtime.mjs';
const p='/data/bridge-config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));
c._deploymentAcceptance='atomic-save-restart';atomicJson(p,c);console.log('{}');""")
    docker('restart', '--timeout', '35', 'fish-bot')
    wait_ready('single-container restart')
    assert config().get('_deploymentAcceptance') == 'atomic-save-restart'
    node("""import fs from 'node:fs'; import {atomicJson} from '/opt/runtime.mjs';
const p='/data/bridge-config.json';const c=JSON.parse(fs.readFileSync(p,'utf8'));delete c._deploymentAcceptance;atomicJson(p,c);console.log('{}');""")
    # Each essential process must terminate the supervised container and restart.
    for pattern in ['/opt/console-proxy.mjs', '/usr/local/bin/dsh web', '/opt/qq-bridge/src/bridge.js']:
        before = json.loads(docker('inspect', 'fish-bot'))[0]['RestartCount']
        processes = docker('exec', 'fish-bot', 'ps', '-eo', 'pid,args').splitlines()
        matches = [int(line.strip().split(None, 1)[0]) for line in processes if pattern in line and 'ps -eo' not in line]
        assert len(matches) == 1, (pattern, len(matches))
        docker('exec', 'fish-bot', 'kill', '-TERM', str(matches[0]))
        deadline = time.monotonic()+50
        while time.monotonic() < deadline:
            info = json.loads(docker('inspect','fish-bot'))[0]
            if info['RestartCount'] > before:
                break
            time.sleep(1)
        else:
            raise RuntimeError('Supervisor did not restart for ' + pattern)
        wait_ready('essential process recovery: ' + pattern)
    docker('restart', '--timeout', '35', 'snowluma')
    wait_ready('gateway-only restart and reconnect')
    docker('stop', '--timeout', '35', 'fish-bot', 'snowluma')
    stopped = json.loads(docker('inspect', 'fish-bot', 'snowluma'))
    assert all(c['State']['ExitCode'] == 0 for c in stopped), 'Ungraceful stop'
    docker('start','snowluma')
    docker('start','fish-bot')
    wait_ready('whole-stack graceful stop/start')
    subprocess.run(['docker','compose','up','-d','--no-deps','--force-recreate','--no-build','fish-bot'],cwd=PROJECT,check=True,capture_output=True,timeout=120)
    wait_ready('container recreation preserves data and connection')
    current = config()
    for key in initial:
        if key not in ['dsh', 'snowluma']:
            assert current.get(key) == initial[key], 'User configuration changed: ' + key
    for key in initial['dsh']:
        if key not in ['baseUrl','authToken','allowRemote']:
            assert current['dsh'].get(key) == initial['dsh'][key], 'DSH user setting changed'
    assert profile_hashes() == profile, 'Existing profile was rewritten'
    assert current['dsh']['baseUrl'] == 'http://fish-bot:3080'
    print(json.dumps({'test':'user settings and profile preserved','passed':True}),flush=True)

if __name__ == '__main__':
    main()
