// 端到端：用最小假 ctx 驱动真实 apply()，对本地 HTTP 服务器发真请求，
// 检查「服务器确实收到了这个头」而不是只检查内部函数返回值。
import assert from 'node:assert/strict'
import http from 'node:http'
import test from 'node:test'

import { apply } from '../lib/index.js'

/** 造一个只实现本插件用到的三个成员的假上下文。 */
function fakeContext() {
  const events = new Map()
  const disposers = []
  const lines = []
  const level = (kind) => (msg) => lines.push(kind + ': ' + msg)
  return {
    events,
    lines,
    disposers,
    logger: { info: level('info'), warn: level('warn'), debug: level('debug'), error: level('error') },
    on(event, handler) {
      events.set(event, handler)
      return { dispose() {} }
    },
    effect(execute) {
      const dispose = execute()
      if (typeof dispose === 'function') disposers.push(dispose)
      return undefined
    },
  }
}

/** 起一个只记录请求头的本地服务器。 */
function serve() {
  const seen = []
  const server = http.createServer((req, res) => {
    let size = 0
    req.on('data', (chunk) => { size += chunk.length })
    req.on('end', () => {
      seen.push({ url: req.url, method: req.method, headers: req.headers, bytes: size })
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{"ok":true}')
    })
  })
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({
      server,
      seen,
      origin: 'http://127.0.0.1:' + server.address().port,
    }))
  })
}

/** 模拟 llm/stream 下游：next() 里用官方 SDK 的形态（new Request）发请求。 */
async function driveModelCall(handler, sessionId, url, bodyText) {
  let status
  const stream = handler(
    { provider: 'newapi', model: 'qwen3.8-flash', sessionId },
    () => (async function* () {
      // 作用域必须在真正的 fetch 时刻还在
      const response = await fetch(new Request(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer redacted' },
        body: bodyText,
      }))
      status = response.status
      yield status
    })(),
  )
  // 消费者在作用域之外拉第一个 chunk —— 官方 SDK 就是这种懒形态
  const first = await stream[Symbol.asyncIterator]().next()
  return { status, value: first.value }
}

test('e2e: 模型请求真的带上了会话头，且不影响鉴权头', async () => {
  const native = globalThis.fetch
  const ctx = fakeContext()
  apply(ctx, {})
  const { server, seen, origin } = await serve()
  try {
    const handler = ctx.events.get('llm/stream')
    assert.ok(handler, 'apply 必须注册 llm/stream 监听')
    const url = origin + '/v1/chat/completions'
    const bodyText = JSON.stringify({ model: 'qwen3.8-flash', messages: [{ role: 'user', content: 'hi' }], stream: true })
    const a = await driveModelCall(handler, 'sess-alpha', url, bodyText)
    const b = await driveModelCall(handler, 'sess-beta', url, bodyText)
    assert.equal(a.status, 200)
    assert.equal(seen.length, 2)
    assert.equal(seen[0].headers['x-session-id'], 'sess-alpha', '第一次带的是它自己的会话 id')
    assert.equal(seen[1].headers['x-session-id'], 'sess-beta', '第二次换了会话，头也换')
    assert.equal(seen[0].headers.authorization, 'Bearer redacted', '鉴权头原样保留')
    assert.equal(seen[0].headers['content-type'], 'application/json')
    assert.match(ctx.lines.join('\n'), /active, header=x-session-id/)
  } finally {
    server.close()
    for (const dispose of ctx.disposers) dispose()
    assert.equal(globalThis.fetch, native, '卸载后必须把 fetch 还回去')
  }
})

test('e2e: 同一进程里的无关 POST 不带会话头', async () => {
  const ctx = fakeContext()
  apply(ctx, {})
  const { server, seen, origin } = await serve()
  try {
    await fetch(new Request(origin + '/repos/o/r/issues', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ title: 'bug' }),
    }))
    await fetch(origin + '/models', { method: 'GET' })
    assert.equal(seen.length, 2)
    assert.equal(seen[0].headers['x-session-id'], undefined, '不在模型调用链上就不该盖')
    assert.equal(seen[1].headers['x-session-id'], undefined)
  } finally {
    server.close()
    for (const dispose of ctx.disposers) dispose()
  }
})

test('e2e: enabled false 时既不注册监听也不碰 fetch', () => {
  const native = globalThis.fetch
  const ctx = fakeContext()
  apply(ctx, { enabled: false })
  assert.equal(ctx.events.size, 0, '不该留下任何监听')
  assert.equal(globalThis.fetch, native, '不该包 fetch')
  assert.equal(ctx.disposers.length, 0)
  assert.match(ctx.lines.join('\n'), /disabled/)
})

test('e2e: 非法头名在加载期就拒绝启动插件', () => {
  const native = globalThis.fetch
  const ctx = fakeContext()
  apply(ctx, { headerName: 'x-deepseek-harness-session-id' })
  assert.equal(ctx.events.size, 0)
  assert.equal(globalThis.fetch, native)
  assert.match(ctx.lines.join('\n'), /refused to start.*attribution family/)
})

test('e2e: 改名与别名会同时生效', async () => {
  const ctx = fakeContext()
  apply(ctx, { headerName: 'x-qhz-session-id', extraHeaders: ['x-opencode-session'] })
  const { server, seen, origin } = await serve()
  try {
    await driveModelCall(ctx.events.get('llm/stream'), 'sess-gamma', origin + '/v1/chat/completions',
      JSON.stringify({ model: 'm', messages: [] }))
    assert.equal(seen[0].headers['x-qhz-session-id'], 'sess-gamma')
    assert.equal(seen[0].headers['x-opencode-session'], 'sess-gamma', '别名同值')
    assert.equal(seen[0].headers['x-session-id'], undefined, '默认名不再出现')
  } finally {
    server.close()
    for (const dispose of ctx.disposers) dispose()
  }
})
