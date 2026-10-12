/**
 * 模拟上游本身：直接看线上格式（不经过 providers），以及直接运行的模式。
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MOCK_MODELS, startMockUpstream } from "./mock-upstream.ts";
import type { MockUpstream } from "./mock-upstream.ts";

let mock: MockUpstream;

beforeAll(async () => {
  mock = await startMockUpstream({ apiKey: "secret" });
});

afterAll(async () => {
  await mock.close();
});

async function post(
  path: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<Response> {
  return fetch(`${mock.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

describe("线上格式", () => {
  it("Anthropic 流式带 event: 行，以 message_delta + message_stop 结束", async () => {
    const res = await post(
      "/v1/messages",
      { "x-api-key": "secret", "anthropic-version": "2023-06-01" },
      {
        model: "mock-basic",
        max_tokens: 10,
        stream: true,
        messages: [{ role: "user", content: "hi" }],
      },
    );
    expect(res.headers.get("content-type")).toMatch(/^text\/event-stream/);
    const text = await res.text();
    expect(text).toMatch(/^event: message_start\ndata: /);
    expect(text).toContain("event: ping\n");
    expect(text.trimEnd()).toMatch(
      /event: message_delta\ndata: .*\n\nevent: message_stop\ndata: \{"type":"message_stop"\}$/,
    );
  });

  it("Responses 流式带 event: 行，以 response.completed 结束", async () => {
    const res = await post(
      "/v1/responses",
      { authorization: "Bearer secret" },
      { model: "mock-think", input: "hi", stream: true },
    );
    const text = await res.text();
    expect(text).toContain("event: response.reasoning_summary_text.delta\n");
    expect(text).toContain("event: response.output_text.delta\n");
    expect(text.trimEnd().split("\n\n").at(-1)).toMatch(
      /^event: response\.completed\ndata: /,
    );
  });

  it("Chat 流式只在 include_usage 时发用量块，以 [DONE] 结束", async () => {
    const body = {
      model: "mock-basic",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    };
    const without = await (
      await post(
        "/v1/chat/completions",
        { authorization: "Bearer secret" },
        body,
      )
    ).text();
    expect(without).not.toContain('"usage"');
    expect(without.trimEnd().endsWith("data: [DONE]")).toBe(true);
    const withUsage = await (
      await post(
        "/v1/chat/completions",
        { authorization: "Bearer secret" },
        { ...body, stream_options: { include_usage: true } },
      )
    ).text();
    expect(withUsage).toContain('"choices":[],"usage"');
  });

  it("Gemini 流式不带 alt=sse 时返回 JSON 数组", async () => {
    const res = await post(
      "/v1beta/models/mock-basic:streamGenerateContent",
      { "x-goog-api-key": "secret" },
      { contents: [{ role: "user", parts: [{ text: "hi" }] }] },
    );
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    const json = (await res.json()) as unknown[];
    expect(Array.isArray(json)).toBe(true);
    expect(json.length).toBeGreaterThan(1);
  });

  it("Gemini 也接受 ?key= 形式的密钥", async () => {
    const res = await post(
      "/v1beta/models/mock-basic:generateContent?key=secret",
      {},
      { contents: [{ parts: [{ text: "hi" }] }] },
    );
    expect(res.status).toBe(200);
  });

  it("各协议的 401 都是对应家的错误形状", async () => {
    const anthropicRes = await post(
      "/v1/messages",
      { "x-api-key": "bad" },
      { model: "m", max_tokens: 1, messages: [] },
    );
    expect(anthropicRes.status).toBe(401);
    expect(await anthropicRes.json()).toMatchObject({
      type: "error",
      error: { type: "authentication_error" },
    });
    const geminiRes = await post(
      "/v1beta/models/m:generateContent",
      {},
      { contents: [] },
    );
    expect(await geminiRes.json()).toMatchObject({
      error: { code: 401, status: "UNAUTHENTICATED" },
    });
    const openaiRes = await post(
      "/v1/chat/completions",
      {},
      { model: "m", messages: [] },
    );
    expect(await openaiRes.json()).toMatchObject({
      error: { code: "invalid_api_key" },
    });
  });

  it("/v1/models 按请求头决定返回 OpenAI 还是 Anthropic 的形状", async () => {
    const openai = await (
      await fetch(`${mock.url}/v1/models`, {
        headers: { authorization: "Bearer secret" },
      })
    ).json();
    expect(openai).toMatchObject({
      object: "list",
      data: expect.arrayContaining([
        expect.objectContaining({ object: "model" }),
      ]),
    });
    const anthropic = (await (
      await fetch(`${mock.url}/v1/models?limit=3`, {
        headers: { "x-api-key": "secret", "anthropic-version": "2023-06-01" },
      })
    ).json()) as {
      data: { id: string; type: string }[];
      has_more: boolean;
      first_id: string;
      last_id: string;
    };
    expect(anthropic.data.map((item) => item.id)).toEqual(
      MOCK_MODELS.slice(0, 3),
    );
    expect(anthropic).toMatchObject({
      has_more: true,
      first_id: MOCK_MODELS[0],
      last_id: MOCK_MODELS[2],
    });
  });

  it("Anthropic 缺 max_tokens 时 400", async () => {
    const res = await post(
      "/v1/messages",
      { "x-api-key": "secret" },
      { model: "m", messages: [{ role: "user", content: "x" }] },
    );
    expect(res.status).toBe(400);
  });

  it("未知路径 404，并记录所有请求", async () => {
    const before = mock.requests.length;
    const res = await fetch(`${mock.url}/nope?x=1`, {
      headers: { "X-Custom": "Value" },
    });
    expect(res.status).toBe(404);
    expect(mock.requests.slice(before)).toEqual([
      expect.objectContaining({
        method: "GET",
        path: "/nope?x=1",
        body: null,
        headers: expect.objectContaining({ "x-custom": "Value" }),
      }),
    ]);
  });
});

describe("直接运行", () => {
  it("打印地址，能响应请求，收到 SIGTERM 后退出", async () => {
    const script = fileURLToPath(
      new URL("./mock-upstream.ts", import.meta.url),
    );
    const child = spawn(
      process.execPath,
      [
        "--disable-warning=ExperimentalWarning",
        script,
        "--port",
        "0",
        "--api-key",
        "abc",
      ],
      {
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    try {
      const url = await new Promise<string>((resolve, reject) => {
        let output = "";
        const timer = setTimeout(
          () => reject(new Error(`no startup line: ${output}`)),
          5000,
        );
        child.stdout.on("data", (chunk: Buffer) => {
          output += chunk.toString();
          const match = /http:\/\/127\.0\.0\.1:\d+/.exec(output);
          if (match) {
            clearTimeout(timer);
            resolve(match[0]);
          }
        });
        child.stderr.on("data", (chunk: Buffer) => {
          output += chunk.toString();
        });
        child.on("exit", (code) =>
          reject(new Error(`exited early (${String(code)}): ${output}`)),
        );
      });
      const res = await fetch(`${url}/v1/models`, {
        headers: { authorization: "Bearer abc" },
      });
      expect(res.status).toBe(200);
      const exited = new Promise<number | null>((resolve) =>
        child.on("exit", (code) => resolve(code)),
      );
      child.kill("SIGTERM");
      expect(await exited).toBe(0);
    } finally {
      if (child.exitCode === null) child.kill("SIGKILL");
    }
  });
});
