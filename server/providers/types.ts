import type { EndpointType } from "../../shared/endpoints.ts";

/** 发起一次生成请求需要的全部信息 */
export interface CompletionRequest {
  endpointType: EndpointType;
  /** 管理员填的基础地址，可能是空串（用默认值），由 shared/endpoints.ts 推出实际地址 */
  baseUrl: string;
  /** 可能是空串：不带认证头 */
  apiKey: string;
  /** 额外请求头，最后合并，可以覆盖默认的认证头 */
  extraHeaders: Record<string, string>;
  model: string;
  /** 作为一条 user 消息发出 */
  prompt: string;
  stream: boolean;
  /** null 表示不传；Anthropic 必须传，null 时用 DEFAULT_ANTHROPIC_MAX_TOKENS */
  maxTokens: number | null;
  /** null 表示不传 */
  temperature: number | null;
  /** 超时或服务关闭时由调用方中止；中止后 runCompletion 以 AbortError 拒绝 */
  signal: AbortSignal;
  /**
   * 收到增量时回调（流式请求每收到一段调用一次；非流式请求不调用）。
   * output / reasoning 是这一次新增的文字，不是累计值。
   */
  onDelta?: (delta: CompletionDelta) => void;
}

export interface CompletionDelta {
  output?: string;
  reasoning?: string;
}

/** 一次生成请求成功结束后的结果 */
export interface CompletionResult {
  /** 完整的正文输出 */
  output: string;
  /** 完整的思考过程；上游没有单独返回就是空串 */
  reasoning: string;
  inputTokens: number | null;
  outputTokens: number | null;
  /** 上游的结束原因，原样保存 */
  finishReason: string | null;
}

/** 列出上游模型需要的信息 */
export interface ListModelsRequest {
  endpointType: EndpointType;
  baseUrl: string;
  apiKey: string;
  extraHeaders: Record<string, string>;
  signal?: AbortSignal;
}

export const DEFAULT_ANTHROPIC_MAX_TOKENS = 8192;
export const ANTHROPIC_VERSION = "2023-06-01";

/**
 * 上游返回了错误（HTTP 非 2xx、流里的 error 事件、被安全策略拦下、响应格式认不出…）。
 * message 是给人看的一句话，如 "HTTP 401：Incorrect API key provided"。
 */
export class ProviderError extends Error {
  readonly status: number | null;
  constructor(message: string, status: number | null = null) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}
