/**
 * 模拟上游：一个本地 HTTP 服务，四种协议（OpenAI Chat / OpenAI Responses / Anthropic / Gemini）
 * 的流式与非流式接口、模型列表都有。给测试和手动联调用，不连外网。
 *
 * 行为由请求的模型名里包含的词决定（不分大小写），所以在后台填不同的模型名就能触发：
 *   hang         一直不响应，直到 close()（测超时）
 *   error        HTTP 500
 *   midfail      流式：发两段后发一个错误事件；非流式：HTTP 500
 *   slow         流式每段间隔 250 毫秒；非流式 1.5 秒后才响应
 *   rawhtml      文字中间夹一个没有代码围栏的完整 HTML 文档
 *   html         一句话 + ```html 围栏里的完整网页 + 一句话
 *   thinktag     正文以 <think>…</think> 开头
 *   think        协议原生的思考过程（reasoning_content / 推理摘要 / thinking 块 / thought 段）+ 正文
 *   nostream     请求流式也返回一次性的 JSON
 *   alwaysstream 请求非流式也返回 SSE
 *   其他          多行纯文本，引用提示词的前 40 个字
 *
 * 直接运行：node server/test/mock-upstream.ts [--port 4010] [--api-key KEY]
 */
import http from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Socket } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import type { EndpointType } from "../../shared/endpoints.ts";

export interface RecordedRequest {
  method: string;
  /** 路径，含查询参数 */
  path: string;
  /** 名字都是小写 */
  headers: Record<string, string>;
  /** 解析后的 JSON；没有请求体或不是 JSON 时为 null */
  body: unknown;
}

export interface MockUpstream {
  /** http://127.0.0.1:端口，可以直接当作任何一种端点类型的基础地址 */
  url: string;
  requests: RecordedRequest[];
  close(): Promise<void>;
}

export interface MockUpstreamOptions {
  /** 默认 0（随机端口） */
  port?: number;
  /** 设置后，密钥缺失或不对时返回 401 */
  apiKey?: string;
  /** 模型列表每页最多返回几个（测翻页用）；默认按请求里的 limit / pageSize */
  modelsPageSize?: number;
}

/** 模型列表接口返回的模型（故意不按字母序） */
export const MOCK_MODELS = [
  "mock-think",
  "mock-basic",
  "mock-html",
  "mock-rawhtml",
  "mock-thinktag",
  "mock-slow",
  "mock-slow-html",
  "mock-nostream",
  "mock-alwaysstream",
  "mock-midfail",
  "mock-error",
  "mock-hang",
] as const;

/** Gemini 的模型列表里额外有一个不支持 generateContent 的模型，用来测过滤 */
export const MOCK_GEMINI_EMBEDDING_MODEL = "mock-embedding";

const PROTOCOL_LABEL: Record<EndpointType, string> = {
  "openai-chat": "OpenAI Chat Completions",
  "openai-responses": "OpenAI Responses",
  anthropic: "Anthropic Messages",
  gemini: "Google Gemini",
};

const FINISH_REASON: Record<EndpointType, string> = {
  "openai-chat": "stop",
  "openai-responses": "completed",
  anthropic: "end_turn",
  gemini: "STOP",
};

/** 模拟的 token 数：每 4 个字符算 1 个，空串是 0 */
export function countMockTokens(text: string): number {
  const length = Array.from(text).length;
  return length === 0 ? 0 : Math.ceil(length / 4);
}

export interface MockReply {
  /** 完整的正文 */
  output: string;
  /** 协议原生的思考过程（只有 think 模型有，thinktag 的思考写在正文里） */
  reasoning: string;
}

const FENCE = "```";

const HTML_PAGE = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>模拟网页</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font-family: system-ui, sans-serif; background: linear-gradient(135deg, #1e293b, #0f766e); color: #f8fafc; }
  .card { padding: 24px 32px; border-radius: 12px; background: rgba(255, 255, 255, 0.12); text-align: center; }
  h1 { margin: 0 0 8px; font-size: 22px; }
</style>
</head>
<body>
<div class="card">
  <h1>模拟上游生成的网页</h1>
  <p id="now">正在读取时间…</p>
</div>
<script>
  document.getElementById("now").textContent = "当前时间：" + new Date().toLocaleString();
</script>
</body>
</html>`;

const RAW_HTML_PAGE = `<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><title>原始网页</title>
<style>body { font-family: sans-serif; padding: 16px; } .ok { color: #15803d; }</style>
</head>
<body><h2 class="ok">没有代码围栏的网页</h2><p>这段 HTML 直接夹在模型的文字中间。</p></body>
</html>`;

/** 某个模型对某条提示词的回答（测试里可以用它算期望值） */
export function mockReply(
  protocol: EndpointType,
  model: string,
  prompt: string,
): MockReply {
  const name = model.toLowerCase();
  const chars = Array.from(prompt.replace(/\s+/g, " ").trim());
  const head = chars.slice(0, 40).join("") + (chars.length > 40 ? "…" : "");
  const plain = [
    `这是模拟上游（${PROTOCOL_LABEL[protocol]}）返回的回答，模型：${model}。`,
    `你的提示词开头是：「${head}」`,
    "结论：一切正常，这是一段多行的纯文本输出。",
  ].join("\n");

  let output: string;
  if (name.includes("rawhtml")) {
    output = `下面直接给出网页源码：\n${RAW_HTML_PAGE}\n以上就是完整的页面，可以直接保存使用。`;
  } else if (name.includes("html")) {
    output = `好的，下面是一个完整的单文件网页：\n\n${FENCE}html\n${HTML_PAGE}\n${FENCE}\n\n把上面的代码保存成 .html 文件，用浏览器打开即可。`;
  } else {
    output = plain;
  }

  let reasoning = "";
  if (name.includes("thinktag")) {
    output = `<think>\n先读题，弄清楚要回答什么。\n再一步一步推理，检查有没有算错。\n</think>\n\n${output}`;
  } else if (name.includes("think")) {
    reasoning =
      "先读题，弄清楚要回答什么。\n再一步一步推理，检查有没有算错。\n确认无误后给出答案。";
  }
  return { output, reasoning };
}

/** 每段约 12 个字（按码点切，不会切坏 emoji） */
function chunkText(text: string, size = 12): string[] {
  const chars = Array.from(text);
  const chunks: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    chunks.push(chars.slice(i, i + size).join(""));
  }
  return chunks;
}

interface Behavior {
  hang: boolean;
  fail: boolean;
  midfail: boolean;
  slow: boolean;
  forceJson: boolean;
  forceSse: boolean;
}

function behaviorOf(model: string): Behavior {
  const name = model.toLowerCase();
  return {
    hang: name.includes("hang"),
    fail: name.includes("error"),
    midfail: name.includes("midfail"),
    slow: name.includes("slow"),
    forceJson: name.includes("nostream"),
    forceSse: name.includes("alwaysstream"),
  };
}

interface Usage {
  input: number;
  output: number;
  reasoning: number;
}

function usageOf(prompt: string, reply: MockReply): Usage {
  return {
    input: countMockTokens(prompt),
    output: countMockTokens(reply.output),
    reasoning: countMockTokens(reply.reasoning),
  };
}

/* ------------------------------------------------------------------ */
/* 各协议的响应                                                         */
/* ------------------------------------------------------------------ */

/** 一帧 SSE；delta 表示它带了一段输出（slow / midfail 按它计数） */
interface Frame {
  text: string;
  delta: boolean;
}

function sse(data: unknown, event?: string): string {
  return `${event ? `event: ${event}\n` : ""}data: ${JSON.stringify(data)}\n\n`;
}

function errorBody(
  protocol: EndpointType,
  status: number,
  message: string,
): unknown {
  if (protocol === "anthropic") {
    const type =
      status === 401
        ? "authentication_error"
        : status === 400
          ? "invalid_request_error"
          : "api_error";
    return { type: "error", error: { type, message } };
  }
  if (protocol === "gemini") {
    const statusText =
      status === 401
        ? "UNAUTHENTICATED"
        : status === 400
          ? "INVALID_ARGUMENT"
          : status === 404
            ? "NOT_FOUND"
            : "INTERNAL";
    return { error: { code: status, message, status: statusText } };
  }
  const type =
    status === 401
      ? "invalid_request_error"
      : status === 400
        ? "invalid_request_error"
        : "server_error";
  return {
    error: {
      message,
      type,
      param: null,
      code: status === 401 ? "invalid_api_key" : null,
    },
  };
}

function midfailFrame(protocol: EndpointType): string {
  const message = "mock stream failure";
  switch (protocol) {
    case "openai-chat":
      return sse({ error: { message, type: "server_error", code: null } });
    case "openai-responses":
      return sse(
        {
          type: "response.failed",
          response: {
            id: "resp_mock",
            object: "response",
            status: "failed",
            error: { code: "server_error", message },
            output: [],
          },
        },
        "response.failed",
      );
    case "anthropic":
      return sse(
        { type: "error", error: { type: "overloaded_error", message } },
        "error",
      );
    case "gemini":
      return sse({ error: { code: 500, message, status: "INTERNAL" } });
  }
}

/* ---- OpenAI Chat Completions ---- */

function chatJson(model: string, reply: MockReply, usage: Usage): unknown {
  const message: Record<string, unknown> = {
    role: "assistant",
    content: reply.output,
  };
  if (reply.reasoning) message.reasoning_content = reply.reasoning;
  return {
    id: "chatcmpl-mock",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      { index: 0, message, finish_reason: FINISH_REASON["openai-chat"] },
    ],
    usage: {
      prompt_tokens: usage.input,
      completion_tokens: usage.output + usage.reasoning,
      total_tokens: usage.input + usage.output + usage.reasoning,
    },
  };
}

function chatFrames(
  model: string,
  reply: MockReply,
  usage: Usage,
  includeUsage: boolean,
): Frame[] {
  const base = {
    id: "chatcmpl-mock",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
  };
  const chunk = (
    delta: Record<string, unknown>,
    finish: string | null = null,
  ) => sse({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
  const frames: Frame[] = [
    // 有的服务（如 OpenRouter）会先发注释行保活
    { text: ": mock keep-alive\n\n", delta: false },
    { text: chunk({ role: "assistant", content: "" }), delta: false },
  ];
  for (const piece of chunkText(reply.reasoning)) {
    frames.push({ text: chunk({ reasoning_content: piece }), delta: true });
  }
  for (const piece of chunkText(reply.output)) {
    frames.push({ text: chunk({ content: piece }), delta: true });
  }
  frames.push({ text: chunk({}, FINISH_REASON["openai-chat"]), delta: false });
  if (includeUsage) {
    frames.push({
      text: sse({
        ...base,
        choices: [],
        usage: {
          prompt_tokens: usage.input,
          completion_tokens: usage.output + usage.reasoning,
          total_tokens: usage.input + usage.output + usage.reasoning,
        },
      }),
      delta: false,
    });
  }
  frames.push({ text: "data: [DONE]\n\n", delta: false });
  return frames;
}

/* ---- OpenAI Responses ---- */

function responsesObject(
  model: string,
  reply: MockReply,
  usage: Usage,
  status: string,
): Record<string, unknown> {
  const output: unknown[] = [];
  if (status === "completed") {
    if (reply.reasoning) {
      output.push({
        id: "rs_mock",
        type: "reasoning",
        summary: [{ type: "summary_text", text: reply.reasoning }],
      });
    }
    output.push({
      id: "msg_mock",
      type: "message",
      role: "assistant",
      status: "completed",
      content: [{ type: "output_text", text: reply.output, annotations: [] }],
    });
  }
  return {
    id: "resp_mock",
    object: "response",
    created_at: Math.floor(Date.now() / 1000),
    status,
    model,
    output,
    usage:
      status === "completed"
        ? {
            input_tokens: usage.input,
            output_tokens: usage.output + usage.reasoning,
            output_tokens_details: { reasoning_tokens: usage.reasoning },
            total_tokens: usage.input + usage.output + usage.reasoning,
          }
        : null,
  };
}

function responsesFrames(
  model: string,
  reply: MockReply,
  usage: Usage,
): Frame[] {
  let sequence = 0;
  const frame = (
    type: string,
    data: Record<string, unknown>,
    delta = false,
  ): Frame => ({
    text: sse({ type, sequence_number: sequence++, ...data }, type),
    delta,
  });
  const frames: Frame[] = [
    frame("response.created", {
      response: responsesObject(model, reply, usage, "in_progress"),
    }),
    frame("response.in_progress", {
      response: responsesObject(model, reply, usage, "in_progress"),
    }),
  ];
  let index = 0;
  if (reply.reasoning) {
    const item = { id: "rs_mock", type: "reasoning", summary: [] };
    frames.push(
      frame("response.output_item.added", { output_index: index, item }),
    );
    frames.push(
      frame("response.reasoning_summary_part.added", {
        item_id: "rs_mock",
        output_index: index,
        summary_index: 0,
        part: { type: "summary_text", text: "" },
      }),
    );
    for (const piece of chunkText(reply.reasoning)) {
      frames.push(
        frame(
          "response.reasoning_summary_text.delta",
          {
            item_id: "rs_mock",
            output_index: index,
            summary_index: 0,
            delta: piece,
          },
          true,
        ),
      );
    }
    frames.push(
      frame("response.reasoning_summary_text.done", {
        item_id: "rs_mock",
        output_index: index,
        summary_index: 0,
        text: reply.reasoning,
      }),
    );
    frames.push(
      frame("response.output_item.done", {
        output_index: index,
        item: {
          ...item,
          summary: [{ type: "summary_text", text: reply.reasoning }],
        },
      }),
    );
    index++;
  }
  const message = {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    status: "in_progress",
    content: [],
  };
  frames.push(
    frame("response.output_item.added", { output_index: index, item: message }),
  );
  frames.push(
    frame("response.content_part.added", {
      item_id: "msg_mock",
      output_index: index,
      content_index: 0,
      part: { type: "output_text", text: "", annotations: [] },
    }),
  );
  for (const piece of chunkText(reply.output)) {
    frames.push(
      frame(
        "response.output_text.delta",
        {
          item_id: "msg_mock",
          output_index: index,
          content_index: 0,
          delta: piece,
        },
        true,
      ),
    );
  }
  frames.push(
    frame("response.output_text.done", {
      item_id: "msg_mock",
      output_index: index,
      content_index: 0,
      text: reply.output,
    }),
  );
  frames.push(
    frame("response.content_part.done", {
      item_id: "msg_mock",
      output_index: index,
      content_index: 0,
      part: { type: "output_text", text: reply.output, annotations: [] },
    }),
  );
  frames.push(
    frame("response.output_item.done", {
      output_index: index,
      item: {
        ...message,
        status: "completed",
        content: [{ type: "output_text", text: reply.output, annotations: [] }],
      },
    }),
  );
  frames.push(
    frame("response.completed", {
      response: responsesObject(model, reply, usage, "completed"),
    }),
  );
  return frames;
}

/* ---- Anthropic Messages ---- */

/** 输入 tokens 一半算作缓存命中，测"输入 = input + cache_*"的加法 */
function anthropicUsage(
  usage: Usage,
  outputTokens: number,
): Record<string, number> {
  const cached = Math.floor(usage.input / 2);
  return {
    input_tokens: usage.input - cached,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
    output_tokens: outputTokens,
  };
}

function anthropicJson(model: string, reply: MockReply, usage: Usage): unknown {
  const content: unknown[] = [];
  if (reply.reasoning)
    content.push({
      type: "thinking",
      thinking: reply.reasoning,
      signature: "mock-signature",
    });
  content.push({ type: "text", text: reply.output });
  return {
    id: "msg_mock",
    type: "message",
    role: "assistant",
    model,
    content,
    stop_reason: FINISH_REASON.anthropic,
    stop_sequence: null,
    usage: anthropicUsage(usage, usage.output + usage.reasoning),
  };
}

function anthropicFrames(
  model: string,
  reply: MockReply,
  usage: Usage,
): Frame[] {
  const frame = (
    type: string,
    data: Record<string, unknown>,
    delta = false,
  ): Frame => ({
    text: sse({ type, ...data }, type),
    delta,
  });
  const frames: Frame[] = [
    frame("message_start", {
      message: {
        id: "msg_mock",
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: anthropicUsage(usage, 1),
      },
    }),
    frame("ping", {}),
  ];
  let index = 0;
  if (reply.reasoning) {
    frames.push(
      frame("content_block_start", {
        index,
        content_block: { type: "thinking", thinking: "", signature: "" },
      }),
    );
    for (const piece of chunkText(reply.reasoning)) {
      frames.push(
        frame(
          "content_block_delta",
          { index, delta: { type: "thinking_delta", thinking: piece } },
          true,
        ),
      );
    }
    frames.push(
      frame("content_block_delta", {
        index,
        delta: { type: "signature_delta", signature: "mock-signature" },
      }),
    );
    frames.push(frame("content_block_stop", { index }));
    index++;
  }
  frames.push(
    frame("content_block_start", {
      index,
      content_block: { type: "text", text: "" },
    }),
  );
  for (const piece of chunkText(reply.output)) {
    frames.push(
      frame(
        "content_block_delta",
        { index, delta: { type: "text_delta", text: piece } },
        true,
      ),
    );
  }
  frames.push(frame("content_block_stop", { index }));
  frames.push(
    frame("message_delta", {
      delta: { stop_reason: FINISH_REASON.anthropic, stop_sequence: null },
      usage: { output_tokens: usage.output + usage.reasoning },
    }),
  );
  frames.push(frame("message_stop", {}));
  return frames;
}

/* ---- Gemini ---- */

function geminiUsage(usage: Usage): Record<string, number> {
  const result: Record<string, number> = {
    promptTokenCount: usage.input,
    candidatesTokenCount: usage.output,
    totalTokenCount: usage.input + usage.output + usage.reasoning,
  };
  if (usage.reasoning > 0) result.thoughtsTokenCount = usage.reasoning;
  return result;
}

function geminiJson(
  model: string,
  reply: MockReply,
  usage: Usage,
): Record<string, unknown> {
  const parts: unknown[] = [];
  if (reply.reasoning) parts.push({ text: reply.reasoning, thought: true });
  parts.push({ text: reply.output });
  return {
    candidates: [
      {
        content: { parts, role: "model" },
        finishReason: FINISH_REASON.gemini,
        index: 0,
      },
    ],
    usageMetadata: geminiUsage(usage),
    modelVersion: model,
  };
}

/** 每块一个响应对象；中间块只带 promptTokenCount，最后一块带结束原因和完整用量 */
function geminiChunks(
  model: string,
  reply: MockReply,
  usage: Usage,
): Record<string, unknown>[] {
  const pieces = [
    ...chunkText(reply.reasoning).map((text) => ({ text, thought: true })),
    ...chunkText(reply.output).map((text) => ({ text })),
  ];
  return pieces.map((part, i) => {
    const last = i === pieces.length - 1;
    const candidate: Record<string, unknown> = {
      content: { parts: [part], role: "model" },
      index: 0,
    };
    if (last) candidate.finishReason = FINISH_REASON.gemini;
    return {
      candidates: [candidate],
      usageMetadata: last
        ? geminiUsage(usage)
        : { promptTokenCount: usage.input, totalTokenCount: usage.input },
      modelVersion: model,
    };
  });
}

/* ------------------------------------------------------------------ */
/* 请求处理                                                             */
/* ------------------------------------------------------------------ */

function textOfContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) =>
      typeof part === "string"
        ? part
        : typeof part === "object" &&
            part !== null &&
            typeof (part as { text?: unknown }).text === "string"
          ? (part as { text: string }).text
          : "",
    )
    .join("");
}

/** 取最后一条 user 消息的文字 */
function lastUserText(
  messages: unknown,
  contentKey: "content" | "parts",
): string {
  if (!Array.isArray(messages)) return "";
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as Record<string, unknown> | null;
    if (typeof message !== "object" || message === null) continue;
    if (message.role !== undefined && message.role !== "user") continue;
    return textOfContent(message[contentKey]);
  }
  return "";
}

function promptOf(
  protocol: EndpointType,
  body: Record<string, unknown>,
): string {
  switch (protocol) {
    case "openai-chat":
    case "anthropic":
      return lastUserText(body.messages, "content");
    case "openai-responses":
      return typeof body.input === "string"
        ? body.input
        : lastUserText(body.input, "content");
    case "gemini":
      return lastUserText(body.contents, "parts");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.destroyed) return;
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

async function sendFrames(
  res: ServerResponse,
  protocol: EndpointType,
  frames: Frame[],
  behavior: Behavior,
  signal: AbortSignal,
): Promise<void> {
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache",
  });
  let deltas = 0;
  for (const frame of frames) {
    if (signal.aborted || res.destroyed) return;
    if (behavior.slow && frame.delta && deltas > 0) {
      try {
        await delay(250, undefined, { signal });
      } catch {
        return;
      }
    }
    res.write(frame.text);
    if (frame.delta) {
      deltas++;
      if (behavior.midfail && deltas === 2) {
        res.end(midfailFrame(protocol));
        return;
      }
    }
  }
  res.end();
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function flattenHeaders(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value)
      ? value.join(", ")
      : value;
  }
  return headers;
}

/** 一页模型列表：返回这一页和下一页从哪开始（null 表示没有了） */
function paginate<T>(
  items: readonly T[],
  start: number,
  requested: number,
  cap: number | undefined,
): { page: T[]; next: number | null } {
  const size = Math.max(1, Math.min(requested, cap ?? requested));
  const page = items.slice(start, start + size);
  const next = start + size < items.length ? start + size : null;
  return { page, next };
}

function intParam(value: string | null, fallback: number, max: number): number {
  const parsed = value === null ? Number.NaN : Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(parsed, max)
    : fallback;
}

export async function startMockUpstream(
  options: MockUpstreamOptions = {},
): Promise<MockUpstream> {
  const requests: RecordedRequest[] = [];
  const sockets = new Set<Socket>();
  const inflight = new Set<AbortController>();
  const apiKey = options.apiKey;

  async function handleCompletion(
    protocol: EndpointType,
    model: string,
    wantsStream: boolean,
    body: Record<string, unknown>,
    res: ServerResponse,
    signal: AbortSignal,
  ): Promise<void> {
    const behavior = behaviorOf(model);
    if (behavior.hang) return; // 不响应，连接一直挂着，直到客户端中止或 close()
    const stream = (wantsStream && !behavior.forceJson) || behavior.forceSse;
    if (behavior.fail || (behavior.midfail && !stream)) {
      sendJson(res, 500, errorBody(protocol, 500, "mock upstream failure"));
      return;
    }
    const prompt = promptOf(protocol, body);
    const reply = mockReply(protocol, model, prompt);
    const usage = usageOf(prompt, reply);

    if (!stream) {
      if (behavior.slow) {
        try {
          await delay(1500, undefined, { signal });
        } catch {
          return;
        }
      }
      const json =
        protocol === "openai-chat"
          ? chatJson(model, reply, usage)
          : protocol === "openai-responses"
            ? responsesObject(model, reply, usage, "completed")
            : protocol === "anthropic"
              ? anthropicJson(model, reply, usage)
              : geminiJson(model, reply, usage);
      sendJson(res, 200, json);
      return;
    }

    let frames: Frame[];
    if (protocol === "openai-chat") {
      const streamOptions = body.stream_options as
        | { include_usage?: unknown }
        | undefined;
      frames = chatFrames(
        model,
        reply,
        usage,
        streamOptions?.include_usage === true,
      );
    } else if (protocol === "openai-responses") {
      frames = responsesFrames(model, reply, usage);
    } else if (protocol === "anthropic") {
      frames = anthropicFrames(model, reply, usage);
    } else {
      frames = geminiChunks(model, reply, usage).map((chunk) => ({
        text: sse(chunk),
        delta: true,
      }));
    }
    await sendFrames(res, protocol, frames, behavior, signal);
  }

  function modelList(
    protocol: "openai" | "anthropic" | "gemini",
    url: URL,
    res: ServerResponse,
  ): void {
    if (protocol === "openai") {
      sendJson(res, 200, {
        object: "list",
        data: MOCK_MODELS.map((id) => ({
          id,
          object: "model",
          created: 1_700_000_000,
          owned_by: "mock",
        })),
      });
      return;
    }
    if (protocol === "anthropic") {
      const afterId = url.searchParams.get("after_id");
      const start = afterId
        ? MOCK_MODELS.indexOf(afterId as (typeof MOCK_MODELS)[number]) + 1
        : 0;
      const limit = intParam(url.searchParams.get("limit"), 20, 1000);
      const { page, next } = paginate(
        MOCK_MODELS,
        Math.max(0, start),
        limit,
        options.modelsPageSize,
      );
      sendJson(res, 200, {
        data: page.map((id) => ({
          id,
          type: "model",
          display_name: id,
          created_at: "2025-01-01T00:00:00Z",
        })),
        has_more: next !== null,
        first_id: page[0] ?? null,
        last_id: page.at(-1) ?? null,
      });
      return;
    }
    const all = [
      ...MOCK_MODELS.map((id) => ({
        name: `models/${id}`,
        displayName: id,
        supportedGenerationMethods: ["generateContent", "countTokens"],
      })),
      {
        name: `models/${MOCK_GEMINI_EMBEDDING_MODEL}`,
        displayName: "Embedding",
        supportedGenerationMethods: ["embedContent"],
      },
    ];
    const token = url.searchParams.get("pageToken");
    const start = token ? Number.parseInt(token, 10) || 0 : 0;
    const size = intParam(url.searchParams.get("pageSize"), 50, 1000);
    const { page, next } = paginate(all, start, size, options.modelsPageSize);
    sendJson(
      res,
      200,
      next === null
        ? { models: page }
        : { models: page, nextPageToken: String(next) },
    );
  }

  /** 密钥检查；不通过时已经写好 401 响应，返回 false */
  function authorized(
    protocol: EndpointType,
    headers: Record<string, string>,
    url: URL,
    res: ServerResponse,
  ): boolean {
    if (apiKey === undefined) return true;
    let ok: boolean;
    let message: string;
    if (protocol === "anthropic") {
      ok = headers["x-api-key"] === apiKey;
      message = "invalid x-api-key";
    } else if (protocol === "gemini") {
      ok =
        headers["x-goog-api-key"] === apiKey ||
        url.searchParams.get("key") === apiKey;
      message = "API key not valid. Please pass a valid API key.";
    } else {
      ok = headers.authorization === `Bearer ${apiKey}`;
      message = "Incorrect API key provided.";
    }
    if (!ok) sendJson(res, 401, errorBody(protocol, 401, message));
    return ok;
  }

  async function handle(
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const controller = new AbortController();
    inflight.add(controller);
    res.on("close", () => {
      controller.abort();
      inflight.delete(controller);
    });

    const rawPath = req.url ?? "/";
    const url = new URL(rawPath, "http://mock.local");
    const headers = flattenHeaders(req);
    const text = await readBody(req);
    let body: unknown = null;
    if (text.trim() !== "") {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    requests.push({
      method: req.method ?? "GET",
      path: rawPath,
      headers,
      body,
    });

    const path = url.pathname.replace(/\/+$/, "");
    const method = req.method ?? "GET";
    const json =
      typeof body === "object" && body !== null && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : null;

    if (method === "GET" && path === "/v1/models") {
      const anthropicStyle =
        headers["x-api-key"] !== undefined ||
        headers["anthropic-version"] !== undefined;
      if (
        !authorized(
          anthropicStyle ? "anthropic" : "openai-chat",
          headers,
          url,
          res,
        )
      )
        return;
      modelList(anthropicStyle ? "anthropic" : "openai", url, res);
      return;
    }
    if (method === "GET" && path === "/v1beta/models") {
      if (!authorized("gemini", headers, url, res)) return;
      modelList("gemini", url, res);
      return;
    }

    const route: {
      protocol: EndpointType;
      model: string;
      stream: boolean;
    } | null = (() => {
      if (method !== "POST") return null;
      if (path === "/v1/chat/completions")
        return {
          protocol: "openai-chat",
          model: String(json?.model ?? ""),
          stream: json?.stream === true,
        };
      if (path === "/v1/responses")
        return {
          protocol: "openai-responses",
          model: String(json?.model ?? ""),
          stream: json?.stream === true,
        };
      if (path === "/v1/messages")
        return {
          protocol: "anthropic",
          model: String(json?.model ?? ""),
          stream: json?.stream === true,
        };
      const gemini =
        /^\/v1beta\/models\/([^/:]+):(generateContent|streamGenerateContent)$/.exec(
          path,
        );
      if (gemini?.[1] && gemini[2]) {
        return {
          protocol: "gemini",
          model: decodeURIComponent(gemini[1]),
          stream: gemini[2] === "streamGenerateContent",
        };
      }
      return null;
    })();

    if (!route) {
      sendJson(res, 404, {
        error: {
          message: `mock upstream: no route for ${method} ${url.pathname}`,
        },
      });
      return;
    }
    if (!authorized(route.protocol, headers, url, res)) return;
    if (!json) {
      sendJson(
        res,
        400,
        errorBody(route.protocol, 400, "request body must be a JSON object"),
      );
      return;
    }
    if (route.protocol !== "gemini" && route.model.trim() === "") {
      sendJson(
        res,
        400,
        errorBody(route.protocol, 400, "model: Field required"),
      );
      return;
    }
    if (route.protocol === "anthropic" && typeof json.max_tokens !== "number") {
      sendJson(
        res,
        400,
        errorBody(route.protocol, 400, "max_tokens: Field required"),
      );
      return;
    }
    if (
      route.protocol === "gemini" &&
      route.stream &&
      url.searchParams.get("alt") !== "sse"
    ) {
      // 真实的 Gemini 不带 alt=sse 时返回响应块组成的 JSON 数组
      const behavior = behaviorOf(route.model);
      if (behavior.hang) return;
      if (behavior.fail) {
        sendJson(res, 500, errorBody("gemini", 500, "mock upstream failure"));
        return;
      }
      const prompt = promptOf("gemini", json);
      const reply = mockReply("gemini", route.model, prompt);
      sendJson(
        res,
        200,
        geminiChunks(route.model, reply, usageOf(prompt, reply)),
      );
      return;
    }
    await handleCompletion(
      route.protocol,
      route.model,
      route.stream,
      json,
      res,
      controller.signal,
    );
  }

  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (!res.headersSent)
        sendJson(res, 500, {
          error: { message: `mock upstream crashed: ${String(err)}` },
        });
      else res.destroy();
    });
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port ?? 0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("mock upstream: unexpected server address");
  }

  let closing: Promise<void> | null = null;
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close() {
      closing ??= new Promise<void>((resolve) => {
        for (const controller of inflight) controller.abort();
        server.close(() => resolve());
        // 挂着的连接（hang、keep-alive）不主动断开的话 close 永远等不到
        server.closeAllConnections();
        for (const socket of sockets) socket.destroy();
      });
      return closing;
    },
  };
}

/* ------------------------------------------------------------------ */
/* 直接运行                                                             */
/* ------------------------------------------------------------------ */

function argValue(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index !== -1) return args[index + 1];
  const inline = args.find((arg) => arg.startsWith(`${name}=`));
  return inline?.slice(name.length + 1);
}

async function runStandalone(): Promise<void> {
  const args = process.argv.slice(2);
  const port = Number.parseInt(argValue(args, "--port") ?? "4010", 10);
  const apiKey = argValue(args, "--api-key");
  const mock = await startMockUpstream({
    port: Number.isFinite(port) ? port : 4010,
    apiKey,
  });
  console.log(`模拟上游已启动：${mock.url}`);
  console.log(
    `  四种端点类型的基础地址都填 ${mock.url}${apiKey ? `，密钥填 ${apiKey}` : "（不校验密钥）"}`,
  );
  console.log(`  可用模型：${[...MOCK_MODELS].sort().join("、")}`);
  console.log(
    "  模型名里包含 hang / error / midfail / slow / rawhtml / html / thinktag / think / nostream / alwaysstream 时行为不同",
  );
  const stop = () => {
    void mock.close().then(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

const entry = process.argv[1];
if (entry !== undefined && import.meta.url === pathToFileURL(entry).href) {
  runStandalone().catch((err: unknown) => {
    console.error(err);
    process.exit(1);
  });
}
