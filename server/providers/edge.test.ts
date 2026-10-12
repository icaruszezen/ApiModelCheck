/**
 * 模拟上游覆盖不到的异常情况：用一次性的小服务器返回各种不规范的响应。
 */
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import type { EndpointType } from "../../shared/endpoints.ts";
import { ProviderError, listModels, runCompletion } from "./index.ts";
import type { CompletionDelta, CompletionRequest } from "./index.ts";

type Handler = (req: IncomingMessage, res: ServerResponse) => void;

const servers: http.Server[] = [];

async function serve(handler: Handler): Promise<string> {
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => handler(req, res));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("no address");
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

function request(
  baseUrl: string,
  type: EndpointType,
  overrides: Partial<CompletionRequest> = {},
): CompletionRequest {
  return {
    endpointType: type,
    baseUrl,
    apiKey: "",
    extraHeaders: {},
    model: "m",
    prompt: "p",
    stream: false,
    maxTokens: null,
    temperature: null,
    signal: AbortSignal.timeout(5000),
    ...overrides,
  };
}

function reply(
  status: number,
  body: string,
  contentType = "application/json",
): Handler {
  return (_req, res) => {
    res.writeHead(status, { "content-type": contentType });
    res.end(body);
  };
}

async function failure(promise: Promise<unknown>): Promise<ProviderError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(ProviderError);
    return error as ProviderError;
  }
  throw new Error("expected rejection");
}

const chatChunk = (
  delta: Record<string, unknown>,
  finish: string | null = null,
) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;

describe("HTTP 错误消息", () => {
  it.each([
    ['{"error":{"message":"Invalid model"}}', "HTTP 400：Invalid model"],
    ['{"error":"plain string error"}', "HTTP 400：plain string error"],
    ['{"message":"top level message"}', "HTTP 400：top level message"],
    ['{"detail":"FastAPI detail"}', "HTTP 400：FastAPI detail"],
    [
      '{"detail":[{"msg":"field a required"},{"msg":"field b invalid"}]}',
      "HTTP 400：field a required；field b invalid",
    ],
    [
      '[{"error":{"code":400,"message":"wrapped in array","status":"INVALID_ARGUMENT"}}]',
      "HTTP 400：wrapped in array",
    ],
    [
      '{"error":{"message":""},"message":"fallback to message"}',
      "HTTP 400：fallback to message",
    ],
    ["not json at all", "HTTP 400：not json at all"],
  ])("%s", async (body, expected) => {
    const url = await serve(reply(400, body));
    const error = await failure(runCompletion(request(url, "openai-chat")));
    expect(error.message).toBe(expected);
    expect(error.status).toBe(400);
  });

  it("空响应体时用状态文字", async () => {
    const url = await serve(reply(503, ""));
    const error = await failure(runCompletion(request(url, "anthropic")));
    expect(error.message).toBe("HTTP 503：Service Unavailable");
  });

  it("HTML 错误页只取标题", async () => {
    const page =
      "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>502</h1></body></html>";
    const url = await serve(reply(502, page, "text/html"));
    const error = await failure(runCompletion(request(url, "gemini")));
    expect(error.message).toBe("HTTP 502：502 Bad Gateway");
  });

  it("很长的非 JSON 文本截到 500 字；超过 64KB 的响应体也能正常报错", async () => {
    const url = await serve(reply(500, "x".repeat(200_000), "text/plain"));
    const error = await failure(
      runCompletion(request(url, "openai-responses")),
    );
    expect(error.message).toBe(`HTTP 500：${"x".repeat(500)}`);
  });
});

describe("不规范的成功响应", () => {
  it("非流式返回的不是 JSON", async () => {
    const url = await serve(reply(200, "<html>oops</html>", "text/html"));
    const error = await failure(runCompletion(request(url, "openai-chat")));
    expect(error.message).toBe("上游返回的不是 JSON：<html>oops</html>");
  });

  it("空响应体", async () => {
    const url = await serve(reply(200, ""));
    const error = await failure(runCompletion(request(url, "anthropic")));
    expect(error.message).toBe("上游返回的不是 JSON：（空）");
  });

  it("200 但响应体是错误对象", async () => {
    const url = await serve(
      reply(
        200,
        '{"error":{"message":"quota exceeded","type":"insufficient_quota"}}',
      ),
    );
    const error = await failure(runCompletion(request(url, "openai-chat")));
    expect(error.message).toBe("quota exceeded");
  });

  it("认不出的 JSON 结构", async () => {
    const url = await serve(reply(200, '{"foo":1}'));
    const error = await failure(
      runCompletion(request(url, "openai-responses")),
    );
    expect(error.message).toBe('上游返回的响应格式无法识别：{"foo":1}');
  });

  it("SSE 被标成 text/plain：仍按 SSE 解析并报出增量", async () => {
    const body =
      chatChunk({ content: "你好" }) +
      chatChunk({ content: "，世界" }, "stop") +
      "data: [DONE]\n\n";
    const url = await serve(reply(200, body, "text/plain"));
    const deltas: CompletionDelta[] = [];
    const result = await runCompletion(
      request(url, "openai-chat", {
        stream: true,
        onDelta: (delta) => deltas.push(delta),
      }),
    );
    expect(result.output).toBe("你好，世界");
    expect(result.finishReason).toBe("stop");
    expect(deltas).toEqual([{ output: "你好" }, { output: "，世界" }]);
  });

  it("SSE 被标成 text/plain 且分段慢慢到：增量实时报出，中止前收到的部分留得住", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      // 开头只有空白和半个字段名，要多读几段才能认出是 SSE
      res.write("\n");
      setTimeout(() => res.write("da"), 30);
      setTimeout(
        () => res.write(`ta: ${chatChunk({ content: "第一段" }).slice(6)}`),
        60,
      );
      setTimeout(() => res.write(chatChunk({ content: "第二段" })), 120);
      // 之后不再发送也不结束，直到客户端中止
    });
    const controller = new AbortController();
    const deltas: CompletionDelta[] = [];
    const error = await runCompletion(
      request(url, "openai-chat", {
        stream: true,
        signal: controller.signal,
        onDelta: (delta) => {
          deltas.push(delta);
          if (deltas.length === 2) setTimeout(() => controller.abort(), 50);
        },
      }),
    ).catch((err: unknown) => err);
    expect(error).toMatchObject({ name: "AbortError" });
    expect(deltas).toEqual([{ output: "第一段" }, { output: "第二段" }]);
  });

  it("流式请求收到没标类型的 JSON：照常按一次性响应解析", async () => {
    const url = await serve(
      reply(
        200,
        '{"choices":[{"message":{"content":"整段"},"finish_reason":"stop"}]}',
        "text/plain",
      ),
    );
    const deltas: CompletionDelta[] = [];
    const result = await runCompletion(
      request(url, "openai-chat", {
        stream: true,
        onDelta: (delta) => deltas.push(delta),
      }),
    );
    expect(result.output).toBe("整段");
    expect(deltas).toEqual([{ output: "整段" }]);
  });

  it("碰巧有 data: 行的网页不会被当成 SSE", async () => {
    const url = await serve(
      reply(200, "<p>\ndata: not an event\n</p>", "text/html"),
    );
    const error = await failure(
      runCompletion(request(url, "openai-chat", { stream: true })),
    );
    expect(error.message).toMatch(/^上游返回的不是 JSON：/);
  });

  it("流在没有结束事件的情况下正常关闭：返回已收到的内容", async () => {
    const url = await serve(
      reply(
        200,
        chatChunk({ content: "半截" }) + ": comment\n\ndata: keep-alive\n\n",
        "text/event-stream",
      ),
    );
    const result = await runCompletion(
      request(url, "openai-chat", { stream: true }),
    );
    expect(result).toEqual({
      output: "半截",
      reasoning: "",
      inputTokens: null,
      outputTokens: null,
      finishReason: null,
    });
  });

  it.each(["text/event-stream", "text/plain"])(
    "流里只有心跳就正常关闭（%s）→ 报错，不记成成功",
    async (contentType) => {
      const url = await serve(
        reply(200, ": keep-alive\n\n: keep-alive\n\n", contentType),
      );
      const error = await failure(
        runCompletion(request(url, "anthropic", { stream: true })),
      );
      expect(error.message).toBe("上游的流没有返回任何内容就结束了");
    },
  );

  it("只有思考过程、没有正文和结束原因的流照样算成功", async () => {
    const url = await serve(
      reply(
        200,
        chatChunk({ reasoning_content: "想了想" }),
        "text/event-stream",
      ),
    );
    const result = await runCompletion(
      request(url, "openai-chat", { stream: true }),
    );
    expect(result.reasoning).toBe("想了想");
    expect(result.output).toBe("");
  });

  it("收到 [DONE] 后不再读后面的内容", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chatChunk({ content: "a" }, "stop") + "data: [DONE]\n\n");
      // 不结束响应：客户端应在 [DONE] 后自己停下
    });
    const result = await runCompletion(
      request(url, "openai-chat", { stream: true }),
    );
    expect(result.output).toBe("a");
  });

  it("流读到一半连接被掐断 → 网络错误", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chatChunk({ content: "部分输出" }));
      setTimeout(() => res.socket?.destroy(), 50);
    });
    const deltas: CompletionDelta[] = [];
    const error = await failure(
      runCompletion(
        request(url, "openai-chat", {
          stream: true,
          onDelta: (delta) => deltas.push(delta),
        }),
      ),
    );
    expect(error.message).toMatch(/^网络错误：接收输出时连接中断/);
    expect(deltas).toEqual([{ output: "部分输出" }]);
  });

  it("已经收到结束原因后连接才断：视为成功", async () => {
    const url = await serve((_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write(chatChunk({ content: "完整" }, "stop"));
      setTimeout(() => res.socket?.destroy(), 50);
    });
    const result = await runCompletion(
      request(url, "openai-chat", { stream: true }),
    );
    expect(result.output).toBe("完整");
    expect(result.finishReason).toBe("stop");
  });

  it("onDelta 回调抛出的错误原样传出去", async () => {
    const url = await serve(
      reply(200, chatChunk({ content: "x" }), "text/event-stream"),
    );
    const boom = new Error("callback failed");
    await expect(
      runCompletion(
        request(url, "openai-chat", {
          stream: true,
          onDelta: () => {
            throw boom;
          },
        }),
      ),
    ).rejects.toBe(boom);
  });

  it("基础地址里的路径和查询参数会保留", async () => {
    let seen = "";
    const url = await serve((req, res) => {
      seen = req.url ?? "";
      reply(
        200,
        '{"choices":[{"message":{"content":"ok"},"finish_reason":"stop"}]}',
      )(req, res);
    });
    const result = await runCompletion(
      request(`${url}/openai/v1?api-version=2024-10-21`, "openai-chat"),
    );
    expect(result.output).toBe("ok");
    expect(seen).toBe("/openai/v1/chat/completions?api-version=2024-10-21");
  });

  it("基础地址无效", async () => {
    const error = await failure(
      runCompletion(request("not a url", "openai-chat")),
    );
    expect(error.message).toContain("基础地址无效");
  });
});

describe("重定向", () => {
  /** 一个把所有请求 301 到 target 的服务器 */
  async function redirecting(target: string): Promise<string> {
    return serve((req, res) => {
      res.writeHead(301, { location: `${target}${req.url ?? "/"}` });
      res.end();
    });
  }

  it("生成请求不跟随重定向，报出新地址，新地址收不到请求", async () => {
    let hits = 0;
    const target = await serve((req, res) => {
      hits++;
      reply(200, "{}")(req, res);
    });
    const url = await redirecting(target);
    const error = await failure(
      runCompletion(
        request(`${url}/v1?api-version=1`, "anthropic", {
          apiKey: "sk-secret-redirect",
        }),
      ),
    );
    expect(error.message).toBe(
      `上游返回了重定向（301 → ${target}/v1/messages），请把基础地址改成重定向后的地址`,
    );
    expect(error.message).not.toContain("sk-secret-redirect");
    expect(error.status).toBe(301);
    expect(hits).toBe(0);
  });

  it("拉取模型列表也一样；相对地址按请求地址补全", async () => {
    let hits = 0;
    const url = await serve((req, res) => {
      if (req.url?.startsWith("/moved")) hits++;
      res.writeHead(302, { location: "/moved/v1beta/models" });
      res.end();
    });
    const error = await failure(
      listModels({
        endpointType: "gemini",
        baseUrl: url,
        apiKey: "k",
        extraHeaders: {},
      }),
    );
    expect(error.message).toBe(
      `上游返回了重定向（302 → ${url}/moved/v1beta/models），请把基础地址改成重定向后的地址`,
    );
    expect(hits).toBe(0);
  });

  /** 记下每个请求的方法、路径、认证头和请求体，再交给 handler 回应 */
  interface Seen {
    method: string;
    url: string;
    auth: string | undefined;
    body: string;
  }
  async function recording(
    handler: (seen: Seen, res: ServerResponse) => void,
  ): Promise<{ url: string; seen: Seen[] }> {
    const seen: Seen[] = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (chunk: Buffer) => chunks.push(chunk));
      req.on("end", () => {
        const entry = {
          method: req.method ?? "",
          url: req.url ?? "",
          auth: req.headers.authorization,
          body: Buffer.concat(chunks).toString("utf8"),
        };
        seen.push(entry);
        handler(entry, res);
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (address === null || typeof address === "string")
      throw new Error("no address");
    return { url: `http://127.0.0.1:${address.port}`, seen };
  }

  function sendJson(res: ServerResponse, body: unknown): void {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  }

  it.each([307, 308])(
    "同源的 %i（补结尾斜杠）用同样的方法、请求头和请求体重发",
    async (status) => {
      const { url, seen } = await recording((entry, res) => {
        if (!entry.url.endsWith("/")) {
          res.writeHead(status, { location: `${entry.url}/` });
          res.end();
          return;
        }
        sendJson(res, {
          choices: [{ message: { content: "ok" }, finish_reason: "stop" }],
        });
      });
      const result = await runCompletion(
        request(`${url}/v1`, "openai-chat", { apiKey: "sk-same-origin" }),
      );
      expect(result.output).toBe("ok");
      expect(seen.map((entry) => `${entry.method} ${entry.url}`)).toEqual([
        "POST /v1/chat/completions",
        "POST /v1/chat/completions/",
      ]);
      expect(seen[1]?.auth).toBe("Bearer sk-same-origin");
      expect(seen[1]?.body).toBe(seen[0]?.body);
      expect(JSON.parse(seen[1]?.body ?? "")).toMatchObject({
        model: "m",
        messages: [{ role: "user", content: "p" }],
      });
    },
  );

  it("拉取模型列表遇到同源 307 也跟过去", async () => {
    const { url, seen } = await recording((entry, res) => {
      if (entry.url === "/v1/models") {
        res.writeHead(307, { location: "/v1/models/" });
        res.end();
        return;
      }
      sendJson(res, { data: [{ id: "m1" }] });
    });
    const models = await listModels({
      endpointType: "openai-chat",
      baseUrl: `${url}/v1`,
      apiKey: "k",
      extraHeaders: {},
    });
    expect(models).toEqual(["m1"]);
    expect(seen.map((entry) => entry.url)).toEqual([
      "/v1/models",
      "/v1/models/",
    ]);
  });

  it("跨域的 307 照样报错，目标收不到请求", async () => {
    const target = await recording((_entry, res) => sendJson(res, {}));
    const source = await recording((entry, res) => {
      res.writeHead(307, { location: `${target.url}${entry.url}` });
      res.end();
    });
    const error = await failure(
      runCompletion(
        request(`${source.url}/v1`, "openai-chat", { apiKey: "sk-cross" }),
      ),
    );
    expect(error.message).toBe(
      `上游返回了重定向（307 → ${target.url}/v1/chat/completions），请把基础地址改成重定向后的地址`,
    );
    expect(error.status).toBe(307);
    expect(source.seen).toHaveLength(1);
    expect(target.seen).toHaveLength(0);
  });

  it("同源重定向转圈时最多跟 3 次就报错", async () => {
    // /a/chat/completions → /a → /b → /a → …
    const { url, seen } = await recording((entry, res) => {
      res.writeHead(308, { location: entry.url === "/a" ? "/b" : "/a" });
      res.end();
    });
    const error = await failure(
      runCompletion(request(`${url}/a`, "openai-chat")),
    );
    expect(error.message).toMatch(/^上游连续重定向超过 3 次（最后一次 308 → /);
    expect(error.status).toBe(308);
    // 第一次请求加上跟随的 3 次
    expect(seen).toHaveLength(4);
  });
});

describe("listModels 的异常情况", () => {
  it("返回的不是 JSON", async () => {
    const url = await serve(reply(200, "hello", "text/plain"));
    const error = await failure(
      listModels({
        endpointType: "openai-chat",
        baseUrl: url,
        apiKey: "",
        extraHeaders: {},
      }),
    );
    expect(error.message).toBe("上游返回的不是 JSON：hello");
  });

  it("认不出的结构", async () => {
    const url = await serve(reply(200, '{"items":[]}'));
    const error = await failure(
      listModels({
        endpointType: "anthropic",
        baseUrl: url,
        apiKey: "",
        extraHeaders: {},
      }),
    );
    expect(error.message).toBe('上游返回的模型列表格式无法识别：{"items":[]}');
  });

  it("OpenAI 兼容服务直接返回数组、带重复项时去重排序", async () => {
    const url = await serve(
      reply(
        200,
        '[{"id":"b-10"},{"id":"b-9"},{"id":"a"},{"id":"a"},{"id":""}]',
      ),
    );
    const models = await listModels({
      endpointType: "openai-chat",
      baseUrl: url,
      apiKey: "",
      extraHeaders: {},
    });
    expect(models).toEqual(["a", "b-9", "b-10"]);
  });

  it("Gemini 没有模型时返回 {}", async () => {
    const url = await serve(reply(200, "{}"));
    expect(
      await listModels({
        endpointType: "gemini",
        baseUrl: url,
        apiKey: "",
        extraHeaders: {},
      }),
    ).toEqual([]);
  });

  it("翻页标记一直不变时不会死循环", async () => {
    let calls = 0;
    const url = await serve((req, res) => {
      calls++;
      reply(
        200,
        JSON.stringify({
          data: [{ id: "same" }],
          has_more: true,
          last_id: "same",
        }),
      )(req, res);
    });
    const models = await listModels({
      endpointType: "anthropic",
      baseUrl: url,
      apiKey: "",
      extraHeaders: {},
    });
    expect(models).toEqual(["same"]);
    expect(calls).toBe(2);
  });

  it("翻页最多 10 页", async () => {
    let calls = 0;
    const url = await serve((req, res) => {
      calls++;
      reply(
        200,
        JSON.stringify({
          models: [{ name: `models/m-${calls}` }],
          nextPageToken: `t${calls}`,
        }),
      )(req, res);
    });
    const models = await listModels({
      endpointType: "gemini",
      baseUrl: url,
      apiKey: "",
      extraHeaders: {},
    });
    expect(calls).toBe(10);
    expect(models).toHaveLength(10);
  });
});
