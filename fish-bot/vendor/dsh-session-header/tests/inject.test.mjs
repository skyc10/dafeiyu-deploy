// 单元测试直接跑编译产物：只依赖 lib/inject.js，不需要起整个宿主。
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveConfig, sessionIdFromBody, SessionHeaderInjector } from '../lib/inject.js'

const GATEWAY = 'http://gateway.example:3000/v1/chat/completions'
const SCOPE = { sessionId: 'sess-main-1', provider: 'newapi', model: 'qwen3.8-flash' }

/** 造一份「像模型请求」的 body；prompt_cache_key 可选。 */
function modelBody(key) {
  return JSON.stringify({
    model: 'qwen3.8-flash',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    ...(key === undefined ? {} : { prompt_cache_key: key }),
  })
}

/** 新建一个按默认策略运行的注入器。 */
function injector(overrides) {
  return new SessionHeaderInjector(resolveConfig(overrides))
}

test('config: 缺省全部补齐', () => {
  assert.deepEqual(resolveConfig(), {
    enabled: true, headerName: 'x-session-id', extraHeaders: [], overwrite: false,
    bodyFallback: true, debug: false,
  })
})

test('config: 拼错的键直接拒绝而不是忽略', () => {
  assert.throws(() => resolveConfig({ enabled: true, header: 'x' }), /unknown config key\(s\): header/)
})

test('config: 拒绝冒用 harness 归因头族', () => {
  assert.throws(
    () => resolveConfig({ headerName: 'x-deepseek-harness-session-id' }),
    /harness attribution family/,
  )
})

test('config: 拒绝鉴权与传输层头名', () => {
  for (const name of ['authorization', 'cookie', 'content-type', 'host']) {
    assert.throws(() => resolveConfig({ headerName: name }), /authentication or transport header/)
  }
})

test('config: 头名归一为小写，别名去重且不含主名', () => {
  const policy = resolveConfig({
    headerName: 'X-QHZ-Session-Id',
    extraHeaders: ['X-Alias', 'x-alias', 'x-qhz-session-id'],
  })
  assert.equal(policy.headerName, 'x-qhz-session-id')
  assert.deepEqual(policy.extraHeaders, ['x-alias'])
})

test('config: 类型不符一律拒绝', () => {
  assert.throws(() => resolveConfig({ overwrite: 'yes' }), /overwrite must be a boolean/)
  assert.throws(() => resolveConfig({ extraHeaders: 'x-a' }), /must be an array/)
  assert.throws(() => resolveConfig({ headerName: 'bad name' }), /not a header name/)
})

test('body: 只有模型请求才交出 id', () => {
  assert.equal(sessionIdFromBody(modelBody('sess-body-9')), 'sess-body-9')
  assert.equal(sessionIdFromBody(modelBody()), undefined, '没有 prompt_cache_key 就不猜')
  assert.equal(sessionIdFromBody(JSON.stringify({ url: 'https://api.github.com/x', q: 'in:body' })), undefined)
  assert.equal(sessionIdFromBody('not json at all'), undefined)
  assert.equal(sessionIdFromBody(undefined), undefined)
  assert.equal(sessionIdFromBody(JSON.stringify({ model: 'm', messages: [], prompt_cache_key: 'a\r\nb' })), undefined)
})

test('stamp: 作用域丢失时从 body 兜底，且不改调用方对象', () => {
  const subject = injector()
  const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body: modelBody('sess-body-9') }
  const before = Object.keys(init).join(',')
  const out = subject.decorate(GATEWAY, init)
  assert.equal(Object.keys(init).join(','), before, '不能就地改调用方的 init')
  assert.equal(out.init.headers.get('x-session-id'), 'sess-body-9')
  assert.equal(out.init.headers.get('content-type'), 'application/json', '原有头必须留着')
  assert.equal(subject.counters.fromBody, 1)
  assert.equal(subject.counters.injected, 1)
})

test('stamp: 作用域里的会话 id 优先于 body 里的值', () => {
  const subject = injector()
  let stamped
  const stream = subject.trace(SCOPE, () => {
    stamped = subject.decorate(GATEWAY, { method: 'POST', headers: {}, body: modelBody('someone-else') })
      .init.headers.get('x-session-id')
    return (async function* () {})()
  })
  assert.equal(stamped, 'sess-main-1')
  assert.equal(subject.counters.fromBody, 0, '命中作用域就不该去解析 body')
  assert.ok(stream)
})

test('stamp: 已有同名头默认不覆盖，overwrite 才覆盖', () => {
  const keep = injector()
  const init = { method: 'POST', headers: { 'x-session-id': 'client-owned' }, body: modelBody('from-body') }
  const out = keep.decorate(GATEWAY, init)
  assert.equal(out.init, init, '按策略不动时原样返回')
  assert.equal(keep.counters.already, 1)
  assert.equal(keep.counters.injected, 0)

  const forced = injector({ overwrite: true })
  const out2 = forced.decorate(GATEWAY, {
    method: 'POST', headers: { 'x-session-id': 'client-owned' }, body: modelBody('from-body'),
  })
  assert.equal(out2.init.headers.get('x-session-id'), 'from-body')
  assert.equal(forced.counters.injected, 1)
})

test('stamp: 非 POST 与非 http(s) 目标直接放过', () => {
  const subject = injector()
  const get = { method: 'GET' }
  assert.equal(subject.decorate('http://gateway.example:3000/v1/models', get).init, get, 'GET 原样返回')
  const data = { method: 'POST', body: modelBody('a') }
  assert.equal(subject.decorate('data:text/plain,x', data).init, data, '非 http 原样返回')
  assert.equal(subject.counters.seen, 0)
  assert.equal(subject.counters.injected, 0)
})

test('stamp: 同进程里的无关 POST 不被盖章', () => {
  const subject = injector()
  const init = { method: 'POST', headers: { authorization: 'Bearer t' }, body: JSON.stringify({ title: 'bug' }) }
  const out = subject.decorate('https://api.github.com/repos/o/r/issues', init)
  assert.equal(out.init, init, '不是模型请求就原样放行')
  assert.equal(subject.counters.seen, 1, '它确实被检查过')
  assert.equal(subject.counters.injected, 0)
})

test('stamp: Request 形态靠作用域就地补头（openai SDK 走这条）', () => {
  const subject = injector()
  let stamped = false
  subject.trace(SCOPE, () => {
    const request = new Request(GATEWAY, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: modelBody('sess-req-3'),
    })
    subject.decorate(request, undefined)
    assert.equal(request.headers.get('x-session-id'), 'sess-main-1')
    assert.equal(request.headers.get('content-type'), 'application/json', '原有头留着')
    stamped = true
    return (async function* () {})()
  })
  assert.ok(stamped)
  assert.equal(subject.counters.injected, 1)
})

test('stamp: 已知边界 —— Request 形态丢了作用域时不猜（body 是流，读不了）', () => {
  const subject = injector()
  const request = new Request(GATEWAY, { method: 'POST', headers: {}, body: modelBody('sess-req-3') })
  subject.decorate(request, undefined)
  assert.equal(request.headers.get('x-session-id'), null)
  assert.equal(subject.counters.injected, 0)
  assert.equal(subject.counters.missing, 0, '作用域外本来就不是模型请求，不算丢')
})

test('scope: next() 当场发请求时也在作用域内', () => {
  const subject = injector()
  let seen
  subject.trace(SCOPE, () => {
    seen = subject.current()?.sessionId
    return (async function* () { yield 'a' })()
  })
  assert.equal(seen, 'sess-main-1')
})

test('scope: 懒到第一个 chunk 才发请求也认得会话，且不泄漏到外面', async () => {
  const subject = injector()
  let seen
  const stream = subject.trace(SCOPE, () => (async function* () {
    seen = subject.current()?.sessionId
    yield 'a'
  })())
  assert.equal(subject.current(), undefined, '构造流本身不该留下作用域')
  const first = await stream[Symbol.asyncIterator]().next()
  assert.equal(first.value, 'a')
  assert.equal(seen, 'sess-main-1')
  assert.equal(subject.current(), undefined)
})

test('scope: 会话 id 不安全时宁可不加', () => {
  const subject = injector()
  const init = { method: 'POST', headers: {}, body: modelBody() }
  let out
  subject.trace({ ...SCOPE, sessionId: 'bad\r\nvalue' }, () => {
    out = subject.decorate(GATEWAY, init)
    return (async function* () {})()
  })
  assert.equal(out.init, init, '空头不如没有头：原对象不动')
  assert.equal(Object.keys(init.headers).length, 0)
  assert.equal(subject.counters.missing, 1, '丢在作用域里要能被计数发现')
  assert.equal(subject.counters.injected, 0)
})

test('counters: 摘要可读且 errors 恒为 0', () => {
  const subject = injector()
  subject.decorate(GATEWAY, { method: 'POST', headers: {}, body: modelBody('sess-sum-1') })
  assert.match(subject.summary(), /^seen=1 injected=1 already=0 fromBody=1 missing=0 errors=0$/)
})
