import fs from 'node:fs';
import http from 'node:http';
import assert from 'node:assert/strict';
import { NodeApiClient } from '/opt/qq-bridge/src/dsh-client.js';
const c=JSON.parse(fs.readFileSync('/data/bridge-config.json','utf8'));
const launch=[...fs.readFileSync('/data/dsh.log','utf8').matchAll(/[?&]token=([A-Za-z0-9_-]+)/g)].at(-1)?.[1];
assert.equal(c.dsh.authToken,launch);
assert.equal(c.dsh.baseUrl,'http://fish-bot:3080');
assert.equal(fs.realpathSync('/opt/qq-bridge/config.json'),'/data/bridge-config.json');
const api=new NodeApiClient(c.dsh.baseUrl,4000,{token:launch,allowRemote:true});
assert.equal((await api.settings.describe({})).result.ok,true);
const headers={'x-console-token':c.consoleToken||fs.readFileSync('/data/bridge-state/console-token','utf8').trim()};
const sharedAgent = new http.Agent({keepAlive:true});
let reusedConnections = 0;
// Use node:http: fetch may normalize or drop a custom Host header.
function status(url,options={}) {
  return new Promise((resolve,reject) => {
    const request=http.request(url,{agent:sharedAgent,method:options.method||'GET',headers:{...(options.headers||{}),...(options.body ? {'Content-Length':Buffer.byteLength(options.body)} : {})}},response => {
      if (request.reusedSocket) reusedConnections++;
      response.resume(); response.on('end',()=>resolve(response.statusCode));
    });
    request.setTimeout(4000,()=>request.destroy(new Error('HTTP probe timeout')));
    request.on('error',reject); request.end(options.body);
  });
}
assert.equal(await status('http://127.0.0.1:13100/api/status',{headers}),200);
assert.equal(await status('http://127.0.0.1:13100/api/status'),401);
assert.equal(await status('http://127.0.0.1:13100/api/status',{headers:{...headers,Host:'untrusted.invalid:13100'}}),403);
assert.equal(await status('http://127.0.0.1:13100/api/connection-probe',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:'http://untrusted.invalid'},body:'{}'}),403);
assert.equal(await status(c.dsh.baseUrl+'/api/settings/describe',{method:'POST',headers:{Cookie:api.cookie,Host:'untrusted.invalid:3080','Content-Type':'application/json'},body:'{}'}),403);
assert.equal(await status('http://127.0.0.1:13100/api/connection-probe',{method:'POST',headers:{...headers,'Content-Type':'application/json',Origin:'http://127.0.0.1:13100'},body:'{}'}),404);
assert.equal(await status('http://127.0.0.1:13100/api/status',{headers}),200);
assert.ok(reusedConnections>0);
const old=JSON.parse(fs.readFileSync('/data/bridge-config.pre-upgrade-live.json','utf8'));
const oldURL=new URL(c.dsh.baseUrl);oldURL.searchParams.set('token',old.dsh.authToken);
assert.equal(await status(oldURL),401);
sharedAgent.destroy();
console.log(JSON.stringify({test:'service-name RPC, current/stale token, single config, console auth, Host/Origin protection',passed:true}));
