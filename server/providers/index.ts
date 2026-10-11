/**
 * 对外只有两个函数：runCompletion 发一次生成请求，listModels 列出上游模型。
 * 按 endpointType 分派到各家的实现。
 */
import { buildModelsUrl, buildRequestUrl } from "../../shared/endpoints.ts";
import type { EndpointType } from "../../shared/endpoints.ts";
import { anthropic } from "./anthropic.ts";
import { gemini } from "./gemini.ts";
import {
  OutputBuilder,
  buildHeaders,
  describeNetworkError,
  isRecord,
  notJsonError,
  parseJsonText,
  readBodyText,
  rethrowIfAborted,
  sendRequest,
} from "./http.ts";
import type { ProviderAdapter } from "./http.ts";
import { openaiChat } from "./openai-chat.ts";
import { openaiResponses } from "./openai-responses.ts";
import { readSseStream } from "./sse.ts";
import type { SseEvent } from "./sse.ts";
import { ProviderError } from "./types.ts";
import type {
  CompletionDelta,
  CompletionRequest,
  CompletionResult,
  ListModelsRequest,
} from "./types.ts";

export * from "./types.ts";

const ADAPTERS: Record<EndpointType, ProviderAdapter> = {
  "openai-chat": openaiChat,
  "openai-responses": openaiResponses,
  anthropic,
  gemini,
};

/** 调用方没给 signal 时，拉取模型列表的超时 */
const LIST_MODELS_TIMEOUT_MS = 20_000;

function adapterFor(type: EndpointType): ProviderAdapter {
  const adapter = ADAPTERS[type];
  if (!adapter) throw new ProviderError(`不支持的端点类型：${String(type)}`);
  return adapter;
}

function resolveUrl(build: () => string): string {
  try {
    return build();
  } catch {
    throw new ProviderError("基础地址无效，无法拼出请求地址");
  }
}

function isEventStream(response: Response): boolean {
  return /\btext\/event-stream\b/i.test(
    response.headers.get("content-type") ?? "",
  );
}

/**
 * 有的中转把 SSE 标成 text/plain 之类的类型：解析 JSON 失败时看一眼是不是 SSE。
 * 要求至少有一行 data 是 JSON 对象或 [DONE]，免得把碰巧有 "data:" 行的网页当成空输出。
 */
function looksLikeSse(text: string): boolean {
  return /^data: ?(\{|\[DONE\])/m.test(text);
}

/** 处理一个 SSE 事件；返回 true 表示流已经明确结束 */
function dispatchEvent(
  handler: ReturnType<ProviderAdapter["createStreamHandler"]>,
  event: SseEvent,
): boolean {
  const data = event.data.trim();
  if (data === "[DONE]") return true;
  let json: unknown;
  try {
    json = JSON.parse(data);
  } catch {
    // 心跳之类的非 JSON 数据，跳过
    return false;
  }
  return isRecord(json) ? handler.onEvent(json, event.event) : false;
}

async function readStream(
  body: AsyncIterable<Uint8Array> | Iterable<Uint8Array> | null,
  adapter: ProviderAdapter,
  onDelta: ((delta: CompletionDelta) => void) | undefined,
  signal: AbortSignal,
): Promise<CompletionResult> {
  const out = new OutputBuilder(onDelta);
  const handler = adapter.createStreamHandler(out);
  if (body) {
    const events = readSseStream(body);
    try {
      for (;;) {
        let next: IteratorResult<SseEvent, void>;
        try {
          next = await events.next();
        } catch (err) {
          rethrowIfAborted(signal, err);
          // 已经收到结束原因的话，连接断在收尾阶段不影响结果
          if (out.finishReason !== null) break;
          throw new ProviderError(
            `网络错误：接收输出时连接中断，${describeNetworkError(err)}`,
          );
        }
        // 流在没有明确结束事件的情况下断开：返回已经收到的内容
        if (next.done) break;
        if (dispatchEvent(handler, next.value)) break;
      }
    } finally {
      // 提前结束（收到结束事件、上游报错、回调抛错）时取消响应体，释放连接
      events.return(undefined).catch(() => {});
    }
  }
  handler.finish?.();
  return out.result();
}

async function readNonStream(
  response: Response,
  adapter: ProviderAdapter,
  onDelta: ((delta: CompletionDelta) => void) | undefined,
  signal: AbortSignal,
): Promise<CompletionResult> {
  const text = await readBodyText(response, signal);
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    if (looksLikeSse(text)) {
      return readStream(
        [new TextEncoder().encode(text)],
        adapter,
        onDelta,
        signal,
      );
    }
    throw notJsonError(text);
  }
  const result = adapter.parseResponse(json);
  // 请求的是流式、上游却一次性返回：把完整输出当作一段增量报出去
  if (onDelta && (result.output || result.reasoning)) {
    const delta: CompletionDelta = {};
    if (result.reasoning) delta.reasoning = result.reasoning;
    if (result.output) delta.output = result.output;
    onDelta(delta);
  }
  return result;
}

export async function runCompletion(
  request: CompletionRequest,
): Promise<CompletionResult> {
  const { signal } = request;
  try {
    signal.throwIfAborted();
    const adapter = adapterFor(request.endpointType);
    const url = resolveUrl(() =>
      buildRequestUrl(
        request.endpointType,
        request.baseUrl,
        request.model,
        request.stream,
      ),
    );
    const headers = buildHeaders(
      adapter.authHeaders(request.apiKey),
      request.extraHeaders,
      true,
    );
    const response = await sendRequest(url, {
      method: "POST",
      headers,
      body: JSON.stringify(adapter.buildBody(request)),
      signal,
    });
    // 非流式请求不回调 onDelta（即使上游硬是返回了 SSE）
    const onDelta = request.stream ? request.onDelta : undefined;
    if (isEventStream(response)) {
      return await readStream(response.body, adapter, onDelta, signal);
    }
    return await readNonStream(response, adapter, onDelta, signal);
  } catch (err) {
    rethrowIfAborted(signal, err);
    throw err;
  }
}

export async function listModels(
  request: ListModelsRequest,
): Promise<string[]> {
  const ownTimeout = request.signal
    ? null
    : AbortSignal.timeout(LIST_MODELS_TIMEOUT_MS);
  const signal = request.signal ?? (ownTimeout as AbortSignal);
  try {
    signal.throwIfAborted();
    const adapter = adapterFor(request.endpointType);
    const url = resolveUrl(() =>
      buildModelsUrl(request.endpointType, request.baseUrl),
    );
    const headers = buildHeaders(
      adapter.authHeaders(request.apiKey),
      request.extraHeaders,
      false,
    );
    const getJson = async (pageUrl: string): Promise<unknown> => {
      const response = await sendRequest(pageUrl, {
        method: "GET",
        headers,
        signal,
      });
      return parseJsonText(await readBodyText(response, signal));
    };
    const ids = await adapter.listModels({ url, getJson });
    const unique = [
      ...new Set(ids.map((id) => id.trim()).filter((id) => id !== "")),
    ];
    return unique.sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  } catch (err) {
    // 自己加的超时调用方没法判断，转成一句话；调用方自己的 signal 中止时原样抛出
    if (ownTimeout?.aborted) {
      throw new ProviderError(
        `拉取模型列表超时：${LIST_MODELS_TIMEOUT_MS / 1000} 秒内没有完成`,
      );
    }
    rethrowIfAborted(signal, err);
    throw err;
  }
}
