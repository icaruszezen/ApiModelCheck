import { afterEach, describe, expect, it, vi } from "vitest";
import {
  adminApi,
  ApiRequestError,
  isUnauthorized,
  publicApi,
  UNAUTHORIZED_EVENT,
  type UnauthorizedEventDetail,
} from "./client";

/** 记下收到的"未登录"事件；测试环境是 node，没有 window，拿一个 EventTarget 顶上 */
function listen() {
  const target = new EventTarget();
  vi.stubGlobal("window", target);
  const events: Event[] = [];
  target.addEventListener(UNAUTHORIZED_EVENT, (event) => events.push(event));
  return events;
}

function respondWith(status: number, body: unknown) {
  const calledAt: number[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      calledAt.push(performance.now());
      return new Response(JSON.stringify(body), { status });
    }),
  );
  return calledAt;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("401 时的事件", () => {
  it("后台接口回 401：带着请求发出的时刻（在 fetch 之前取）发事件，并抛 401 错误", async () => {
    const events = listen();
    const calledAt = respondWith(401, { error: "未登录或登录已过期" });
    const before = performance.now();
    const error = await adminApi.models().catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiRequestError);
    expect((error as ApiRequestError).status).toBe(401);
    expect((error as ApiRequestError).message).toBe("未登录或登录已过期");
    expect(events).toHaveLength(1);
    const event = events[0];
    expect(event).toBeInstanceOf(CustomEvent);
    const { startedAt } = (event as CustomEvent<UnauthorizedEventDetail>)
      .detail;
    expect(startedAt).toBeGreaterThanOrEqual(before);
    expect(calledAt).toHaveLength(1);
    expect(startedAt).toBeLessThanOrEqual(calledAt[0] ?? Number.NaN);
  });

  it("前台接口的 401、后台接口的其他错误都不发", async () => {
    const events = listen();
    respondWith(401, { error: "x" });
    await publicApi.board().catch(() => {});
    respondWith(500, { error: "服务器出错" });
    await adminApi.models().catch(() => {});
    expect(events).toHaveLength(0);
  });
});

describe("isUnauthorized", () => {
  it("只有 HTTP 401 的接口错误才算", () => {
    expect(isUnauthorized(new ApiRequestError("未登录", 401))).toBe(true);
    expect(isUnauthorized(new ApiRequestError("没有权限", 403))).toBe(false);
    expect(isUnauthorized(new ApiRequestError("连不上", 0))).toBe(false);
    expect(isUnauthorized(new Error("401"))).toBe(false);
    expect(isUnauthorized(undefined)).toBe(false);
  });
});
