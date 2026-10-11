/**
 * 各家协议共用的部分：请求头、发请求与错误归一、JSON 取值小工具、输出累积器、协议适配器接口。
 */
import { ProviderError } from "./types.ts";
import type {
  CompletionDelta,
  CompletionRequest,
  CompletionResult,
} from "./types.ts";

/* ------------------------------------------------------------------ */
/* JSON 取值                                                            */
/* ------------------------------------------------------------------ */

export type JsonObject = Record<string, unknown>;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asRecord(value: unknown): JsonObject | null {
  return isRecord(value) ? value : null;
}

/** 数组的第一个元素（是对象时） */
export function firstRecord(value: unknown): JsonObject | null {
  return Array.isArray(value) ? asRecord(value[0]) : null;
}

/** 把任意值压成一行给人看的预览，最多 max 个字符 */
export function preview(value: unknown, max = 200): string {
  let text: string;
  if (typeof value === "string") text = value;
  else {
    try {
      text = JSON.stringify(value) ?? String(value);
    } catch {
      text = String(value);
    }
  }
  text = text.trim();
  if (text === "") return "（空）";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

/**
 * 从上游的错误 JSON 里找给人看的消息：依次看 error.message、error（字符串）、message、detail。
 * 兼容 Gemini 偶尔把错误包在数组里、FastAPI 风格的 detail 数组。
 */
export function errorMessageFrom(json: unknown): string | null {
  const root = Array.isArray(json) ? json[0] : json;
  if (!isRecord(root)) return null;
  const { error } = root;
  if (isRecord(error)) {
    const message = nonEmpty(error.message);
    if (message) return message;
  }
  const errorText = nonEmpty(error);
  if (errorText) return errorText;
  const message = nonEmpty(root.message);
  if (message) return message;
  const detail = nonEmpty(root.detail);
  if (detail) return detail;
  if (Array.isArray(root.detail)) {
    const parts = root.detail
      .map((item) => (isRecord(item) ? nonEmpty(item.msg) : nonEmpty(item)))
      .filter((item): item is string => item !== null);
    if (parts.length > 0) return parts.join("；");
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 输出累积                                                             */
/* ------------------------------------------------------------------ */

/** 累积正文 / 思考过程 / 用量；流式时每段新增的文字同时通过 onDelta 报出去 */
export class OutputBuilder {
  output = "";
  reasoning = "";
  inputTokens: number | null = null;
  outputTokens: number | null = null;
  finishReason: string | null = null;
  readonly #onDelta: ((delta: CompletionDelta) => void) | undefined;
  #reasoningBreak = false;

  constructor(onDelta?: (delta: CompletionDelta) => void) {
    this.#onDelta = onDelta;
  }

  addOutput(text: string | null | undefined): void {
    if (!text) return;
    this.output += text;
    this.#onDelta?.({ output: text });
  }

  addReasoning(text: string | null | undefined): void {
    if (!text) return;
    if (this.#reasoningBreak && this.reasoning !== "") text = `\n\n${text}`;
    this.#reasoningBreak = false;
    this.reasoning += text;
    this.#onDelta?.({ reasoning: text });
  }

  /**
   * 下一段思考过程属于新的一块（Anthropic 的新 thinking 块、Responses 的新摘要段），
   * 和前面的用空行隔开。流式、非流式走同一个规则，两种方式拼出来的结果一致。
   */
  breakReasoning(): void {
    this.#reasoningBreak = true;
  }

  result(): CompletionResult {
    return {
      output: this.output,
      reasoning: this.reasoning,
      inputTokens: this.inputTokens,
      outputTokens: this.outputTokens,
      finishReason: this.finishReason,
    };
  }
}

/* ------------------------------------------------------------------ */
/* 协议适配器                                                           */
/* ------------------------------------------------------------------ */

export interface StreamHandler {
  /**
   * 处理一个 SSE 事件（data 已按 JSON 解析成对象，eventName 是 `event:` 字段，可能为空）。
   * 返回 true 表示上游明确表示输出结束了；上游报错时抛 ProviderError。
   */
  onEvent(data: JsonObject, eventName: string): boolean;
  /** 流读完后的收尾（比如 Responses 只在结束事件里给了完整输出） */
  finish?(): void;
}

export interface ModelsContext {
  /** buildModelsUrl 推出的地址 */
  url: string;
  /** 带认证头 GET 一个地址，返回解析后的 JSON；出错时抛 ProviderError */
  getJson(url: string): Promise<unknown>;
}

export interface ProviderAdapter {
  /** 认证相关的请求头 */
  authHeaders(apiKey: string): Record<string, string>;
  buildBody(request: CompletionRequest): JsonObject;
  /** 解析非流式响应；格式认不出或上游报错时抛 ProviderError */
  parseResponse(json: unknown): CompletionResult;
  createStreamHandler(out: OutputBuilder): StreamHandler;
  /** 列出模型 ID（可能有重复、未排序，由调用方整理） */
  listModels(context: ModelsContext): Promise<string[]>;
}

/** 同一个地址加 / 改查询参数（保留基础地址里原有的参数，如 api-version） */
export function withQuery(url: string, params: Record<string, string>): string {
  const parsed = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    parsed.searchParams.set(key, value);
  }
  return parsed.href;
}

/** 列表接口最多翻几页，防止上游的翻页标记出错时死循环 */
export const MAX_MODEL_PAGES = 10;

/* ------------------------------------------------------------------ */
/* 发请求                                                               */
/* ------------------------------------------------------------------ */

/**
 * 依次写入默认头、认证头、额外请求头。用 Headers 合并，名字不分大小写，
 * 额外请求头里的 "Authorization" 能覆盖默认的 "authorization"。
 */
export function buildHeaders(
  auth: Record<string, string>,
  extraHeaders: Record<string, string>,
  jsonBody: boolean,
): Headers {
  const headers = new Headers();
  const entries: [string, string][] = [];
  if (jsonBody) entries.push(["content-type", "application/json"]);
  entries.push(...Object.entries(auth), ...Object.entries(extraHeaders ?? {}));
  for (const [name, value] of entries) {
    try {
      headers.set(name, value);
    } catch {
      throw new ProviderError(
        `请求头 ${name} 不合法（名字或值里有不允许的字符）`,
      );
    }
  }
  return headers;
}

/** 常见网络错误码的中文说明 */
const NETWORK_ERROR_HINTS: Record<string, string> = {
  ECONNREFUSED: "连接被拒绝",
  ECONNRESET: "连接被重置",
  ENOTFOUND: "域名解析失败",
  EAI_AGAIN: "域名解析暂时失败",
  ETIMEDOUT: "连接超时",
  EHOSTUNREACH: "主机不可达",
  ENETUNREACH: "网络不可达",
  EPIPE: "连接已断开",
  UND_ERR_CONNECT_TIMEOUT: "连接超时",
  UND_ERR_SOCKET: "连接意外断开",
  UND_ERR_HEADERS_TIMEOUT: "等待响应头超时",
  UND_ERR_BODY_TIMEOUT: "等待响应数据超时",
  CERT_HAS_EXPIRED: "证书已过期",
  DEPTH_ZERO_SELF_SIGNED_CERT: "自签名证书不受信任",
  SELF_SIGNED_CERT_IN_CHAIN: "证书链中有不受信任的自签名证书",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "无法验证证书",
  ERR_TLS_CERT_ALTNAME_INVALID: "证书与域名不匹配",
};

function errorCode(value: unknown): string | null {
  if (!isRecord(value) && !(value instanceof Error)) return null;
  const code = (value as { code?: unknown }).code;
  return typeof code === "string" && code !== "" ? code : null;
}

/** fetch 抛出的网络错误 → 一句简短的说明（优先用 cause.code） */
export function describeNetworkError(err: unknown): string {
  const cause = err instanceof Error ? err.cause : undefined;
  let code = errorCode(cause) ?? errorCode(err);
  // 一个域名解析出多个地址都连不上时，cause 是 AggregateError
  if (!code && cause instanceof AggregateError) {
    code = errorCode(cause.errors[0]);
  }
  if (code) {
    const hint = NETWORK_ERROR_HINTS[code];
    return hint ? `${code}（${hint}）` : code;
  }
  if (cause instanceof Error && cause.message) return cause.message;
  if (err instanceof Error && err.message) return err.message;
  return String(err);
}

export function networkError(err: unknown): ProviderError {
  return new ProviderError(`网络错误：${describeNetworkError(err)}`);
}

function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.name === "TimeoutError")
  );
}

/**
 * 已经中止时，原样抛出中止错误（调用方靠 signal.aborted 判断超时，不能包成 ProviderError）。
 * 中止的同时碰巧发生了别的错误，也以中止为准。
 */
export function rethrowIfAborted(
  signal: AbortSignal | undefined,
  err: unknown,
): void {
  if (!signal?.aborted) return;
  if (err === signal.reason || isAbortError(err)) throw err;
  throw signal.reason;
}

/**
 * Node 自带的 fetch（undici）默认 300 秒收不到响应头、或两段数据间隔 300 秒就断开，
 * 而模型超时最长能配 3600 秒（非流式的长推理要等很久才有响应头）。超时统一交给调用方的
 * AbortSignal，所以换一个关掉这两个计时器的 dispatcher。undici 没有作为公开模块暴露，
 * 只能拿全局 dispatcher 的类来造（设了 NODE_USE_ENV_PROXY 时它是 EnvHttpProxyAgent，代理设置照样生效）；
 * 拿不到就退回默认行为。
 */
const GLOBAL_DISPATCHER = Symbol.for("undici.globalDispatcher.1");
let dispatcherCache: { base: unknown; dispatcher: unknown } | null = null;

function longLivedDispatcher(): unknown {
  const base = (globalThis as Record<symbol, unknown>)[GLOBAL_DISPATCHER];
  if (dispatcherCache && dispatcherCache.base === base) {
    return dispatcherCache.dispatcher;
  }
  let dispatcher: unknown;
  try {
    const ctor =
      typeof base === "object" && base !== null ? base.constructor : undefined;
    if (ctor && (ctor.name === "Agent" || ctor.name === "EnvHttpProxyAgent")) {
      const Dispatcher = ctor as new (options: object) => unknown;
      dispatcher = new Dispatcher({ headersTimeout: 0, bodyTimeout: 0 });
    }
  } catch {
    dispatcher = undefined;
  }
  dispatcherCache = { base, dispatcher };
  return dispatcher;
}

/** 错误响应体最多读这么多 */
const ERROR_BODY_LIMIT = 64 * 1024;

async function readLimitedText(
  response: Response,
  limit: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (size < limit) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      size += value.byteLength;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, limit));
}

/** HTML 错误页（网关 502 之类）只取标题或纯文字，免得一屏标签 */
function htmlToText(text: string): string {
  const title = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(text)?.[1]?.trim();
  if (title) return title;
  return text
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function httpError(
  response: Response,
  signal: AbortSignal,
): Promise<ProviderError> {
  let text = "";
  try {
    text = await readLimitedText(response, ERROR_BODY_LIMIT);
  } catch (err) {
    rethrowIfAborted(signal, err);
    // 读错误响应体失败不影响报错本身，退回用状态文字
  }
  let message: string | null = null;
  try {
    message = errorMessageFrom(JSON.parse(text));
  } catch {
    // 不是 JSON
  }
  if (!message) {
    const plain = /^\s*<(!doctype html|html)/i.test(text)
      ? htmlToText(text)
      : text.trim();
    message = plain
      ? plain.slice(0, 500)
      : response.statusText || "没有返回错误信息";
  }
  return new ProviderError(
    `HTTP ${response.status}：${message}`,
    response.status,
  );
}

export interface SendOptions {
  method: "GET" | "POST";
  headers: Headers;
  body?: string;
  signal: AbortSignal;
}

/** 发出请求；网络错误、非 2xx 都转成 ProviderError，中止时原样抛出中止错误 */
export async function sendRequest(
  url: string,
  options: SendOptions,
): Promise<Response> {
  let response: Response;
  try {
    const init = {
      method: options.method,
      headers: options.headers,
      body: options.body,
      signal: options.signal,
      dispatcher: longLivedDispatcher(),
    };
    response = await fetch(url, init as RequestInit);
  } catch (err) {
    rethrowIfAborted(options.signal, err);
    throw networkError(err);
  }
  if (!response.ok) throw await httpError(response, options.signal);
  return response;
}

/** 读完整个响应体（网络错误转成 ProviderError） */
export async function readBodyText(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  try {
    return await response.text();
  } catch (err) {
    rethrowIfAborted(signal, err);
    throw networkError(err);
  }
}

export function notJsonError(text: string): ProviderError {
  return new ProviderError(`上游返回的不是 JSON：${preview(text)}`);
}

export function parseJsonText(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw notJsonError(text);
  }
}

/** 解析失败时的统一报错：上游 JSON 里带了错误消息就用它 */
export function unrecognized(json: unknown, what = "响应"): ProviderError {
  const message = errorMessageFrom(json);
  if (message) return new ProviderError(message);
  return new ProviderError(`上游返回的${what}格式无法识别：${preview(json)}`);
}
