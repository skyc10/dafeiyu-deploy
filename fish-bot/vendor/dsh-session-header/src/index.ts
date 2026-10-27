/**
 * dsh-session-header —— 给每一次模型请求盖上一个稳定的会话头。
 *
 * 背景：Harness 的 pi-ai 路由不提供任何请求头注入口（GenerateOptions 里没有
 * headers 字段；compat 里那两个 session-affinity 开关在 DSH 的门表里对全部
 * 协议都是 withhold），所以一个按会话变化的头在配置层做不到。本插件因此走
 * 运行时两件套，且完全不改动 harness 源码：
 *
 *   1. 监听 'llm/stream'（全局、前置），把本次调用的 sessionId 放进一个
 *      AsyncLocalStorage 作用域；
 *   2. 包一层 globalThis.fetch，在真正发请求的那一刻取回该值，写成请求头。
 *
 * 值取自同一条异步链，所以主会话、subagent、compaction / session-title
 * 辅助调用各带各的会话 id，不会互相串。第二层兜底：作用域丢失时改从请求体
 * 的 prompt_cache_key 取值（把 provider 的 cacheRetention 配成 long 并给模型
 * 打开 supportsLongCacheRetention 后，这个字段就是会话 id 本身）。
 *
 * 只贴「像模型请求」的出口：必须在作用域内，或者请求体同时带 string model 与
 * messages/input 数组。同进程里的 GitHub、npm、遥测等出口不会被盖章。
 *
 * 头名默认 x-session-id。刻意避开 x-deepseek-harness-*：那是官方 provider
 * 路由成套发送的归因头族，第三方补其中一个等于留下半套归因的畸形流量。
 *
 * 要把它送到真实上游，还需要在网关侧改名转发（new-api 渠道 header_override）：
 *   { "x-opencode-session": "{client_header:x-session-id}" }
 * 注意 new-api 的渠道「测试」会跳过 client_header 占位符，别拿测试结果当证据。
 *
 * @module dsh-session-header
 */

import type { Context } from '@deepseek-ai/cordis'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import { resolveConfig, SessionHeaderInjector, type FetchInitLike, type InjectorConfig, type RequestScope } from './inject.js'

/** 插件 fiber 名，与 cordis.patch.yml 里的 id 一致。 */
export const name = 'llm-session-header'

/** 拦 'llm/stream' 需要 llm 服务在册。 */
export const inject = ['llm']

/** 标记「fetch 已被本插件包过」，防止重复安装或还原错人。 */
const PATCH_MARKER = Symbol.for('dsh-session-header.patched')

/** 会话头插件的配置；全部字段都有默认值。 */
export interface SessionHeaderConfig extends InjectorConfig {}

/** 取错误文本。 */
function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 从 fetch 第一参数里取 host，只用于日志（绝不打印路径与查询串）。 */
function hostOf(input: unknown): string {
  try {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href
      : typeof (input as { url?: unknown }).url === 'string' ? (input as { url: string }).url : undefined
    return url === undefined ? '?' : new URL(url).host
  } catch {
    return '?'
  }
}

/**
 * 安装会话头注入。
 * @param ctx - 插件上下文。
 * @param config - 来自组合层的原始配置。
 */
export function apply(ctx: Context, config: Partial<InjectorConfig> = {}): void {
  const log = ctx.logger

  let policy: InjectorConfig
  try {
    policy = resolveConfig(config as Record<string, unknown>)
  } catch (error) {
    // 配置写错就整个不装：半生效的注入比没有注入更难排查。
    log.warn('session-header: refused to start, ' + message(error))
    return
  }

  if (!policy.enabled) {
    log.info('session-header: disabled, no listener and no fetch patch')
    return
  }

  const injector = new SessionHeaderInjector(policy)

  ctx.on('llm/stream', (options: GenerateOptions, next: () => AsyncIterable<StreamChunk>): AsyncIterable<StreamChunk> => {
    if (options.sessionId === undefined) return next()
    const sessionId = String(options.sessionId)
    if (sessionId === '') return next()
    const scope: RequestScope = {
      sessionId,
      provider: options.provider,
      model: options.model,
      ...(options.purpose === undefined ? {} : { purpose: options.purpose }),
    }
    return injector.trace(scope, next)
  }, { global: true, prepend: true })

  const native = globalThis.fetch
  const nativeMark = (native as unknown as Record<symbol, unknown> | undefined)?.[PATCH_MARKER]
  if (typeof native !== 'function') {
    log.warn('session-header: globalThis.fetch is missing; listening only, no header will be added')
    return
  }
  if (nativeMark !== undefined) {
    log.warn('session-header: fetch is already patched (' + String(nativeMark) + '); standing down to avoid a double patch')
    return
  }

  const original = native as unknown as (this: unknown, input: unknown, init?: unknown) => Promise<Response>
  const wrapped = function (this: unknown, input: unknown, init?: unknown): Promise<Response> {
    let call = { input, init }
    try {
      call = injector.decorate(input, init as FetchInitLike | undefined)
      if (policy.debug) {
        const scope = injector.current()
        log.debug('session-header: stamp=' + (injector.counters.injected) + ' host=' + hostOf(input)
          + (scope === undefined ? ' scope=body' : ' scope=' + scope.provider + '/' + scope.model))
      }
    } catch (error) {
      // decorate 自己已经不抛错；这里是最后一道保险，宁可少一个头。
      log.warn('session-header: decorate failed, ' + message(error))
    }
    return original.call(globalThis, call.input, call.init)
  }
  Object.defineProperty(wrapped, PATCH_MARKER, { value: policy.headerName, enumerable: false })
  globalThis.fetch = wrapped as unknown as typeof globalThis.fetch

  const names = [policy.headerName, ...policy.extraHeaders]
  log.info('session-header: active, header=' + names.join(',') + ' overwrite=' + policy.overwrite
    + ' bodyFallback=' + policy.bodyFallback)

  // 卸载时只在「我们的补丁仍在最外层」时摘掉自己。若已有别的插件包在我们
  // 外面，摘了会把人家的链一起扯断，所以那种情况只报不拆。
  ctx.effect(() => () => {
    if ((globalThis.fetch as unknown) === (wrapped as unknown)) {
      globalThis.fetch = native
      log.info('session-header: fetch restored, ' + injector.summary())
      return
    }
    log.warn('session-header: another patch now owns globalThis.fetch; leaving the chain alone (' + injector.summary() + ')')
  }, 'session-header: global fetch patch')
}
