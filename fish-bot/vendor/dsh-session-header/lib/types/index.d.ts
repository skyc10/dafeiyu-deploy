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
import type { Context } from '@deepseek-ai/cordis';
import { type InjectorConfig } from './inject.js';
/** 插件 fiber 名，与 cordis.patch.yml 里的 id 一致。 */
export declare const name = "llm-session-header";
/** 拦 'llm/stream' 需要 llm 服务在册。 */
export declare const inject: string[];
/** 会话头插件的配置；全部字段都有默认值。 */
export interface SessionHeaderConfig extends InjectorConfig {
}
/**
 * 安装会话头注入。
 * @param ctx - 插件上下文。
 * @param config - 来自组合层的原始配置。
 */
export declare function apply(ctx: Context, config?: Partial<InjectorConfig>): void;
