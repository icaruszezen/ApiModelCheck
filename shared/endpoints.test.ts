import { describe, expect, it } from "vitest";
import { buildModelsUrl, buildRequestUrl } from "./endpoints.ts";

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
  it("基础地址带路径时直接接后缀，已带后缀时原样使用", () => {
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

describe("buildModelsUrl", () => {
  it("推出模型列表地址", () => {
    expect(buildModelsUrl("openai-chat", "https://api.openai.com/v1")).toBe("https://api.openai.com/v1/models");
    expect(buildModelsUrl("openai-chat", "https://h.example/v1/chat/completions")).toBe("https://h.example/v1/models");
    expect(buildModelsUrl("anthropic", "https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/models");
    expect(buildModelsUrl("gemini", "")).toBe("https://generativelanguage.googleapis.com/v1beta/models");
  });
});
