import net from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ENDPOINT_TYPES } from "../../shared/endpoints.ts";
import type { EndpointType } from "../../shared/endpoints.ts";
import {
  MOCK_GEMINI_EMBEDDING_MODEL,
  MOCK_MODELS,
  countMockTokens,
  mockReply,
  startMockUpstream,
} from "../test/mock-upstream.ts";
import type { MockUpstream, RecordedRequest } from "../test/mock-upstream.ts";
import { ProviderError, listModels, runCompletion } from "./index.ts";
import type {
  CompletionDelta,
  CompletionRequest,
  CompletionResult,
} from "./index.ts";

const KEY = "sk-test-0123456789";
const PROMPT =
  "9.11 和 9.9 哪个大？请先给出结论，再用一两句话解释。\n这句话是为了让提示词超过四十个字，好检查引用时的截断。";
const FINISH: Record<EndpointType, string> = {
  "openai-chat": "stop",
  "openai-responses": "completed",
  anthropic: "end_turn",
  gemini: "STOP",
};

let mock: MockUpstream;
let open: MockUpstream; // 不校验密钥的实例，用来看"没有密钥"时的请求头

beforeAll(async () => {
  [mock, open] = await Promise.all([
    startMockUpstream({ apiKey: KEY, modelsPageSize: 5 }),
    startMockUpstream(),
  ]);
});

afterAll(async () => {
  await Promise.all([mock.close(), open.close()]);
});

function makeRequest(
  type: EndpointType,
  overrides: Partial<CompletionRequest> = {},
): CompletionRequest {
  return {
    endpointType: type,
    baseUrl: mock.url,
    apiKey: KEY,
    extraHeaders: {},
    model: "mock-basic",
    prompt: PROMPT,
    stream: false,
    maxTokens: null,
    temperature: null,
    signal: AbortSignal.timeout(10_000),
    ...overrides,
  };
}

async function run(
  type: EndpointType,
  overrides: Partial<CompletionRequest> = {},
): Promise<{ result: CompletionResult; deltas: CompletionDelta[] }> {
  const deltas: CompletionDelta[] = [];
  const result = await runCompletion(
    makeRequest(type, { onDelta: (delta) => deltas.push(delta), ...overrides }),
  );
  return { result, deltas };
}

async function runError(
  type: EndpointType,
  overrides: Partial<CompletionRequest> = {},
): Promise<{ error: unknown; deltas: CompletionDelta[] }> {
  const deltas: CompletionDelta[] = [];
  try {
    await runCompletion(
      makeRequest(type, {
        onDelta: (delta) => deltas.push(delta),
        ...overrides,
      }),
    );
  } catch (error) {
    return { error, deltas };
  }
  throw new Error("expected runCompletion to reject");
}

function lastRequest(upstream: MockUpstream): RecordedRequest {
  const request = upstream.requests.at(-1);
  if (!request) throw new Error("no request recorded");
  return request;
}

function join(deltas: CompletionDelta[], key: keyof CompletionDelta): string {
  return deltas.map((delta) => delta[key] ?? "").join("");
}

/** 一个当前没人监听的端口 */
async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string")
    throw new Error("no port");
  return address.port;
}

describe.each(ENDPOINT_TYPES)("%s", (type) => {
  describe.each([false, true])("stream=%s", (stream) => {
    it.each([
      "mock-basic",
      "mock-think",
      "mock-thinktag",
      "mock-html",
      "mock-rawhtml",
    ])("%s：正文、思考过程、用量、结束原因", async (model) => {
      const { result, deltas } = await run(type, { model, stream });
      const expected = mockReply(type, model, PROMPT);
      expect(result.output).toBe(expected.output);
      expect(result.reasoning).toBe(expected.reasoning);
      if (model === "mock-think") expect(result.reasoning).not.toBe("");
      expect(result.inputTokens).toBe(countMockTokens(PROMPT));
      expect(result.outputTokens).toBe(
        countMockTokens(expected.output) + countMockTokens(expected.reasoning),
      );
      expect(result.finishReason).toBe(FINISH[type]);
      if (stream) {
        // 按约 12 字一段切开发送，增量拼起来要和最终结果一致
        expect(deltas.length).toBeGreaterThan(3);
        expect(join(deltas, "output")).toBe(result.output);
        expect(join(deltas, "reasoning")).toBe(result.reasoning);
      } else {
        expect(deltas).toEqual([]);
      }
    });

    it("HTTP 错误 → ProviderError，带状态码和上游的消息", async () => {
      const { error } = await runError(type, { model: "mock-error", stream });
      expect(error).toBeInstanceOf(ProviderError);
      expect((error as ProviderError).message).toBe(
        "HTTP 500：mock upstream failure",
      );
      expect((error as ProviderError).status).toBe(500);
    });

    it("密钥不对 → HTTP 401", async () => {
      const { error } = await runError(type, { apiKey: "wrong", stream });
      expect(error).toBeInstanceOf(ProviderError);
      const message = (error as ProviderError).message;
      expect(message.startsWith("HTTP 401：")).toBe(true);
      expect(message.length).toBeGreaterThan("HTTP 401：".length + 5);
      expect((error as ProviderError).status).toBe(401);
    });

    it("hang 模型在中止后立刻以中止错误拒绝（不是 ProviderError）", async () => {
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => controller.abort(), 200);
      const { error } = await runError(type, {
        model: "mock-hang",
        stream,
        signal: controller.signal,
      });
      expect(Date.now() - started).toBeLessThan(2000);
      expect(error).not.toBeInstanceOf(ProviderError);
      expect((error as Error).name).toBe("AbortError");
      expect(controller.signal.aborted).toBe(true);
    });

    it("midfail", async () => {
      const { error, deltas } = await runError(type, {
        model: "mock-midfail",
        stream,
      });
      expect(error).toBeInstanceOf(ProviderError);
      if (stream) {
        expect((error as ProviderError).message).toBe("mock stream failure");
        // 出错前的两段已经报出去了
        expect(deltas).toHaveLength(2);
      } else {
        expect((error as ProviderError).message).toBe(
          "HTTP 500：mock upstream failure",
        );
      }
    });
  });

  it("流式读到一半被中止：以中止错误拒绝，之前的增量已经报出", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 600);
    const started = Date.now();
    const { error, deltas } = await runError(type, {
      model: "mock-slow",
      stream: true,
      signal: controller.signal,
    });
    expect(Date.now() - started).toBeLessThan(2000);
    expect((error as Error).name).toBe("AbortError");
    expect(error).not.toBeInstanceOf(ProviderError);
    expect(deltas.length).toBeGreaterThan(0);
  });

  it("中止原因是自定义的错误时原样抛出", async () => {
    const controller = new AbortController();
    const reason = new Error("custom timeout");
    setTimeout(() => controller.abort(reason), 100);
    const { error } = await runError(type, {
      model: "mock-hang",
      stream: true,
      signal: controller.signal,
    });
    expect(error).toBe(reason);
  });

  it("已经中止的 signal 直接拒绝，不发请求", async () => {
    const before = mock.requests.length;
    const { error } = await runError(type, { signal: AbortSignal.abort() });
    expect((error as Error).name).toBe("AbortError");
    expect(mock.requests.length).toBe(before);
  });

  it("请求流式但上游返回 JSON：照常解析，并用一次 onDelta 报出完整输出", async () => {
    const { result, deltas } = await run(type, {
      model: "mock-nostream-think",
      stream: true,
    });
    const expected = mockReply(type, "mock-nostream-think", PROMPT);
    expect(result.output).toBe(expected.output);
    expect(result.reasoning).toBe(expected.reasoning);
    expect(deltas).toEqual([
      { reasoning: expected.reasoning, output: expected.output },
    ]);
  });

  it("请求非流式但上游返回 SSE：照常解析，不调用 onDelta", async () => {
    const { result, deltas } = await run(type, {
      model: "mock-alwaysstream",
      stream: false,
    });
    expect(result.output).toBe(
      mockReply(type, "mock-alwaysstream", PROMPT).output,
    );
    expect(result.finishReason).toBe(FINISH[type]);
    expect(deltas).toEqual([]);
  });

  it("网络错误 → ProviderError（网络错误：…）", async () => {
    const port = await closedPort();
    const { error } = await runError(type, {
      baseUrl: `http://127.0.0.1:${port}`,
    });
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toMatch(/^网络错误：ECONNREFUSED/);
    expect((error as ProviderError).status).toBeNull();
  });

  it("列出模型：去重、排序", async () => {
    const models = await listModels({
      endpointType: type,
      baseUrl: mock.url,
      apiKey: KEY,
      extraHeaders: {},
    });
    expect(models).toEqual([...MOCK_MODELS].sort());
    expect(models).not.toContain(MOCK_GEMINI_EMBEDDING_MODEL);
  });

  it("列出模型：密钥不对 → HTTP 401", async () => {
    await expect(
      listModels({
        endpointType: type,
        baseUrl: mock.url,
        apiKey: "wrong",
        extraHeaders: {},
      }),
    ).rejects.toThrow(/^HTTP 401：/);
  });

  it("列出模型：网络错误", async () => {
    const port = await closedPort();
    await expect(
      listModels({
        endpointType: type,
        baseUrl: `http://127.0.0.1:${port}`,
        apiKey: "",
        extraHeaders: {},
      }),
    ).rejects.toThrow(/^网络错误：/);
  });
});

describe("请求头", () => {
  it("OpenAI 两种端点用 Bearer", async () => {
    for (const type of ["openai-chat", "openai-responses"] as const) {
      await run(type);
      const { headers } = lastRequest(mock);
      expect(headers.authorization).toBe(`Bearer ${KEY}`);
      expect(headers["content-type"]).toBe("application/json");
      expect(headers["x-api-key"]).toBeUndefined();
    }
  });

  it("Anthropic 用 x-api-key 和 anthropic-version", async () => {
    await run("anthropic");
    const { headers } = lastRequest(mock);
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers.authorization).toBeUndefined();
  });

  it("Gemini 用 x-goog-api-key", async () => {
    await run("gemini");
    const { headers } = lastRequest(mock);
    expect(headers["x-goog-api-key"]).toBe(KEY);
    expect(headers.authorization).toBeUndefined();
  });

  it("密钥为空时不带认证头（anthropic-version 照样带）", async () => {
    for (const type of ENDPOINT_TYPES) {
      await run(type, { baseUrl: open.url, apiKey: "" });
      const { headers } = lastRequest(open);
      expect(headers.authorization).toBeUndefined();
      expect(headers["x-api-key"]).toBeUndefined();
      expect(headers["x-goog-api-key"]).toBeUndefined();
      expect(headers["anthropic-version"]).toBe(
        type === "anthropic" ? "2023-06-01" : undefined,
      );
    }
  });

  it("额外请求头最后合并，名字不分大小写地覆盖默认的", async () => {
    await run("openai-chat", {
      baseUrl: open.url,
      extraHeaders: {
        Authorization: "Bearer other",
        "X-Trace-Id": "abc",
        "Content-Type": "application/json; charset=utf-8",
      },
    });
    let { headers } = lastRequest(open);
    expect(headers.authorization).toBe("Bearer other");
    expect(headers["x-trace-id"]).toBe("abc");
    expect(headers["content-type"]).toBe("application/json; charset=utf-8");

    await run("anthropic", {
      baseUrl: open.url,
      extraHeaders: {
        "Anthropic-Version": "2024-01-01",
        "anthropic-beta": "beta-1",
      },
    });
    ({ headers } = lastRequest(open));
    expect(headers["anthropic-version"]).toBe("2024-01-01");
    expect(headers["anthropic-beta"]).toBe("beta-1");
    expect(headers["x-api-key"]).toBe(KEY);
  });

  it("列模型也带认证头，GET 不带 Content-Type", async () => {
    await listModels({
      endpointType: "anthropic",
      baseUrl: open.url,
      apiKey: KEY,
      extraHeaders: { "X-A": "1" },
    });
    const { headers, method } = lastRequest(open);
    expect(method).toBe("GET");
    expect(headers["x-api-key"]).toBe(KEY);
    expect(headers["anthropic-version"]).toBe("2023-06-01");
    expect(headers["x-a"]).toBe("1");
    expect(headers["content-type"]).toBeUndefined();
  });

  it("请求头不合法 → ProviderError", async () => {
    const { error } = await runError("openai-chat", {
      extraHeaders: { "Bad Name": "x" },
    });
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toContain("Bad Name");
  });
});

describe("请求体", () => {
  const user = [{ role: "user", content: PROMPT }];

  it("openai-chat：流式加 stream_options，null 字段不传", async () => {
    await run("openai-chat", { stream: true });
    expect(lastRequest(mock)).toMatchObject({
      method: "POST",
      path: "/v1/chat/completions",
    });
    expect(lastRequest(mock).body).toEqual({
      model: "mock-basic",
      messages: user,
      stream: true,
      stream_options: { include_usage: true },
    });
    await run("openai-chat", { maxTokens: 256, temperature: 0 });
    expect(lastRequest(mock).body).toEqual({
      model: "mock-basic",
      messages: user,
      stream: false,
      max_tokens: 256,
      temperature: 0,
    });
  });

  it("openai-responses：input 是提示词，max_output_tokens 可选", async () => {
    await run("openai-responses", { stream: true });
    expect(lastRequest(mock)).toMatchObject({ path: "/v1/responses" });
    expect(lastRequest(mock).body).toEqual({
      model: "mock-basic",
      input: PROMPT,
      stream: true,
    });
    await run("openai-responses", { maxTokens: 100, temperature: 1.5 });
    expect(lastRequest(mock).body).toEqual({
      model: "mock-basic",
      input: PROMPT,
      stream: false,
      max_output_tokens: 100,
      temperature: 1.5,
    });
  });

  it("anthropic：max_tokens 默认 8192", async () => {
    await run("anthropic");
    expect(lastRequest(mock)).toMatchObject({ path: "/v1/messages" });
    expect(lastRequest(mock).body).toEqual({
      model: "mock-basic",
      max_tokens: 8192,
      messages: user,
      stream: false,
    });
    await run("anthropic", { stream: true, maxTokens: 1024, temperature: 0.7 });
    expect(lastRequest(mock).body).toEqual({
      model: "mock-basic",
      max_tokens: 1024,
      messages: user,
      stream: true,
      temperature: 0.7,
    });
  });

  it("gemini：只在需要时加 generationConfig，流式走 alt=sse", async () => {
    await run("gemini", { stream: true });
    expect(lastRequest(mock).path).toBe(
      "/v1beta/models/mock-basic:streamGenerateContent?alt=sse",
    );
    expect(lastRequest(mock).body).toEqual({
      contents: [{ role: "user", parts: [{ text: PROMPT }] }],
    });
    await run("gemini", { maxTokens: 64 });
    expect(lastRequest(mock).path).toBe(
      "/v1beta/models/mock-basic:generateContent",
    );
    expect(lastRequest(mock).body).toEqual({
      contents: [{ role: "user", parts: [{ text: PROMPT }] }],
      generationConfig: { maxOutputTokens: 64 },
    });
    await run("gemini", { temperature: 0.2 });
    expect(lastRequest(mock).body).toEqual({
      contents: [{ role: "user", parts: [{ text: PROMPT }] }],
      generationConfig: { temperature: 0.2 },
    });
  });

  it("gemini：模型名写成 models/xxx 也行", async () => {
    const { result } = await run("gemini", { model: "models/mock-think" });
    expect(lastRequest(mock).path).toBe(
      "/v1beta/models/mock-think:generateContent",
    );
    expect(result.reasoning).not.toBe("");
  });
});

describe("listModels 翻页", () => {
  it("Anthropic 用 limit=1000 与 after_id 翻页", async () => {
    const before = mock.requests.length;
    const models = await listModels({
      endpointType: "anthropic",
      baseUrl: mock.url,
      apiKey: KEY,
      extraHeaders: {},
    });
    expect(models).toEqual([...MOCK_MODELS].sort());
    const paths = mock.requests.slice(before).map((request) => request.path);
    // 12 个模型、每页 5 个 → 3 页
    expect(paths).toEqual([
      "/v1/models?limit=1000",
      `/v1/models?limit=1000&after_id=${MOCK_MODELS[4]}`,
      `/v1/models?limit=1000&after_id=${MOCK_MODELS[9]}`,
    ]);
  });

  it("Gemini 用 pageSize=1000 与 pageToken 翻页，过滤掉不能生成内容的模型", async () => {
    const before = mock.requests.length;
    const models = await listModels({
      endpointType: "gemini",
      baseUrl: mock.url,
      apiKey: KEY,
      extraHeaders: {},
    });
    expect(models).toEqual([...MOCK_MODELS].sort());
    const paths = mock.requests.slice(before).map((request) => request.path);
    expect(paths).toEqual([
      "/v1beta/models?pageSize=1000",
      "/v1beta/models?pageSize=1000&pageToken=5",
      "/v1beta/models?pageSize=1000&pageToken=10",
    ]);
  });

  it("OpenAI 用 Bearer 拿到 OpenAI 形状的列表", async () => {
    await listModels({
      endpointType: "openai-chat",
      baseUrl: mock.url,
      apiKey: KEY,
      extraHeaders: {},
    });
    expect(lastRequest(mock)).toMatchObject({
      method: "GET",
      path: "/v1/models",
    });
    expect(lastRequest(mock).headers.authorization).toBe(`Bearer ${KEY}`);
  });

  it("调用方的 signal 中止时原样抛出中止错误", async () => {
    const controller = new AbortController();
    controller.abort();
    const promise = listModels({
      endpointType: "openai-chat",
      baseUrl: mock.url,
      apiKey: KEY,
      extraHeaders: {},
      signal: controller.signal,
    });
    await expect(promise).rejects.toMatchObject({ name: "AbortError" });
    await expect(promise).rejects.not.toBeInstanceOf(ProviderError);
  });
});

describe("模拟上游", () => {
  it("close() 会断开挂着的连接", async () => {
    const upstream = await startMockUpstream();
    const pending = runCompletion({
      ...makeRequest("openai-chat", {
        baseUrl: upstream.url,
        model: "mock-hang",
      }),
      signal: AbortSignal.timeout(5000),
    }).catch((error: unknown) => error);
    await new Promise((resolve) => setTimeout(resolve, 100));
    const started = Date.now();
    await upstream.close();
    expect(Date.now() - started).toBeLessThan(1000);
    const error = await pending;
    // 服务端主动断开，客户端看到的是网络错误
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).message).toMatch(/^网络错误：/);
  });

  it("slow 模型非流式 1.5 秒后才响应", async () => {
    const started = Date.now();
    const { result } = await run("openai-chat", { model: "mock-slow" });
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400);
    expect(result.output).toBe(
      mockReply("openai-chat", "mock-slow", PROMPT).output,
    );
  });
});
