/**
 * OpenAI Chat Completions（以及绝大多数"OpenAI 兼容"的中转和推理服务）。
 */
import { ENDPOINT_META } from "../../shared/endpoints.ts";
import { ProviderError } from "./types.ts";
import type { CompletionRequest, CompletionResult } from "./types.ts";
import {
  OutputBuilder,
  asArray,
  asNumber,
  asRecord,
  asString,
  errorMessageFrom,
  firstRecord,
  isRecord,
  unrecognized,
} from "./http.ts";
import type {
  JsonObject,
  ModelsContext,
  ProviderAdapter,
  StreamHandler,
} from "./http.ts";

export function bearerAuth(apiKey: string): Record<string, string> {
  const key = apiKey.trim();
  return key ? { authorization: `Bearer ${key}` } : {};
}

/** GET /models → data[].id（OpenAI 两种端点共用）；个别兼容服务直接返回数组 */
export async function listOpenAIModels({
  url,
  getJson,
}: ModelsContext): Promise<string[]> {
  const json = await getJson(url);
  const items = Array.isArray(json)
    ? json
    : isRecord(json)
      ? json.data
      : undefined;
  if (!Array.isArray(items)) throw unrecognized(json, "模型列表");
  return items
    .map((item) => (isRecord(item) ? asString(item.id) : asString(item)))
    .filter((id): id is string => !!id);
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  return asArray(value)
    .map((item) =>
      typeof item === "string"
        ? item
        : isRecord(item)
          ? (asString(item.text) ?? "")
          : "",
    )
    .join("");
}

/**
 * message.content / delta.content 可能是字符串，也可能是 [{type:"text", text}] 分段数组；
 * 个别兼容服务（如 Mistral 的推理模型）还会在数组里放 {type:"thinking"} 段。
 */
function readContent(content: unknown): { text: string; thinking: string } {
  if (typeof content === "string") return { text: content, thinking: "" };
  let text = "";
  let thinking = "";
  for (const part of asArray(content)) {
    if (typeof part === "string") {
      text += part;
    } else if (isRecord(part)) {
      if (part.type === "thinking" || part.type === "reasoning") {
        thinking += textOf(part.thinking ?? part.reasoning ?? part.text);
      } else if (typeof part.text === "string") {
        text += part.text;
      }
    }
  }
  return { text, thinking };
}

/** 思考过程：DeepSeek 等用 reasoning_content，OpenRouter 等用 reasoning */
function reasoningOf(message: JsonObject): string {
  return (
    asString(message.reasoning_content) || asString(message.reasoning) || ""
  );
}

function applyUsage(out: OutputBuilder, usage: unknown): void {
  const record = asRecord(usage);
  if (!record) return;
  out.inputTokens = asNumber(record.prompt_tokens) ?? out.inputTokens;
  out.outputTokens = asNumber(record.completion_tokens) ?? out.outputTokens;
}

function hasError(json: JsonObject): boolean {
  return (
    isRecord(json.error) ||
    (typeof json.error === "string" && json.error !== "")
  );
}

/** OpenAI 的 o 系列、GPT-5 系列（可带 "openai/" 这类厂商前缀） */
const REASONING_MODEL = /^(o\d|gpt-5)/i;

/**
 * 最大输出 tokens 用哪个字段：OpenAI 的推理模型只认 max_completion_tokens，传 max_tokens 会 400；
 * OpenAI 官方地址上所有模型都认 max_completion_tokens。其余兼容服务大多只认 max_tokens。
 */
function maxTokensField(request: CompletionRequest): string {
  const model = request.model.trim().replace(/^[^/]*\//, "");
  if (REASONING_MODEL.test(model)) return "max_completion_tokens";
  let host = "";
  try {
    host = new URL(
      request.baseUrl.trim() || ENDPOINT_META["openai-chat"].defaultBaseUrl,
    ).hostname;
  } catch {
    // 地址无效时发请求前就会报错，这里随便用哪个都行
  }
  return host === "api.openai.com" ? "max_completion_tokens" : "max_tokens";
}

function buildBody(request: CompletionRequest): JsonObject {
  const body: JsonObject = {
    model: request.model.trim(),
    messages: [{ role: "user", content: request.prompt }],
    stream: request.stream,
  };
  if (request.stream) body.stream_options = { include_usage: true };
  if (request.maxTokens !== null) {
    body[maxTokensField(request)] = request.maxTokens;
  }
  if (request.temperature !== null) body.temperature = request.temperature;
  return body;
}

function parseResponse(json: unknown): CompletionResult {
  if (!isRecord(json) || !Array.isArray(json.choices)) throw unrecognized(json);
  const out = new OutputBuilder();
  const choice = firstRecord(json.choices);
  const message = asRecord(choice?.message) ?? {};
  const content = readContent(message.content);
  out.addReasoning(reasoningOf(message) || content.thinking);
  out.addOutput(content.text || asString(message.refusal));
  out.finishReason = asString(choice?.finish_reason);
  applyUsage(out, json.usage);
  return out.result();
}

function createStreamHandler(out: OutputBuilder): StreamHandler {
  return {
    onEvent(data) {
      if (hasError(data)) {
        throw new ProviderError(
          errorMessageFrom(data) ?? "上游在输出过程中返回了错误",
        );
      }
      // 开了 include_usage 时最后有一个 choices 为空、只带 usage 的块；有的服务每块都带 usage
      applyUsage(out, data.usage);
      const choice = firstRecord(data.choices);
      if (!choice) return false;
      const delta = asRecord(choice.delta) ?? asRecord(choice.message);
      if (delta) {
        const content = readContent(delta.content);
        out.addReasoning(reasoningOf(delta));
        out.addReasoning(content.thinking);
        out.addOutput(content.text);
        out.addOutput(asString(delta.refusal));
      }
      const finish = asString(choice.finish_reason);
      if (finish) out.finishReason = finish;
      return false;
    },
  };
}

export const openaiChat: ProviderAdapter = {
  authHeaders: bearerAuth,
  buildBody,
  parseResponse,
  createStreamHandler,
  listModels: listOpenAIModels,
};
