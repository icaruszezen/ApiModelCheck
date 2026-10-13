/**
 * 渠道的 API 端点类型，以及由"基础地址"推出实际请求地址的规则。
 * 服务端发请求、后台表单预览地址用的是同一份。
 */

export const ENDPOINT_TYPES = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
] as const;

export type EndpointType = (typeof ENDPOINT_TYPES)[number];

export interface EndpointMeta {
  /** 完整名称，后台下拉里显示 */
  label: string;
  /** 短名，前台标签里显示 */
  short: string;
  /** 基础地址留空时用的默认值 */
  defaultBaseUrl: string;
  /** 一句说明，后台表单里显示 */
  hint: string;
  /** 正常答完时存下的结束原因（Responses 存的是响应状态）；前台卡片上这种不写 */
  normalFinish: string;
}

export const ENDPOINT_META: Record<EndpointType, EndpointMeta> = {
  "openai-chat": {
    label: "OpenAI Chat Completions",
    short: "Chat Completions",
    defaultBaseUrl: "https://api.openai.com/v1",
    hint: "POST {基础地址}/chat/completions（只写域名时先补 /v1）。绝大多数 OpenAI 兼容的中转与开源推理服务用这一种。",
    normalFinish: "stop",
  },
  "openai-responses": {
    label: "OpenAI Responses",
    short: "Responses",
    defaultBaseUrl: "https://api.openai.com/v1",
    hint: "POST {基础地址}/responses（只写域名时先补 /v1）。OpenAI 新一代接口。",
    normalFinish: "completed",
  },
  anthropic: {
    label: "Anthropic Messages",
    short: "Messages",
    defaultBaseUrl: "https://api.anthropic.com",
    hint: "POST {基础地址}/v1/messages（地址已以 /v1 这类版本段结尾时不再补 /v1），使用 x-api-key 认证。",
    normalFinish: "end_turn",
  },
  gemini: {
    label: "Google Gemini",
    short: "Gemini",
    defaultBaseUrl: "https://generativelanguage.googleapis.com",
    hint: "POST {基础地址}/v1beta/models/{模型}:generateContent（地址已以版本段结尾或含 /publishers/ 时不再补 /v1beta），使用 x-goog-api-key 认证。",
    normalFinish: "STOP",
  },
};

/** 各种端点正常答完时的结束原因 */
export const NORMAL_FINISH_REASONS: ReadonlySet<string> = new Set(
  Object.values(ENDPOINT_META).map((meta) => meta.normalFinish),
);

export function isEndpointType(value: unknown): value is EndpointType {
  return (
    typeof value === "string" &&
    (ENDPOINT_TYPES as readonly string[]).includes(value)
  );
}

/** 每种类型的请求路径后缀；基础地址已经以它结尾时原样使用 */
const REQUEST_SUFFIX: Record<Exclude<EndpointType, "gemini">, string> = {
  "openai-chat": "/chat/completions",
  "openai-responses": "/responses",
  anthropic: "/messages",
};

/** 要补上的版本段：OpenAI 只在基础地址只写到域名（没有路径）时补，Anthropic / Gemini 见 apiRootPath */
const VERSION_PREFIX: Record<EndpointType, string> = {
  "openai-chat": "/v1",
  "openai-responses": "/v1",
  anthropic: "/v1",
  gemini: "/v1beta",
};

/** 路径的最后一段已经是版本段（v1、v1beta、v2alpha…） */
const VERSION_SEGMENT = /^v\d+[a-z0-9]*$/i;

function parseBase(type: EndpointType, baseUrl: string): URL {
  const raw = baseUrl.trim() || ENDPOINT_META[type].defaultBaseUrl;
  return new URL(raw);
}

/**
 * 去掉已经写进基础地址里的请求后缀，得到"版本段"那一层的路径（不带末尾斜杠）。
 * - 没有路径：补上版本段；
 * - OpenAI 两种类型：有路径就原样用（兼容服务的版本段五花八门，如 /api/paas/v4、/openai）；
 * - Anthropic / Gemini：各家兼容接口文档里给的基础地址多半带前缀不带版本段
 *   （如 https://api.deepseek.com/anthropic，由 SDK 补 /v1/messages），所以最后一段不是版本段时也补上。
 *   已经写到 /messages、/models 的完整地址不补；Gemini 的 Vertex 地址（…/publishers/google）也不补。
 * 注意 URL 对象的 pathname 至少是 "/"，所以路径在字符串上算好再写回去。
 */
function apiRootPath(type: EndpointType, url: URL): string {
  const original = url.pathname.replace(/\/+$/, "");
  let path = original;
  if (type === "gemini") {
    path = path.replace(/\/models(\/[^/]*)?$/, "");
  } else {
    const suffix = REQUEST_SUFFIX[type];
    if (path.endsWith(suffix)) path = path.slice(0, -suffix.length);
    path = path.replace(/\/models$/, "");
  }
  if (path === "") return VERSION_PREFIX[type];
  if (type === "openai-chat" || type === "openai-responses") return path;
  // 写到了请求后缀或 /models：管理员给的就是完整地址
  if (path !== original) return path;
  if (type === "gemini" && /\/publishers(\/|$)/.test(path)) return path;
  const last = path.slice(path.lastIndexOf("/") + 1);
  return VERSION_SEGMENT.test(last) ? path : path + VERSION_PREFIX[type];
}

/** Gemini 的模型名允许写成 "models/gemini-2.5-pro" */
export function normalizeGeminiModel(model: string): string {
  return model.trim().replace(/^models\//, "");
}

/**
 * 实际的生成请求地址。
 * - 基础地址只有域名：补上版本段（OpenAI / Anthropic 是 /v1，Gemini 是 /v1beta）；
 * - Anthropic / Gemini 的地址最后一段不是版本段时也补（规则见 apiRootPath）；
 * - 已经以请求后缀结尾（如 .../chat/completions）：原样使用；
 * - 其余情况：在后面接上请求后缀。
 * 基础地址里的查询参数会保留。
 */
export function buildRequestUrl(
  type: EndpointType,
  baseUrl: string,
  model: string,
  stream: boolean,
): string {
  const url = parseBase(type, baseUrl);
  const root = apiRootPath(type, url);
  if (type === "gemini") {
    const name = normalizeGeminiModel(model);
    // 还没填模型时（后台预览地址）先占个位，最后换成可读的"{模型}"
    const segment = name ? encodeURIComponent(name) : "__MODEL__";
    url.pathname = `${root}/models/${segment}:${stream ? "streamGenerateContent" : "generateContent"}`;
    if (stream) url.searchParams.set("alt", "sse");
    return name ? url.href : url.href.replace("__MODEL__", "{模型}");
  }
  url.pathname = root + REQUEST_SUFFIX[type];
  return url.href;
}

/** 拉取模型列表的地址 */
export function buildModelsUrl(type: EndpointType, baseUrl: string): string {
  const url = parseBase(type, baseUrl);
  url.pathname = `${apiRootPath(type, url)}/models`;
  return url.href;
}

/**
 * 基础地址的问题，没有问题时返回 null；空串合法（用默认值）。
 * 地址里带用户名密码（user:pass@host）不行：fetch 会拒绝，报错里还会带出密码。
 */
export function baseUrlIssue(baseUrl: string): string | null {
  const raw = baseUrl.trim();
  if (raw === "") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "基础地址必须是 http:// 或 https:// 开头的有效地址";
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return "基础地址必须是 http:// 或 https:// 开头的有效地址";
  }
  if (url.username || url.password) {
    return "基础地址里不能带用户名和密码，需要时请在额外请求头里加 Authorization: Basic …";
  }
  return null;
}

/** 基础地址能不能用（见 baseUrlIssue） */
export function isValidBaseUrl(baseUrl: string): boolean {
  return baseUrlIssue(baseUrl) === null;
}
