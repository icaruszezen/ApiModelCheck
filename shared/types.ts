/**
 * 前后端共用的接口数据结构。时间一律是 ISO 8601 的 UTC 字符串（`new Date().toISOString()`），
 * 由前端按浏览器的时区格式化。
 */

import type { EndpointType } from "./endpoints.ts";

export type { EndpointType } from "./endpoints.ts";

/** 一次检测的状态 */
export type ResultStatus = "running" | "success" | "error" | "timeout";

/** 检测是定时触发的，还是管理员在后台点"立即检测"触发的 */
export type ResultTrigger = "schedule" | "manual";

/** 一次检测（一个模型 × 一条提示词）的完整结果 */
export interface ResultDetail {
  id: number;
  modelId: number;
  promptId: number;
  /** 发出请求时提示词的内容（提示词之后被改过也不影响这条记录） */
  promptSnapshot: string;
  status: ResultStatus;
  /** 这次请求是不是流式的 */
  stream: boolean;
  /** 模型的正文输出；检测中且为流式时是目前收到的部分 */
  output: string;
  /** 模型单独返回的思考过程（reasoning_content / thinking 等），没有就是空串 */
  reasoning: string;
  /** 失败或超时的原因；成功时为 null */
  error: string | null;
  startedAt: string;
  finishedAt: string | null;
  /** 从发出请求到结束的毫秒数 */
  durationMs: number | null;
  /** 流式请求从发出到收到第一个字的毫秒数 */
  firstTokenMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** 上游返回的结束原因（stop / length / end_turn / MAX_TOKENS …），原样保存 */
  finishReason: string | null;
  trigger: ResultTrigger;
}

/** 历史记录列表里的一行（不带输出正文） */
export interface ResultSummary {
  id: number;
  status: ResultStatus;
  startedAt: string;
  finishedAt: string | null;
  durationMs: number | null;
  trigger: ResultTrigger;
}

/* ------------------------------------------------------------------ */
/* 前台                                                                */
/* ------------------------------------------------------------------ */

export interface SiteInfo {
  title: string;
  description: string;
}

/** GET /api/public/board */
export interface BoardResponse {
  site: SiteInfo;
  /** 服务器生成这份数据的时间 */
  generatedAt: string;
  /** 只含启用的渠道，按排序值、id 排列；没有启用模型的渠道也在里面（models 为空） */
  channels: BoardChannel[];
}

export interface BoardChannel {
  id: number;
  name: string;
  endpointType: EndpointType;
  /** 只含启用的模型，按排序值、id 排列 */
  models: BoardModel[];
}

export interface BoardModel {
  id: number;
  /** 上游的模型 ID */
  model: string;
  /** 显示名；后台没填时等于 model */
  displayName: string;
  stream: boolean;
  timeoutSeconds: number;
  intervalMinutes: number;
  /** 最近一轮检测开始的时间；从没检测过是 null */
  lastRunAt: string | null;
  /** 下一轮预计开始的时间；从没检测过、或者没有可检测的提示词时是 null */
  nextRunAt: string | null;
  /** 这一轮正在进行中（含排队） */
  running: boolean;
  /** 分配给这个模型、且启用的提示词，每条一项，按提示词的排序值、id 排列 */
  checks: BoardCheck[];
}

export interface BoardPrompt {
  id: number;
  title: string;
  content: string;
}

export interface BoardCheck {
  prompt: BoardPrompt;
  /** 最近一条记录（可能正在检测中）；从没检测过是 null */
  latest: ResultDetail | null;
  /** 只在 latest 正在检测中时给出：最近一条已经结束的记录（优先跳过被服务停止 / 重启打断的），没有就是 null */
  previous: ResultDetail | null;
}

/** GET /api/public/history?modelId=&promptId=&limit= */
export interface HistoryResponse {
  items: ResultSummary[];
}

/* ------------------------------------------------------------------ */
/* 后台                                                                */
/* ------------------------------------------------------------------ */

/** POST /api/admin/login 的请求体 */
export interface LoginInput {
  username: string;
  password: string;
}

/** GET /api/admin/me、POST /api/admin/login 的返回 */
export interface AdminSession {
  username: string;
}

export interface AdminChannel {
  id: number;
  name: string;
  endpointType: EndpointType;
  /** 管理员填的基础地址，可能是空串（表示用默认值） */
  baseUrl: string;
  /** 是否已经保存过密钥 */
  hasApiKey: boolean;
  /** 打码后的密钥，如 "sk-a…9f3c"；没有密钥时是空串 */
  apiKeyMasked: string;
  /** 额外请求头，键值都是字符串 */
  extraHeaders: Record<string, string>;
  enabled: boolean;
  sortOrder: number;
  /** 这个渠道下的模型数 */
  modelCount: number;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/admin/channels、PUT /api/admin/channels/:id 的请求体 */
export interface ChannelInput {
  name: string;
  endpointType: EndpointType;
  baseUrl: string;
  /**
   * 新建时必填（可以是空串，表示不带认证）；
   * 修改时不传或传空串表示保留原来的密钥，传 null 表示清掉。
   */
  apiKey?: string | null;
  extraHeaders: Record<string, string>;
  enabled: boolean;
  sortOrder: number;
}

/** GET /api/admin/channels/:id/upstream-models 的返回 */
export interface UpstreamModelsResponse {
  models: string[];
}

export interface AdminPrompt {
  id: number;
  title: string;
  content: string;
  enabled: boolean;
  sortOrder: number;
  /** 分配了这条提示词的模型 */
  modelIds: number[];
  createdAt: string;
  updatedAt: string;
}

/** POST /api/admin/prompts、PUT /api/admin/prompts/:id 的请求体 */
export interface PromptInput {
  title: string;
  content: string;
  enabled: boolean;
  sortOrder: number;
  /** 传了就把分配关系整个换成这一组；不传则不动 */
  modelIds?: number[];
}

export interface AdminModel {
  id: number;
  channelId: number;
  channelName: string;
  model: string;
  /** 管理员填的显示名，可能是空串 */
  displayName: string;
  stream: boolean;
  timeoutSeconds: number;
  intervalMinutes: number;
  /** null 表示不传，用上游默认（Anthropic 必须传，用 8192） */
  maxTokens: number | null;
  /** null 表示不传 */
  temperature: number | null;
  enabled: boolean;
  sortOrder: number;
  promptIds: number[];
  lastRunAt: string | null;
  nextRunAt: string | null;
  running: boolean;
  /** 最近一条记录的状态；没有记录是 null */
  lastStatus: ResultStatus | null;
  createdAt: string;
  updatedAt: string;
}

/** POST /api/admin/models、PUT /api/admin/models/:id 的请求体 */
export interface ModelInput {
  channelId: number;
  model: string;
  displayName: string;
  stream: boolean;
  /** 5 – 3600 */
  timeoutSeconds: number;
  /** 1 – 10080（一周） */
  intervalMinutes: number;
  /** 1 – 1000000，或 null */
  maxTokens: number | null;
  /** 0 – 2，或 null */
  temperature: number | null;
  enabled: boolean;
  sortOrder: number;
  promptIds: number[];
}

/** POST /api/admin/models/:id/run 的请求体；不传 promptId 就检测这个模型的全部提示词 */
export interface RunInput {
  promptId?: number;
}

/** 后台检测记录列表的一行 */
export interface AdminResultRow extends ResultSummary {
  modelId: number;
  promptId: number;
  channelName: string;
  /** 模型的显示名（没填时是模型 ID） */
  modelLabel: string;
  promptTitle: string;
  firstTokenMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
}

/** GET /api/admin/results?modelId=&promptId=&status=&page=&pageSize= */
export interface AdminResultsResponse {
  items: AdminResultRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** GET / PUT /api/admin/settings */
export interface Settings {
  /** 前台页面的标题 */
  siteTitle: string;
  /** 前台标题下面的一段说明 */
  siteDescription: string;
  /** 每个"模型 × 提示词"保留最近多少条记录，1 – 1000 */
  retentionPerCheck: number;
  /** 同时检测的模型数上限，1 – 20 */
  maxConcurrency: number;
}

/** 接口出错时的返回体（HTTP 状态码非 2xx） */
export interface ApiError {
  error: string;
}
