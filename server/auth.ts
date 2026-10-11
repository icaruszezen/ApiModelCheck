/**
 * 后台认证：账号密码比对、会话令牌签发与校验、登录失败限流。
 * 令牌 = base64url(JSON{u, exp}) + "." + base64url(HMAC-SHA256(key, payload))，
 * key = HMAC-SHA256(SESSION_SECRET, ADMIN_PASSWORD)：改了密码，旧会话全部失效。
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { getConnInfo } from "@hono/node-server/conninfo";
import type { Context } from "hono";

export const SESSION_COOKIE = "amc_session";
export const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export interface AuthOptions {
  username: string;
  password: string;
  secret: string;
}

export interface Auth {
  /** 用户名、密码都对上才返回 true；比较耗时与输入无关 */
  checkCredentials(username: string, password: string): boolean;
  issueToken(now?: Date): string;
  /** 有效时返回用户名，否则 null */
  verifyToken(token: string | undefined, now?: Date): string | null;
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

function safeEqual(a: string, b: string): boolean {
  // 先摘要成等长的 32 字节，避免 timingSafeEqual 因长度不同抛错、也不泄露长度
  return timingSafeEqual(sha256(a), sha256(b));
}

export function createAuth(options: AuthOptions): Auth {
  const key = createHmac("sha256", options.secret)
    .update(options.password, "utf8")
    .digest();

  const sign = (payload: string) =>
    createHmac("sha256", key).update(payload).digest("base64url");

  return {
    checkCredentials(username, password) {
      // 两项都要比较完再合并结果，不提前返回
      const userOk = safeEqual(username, options.username);
      const passOk = safeEqual(password, options.password);
      return userOk && passOk;
    },

    issueToken(now = new Date()) {
      const exp = Math.floor(now.getTime() / 1000) + SESSION_TTL_SECONDS;
      const payload = Buffer.from(
        JSON.stringify({ u: options.username, exp }),
        "utf8",
      ).toString("base64url");
      return `${payload}.${sign(payload)}`;
    },

    verifyToken(token, now = new Date()) {
      if (!token || token.length > 2048) return null;
      const dot = token.indexOf(".");
      if (dot <= 0 || dot !== token.lastIndexOf(".")) return null;
      const payload = token.slice(0, dot);
      const signature = token.slice(dot + 1);
      const expected = sign(payload);
      const given = Buffer.from(signature, "utf8");
      const wanted = Buffer.from(expected, "utf8");
      if (given.length !== wanted.length || !timingSafeEqual(given, wanted)) {
        return null;
      }
      let data: unknown;
      try {
        data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
      } catch {
        return null;
      }
      if (!data || typeof data !== "object") return null;
      const { u, exp } = data as { u?: unknown; exp?: unknown };
      if (typeof u !== "string" || typeof exp !== "number") return null;
      // 改了 ADMIN_USERNAME 也让旧会话失效
      if (u !== options.username) return null;
      if (exp * 1000 <= now.getTime()) return null;
      return u;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 登录限流                                                             */
/* ------------------------------------------------------------------ */

export const LOGIN_WINDOW_MS = 15 * 60 * 1000;
export const LOGIN_MAX_FAILURES = 10;
export const LOGIN_BLOCK_MS = 15 * 60 * 1000;

interface LimiterEntry {
  /** 窗口内每次失败的时间 */
  failures: number[];
  blockedUntil: number;
}

/**
 * 同一 IP 15 分钟内失败 10 次后，15 分钟内一律拒绝；登录成功清零。
 * 只在内存里记，不用定时器（过期的条目在访问时顺手清掉）。
 */
export class LoginLimiter {
  readonly #entries = new Map<string, LimiterEntry>();
  readonly #maxEntries: number;

  constructor(maxEntries = 10_000) {
    this.#maxEntries = maxEntries;
  }

  isBlocked(ip: string, now = Date.now()): boolean {
    const entry = this.#entries.get(ip);
    return entry !== undefined && entry.blockedUntil > now;
  }

  recordFailure(ip: string, now = Date.now()): void {
    let entry = this.#entries.get(ip);
    if (!entry) {
      if (this.#entries.size >= this.#maxEntries) this.#sweep(now);
      entry = { failures: [], blockedUntil: 0 };
      this.#entries.set(ip, entry);
    }
    entry.failures = entry.failures.filter((t) => now - t < LOGIN_WINDOW_MS);
    entry.failures.push(now);
    if (entry.failures.length >= LOGIN_MAX_FAILURES) {
      entry.blockedUntil = now + LOGIN_BLOCK_MS;
      entry.failures = [];
    }
  }

  recordSuccess(ip: string): void {
    this.#entries.delete(ip);
  }

  #sweep(now: number): void {
    for (const [ip, entry] of this.#entries) {
      const recent = entry.failures.some((t) => now - t < LOGIN_WINDOW_MS);
      if (!recent && entry.blockedUntil <= now) this.#entries.delete(ip);
    }
    // 全是活跃条目（被大量 IP 攻击）时，丢掉最早的一半，保证内存有上限
    if (this.#entries.size >= this.#maxEntries) {
      let toDrop = Math.ceil(this.#entries.size / 2);
      for (const ip of this.#entries.keys()) {
        if (toDrop-- <= 0) break;
        this.#entries.delete(ip);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* 请求信息                                                             */
/* ------------------------------------------------------------------ */

function firstHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first ? first : undefined;
}

/** 客户端 IP：信任代理时取 X-Forwarded-For 的第一个，否则取连接的对端地址 */
export function clientIp(c: Context, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = firstHeaderValue(c.req.header("x-forwarded-for"));
    if (forwarded) return forwarded;
  }
  try {
    return getConnInfo(c).remote.address ?? "unknown";
  } catch {
    // 不是经 @hono/node-server 进来的请求（如测试里的 app.request）没有连接信息
    return "unknown";
  }
}

/** 请求是不是 https（决定 Cookie 要不要加 Secure） */
export function isHttps(c: Context, trustProxy: boolean): boolean {
  if (trustProxy) {
    const proto = firstHeaderValue(c.req.header("x-forwarded-proto"));
    if (proto) return proto.toLowerCase() === "https";
  }
  try {
    return new URL(c.req.url).protocol === "https:";
  } catch {
    return false;
  }
}

/** 请求的 Host：优先 Host 头；信任代理时也接受 X-Forwarded-Host */
export function requestHosts(c: Context, trustProxy: boolean): string[] {
  const hosts: string[] = [];
  const host = c.req.header("host");
  if (host) hosts.push(host.trim().toLowerCase());
  else {
    try {
      hosts.push(new URL(c.req.url).host.toLowerCase());
    } catch {
      // 没有可用的 Host
    }
  }
  if (trustProxy) {
    const forwarded = firstHeaderValue(c.req.header("x-forwarded-host"));
    if (forwarded) hosts.push(forwarded.toLowerCase());
  }
  return hosts;
}
