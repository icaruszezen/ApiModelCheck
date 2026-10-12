import { describe, expect, it } from "vitest";
import { channelSchema, validate } from "./validation.ts";

function channel(baseUrl: unknown) {
  return validate(channelSchema, {
    name: "中转",
    endpointType: "openai-chat",
    baseUrl,
  });
}

describe("channelSchema 的基础地址", () => {
  it("留空、普通地址都可以，首尾空白会去掉", () => {
    const empty = channel(undefined);
    expect(empty.ok && empty.data.baseUrl).toBe("");
    const trimmed = channel("  https://relay.example/v1  ");
    expect(trimmed.ok && trimmed.data.baseUrl).toBe("https://relay.example/v1");
  });

  it("不是 http(s) 地址", () => {
    expect(channel("ftp://relay.example")).toEqual({
      ok: false,
      error: "基础地址必须是 http:// 或 https:// 开头的有效地址",
    });
  });

  it("地址里带用户名密码时给出对应的提示", () => {
    const result = channel("https://user:secret@relay.example/v1");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toMatch(/^基础地址里不能带用户名和密码/);
      expect(result.error).not.toContain("secret");
    }
  });
});
