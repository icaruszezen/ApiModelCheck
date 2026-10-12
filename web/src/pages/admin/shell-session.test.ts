import { describe, expect, it } from "vitest";
import {
  ApiRequestError,
  UNAUTHORIZED_EVENT,
  type UnauthorizedEventDetail,
} from "../../api/client";
import {
  reauthDismissed,
  sentBeforeLogin,
  sessionExpired,
  toSaveError,
  type AdminAuthState,
} from "./shell-session";

const ready: AdminAuthState = {
  status: "ready",
  session: { username: "admin" },
  reauth: false,
};

describe("sessionExpired", () => {
  it("已登录时收到 401：外壳留着，只打开重新登录的弹窗", () => {
    expect(sessionExpired(ready)).toEqual({ ...ready, reauth: true });
  });

  it("弹窗已经打开：原样返回，连着几个 401 不会叠弹窗", () => {
    const expired = sessionExpired(ready);
    expect(sessionExpired(expired)).toBe(expired);
  });

  it("没登录、正在确认、确认失败时的 401 都不算会话过期", () => {
    const states: AdminAuthState[] = [
      { status: "anonymous" },
      { status: "checking" },
      { status: "failed", message: "连不上服务器" },
    ];
    for (const state of states) expect(sessionExpired(state)).toBe(state);
  });
});

describe("reauthDismissed", () => {
  it("关掉弹窗后外壳照旧，下一次 401 又会弹出来", () => {
    const dismissed = reauthDismissed(sessionExpired(ready));
    expect(dismissed).toEqual(ready);
    expect(sessionExpired(dismissed)).toEqual({ ...ready, reauth: true });
  });

  it("没有弹窗时原样返回", () => {
    expect(reauthDismissed(ready)).toBe(ready);
    const anonymous: AdminAuthState = { status: "anonymous" };
    expect(reauthDismissed(anonymous)).toBe(anonymous);
  });
});

describe("sentBeforeLogin", () => {
  const unauthorized = (startedAt: number) =>
    new CustomEvent<UnauthorizedEventDetail>(UNAUTHORIZED_EVENT, {
      detail: { startedAt },
    });

  it("登录前就发出、登录后才回来的 401：带的是旧凭据，不算过期", () => {
    expect(sentBeforeLogin(unauthorized(100), 200)).toBe(true);
  });

  it("登录之后发出的 401：真的过期了", () => {
    expect(sentBeforeLogin(unauthorized(300), 200)).toBe(false);
    expect(sentBeforeLogin(unauthorized(200), 200)).toBe(false);
  });

  it("还没在这个页面里登录过（一进来就是已登录）：都算", () => {
    expect(sentBeforeLogin(unauthorized(0), Number.NEGATIVE_INFINITY)).toBe(
      false,
    );
  });

  it("没带发出时刻的事件当作新的 401", () => {
    expect(sentBeforeLogin(new Event(UNAUTHORIZED_EVENT), 200)).toBe(false);
    expect(
      sentBeforeLogin(new CustomEvent(UNAUTHORIZED_EVENT, { detail: {} }), 200),
    ).toBe(false);
  });
});

describe("toSaveError", () => {
  it("因为没登录失败的：记下来，重新登录后收起", () => {
    expect(
      toSaveError(new ApiRequestError("未登录或登录已过期", 401)),
    ).toEqual({ message: "未登录或登录已过期", unauthorized: true });
  });

  it("别的错误照常显示、不会自己收起", () => {
    expect(toSaveError(new ApiRequestError("名称已存在", 409))).toEqual({
      message: "名称已存在",
      unauthorized: false,
    });
    expect(toSaveError("奇怪的东西")).toEqual({
      message: "操作失败，请稍后重试。",
      unauthorized: false,
    });
  });
});
