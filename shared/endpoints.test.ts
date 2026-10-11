import { describe, expect, it } from "vitest";
import {
  baseUrlIssue,
  buildModelsUrl,
  buildRequestUrl,
  isValidBaseUrl,
} from "./endpoints.ts";

describe("buildRequestUrl", () => {
  it("在只有域名的基础地址后补上版本段", () => {
    expect(buildRequestUrl("openai-chat", "https://api.openai.com", "gpt", false)).toBe(
      "https://api.openai.com/v1/chat/completions",
    );
    expect(buildRequestUrl("anthropic", "https://api.anthropic.com/", "c", true)).toBe(
      "https://api.anthropic.com/v1/messages",
    );
    expect(buildRequestUrl("gemini", "", "gemini-2.5-pro", true)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse",
    );
  });
  it("基础地址带路径（Anthropic / Gemini 已写到版本段）时直接接后缀，已带后缀时原样使用", () => {
    expect(buildRequestUrl("openai-chat", "https://openrouter.ai/api/v1", "x", false)).toBe(
      "https://openrouter.ai/api/v1/chat/completions",
    );
    expect(buildRequestUrl("openai-responses", "https://h.example/v1/responses", "x", true)).toBe(
      "https://h.example/v1/responses",
    );
    expect(buildRequestUrl("anthropic", "https://h.example/v1", "x", false)).toBe(
      "https://h.example/v1/messages",
    );
    expect(buildRequestUrl("gemini", "https://h.example/v1beta", "models/g-1", false)).toBe(
      "https://h.example/v1beta/models/g-1:generateContent",
    );
  });
  it("保留查询参数", () => {
    expect(buildRequestUrl("openai-chat", "https://h.example/openai?api-version=1", "x", false)).toBe(
      "https://h.example/openai/chat/completions?api-version=1",
    );
  });
  it("没填模型时 Gemini 的预览地址显示占位", () => {
    expect(buildRequestUrl("gemini", "", "", false)).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/{模型}:generateContent",
    );
  });
});

describe("Anthropic / Gemini 的基础地址带前缀", () => {
  // [基础地址, 生成请求地址, 模型列表地址]
  const anthropicCases: [string, string, string][] = [
    [
      "https://api.deepseek.com/anthropic",
      "https://api.deepseek.com/anthropic/v1/messages",
      "https://api.deepseek.com/anthropic/v1/models",
    ],
    [
      "https://api.moonshot.cn/anthropic/",
      "https://api.moonshot.cn/anthropic/v1/messages",
      "https://api.moonshot.cn/anthropic/v1/models",
    ],
    [
      "https://open.bigmodel.cn/api/anthropic",
      "https://open.bigmodel.cn/api/anthropic/v1/messages",
      "https://open.bigmodel.cn/api/anthropic/v1/models",
    ],
    [
      "https://api.minimaxi.com/anthropic",
      "https://api.minimaxi.com/anthropic/v1/messages",
      "https://api.minimaxi.com/anthropic/v1/models",
    ],
    [
      "https://openrouter.ai/api",
      "https://openrouter.ai/api/v1/messages",
      "https://openrouter.ai/api/v1/models",
    ],
    [
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic",
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/messages",
      "https://gateway.ai.cloudflare.com/v1/acct/gw/anthropic/v1/models",
    ],
    // 已经写到版本段、写成完整地址：不再补
    ["https://h.example/v1", "https://h.example/v1/messages", "https://h.example/v1/models"],
    [
      "https://api.deepseek.com/anthropic/v1/messages",
      "https://api.deepseek.com/anthropic/v1/messages",
      "https://api.deepseek.com/anthropic/v1/models",
    ],
    [
      "https://h.example/proxy/messages",
      "https://h.example/proxy/messages",
      "https://h.example/proxy/models",
    ],
    [
      "https://h.example/anthropic/v1/models?beta=true",
      "https://h.example/anthropic/v1/messages?beta=true",
      "https://h.example/anthropic/v1/models?beta=true",
    ],
  ];
  it.each(anthropicCases)("anthropic %s", (base, request, models) => {
    expect(buildRequestUrl("anthropic", base, "c", true)).toBe(request);
    expect(buildModelsUrl("anthropic", base)).toBe(models);
  });

  const geminiCases: [string, string, string][] = [
    [
      "https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio",
      "https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta/models/g-1:streamGenerateContent?alt=sse",
      "https://gateway.ai.cloudflare.com/v1/acct/gw/google-ai-studio/v1beta/models",
    ],
    [
      "https://my-proxy.example.com/gemini",
      "https://my-proxy.example.com/gemini/v1beta/models/g-1:streamGenerateContent?alt=sse",
      "https://my-proxy.example.com/gemini/v1beta/models",
    ],
    // 已经写到版本段：不再补
    [
      "https://h.example/gemini/v1",
      "https://h.example/gemini/v1/models/g-1:streamGenerateContent?alt=sse",
      "https://h.example/gemini/v1/models",
    ],
    [
      "https://h.example/v1beta/models/g-1:generateContent",
      "https://h.example/v1beta/models/g-1:streamGenerateContent?alt=sse",
      "https://h.example/v1beta/models",
    ],
    // Vertex AI（express 模式与带项目的完整路径）
    [
      "https://aiplatform.googleapis.com/v1/publishers/google",
      "https://aiplatform.googleapis.com/v1/publishers/google/models/g-1:streamGenerateContent?alt=sse",
      "https://aiplatform.googleapis.com/v1/publishers/google/models",
    ],
    [
      "https://aiplatform.googleapis.com/v1/publishers/google/models/g-1:generateContent?key=k",
      "https://aiplatform.googleapis.com/v1/publishers/google/models/g-1:streamGenerateContent?key=k&alt=sse",
      "https://aiplatform.googleapis.com/v1/publishers/google/models?key=k",
    ],
    [
      "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google",
      "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models/g-1:streamGenerateContent?alt=sse",
      "https://us-central1-aiplatform.googleapis.com/v1/projects/p/locations/us-central1/publishers/google/models",
    ],
  ];
  it.each(geminiCases)("gemini %s", (base, request, models) => {
    expect(buildRequestUrl("gemini", base, "g-1", true)).toBe(request);
    expect(buildModelsUrl("gemini", base)).toBe(models);
  });

  it("OpenAI 两种类型不补版本段", () => {
    expect(buildRequestUrl("openai-chat", "https://h.example/openai", "x", false)).toBe(
      "https://h.example/openai/chat/completions",
    );
    expect(buildModelsUrl("openai-responses", "https://openrouter.ai/api")).toBe(
      "https://openrouter.ai/api/models",
    );
  });
});

describe("baseUrlIssue", () => {
  it("空串和普通的 http(s) 地址没有问题", () => {
    expect(baseUrlIssue("")).toBeNull();
    expect(baseUrlIssue("  ")).toBeNull();
    expect(baseUrlIssue("https://api.example.com/v1?x=1")).toBeNull();
    expect(isValidBaseUrl("http://127.0.0.1:4010")).toBe(true);
  });
  it("不是 http(s) 地址", () => {
    expect(baseUrlIssue("ftp://h.example")).toMatch(/http:\/\/ 或 https:\/\//);
    expect(baseUrlIssue("not a url")).toMatch(/http:\/\/ 或 https:\/\//);
  });
  it("地址里带用户名密码", () => {
    expect(baseUrlIssue("https://user:secret@relay.example/v1")).toMatch(/不能带用户名和密码/);
    expect(isValidBaseUrl("https://user@relay.example/v1")).toBe(false);
  });
});

describe("buildModelsUrl", () => {
  it("推出模型列表地址", () => {
    expect(buildModelsUrl("openai-chat", "https://api.openai.com/v1")).toBe("https://api.openai.com/v1/models");
    expect(buildModelsUrl("openai-chat", "https://h.example/v1/chat/completions")).toBe("https://h.example/v1/models");
    expect(buildModelsUrl("anthropic", "https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/models");
    expect(buildModelsUrl("gemini", "")).toBe("https://generativelanguage.googleapis.com/v1beta/models");
  });
});
