import { describe, expect, it } from "vitest";
import { ApiRequestError } from "../api/client";
import { shouldReloadAfterReauth } from "./use-async";

describe("shouldReloadAfterReauth", () => {
  const unauthorized = new ApiRequestError("未登录或登录已过期", 401);

  it("上一次因为没登录失败了：重新请求", () => {
    expect(shouldReloadAfterReauth({ inFlight: false, error: unauthorized })).toBe(
      true,
    );
  });

  it("还有请求在路上：可能带着过期的凭据，重新请求", () => {
    expect(shouldReloadAfterReauth({ inFlight: true, error: undefined })).toBe(
      true,
    );
  });

  it("好好的、或者是别的错误：不动（别的错误还是让人自己点重试）", () => {
    expect(shouldReloadAfterReauth({ inFlight: false, error: undefined })).toBe(
      false,
    );
    expect(
      shouldReloadAfterReauth({
        inFlight: false,
        error: new ApiRequestError("连不上服务器", 0),
      }),
    ).toBe(false);
    expect(
      shouldReloadAfterReauth({
        inFlight: false,
        error: new ApiRequestError("服务器出错", 500),
      }),
    ).toBe(false);
  });
});
