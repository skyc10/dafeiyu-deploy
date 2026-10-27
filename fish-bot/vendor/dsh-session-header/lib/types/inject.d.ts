/**
 * 会话头注入的纯逻辑：配置校验、请求作用域传递、fetch 出口改写。
 *
 * 这里刻意不 import 任何 harness 包（只用 node 内置的 async_hooks），
 * 所以编译产物可以直接被 'node --test' 驱动做单元测试，不需要起整个宿主。
 *
 * 两件事分开做，是为了让「谁在调用」和「往哪个包上盖」互不依赖：
 *   1. 'llm/stream' 监听器把本次调用的 sessionId 放进 AsyncLocalStorage；
 *   2. 被包住的 fetch 在真正发请求的那一刻读回这个值，写成请求头。
 * 因为值取自同一个异步链，天然按请求配对，不存在「A 会话的头盖到 B 请求」
 * 这种串号问题 —— 这也是不能用 profile.headers 配置项替代它的原因：那是
 * 路由级单值，并行 subagent 会互相覆盖。
 *
 * @module dsh-session-header/inject
 */
/** 默认头名：语义中性，网关侧再用 header_override 改名转发给上游。 */
export declare const DEFAULT_HEADER_NAME = "x-session-id";
/** 一次模型调用的身份，从 'llm/stream' 带到 fetch 出口。 */
export interface RequestScope {
    /** 会话 id。 */
    sessionId: string;
    /** 注册的路由名，仅用于日志与自检归类。 */
    provider: string;
    /** 本次请求的模型 id，仅用于日志与自检归类。 */
    model: string;
    /** 辅助调用类别（compaction / session-title），同样要带会话头。 */
    purpose?: string;
}
/** 插件运行策略；全部字段都在加载期校验完毕。 */
export interface InjectorConfig {
    /** 总开关。关掉时插件不注册任何东西。 */
    enabled: boolean;
    /** 要补的头名（小写）。 */
    headerName: string;
    /** 把同一个值再复制到其它头名上，用于「直连上游、中间没有网关改名」的场景。 */
    extraHeaders: string[];
    /** 请求里已有同名头时是否覆盖。默认不覆盖，尊重别人的值。 */
    overwrite: boolean;
    /** 拿不到调用作用域时，是否退回从请求体里读 prompt_cache_key。 */
    bodyFallback: boolean;
    /** 每次注入打一行 debug；只打元信息，不打请求体与鉴权。 */
    debug: boolean;
}
/** 自检计数，用来回答「到底加上了没有」。 */
export interface InjectorCounters {
    /** 通过方法/协议过滤、被认真检查过的次数。 */
    seen: number;
    /** 成功写入请求头的次数。 */
    injected: number;
    /** 请求里本来就有同名头、按策略未覆盖的次数。 */
    already: number;
    /** 在模型调用链上但拿不到会话 id 的次数。 */
    missing: number;
    /** 靠请求体 prompt_cache_key 兜底命中的次数。 */
    fromBody: number;
    /** 注入过程内部抛错、原样放行的次数（必须永远是 0）。 */
    errors: number;
}
/** 校验失败时抛出；配置写错要响，不要静默不干活。 */
export declare class SessionHeaderConfigError extends Error {
}
/**
 * 校验来自组合层的原始配置并补齐默认值。
 * @param raw - 未校验的配置对象。
 * @returns 生效策略。
 * @throws {SessionHeaderConfigError} 未知键、类型不符、头名非法或头名保留。
 */
export declare function resolveConfig(raw?: Record<string, unknown>): InjectorConfig;
/**
 * 从一段请求体里认出「这是一次模型调用」并取出可当会话 id 的字段。
 *
 * 只在调用作用域丢失时使用。判据故意收紧：必须同时有 string model 和
 * messages/input 数组 —— 同进程里的 GitHub API、npm、遥测出口不会命中。
 *
 * @param body - 请求体。
 * @returns 命中的会话 id，或 undefined。
 */
export declare function sessionIdFromBody(body: unknown): string | undefined;
/** 可改写的 fetch 第二参数（结构子集，避免绑死 DOM/node 的类型差异）。 */
export interface FetchInitLike {
    method?: string;
    headers?: unknown;
    body?: unknown;
    [key: string]: unknown;
}
/**
 * 会话头注入器：持有作用域存储、计数与策略。
 */
export declare class SessionHeaderInjector {
    readonly config: InjectorConfig;
    private readonly store;
    /** 只读的运行计数，用于自检与卸载时汇报。 */
    readonly counters: InjectorCounters;
    constructor(config: InjectorConfig);
    /**
     * 把一次 'llm/stream' 下游链装进作用域。
     *
     * 两头都要包：next() 可能当场就发起 fetch（openai SDK 的 stream 内部是立即
     * 执行的异步函数），也可能是消费到第一个 chunk 时才发；所以既在 store.run 里
     * 调用 next()，也把返回的迭代器逐次包回作用域。
     *
     * @param scope - 本次调用的会话身份。
     * @param start - 下游链构造器。
     * @returns 行为不变、但带作用域的流。
     */
    trace<T>(scope: RequestScope, start: () => AsyncIterable<T>): AsyncIterable<T>;
    /** 当前调用作用域；取不到说明这次 fetch 不在模型请求链上。 */
    current(): RequestScope | undefined;
    /**
     * 给一次 fetch 调用补会话头。
     *
     * 永不抛错：任何意外都记一次 errors 并原样放行 —— 一个附加头没有资格
     * 让用户的模型请求失败。
     *
     * @param input - fetch 第一参数。
     * @param init - fetch 第二参数。
     * @returns 可能被改写过的 input / init。
     */
    decorate(input: unknown, init?: FetchInitLike): {
        input: unknown;
        init: FetchInitLike | undefined;
    };
    private decorateInner;
    /** 一行摘要，供激活与卸载日志复用。 */
    summary(): string;
}
