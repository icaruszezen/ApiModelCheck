/**
 * 后端接口的类型化封装。数据结构见 shared/types.ts。
 * 出错时抛 ApiRequestError：status 是 HTTP 状态码（网络不通时为 0），message 是可以直接给人看的一句话。
 */
import type {
  AdminChannel,
  AdminModel,
  AdminPrompt,
  AdminResultsResponse,
  AdminSession,
  BoardResponse,
  ChannelInput,
  HistoryResponse,
  LoginInput,
  ModelInput,
  PromptInput,
  ResultDetail,
  ResultStatus,
  RunInput,
  Settings,
  UpstreamModelsResponse,
} from "../../../shared/types.ts";

export class ApiRequestError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
  }
}

/** 是不是"没登录 / 登录过期"（HTTP 401） */
export function isUnauthorized(error: unknown): boolean {
  return error instanceof ApiRequestError && error.status === 401;
}

/**
 * 后台接口返回 401 时触发：后台外壳监听它，已登录时弹出重新登录的窗口。
 * 事件是 CustomEvent，detail 见 UnauthorizedEventDetail
 */
export const UNAUTHORIZED_EVENT = "amc:unauthorized";

export interface UnauthorizedEventDetail {
  /** 这个请求是什么时候发出的（requestClock 的读数）：比最近一次登录还早的 401 带的是旧凭据，不算过期 */
  startedAt: number;
}

/** 在重新登录的弹窗里登录成功后由后台外壳触发：因为 401 没载入的列表、表单上的提示据此自己刷新 */
export const REAUTHENTICATED_EVENT = "amc:reauthenticated";

/** 给请求和登录打时间戳的钟：单调递增，改系统时间也不会倒退 */
export function requestClock(): number {
  return performance.now();
}

async function request<T>(
  method: "GET" | "POST" | "PUT" | "DELETE",
  path: string,
  body?: unknown,
): Promise<T> {
  // 在 fetch 之前取：响应回来时登录状态可能已经变了
  const startedAt = requestClock();
  let response: Response;
  try {
    response = await fetch(path, {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers:
        body === undefined ? undefined : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiRequestError("连不上服务器，请检查网络后重试。", 0);
  }
  if (response.status === 204) return undefined as T;
  const text = await response.text();
  let data: unknown = undefined;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = undefined;
    }
  }
  if (!response.ok) {
    if (response.status === 401 && path.startsWith("/api/admin/")) {
      window.dispatchEvent(
        new CustomEvent<UnauthorizedEventDetail>(UNAUTHORIZED_EVENT, {
          detail: { startedAt },
        }),
      );
    }
    const message =
      data && typeof data === "object" && "error" in data
        ? String((data as { error: unknown }).error)
        : `请求失败（HTTP ${response.status}）`;
    throw new ApiRequestError(message, response.status);
  }
  return data as T;
}

function query(params: Record<string, string | number | undefined | null>) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== "") {
      search.set(key, String(value));
    }
  }
  const text = search.toString();
  return text ? `?${text}` : "";
}

/* ---------------------------- 前台 ---------------------------- */

export const publicApi = {
  board: () => request<BoardResponse>("GET", "/api/public/board"),
  history: (modelId: number, promptId: number, limit = 20) =>
    request<HistoryResponse>(
      "GET",
      `/api/public/history${query({ modelId, promptId, limit })}`,
    ),
  result: (id: number) =>
    request<ResultDetail>("GET", `/api/public/results/${id}`),
};

/* ---------------------------- 后台 ---------------------------- */

export interface AdminResultsQuery {
  modelId?: number;
  promptId?: number;
  status?: ResultStatus;
  page?: number;
  pageSize?: number;
}

export const adminApi = {
  login: (input: LoginInput) =>
    request<AdminSession>("POST", "/api/admin/login", input),
  logout: () => request<void>("POST", "/api/admin/logout"),
  me: () => request<AdminSession>("GET", "/api/admin/me"),

  channels: () => request<AdminChannel[]>("GET", "/api/admin/channels"),
  createChannel: (input: ChannelInput) =>
    request<AdminChannel>("POST", "/api/admin/channels", input),
  updateChannel: (id: number, input: ChannelInput) =>
    request<AdminChannel>("PUT", `/api/admin/channels/${id}`, input),
  deleteChannel: (id: number) =>
    request<void>("DELETE", `/api/admin/channels/${id}`),
  upstreamModels: (id: number) =>
    request<UpstreamModelsResponse>(
      "GET",
      `/api/admin/channels/${id}/upstream-models`,
    ),

  prompts: () => request<AdminPrompt[]>("GET", "/api/admin/prompts"),
  createPrompt: (input: PromptInput) =>
    request<AdminPrompt>("POST", "/api/admin/prompts", input),
  updatePrompt: (id: number, input: PromptInput) =>
    request<AdminPrompt>("PUT", `/api/admin/prompts/${id}`, input),
  deletePrompt: (id: number) =>
    request<void>("DELETE", `/api/admin/prompts/${id}`),

  models: () => request<AdminModel[]>("GET", "/api/admin/models"),
  createModel: (input: ModelInput) =>
    request<AdminModel>("POST", "/api/admin/models", input),
  updateModel: (id: number, input: ModelInput) =>
    request<AdminModel>("PUT", `/api/admin/models/${id}`, input),
  deleteModel: (id: number) =>
    request<void>("DELETE", `/api/admin/models/${id}`),
  runModel: (id: number, input: RunInput = {}) =>
    request<{ queued: boolean }>("POST", `/api/admin/models/${id}/run`, input),

  results: (params: AdminResultsQuery = {}) =>
    request<AdminResultsResponse>(
      "GET",
      `/api/admin/results${query({ ...params })}`,
    ),
  result: (id: number) =>
    request<ResultDetail>("GET", `/api/admin/results/${id}`),
  deleteResult: (id: number) =>
    request<void>("DELETE", `/api/admin/results/${id}`),
  /** 清空记录；传 modelId 只清这个模型的 */
  clearResults: (modelId?: number) =>
    request<{ deleted: number }>(
      "DELETE",
      `/api/admin/results${query({ modelId })}`,
    ),

  settings: () => request<Settings>("GET", "/api/admin/settings"),
  updateSettings: (input: Settings) =>
    request<Settings>("PUT", "/api/admin/settings", input),
};
