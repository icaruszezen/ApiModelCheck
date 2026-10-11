import { describe, expect, it } from "vitest";
import {
  createAuth,
  LOGIN_BLOCK_MS,
  LOGIN_MAX_FAILURES,
  LOGIN_WINDOW_MS,
  LoginLimiter,
  SESSION_TTL_SECONDS,
} from "./auth.ts";

const options = {
  username: "admin",
  password: "correct horse",
  secret: "s".repeat(64),
};

describe("createAuth", () => {
  it("checkCredentials 用户名和密码都要对", () => {
    const auth = createAuth(options);
    expect(auth.checkCredentials("admin", "correct horse")).toBe(true);
    expect(auth.checkCredentials("admin", "wrong")).toBe(false);
    expect(auth.checkCredentials("root", "correct horse")).toBe(false);
    expect(auth.checkCredentials("", "")).toBe(false);
  });

  it("签发的令牌在有效期内有效，过期后无效", () => {
    const auth = createAuth(options);
    const now = new Date("2026-01-01T00:00:00Z");
    const token = auth.issueToken(now);
    expect(auth.verifyToken(token, now)).toBe("admin");
    const almost = new Date(now.getTime() + (SESSION_TTL_SECONDS - 1) * 1000);
    expect(auth.verifyToken(token, almost)).toBe("admin");
    const expired = new Date(now.getTime() + SESSION_TTL_SECONDS * 1000);
    expect(auth.verifyToken(token, expired)).toBeNull();
  });

  it("篡改过的令牌无效", () => {
    const auth = createAuth(options);
    const token = auth.issueToken();
    const [payload, signature] = token.split(".") as [string, string];
    const forged = Buffer.from(
      JSON.stringify({
        u: "admin",
        exp: Math.floor(Date.now() / 1000) + 10 ** 8,
      }),
    ).toString("base64url");
    expect(auth.verifyToken(`${forged}.${signature}`)).toBeNull();
    const flipped = signature.startsWith("A")
      ? `B${signature.slice(1)}`
      : `A${signature.slice(1)}`;
    expect(auth.verifyToken(`${payload}.${flipped}`)).toBeNull();
    expect(auth.verifyToken(`${payload}.`)).toBeNull();
    expect(auth.verifyToken(payload)).toBeNull();
    expect(auth.verifyToken(`${token}.x`)).toBeNull();
    expect(auth.verifyToken("")).toBeNull();
    expect(auth.verifyToken(undefined)).toBeNull();
  });

  it("改了密码、密钥或用户名，旧令牌全部失效", () => {
    const token = createAuth(options).issueToken();
    expect(
      createAuth({ ...options, password: "new password" }).verifyToken(token),
    ).toBeNull();
    expect(
      createAuth({ ...options, secret: "t".repeat(64) }).verifyToken(token),
    ).toBeNull();
    expect(
      createAuth({ ...options, username: "boss" }).verifyToken(token),
    ).toBeNull();
    expect(createAuth({ ...options }).verifyToken(token)).toBe("admin");
  });
});

describe("LoginLimiter", () => {
  it("窗口内失败 10 次后封禁 15 分钟，成功登录清零", () => {
    const limiter = new LoginLimiter();
    const t0 = 1_000_000;
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++)
      limiter.recordFailure("1.1.1.1", t0 + i);
    expect(limiter.isBlocked("1.1.1.1", t0 + 100)).toBe(false);
    limiter.recordFailure("1.1.1.1", t0 + 100);
    expect(limiter.isBlocked("1.1.1.1", t0 + 101)).toBe(true);
    expect(limiter.isBlocked("2.2.2.2", t0 + 101)).toBe(false);
    expect(limiter.isBlocked("1.1.1.1", t0 + 100 + LOGIN_BLOCK_MS)).toBe(false);

    limiter.recordFailure("3.3.3.3", t0);
    limiter.recordSuccess("3.3.3.3");
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++)
      limiter.recordFailure("3.3.3.3", t0 + i);
    expect(limiter.isBlocked("3.3.3.3", t0 + 50)).toBe(false);
  });

  it("超出窗口的失败不计入", () => {
    const limiter = new LoginLimiter();
    const t0 = 5_000_000;
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++)
      limiter.recordFailure("ip", t0);
    limiter.recordFailure("ip", t0 + LOGIN_WINDOW_MS);
    expect(limiter.isBlocked("ip", t0 + LOGIN_WINDOW_MS)).toBe(false);
  });

  it("条目数有上限", () => {
    const limiter = new LoginLimiter(10);
    for (let i = 0; i < 100; i++) limiter.recordFailure(`ip-${i}`, 1000);
    // 最近的仍然记着，最早的被丢掉，不会无限增长
    for (let i = 0; i < LOGIN_MAX_FAILURES - 1; i++)
      limiter.recordFailure("ip-99", 1000);
    expect(limiter.isBlocked("ip-99", 1001)).toBe(true);
  });
});
