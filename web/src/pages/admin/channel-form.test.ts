import { describe, expect, it } from "vitest";
import type { AdminChannel } from "../../../../shared/types.ts";
import {
  baseUrlError,
  channelToForm,
  channelToggleInput,
  effectiveBaseUrl,
  emptyChannelForm,
  formatHeaders,
  parseExtraHeaders,
  previewRequestUrl,
  validateChannelForm,
  type ChannelFormValues,
} from "./channel-form";

const channel: AdminChannel = {
  id: 7,
  name: "中转 A",
  endpointType: "anthropic",
  baseUrl: "https://relay.example.com",
  hasApiKey: true,
  apiKeyMasked: "sk-a…9f3c",
  extraHeaders: { "X-Team": "qa" },
  enabled: true,
  sortOrder: 3,
  modelCount: 2,
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
};

const form = (patch: Partial<ChannelFormValues> = {}): ChannelFormValues => ({
  ...emptyChannelForm(),
  name: "官方",
  ...patch,
});

describe("parseExtraHeaders", () => {
  it("留空表示没有请求头", () => {
    expect(parseExtraHeaders("")).toEqual({ ok: true, value: {} });
    expect(parseExtraHeaders("  \n ")).toEqual({ ok: true, value: {} });
    expect(parseExtraHeaders("{}")).toEqual({ ok: true, value: {} });
  });

  it("名称和值去掉首尾空白", () => {
    expect(parseExtraHeaders('{" X-Custom ": " value "}')).toEqual({
      ok: true,
      value: { "X-Custom": "value" },
    });
  });

  it("不是 JSON、不是对象都报错", () => {
    expect(parseExtraHeaders("{X-Custom: 1}").ok).toBe(false);
    for (const text of ["[]", '"x"', "null", "42"]) {
      const result = parseExtraHeaders(text);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain("JSON 对象");
    }
  });

  it("值必须是字符串", () => {
    const result = parseExtraHeaders('{"X-Retry": 3}');
    expect(result).toEqual({
      ok: false,
      error: '请求头"X-Retry"的值必须是字符串',
    });
  });

  it("名称要是合法的 HTTP token，不能为空", () => {
    expect(parseExtraHeaders('{"X Bad": "1"}')).toEqual({
      ok: false,
      error: '请求头名称"X Bad"含有不允许的字符',
    });
    expect(parseExtraHeaders('{"  ": "1"}')).toEqual({
      ok: false,
      error: "额外请求头的名称不能为空",
    });
  });

  it("不区分大小写的重名报错", () => {
    expect(parseExtraHeaders('{"X-A": "1", "x-a": "2"}')).toEqual({
      ok: false,
      error: '请求头"x-a"重复了',
    });
  });

  it("值不能有换行、不能太长", () => {
    expect(parseExtraHeaders('{"X-A": "a\\nb"}').ok).toBe(false);
    expect(
      parseExtraHeaders(JSON.stringify({ "X-A": "a".repeat(2001) })).ok,
    ).toBe(false);
    expect(
      parseExtraHeaders(JSON.stringify({ "X-A": "a".repeat(2000) })).ok,
    ).toBe(true);
  });

  it("最多 30 个", () => {
    const headers = Object.fromEntries(
      Array.from({ length: 31 }, (_, index) => [`X-H${index}`, "v"]),
    );
    expect(parseExtraHeaders(JSON.stringify(headers))).toEqual({
      ok: false,
      error: "额外请求头最多 30 个",
    });
  });

  it("名叫 __proto__ 的头是普通的自有属性", () => {
    const result = parseExtraHeaders('{"__proto__": "x"}');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(Object.getPrototypeOf(result.value)).toBe(Object.prototype);
      expect(Object.keys(result.value)).toEqual(["__proto__"]);
    }
  });
});

describe("基础地址", () => {
  it("空串合法，非 http(s) 不合法", () => {
    expect(baseUrlError("")).toBeUndefined();
    expect(baseUrlError("https://a.example.com/v1")).toBeUndefined();
    expect(baseUrlError("ftp://a.example.com")).toContain("http://");
    expect(baseUrlError("not a url")).toContain("http://");
    expect(baseUrlError(`https://a.example.com/${"x".repeat(500)}`)).toBe(
      "基础地址不能超过 500 个字符",
    );
  });

  it("预览实际请求地址；Gemini 的模型位显示成 {模型}", () => {
    expect(previewRequestUrl("openai-chat", "")).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(previewRequestUrl("anthropic", "https://relay.example.com")).toBe(
      "https://relay.example.com/v1/messages",
    );
    expect(previewRequestUrl("gemini", "")).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/{模型}:generateContent",
    );
    expect(previewRequestUrl("openai-chat", "nope")).toBeNull();
  });

  it("列表里没填地址时显示默认地址", () => {
    expect(effectiveBaseUrl({ endpointType: "gemini", baseUrl: "" })).toEqual({
      url: "https://generativelanguage.googleapis.com",
      isDefault: true,
    });
    expect(effectiveBaseUrl(channel)).toEqual({
      url: "https://relay.example.com",
      isDefault: false,
    });
  });
});

describe("channelToForm / formatHeaders", () => {
  it("编辑时密钥框为空，请求头写成缩进的 JSON", () => {
    const values = channelToForm(channel);
    expect(values.apiKey).toBe("");
    expect(values.clearApiKey).toBe(false);
    expect(values.sortOrder).toBe("3");
    expect(JSON.parse(values.extraHeaders)).toEqual({ "X-Team": "qa" });
    expect(formatHeaders({})).toBe("");
  });
});

describe("validateChannelForm", () => {
  it("新建：去空白、排序留空当 0、空密钥照样提交", () => {
    const result = validateChannelForm(
      form({ name: "  官方  ", baseUrl: "  ", sortOrder: "" }),
      "create",
    );
    expect(result.errors).toEqual({});
    expect(result.input).toEqual({
      name: "官方",
      endpointType: "openai-chat",
      baseUrl: "",
      apiKey: "",
      extraHeaders: {},
      enabled: true,
      sortOrder: 0,
    });
  });

  it("逐个字段报错", () => {
    const result = validateChannelForm(
      form({
        name: " ",
        baseUrl: "example.com",
        apiKey: "k".repeat(1001),
        extraHeaders: "{",
        sortOrder: "1.5",
      }),
      "create",
    );
    expect(result.input).toBeNull();
    expect(result.errors.name).toBe("名称不能为空");
    expect(result.errors.baseUrl).toContain("http://");
    expect(result.errors.apiKey).toBe("API 密钥不能超过 1000 个字符");
    expect(result.errors.extraHeaders).toContain("JSON");
    expect(result.errors.sortOrder).toBe(
      "排序值必须是 -1000000 到 1000000 之间的整数",
    );
  });

  it("名称最多 100 字", () => {
    expect(
      validateChannelForm(form({ name: "名".repeat(101) }), "create").errors,
    ).toEqual({
      name: "名称不能超过 100 个字符",
    });
  });

  it("编辑：没填新密钥就不传 apiKey（保留原值）", () => {
    const result = validateChannelForm(channelToForm(channel), "edit");
    expect(result.input).not.toBeNull();
    expect(result.input && "apiKey" in result.input).toBe(false);
    expect(result.input?.extraHeaders).toEqual({ "X-Team": "qa" });
  });

  it("编辑：填了新密钥就替换，勾选清除就传 null", () => {
    const replaced = validateChannelForm(
      { ...channelToForm(channel), apiKey: "  sk-new  " },
      "edit",
    );
    expect(replaced.input?.apiKey).toBe("sk-new");
    const cleared = validateChannelForm(
      { ...channelToForm(channel), clearApiKey: true, apiKey: "ignored" },
      "edit",
    );
    expect(cleared.input?.apiKey).toBeNull();
  });
});

describe("channelToggleInput", () => {
  it("只改启用状态，不带密钥", () => {
    const input = channelToggleInput(channel, false);
    expect(input).toEqual({
      name: "中转 A",
      endpointType: "anthropic",
      baseUrl: "https://relay.example.com",
      extraHeaders: { "X-Team": "qa" },
      enabled: false,
      sortOrder: 3,
    });
    expect("apiKey" in input).toBe(false);
  });
});
