/**
 * Google Gemini（generateContent / streamGenerateContent?alt=sse）。
 */
import { ProviderError } from "./types.ts";
import type { CompletionRequest, CompletionResult } from "./types.ts";
import {
  MAX_MODEL_PAGES,
  OutputBuilder,
  asArray,
  asNumber,
  asRecord,
  asString,
  errorMessageFrom,
  firstRecord,
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
  return key ? { "x-goog-api-key": key } : {};
}

function buildBody(request: CompletionRequest): JsonObject {
  const body: JsonObject = {
    contents: [{ role: "user", parts: [{ text: request.prompt }] }],
  };
  const config: JsonObject = {};
  if (request.maxTokens !== null) config.maxOutputTokens = request.maxTokens;
  if (request.temperature !== null) config.temperature = request.temperature;
  if (Object.keys(config).length > 0) body.generationConfig = config;
  return body;
}

/**
 * 处理一个响应块（非流式就是整个响应）。正文 / 思考按块累加；
 * 用量取最后一个带 usageMetadata 的块，结束原因取最后一个带它的候选。
 */
function applyChunk(out: OutputBuilder, chunk: JsonObject): void {
  if (isRecord(chunk.error)) {
    throw new ProviderError(
      errorMessageFrom(chunk) ?? "上游在输出过程中返回了错误",
    );
  }
  const candidate = firstRecord(chunk.candidates);
  if (!candidate) {
    const blockReason = asString(asRecord(chunk.promptFeedback)?.blockReason);
    if (blockReason) throw new ProviderError(`请求被拦截：${blockReason}`);
  } else {
    for (const part of asArray(asRecord(candidate.content)?.parts)) {
      if (!isRecord(part)) continue;
      if (part.thought === true) out.addReasoning(asString(part.text));
      else out.addOutput(asString(part.text));
    }
    const finish = asString(candidate.finishReason);
    if (finish) out.finishReason = finish;
  }
  const usage = asRecord(chunk.usageMetadata);
  if (usage) {
    out.inputTokens = asNumber(usage.promptTokenCount) ?? out.inputTokens;
    const candidates = asNumber(usage.candidatesTokenCount);
    const thoughts = asNumber(usage.thoughtsTokenCount);
    if (candidates !== null || thoughts !== null) {
      out.outputTokens = (candidates ?? 0) + (thoughts ?? 0);
    }
  }
}

function parseResponse(json: unknown): CompletionResult {
  const out = new OutputBuilder();
  // 不带 alt=sse 的流式接口返回的是响应块数组，也一并认
  const chunks = Array.isArray(json) ? json : [json];
  if (chunks.length === 0 || !chunks.every(isRecord)) throw unrecognized(json);
  for (const chunk of chunks) {
    if (!isRecord(chunk)) continue;
    if (
      !("candidates" in chunk) &&
      !("promptFeedback" in chunk) &&
      !("usageMetadata" in chunk)
    ) {
      throw unrecognized(chunk);
    }
    applyChunk(out, chunk);
  }
  return out.result();
}

function createStreamHandler(out: OutputBuilder): StreamHandler {
  return {
    onEvent(data) {
      applyChunk(out, data);
      // Gemini 没有单独的结束事件，读到流结束为止
      return false;
    },
  };
}

/** GET /v1beta/models?pageSize=1000，有 nextPageToken 时继续；只要支持 generateContent 的 */
async function listModels({ url, getJson }: ModelsContext): Promise<string[]> {
  const ids: string[] = [];
  let pageToken: string | null = null;
  for (let page = 0; page < MAX_MODEL_PAGES; page++) {
    const pageUrl = withQuery(
      url,
      pageToken ? { pageSize: "1000", pageToken } : { pageSize: "1000" },
    );
    const json = await getJson(pageUrl);
    if (
      !isRecord(json) ||
      (json.models !== undefined && !Array.isArray(json.models))
    ) {
      throw unrecognized(json, "模型列表");
    }
    // 一个模型都没有时 Gemini 返回 {}，没有 models 字段
    for (const item of asArray(json.models)) {
      if (!isRecord(item)) continue;
      const name = asString(item.name);
      if (!name) continue;
      const methods = item.supportedGenerationMethods;
      if (Array.isArray(methods) && !methods.includes("generateContent")) {
        continue;
      }
      ids.push(name.replace(/^models\//, ""));
    }
    const next = asString(json.nextPageToken);
    if (!next || next === pageToken) break;
    pageToken = next;
  }
  return ids;
}

export const gemini: ProviderAdapter = {
  authHeaders,
  buildBody,
  parseResponse,
  createStreamHandler,
  listModels,
};
