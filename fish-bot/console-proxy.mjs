#!/usr/bin/env node
// 控制台端口转发：0.0.0.0:<对外端口> -> 127.0.0.1:<控制台端口>
//
// 为什么需要它：
//   qq-bridge 把控制台硬编码监听在 127.0.0.1（bridge.js:7187），且有两处「按端口比对」的
//   校验，都会因为宿主侧端口与容器内端口不同而失败：
//     1) Host 校验（bridge.js:3257）      Host 必须是 `127.0.0.1:<容器内端口>` 等
//        → 宿主经端口映射访问时 Host 是宿主端口，被 403「Host 头不被允许」
//     2) Origin 校验（bridge.js:3331）    非 GET 请求的 Origin host 必须是 `127.0.0.1:<容器内端口>`
//        → 浏览器写操作（切换配置/保存人格…）必带 Origin，被 403「跨站请求被拒绝」
//
//   本代理因此要改写**两个**头：Host 与 Origin，都指向 `127.0.0.1:<容器内端口>`。
//   桥接源码一行不改。
//
// ── 安全设计（重要，别改成无条件改写）──────────────────────────────────────
//   这两个头的校验是**纵深防御**，不是麻烦：
//     - Host 校验防 DNS rebinding（攻击者用 TTL=0 域名解析到 127.0.0.1，
//       浏览器便认为是同源，Origin 校验随之失效）
//     - Origin 校验防 CSRF（任意网页用表单/跨站请求触发 /api/restart 等破坏性接口）
//   所以改写必须是**有条件的**：只有当 Host/Origin 指向本代理自己的宿主侧回环地址时，
//   才把它们「翻译」成容器内回环地址。任何第三方来源（evil.com、其他端口）一律原样透传，
//   由桥接照常拒绝。这样：
//     正常浏览器（127.0.0.1:13100）→ 改写 → 通过
//     恶意页面（Origin: http://evil.com）→ 不改 → 桥接 403 ✓
//     DNS rebinding（Host: evil.com:13100）→ 不改 → 桥接 403 ✓
//   **无条件改写会把这个洞重新打开**，等于自毁防护。
//
// ── 2026-10-25 两次修复记录 ─────────────────────────────────────────────
//   ① 原实现只在**每条连接的第一个请求**上改写，随后 headerDone=true 整条连接透传。
//      浏览器对同源请求默认复用 keep-alive，于是页面 GET / 正常，但每 3 秒的
//      /api/status 轮询复用同一条连接 → Host 未改写 → 403。
//      控制台 api() 只对 401 特判，403 被当正常 JSON 交给 refresh()，
//      dshReady 变 undefined → 界面显示「DSH 未连接 / 桥接未上报上游健康」。
//      （这不是 DSH 掉了，DSH 日志里一直有「已就绪」。）
//      → 改为按请求解析的状态机：用 Content-Length 跟踪请求体边界，每个新请求首部改写一次。
//   ② Origin 从未被改写 → 所有写操作（切换配置等）都报「跨站请求被拒绝」403。
//      → 本版同时按上述条件改写 Origin。
//   注：这两类问题「只在浏览器里」出现，用 curl/urllib 手工测很容易漏（不带 Origin 就绕过了
//   CSRF，不保持 keep-alive 就绕过了 ①）。所以 _fix/test-console-proxy.mjs 必须带 Origin、
//   必须复用连接。
//
// 其它安全性：
//   - 只转发到回环，不引入新的出网能力
//   - 宿主侧由 compose 映射到 127.0.0.1，不对外暴露
//   - 控制台自身的 x-console-token 鉴权照常生效（这是真正的门）
//   - 只改写请求方向的首部块，不影响响应体
import net from 'node:net';

const LISTEN_HOST = process.env.CONSOLE_PROXY_LISTEN || '0.0.0.0';
const LISTEN_PORT = Number(process.env.CONSOLE_PROXY_PORT || 13100);
const TARGET_HOST = '127.0.0.1';
const TARGET_PORT = Number(process.env.CONSOLE_TARGET_PORT || 3100);

// 桥接期望的 Host 值（容器内回环 + 容器内控制台端口）
const REWRITE_HOST = `${TARGET_HOST}:${TARGET_PORT}`;
const REWRITE_ORIGIN = `http://${REWRITE_HOST}`;

// 单个请求首部的上限：bridge.js 对这些接口只用得到几 KB，
// 超过就说明不是常规控制台流量，直接放弃改写。
const MAX_HEADER_BYTES = 64 * 1024;

function log(m) {
  console.log(`[console-proxy] ${m}`);
}

/**
 * 判断一个 authority（`host:port`）是不是「本代理自己的宿主侧回环地址」。
 * 只有这些来源才值得被翻译成容器内地址；其余一律视为外部来源，交给桥接拒绝。
 *
 * 接受 127.0.0.0/8 任意回环地址（宿主可能用 127.0.0.2 之类，也只是本机）。
 */
function isOwnLoopbackAuthority(authority, port) {
  const a = String(authority || '').trim().toLowerCase();
  if (!a) return false;
  const expected = Number(port);
  let host;
  let gotPort;
  if (a.startsWith('[')) {
    // IPv6：[::1]:13100
    const end = a.indexOf(']');
    if (end === -1) return false;
    host = a.slice(0, end + 1);
    const rest = a.slice(end + 1);
    gotPort = rest.startsWith(':') ? rest.slice(1) : '';
  } else {
    const i = a.lastIndexOf(':');
    if (i === -1) return false;
    host = a.slice(0, i);
    gotPort = a.slice(i + 1);
  }
  if (Number(gotPort) !== expected) return false;
  if (host === 'localhost' || host === '[::1]') return true;
  // 127.0.0.0/8
  if (/^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) {
    return host.split('.').every((seg, idx) => idx === 0 || (Number(seg) >= 0 && Number(seg) <= 255));
  }
  return false;
}

/** 取出首部里某个头的一行原始值；没有则返回 null。 */
function headerValue(headText, name) {
  const re = new RegExp(`^${name}[ \\t]*:[ \\t]*([^\\r\\n]*)$`, 'mi');
  const m = headText.match(re);
  return m ? m[1].trim() : null;
}

/** 替换首部里某个头的值（保留原始头名大小写与行位置）。 */
function replaceHeaderLine(text, name, value) {
  const re = new RegExp(`^(${name}[ \\t]*:[ \\t]*)([^\\r\\n]*)$`, 'mi');
  if (!re.test(text)) return null;
  return text.replace(re, (_m, p1) => `${p1}${value}`);
}

/**
 * 按需改写请求首部块里的 Host 与 Origin。返回改写后的 buffer。
 *
 * - Host 缺失（HTTP/1.0 客户端）→ 直接补上（这类请求本来也过不了桥接的 Host 校验）
 * - Host 存在但指向外部地址 → 不改写，让桥接按它自己的规则拒绝
 * - Origin 存在且指向本代理回环 → 改写成容器内 origin
 * - Origin 存在但指向外部 → 不改写（CSRF 防护保持有效）
 * - Origin 缺失（curl / 反向代理直调）→ 不添加（桥接对非 GET 缺 Origin 是放行的）
 */
function rewriteHeaders(buf, listenPort) {
  const text = buf.toString('latin1');
  let next = text;

  const hostVal = headerValue(text, 'Host');
  if (hostVal === null) {
    const eol = next.indexOf('\r\n');
    if (eol !== -1) next = `${next.slice(0, eol)}\r\nHost: ${REWRITE_HOST}${next.slice(eol)}`;
  } else if (isOwnLoopbackAuthority(hostVal, listenPort)) {
    next = replaceHeaderLine(next, 'Host', REWRITE_HOST) ?? next;
  }

  const originVal = headerValue(text, 'Origin');
  if (originVal !== null) {
    let originAuthority = '';
    try { originAuthority = new URL(originVal).host; } catch { originAuthority = ''; }
    if (isOwnLoopbackAuthority(originAuthority, listenPort)) {
      next = replaceHeaderLine(next, 'Origin', REWRITE_ORIGIN) ?? next;
    }
  }

  if (next === text) return buf;
  return Buffer.from(next, 'latin1');
}

const server = net.createServer((client) => {
  const upstream = net.connect({ host: TARGET_HOST, port: TARGET_PORT });

  // 客户端 -> 上游 的解析状态：
  //   'header'      正在等一个请求首部块（改写的时机）
  //   'body'        正在透传第 N 个请求的请求体，剩 remaining 字节
  //   'passthrough' 边界无法安全定位（chunked / Upgrade / 异常），整条连接原样转发
  let state = 'header';
  let remaining = 0;
  let pending = Buffer.alloc(0);
  // 实际监听端口（server.address() 在 listen 之后才有值），用于识别「本代理自己的地址」
  const listenPort = server.address()?.port ?? LISTEN_PORT;

  const goPassthrough = () => {
    if (pending.length) upstream.write(pending);
    pending = Buffer.alloc(0);
    state = 'passthrough';
  };

  client.on('data', (chunk) => {
    if (state === 'passthrough') {
      upstream.write(chunk);
      return;
    }
    pending = Buffer.concat([pending, chunk]);

    for (;;) {
      if (state === 'body') {
        const take = Math.min(remaining, pending.length);
        if (take > 0) {
          upstream.write(pending.subarray(0, take));
          pending = pending.subarray(take);
          remaining -= take;
        }
        if (remaining > 0) return;       // 体还没传完，等下一块
        state = 'header';
        continue;                         // 体结束后紧跟的可能是下一个请求
      }

      // state === 'header'
      const idx = pending.indexOf('\r\n\r\n');
      if (idx === -1) {
        if (pending.length > MAX_HEADER_BYTES) {
          log('请求首部超长，放弃改写并转为透传');
          goPassthrough();
          return;
        }
        return;                           // 首部还没收全
      }

      const head = pending.subarray(0, idx + 4);
      const rest = pending.subarray(idx + 4);
      pending = rest;

      const headText = head.toString('latin1');
      upstream.write(rewriteHeaders(head, listenPort));

      const upgrade = headerValue(headText, 'upgrade');
      const te = headerValue(headText, 'transfer-encoding');
      const cl = headerValue(headText, 'content-length');

      if (upgrade) {
        // WebSocket 之类：升级后是原始长连接，不再有「请求首部」概念
        goPassthrough();
        return;
      }
      if (te !== null) {
        // 分块请求体：长度不可知，无法安全定位下一个首部
        goPassthrough();
        return;
      }
      const len = cl === null ? 0 : Number(cl);
      if (!Number.isFinite(len) || len < 0) {
        goPassthrough();
        return;
      }
      if (len === 0) {
        if (pending.length === 0) return; // 保持 header 态等下一个请求
        continue;
      }
      remaining = len;
      state = 'body';
    }
  });

  upstream.on('data', (chunk) => client.write(chunk));

  const closeBoth = () => {
    client.destroy();
    upstream.destroy();
  };
  client.on('error', closeBoth);
  upstream.on('error', (e) => {
    if (e.code !== 'ECONNREFUSED') log(`上游错误: ${e.code || e.message}`);
    closeBoth();
  });
  client.on('end', () => upstream.end());
  upstream.on('end', () => client.end());
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    log(`端口 ${LISTEN_PORT} 已被占用，退出`);
    process.exit(0);
  }
  log(`监听错误: ${e.code || e.message}`);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  log(`已启动: ${LISTEN_HOST}:${LISTEN_PORT} -> ${TARGET_HOST}:${TARGET_PORT}`
    + `（Host/Origin 改写为 ${REWRITE_HOST}，仅限本代理回环来源）`);
});
