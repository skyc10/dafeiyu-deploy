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
import { AsyncLocalStorage } from 'node:async_hooks';
/** 默认头名：语义中性，网关侧再用 header_override 改名转发给上游。 */
export const DEFAULT_HEADER_NAME = 'x-session-id';
/** 校验失败时抛出；配置写错要响，不要静默不干活。 */
export class SessionHeaderConfigError extends Error {
}
/** 合法头名：小写字母开头，只允许字母、数字与连字符。 */
const NAME_PATTERN = /^[a-z][a-z0-9-]{0,89}$/;
/**
 * 第三方插件不该改写的头名。挡的不是 HTTP 规范的 forbidden 列表，而是
 * 「改了就会影响鉴权、跨域或连接本身」那几个 —— 本插件只加自己的会话头。
 */
const FORBIDDEN_NAMES = new Set([
    'authorization', 'proxy-authorization', 'cookie', 'set-cookie', 'host', 'content-length',
    'content-type', 'connection', 'keep-alive', 'te', 'trailer', 'transfer-encoding',
    'upgrade', 'expect', 'origin', 'referer', 'date', 'if-match', 'if-none-match',
]);
/**
 * Harness 自己的归因头族。官方 deepseek 路由是成套发的
 * （user-id + session-id + compact），第三方只补其中一个会留下「半套归因」
 * 的畸形流量，且可能冒领不属于它的信任，所以直接拒绝。
 */
const RESERVED_PATTERN = /^x-deepseek-harness-/;
/** 可打印、无换行的头部值；空值一律拒绝（宁可不加，也不加一个空头）。 */
function isSafeValue(value) {
    if (value.length === 0 || value.length > 512)
        return false;
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code < 0x20 || code === 0x7f)
            return false;
    }
    return value === value.trim();
}
/** 校验单个头名并归一为小写。 */
function normalizeName(value, field) {
    if (typeof value !== 'string')
        throw new SessionHeaderConfigError(field + ' must be a string');
    const name = value.toLowerCase();
    if (!NAME_PATTERN.test(name)) {
        throw new SessionHeaderConfigError(field + ' "' + value + '" is not a header name this plugin accepts;'
            + ' use a lowercase hyphenated token');
    }
    if (FORBIDDEN_NAMES.has(name)) {
        throw new SessionHeaderConfigError(field + ' "' + name + '" is an authentication or transport header;'
            + ' refusing to touch it');
    }
    if (RESERVED_PATTERN.test(name)) {
        throw new SessionHeaderConfigError(field + ' "' + name + '" belongs to the harness attribution family'
            + ' that the official provider route sends as a set; a third-party stamp would misattribute traffic');
    }
    return name;
}
/** 插件配置的字段全集，用于拒绝拼错的键。 */
const CONFIG_KEYS = [
    'enabled', 'headerName', 'extraHeaders', 'overwrite', 'bodyFallback', 'debug',
];
const DEFAULTS = {
    enabled: true,
    headerName: DEFAULT_HEADER_NAME,
    extraHeaders: [],
    overwrite: false,
    bodyFallback: true,
    debug: false,
};
/**
 * 校验来自组合层的原始配置并补齐默认值。
 * @param raw - 未校验的配置对象。
 * @returns 生效策略。
 * @throws {SessionHeaderConfigError} 未知键、类型不符、头名非法或头名保留。
 */
export function resolveConfig(raw = {}) {
    const unknown = Object.keys(raw).filter(key => !CONFIG_KEYS.includes(key));
    if (unknown.length > 0) {
        throw new SessionHeaderConfigError('unknown config key(s): ' + unknown.join(', ')
            + '; accepted: ' + CONFIG_KEYS.join(', '));
    }
    const flag = (key) => {
        const value = raw[key];
        if (value === undefined)
            return undefined;
        if (typeof value !== 'boolean')
            throw new SessionHeaderConfigError(key + ' must be a boolean');
        return value;
    };
    const enabled = flag('enabled');
    const overwrite = flag('overwrite');
    const bodyFallback = flag('bodyFallback');
    const debug = flag('debug');
    const headerName = raw.headerName === undefined ? DEFAULTS.headerName : normalizeName(raw.headerName, 'headerName');
    const rawExtras = raw.extraHeaders;
    if (rawExtras !== undefined && !Array.isArray(rawExtras)) {
        throw new SessionHeaderConfigError('extraHeaders must be an array of header names');
    }
    const extraHeaders = [];
    for (const entry of rawExtras ?? []) {
        const name = normalizeName(entry, 'extraHeaders[]');
        if (name === headerName || extraHeaders.includes(name))
            continue;
        extraHeaders.push(name);
    }
    return {
        enabled: enabled ?? DEFAULTS.enabled,
        headerName,
        extraHeaders,
        overwrite: overwrite ?? DEFAULTS.overwrite,
        bodyFallback: bodyFallback ?? DEFAULTS.bodyFallback,
        debug: debug ?? DEFAULTS.debug,
    };
}
/**
 * 从一段请求体里认出「这是一次模型调用」并取出可当会话 id 的字段。
 *
 * 只在调用作用域丢失时使用。判据故意收紧：必须同时有 string model 和
 * messages/input 数组 —— 同进程里的 GitHub API、npm、遥测出口不会命中。
 *
 * @param body - 请求体。
 * @returns 命中的会话 id，或 undefined。
 */
export function sessionIdFromBody(body) {
    if (typeof body !== 'string')
        return undefined;
    // 大请求体很常见，但解析成本要封顶：认不出就当没有。
    if (body.length === 0 || body.length > 4194304)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(body);
    }
    catch {
        return undefined;
    }
    if (typeof parsed !== 'object' || parsed === null)
        return undefined;
    const record = parsed;
    const isModelCall = typeof record.model === 'string'
        && (Array.isArray(record.messages) || Array.isArray(record.input));
    if (!isModelCall)
        return undefined;
    const key = record.prompt_cache_key;
    return typeof key === 'string' && isSafeValue(key) ? key : undefined;
}
/** 认出一个 fetch 调用的 url / method / 可改写头容器。 */
function readTarget(input, init) {
    const RequestCtor = globalThis.Request;
    if (typeof RequestCtor === 'function' && input instanceof RequestCtor) {
        const request = input;
        if (typeof request.url !== 'string' || typeof request.headers !== 'object')
            return undefined;
        return { url: request.url, method: String(request.method ?? 'GET').toUpperCase(), request };
    }
    let url;
    if (typeof input === 'string')
        url = input;
    else if (input instanceof URL)
        url = input.href;
    else {
        const nested = input?.url;
        if (typeof nested !== 'string')
            return undefined;
        url = nested;
    }
    return { url, method: String(init?.method ?? 'GET').toUpperCase(), request: undefined };
}
/**
 * 会话头注入器：持有作用域存储、计数与策略。
 */
export class SessionHeaderInjector {
    config;
    store = new AsyncLocalStorage();
    /** 只读的运行计数，用于自检与卸载时汇报。 */
    counters = { seen: 0, injected: 0, already: 0, missing: 0, fromBody: 0, errors: 0 };
    constructor(config) {
        this.config = config;
    }
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
    trace(scope, start) {
        const store = this.store;
        const source = store.run(scope, start);
        return {
            [Symbol.asyncIterator]() {
                const inner = source[Symbol.asyncIterator]();
                return {
                    next: () => store.run(scope, () => inner.next()),
                    return: (value) => store.run(scope, async () => {
                        const result = inner.return === undefined ? undefined : await inner.return(value);
                        return result ?? { done: true, value: undefined };
                    }),
                    throw: (error) => store.run(scope, async () => {
                        const result = inner.throw === undefined ? undefined : await inner.throw(error);
                        return result ?? { done: true, value: undefined };
                    }),
                };
            },
        };
    }
    /** 当前调用作用域；取不到说明这次 fetch 不在模型请求链上。 */
    current() {
        return this.store.getStore();
    }
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
    decorate(input, init) {
        try {
            return this.decorateInner(input, init);
        }
        catch {
            this.counters.errors += 1;
            return { input, init };
        }
    }
    decorateInner(input, init) {
        const target = readTarget(input, init);
        if (target === undefined)
            return { input, init };
        if (target.method !== 'POST')
            return { input, init };
        let protocol;
        try {
            protocol = new URL(target.url).protocol;
        }
        catch {
            return { input, init };
        }
        if (protocol !== 'http:' && protocol !== 'https:')
            return { input, init };
        this.counters.seen += 1;
        const scope = this.current();
        let sessionId = scope !== undefined && isSafeValue(scope.sessionId) ? scope.sessionId : undefined;
        if (sessionId === undefined) {
            const fromBody = this.config.bodyFallback ? sessionIdFromBody(init?.body) : undefined;
            if (fromBody === undefined) {
                // 不是模型调用，或者模型调用没带会话 id —— 什么都不做。
                if (scope !== undefined)
                    this.counters.missing += 1;
                return { input, init };
            }
            this.counters.fromBody += 1;
            sessionId = fromBody;
        }
        const names = [this.config.headerName, ...this.config.extraHeaders];
        let added = 0;
        if (target.request === undefined) {
            // 头的来源形态交给 Headers 构造函数自己校验，不额外命名 DOM 侧的类型。
            const headers = new Headers(init?.headers);
            for (const name of names) {
                if (headers.has(name) && !this.config.overwrite)
                    continue;
                headers.set(name, sessionId);
                added += 1;
            }
            if (added === 0)
                this.counters.already += 1;
            else
                this.counters.injected += 1;
            return added === 0 ? { input, init } : { input, init: { ...init, headers } };
        }
        // Request 形态：就地补头，避免重建 Request 去搬运它的流式 body。
        for (const name of names) {
            if (target.request.headers.has(name) && !this.config.overwrite)
                continue;
            target.request.headers.set(name, sessionId);
            added += 1;
        }
        if (added === 0)
            this.counters.already += 1;
        else
            this.counters.injected += 1;
        return { input, init };
    }
    /** 一行摘要，供激活与卸载日志复用。 */
    summary() {
        const counters = this.counters;
        return 'seen=' + counters.seen + ' injected=' + counters.injected + ' already=' + counters.already
            + ' fromBody=' + counters.fromBody + ' missing=' + counters.missing + ' errors=' + counters.errors;
    }
}
