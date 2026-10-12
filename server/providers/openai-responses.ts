/**
 * OpenAI Responses（POST /responses）。
 */
import { ProviderError } from "./types.ts";
import type { CompletionRequest, CompletionResult } from "./types.ts";
import {
  OutputBuilder,
  asArray,
  asNumber,
  asRecord,
  asString,
  errorMessageFrom,
  isRecord,
  unrecognized,
} from "./http.ts";
import type { JsonObject, ProviderAdapter, StreamHandler } from "./http.ts";
import { bearerAuth, listOpenAIModels } from "./openai-chat.ts";

function buildBody(request: CompletionRequest): JsonObject {
  const body: JsonObject = {
    model: request.model.trim(),
    input: request.prompt,
    stream: request.stream,
  };
  if (request.maxTokens !== null) body.max_output_tokens = request.maxTokens;
  if (request.temperature !== null) body.temperature = request.temperature;
  return body;
}

/** 把一个完整的 response 对象里的正文与思考过程写进 out */
function collectOutput(
  out: OutputBuilder,
  response: JsonObject,
  which: "output" | "reasoning" | "both",
): void {
  for (const item of asArray(response.output)) {
    if (!isRecord(item)) continue;
    if (item.type === "message" && which !== "reasoning") {
      for (const part of asArray(item.content)) {
        if (!isRecord(part)) continue;
        if (part.type === "output_text") out.addOutput(asString(part.text));
        else if (part.type === "refusal") out.addOutput(asString(part.refusal));
      }
    } else if (item.type === "reasoning" && which !== "output") {
      // OpenAI 只给摘要（summary），开源实现（如 gpt-oss）给原文（content 里的 reasoning_text）
      for (const part of [...asArray(item.summary), ...asArray(item.content)]) {
        if (!isRecord(part)) continue;
        out.breakReasoning();
        out.addReasoning(asString(part.text));
      }
    }
  }
}

function failureMessage(response: JsonObject | null): string {
  return errorMessageFrom(response) ?? "上游报告生成失败";
}

/** 用量与结束原因：incomplete 时取具体原因（如 max_output_tokens），否则就是 status 本身 */
function applyFinal(out: OutputBuilder, response: JsonObject): void {
  const usage = asRecord(response.usage);
  if (usage) {
    out.inputTokens = asNumber(usage.input_tokens) ?? out.inputTokens;
    out.outputTokens = asNumber(usage.output_tokens) ?? out.outputTokens;
  }
  const status = asString(response.status);
  if (status === "incomplete") {
    out.finishReason =
      asString(asRecord(response.incomplete_details)?.reason) ?? status;
  } else if (status) {
    out.finishReason = status;
  }
}

function parseResponse(json: unknown): CompletionResult {
  if (!isRecord(json) || !Array.isArray(json.output)) throw unrecognized(json);
  if (json.status === "failed") throw new ProviderError(failureMessage(json));
  const out = new OutputBuilder();
  collectOutput(out, json, "both");
  applyFinal(out, json);
  return out.result();
}

function createStreamHandler(out: OutputBuilder): StreamHandler {
  // 换了一段思考（另一个推理项或另一段摘要）时用空行隔开，和非流式的拼法一致
  let reasoningKey: string | null = null;

  return {
    onEvent(data, eventName) {
      const type = asString(data.type) ?? eventName;
      switch (type) {
        case "response.output_text.delta":
        case "response.refusal.delta":
          out.addOutput(asString(data.delta));
          return false;
        case "response.reasoning_summary_text.delta":
        case "response.reasoning_text.delta": {
          const key = `${type}:${String(data.item_id ?? "")}:${String(data.summary_index ?? data.content_index ?? 0)}`;
          if (reasoningKey !== null && key !== reasoningKey) {
            out.breakReasoning();
          }
          reasoningKey = key;
          out.addReasoning(asString(data.delta));
          return false;
        }
        case "response.completed":
        case "response.incomplete": {
          const response = asRecord(data.response);
          if (response) {
            // 有的中转不发增量，只在结束事件里给完整输出
            if (out.reasoning === "") collectOutput(out, response, "reasoning");
            if (out.output === "") collectOutput(out, response, "output");
            applyFinal(out, response);
          }
          return true;
        }
        case "response.failed":
          throw new ProviderError(failureMessage(asRecord(data.response)));
        case "error":
          throw new ProviderError(
            errorMessageFrom(data) ?? "上游在输出过程中返回了错误",
          );
        default:
          return false;
      }
    },
  };
}

export const openaiResponses: ProviderAdapter = {
  authHeaders: bearerAuth,
  buildBody,
  parseResponse,
  createStreamHandler,
  listModels: listOpenAIModels,
};
