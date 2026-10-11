/**
 * Anthropic Messages（POST /v1/messages）。
 */
import {
  ANTHROPIC_VERSION,
  DEFAULT_ANTHROPIC_MAX_TOKENS,
  ProviderError,
} from "./types.ts";
import type { CompletionRequest, CompletionResult } from "./types.ts";
import {
  MAX_MODEL_PAGES,
  OutputBuilder,
  asArray,
  asNumber,
  asRecord,
  asString,
  errorMessageFrom,
  isRecord,
  unrecognized,
  withQuery,
} from "./http.ts";
import type {
  JsonObject,
  ModelsContext,
  ProviderAdapter,
  StreamHandler,
} from "./http.ts";

function authHeaders(apiKey: string): Record<string, string> {
  const key = apiKey.trim();
  return {
    ...(key ? { "x-api-key": key } : {}),
    "anthropic-version": ANTHROPIC_VERSION,
  };
}

function buildBody(request: CompletionRequest): JsonObject {
  const body: JsonObject = {
    model: request.model.trim(),
    max_tokens: request.maxTokens ?? DEFAULT_ANTHROPIC_MAX_TOKENS,
    messages: [{ role: "user", content: request.prompt }],
    stream: request.stream,
  };
  if (request.temperature !== null) body.temperature = request.temperature;
  return body;
}

/**
 * 用量跟踪：输入 tokens 要把缓存写入、缓存命中的部分也算上。流式时 message_start 与 message_delta
 * 都可能带用量（累计值），各字段以最后一次出现的为准，没出现的字段沿用之前的值。
 */
function usageTracker(out: OutputBuilder): (usage: unknown) => void {
  let input: number | null = null;
  let cacheCreation = 0;
  let cacheRead = 0;
  return (usage) => {
    const record = asRecord(usage);
    if (!record) return;
    input = asNumber(record.input_tokens) ?? input;
    cacheCreation =
      asNumber(record.cache_creation_input_tokens) ?? cacheCreation;
    cacheRead = asNumber(record.cache_read_input_tokens) ?? cacheRead;
    if (input !== null) out.inputTokens = input + cacheCreation + cacheRead;
    out.outputTokens = asNumber(record.output_tokens) ?? out.outputTokens;
  };
}

function addBlock(out: OutputBuilder, block: JsonObject): void {
  if (block.type === "text") {
    out.addOutput(asString(block.text));
  } else if (block.type === "thinking") {
    out.breakReasoning();
    out.addReasoning(asString(block.thinking));
  }
  // redacted_thinking、tool_use 等与检测无关，忽略
}

function parseResponse(json: unknown): CompletionResult {
  if (
    !isRecord(json) ||
    json.type === "error" ||
    !Array.isArray(json.content)
  ) {
    throw unrecognized(json);
  }
  const out = new OutputBuilder();
  for (const block of json.content) {
    if (isRecord(block)) addBlock(out, block);
  }
  usageTracker(out)(json.usage);
  out.finishReason = asString(json.stop_reason);
  return out.result();
}

function createStreamHandler(out: OutputBuilder): StreamHandler {
  const applyUsage = usageTracker(out);
  return {
    onEvent(data, eventName) {
      const type = asString(data.type) ?? eventName;
      switch (type) {
        case "message_start":
          applyUsage(asRecord(data.message)?.usage);
          return false;
        case "content_block_start": {
          // 块开始时通常是空的，但个别实现会把开头的文字直接放在这里
          const block = asRecord(data.content_block);
          if (block) addBlock(out, block);
          return false;
        }
        case "content_block_delta": {
          const delta = asRecord(data.delta);
          if (delta?.type === "text_delta") out.addOutput(asString(delta.text));
          else if (delta?.type === "thinking_delta")
            out.addReasoning(asString(delta.thinking));
          return false;
        }
        case "message_delta": {
          const stop = asString(asRecord(data.delta)?.stop_reason);
          if (stop) out.finishReason = stop;
          applyUsage(data.usage);
          return false;
        }
        case "message_stop":
          return true;
        case "error":
          throw new ProviderError(
            errorMessageFrom(data) ?? "上游在输出过程中返回了错误",
          );
        default:
          // ping、content_block_stop 等
          return false;
      }
    },
  };
}

/** GET /v1/models?limit=1000，has_more 时用 after_id 往后翻 */
async function listModels({ url, getJson }: ModelsContext): Promise<string[]> {
  const ids: string[] = [];
  let afterId: string | null = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page++) {
    const pageUrl = withQuery(
      url,
      afterId ? { limit: "1000", after_id: afterId } : { limit: "1000" },
    );
    const json = await getJson(pageUrl);
    if (!isRecord(json) || !Array.isArray(json.data)) {
      throw unrecognized(json, "模型列表");
    }
    const pageIds = asArray(json.data)
      .map((item) => (isRecord(item) ? asString(item.id) : null))
      .filter((id): id is string => !!id);
    ids.push(...pageIds);
    const next = asString(json.last_id) ?? pageIds.at(-1) ?? null;
    if (json.has_more !== true || !next || next === afterId) break;
    afterId = next;
  }
  return ids;
}

export const anthropic: ProviderAdapter = {
  authHeaders,
  buildBody,
  parseResponse,
  createStreamHandler,
  listModels,
};
