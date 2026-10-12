/**
 * 数据访问层：所有 SQL 都在这里，对外返回 shared/types.ts 里的结构或内部记录类型。
 * 和调度器有关的运行时状态（是否在跑、实时输出）通过 RuntimeView 传进来，repo 本身不依赖调度器。
 */
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import type { EndpointType } from "../shared/endpoints.ts";
import type {
  AdminChannel,
  AdminModel,
  AdminPrompt,
  AdminResultRow,
  AdminResultsResponse,
  BoardChannel,
  BoardCheck,
  BoardModel,
  BoardResponse,
  ChannelInput,
  ModelInput,
  PromptInput,
  ResultDetail,
  ResultStatus,
  ResultSummary,
  ResultTrigger,
  Settings,
} from "../shared/types.ts";
import type { LiveOutput } from "./live.ts";
import { transaction } from "./db.ts";

/** 调度器对外暴露的运行时状态 */
export interface RuntimeView {
  /** 模型正在检测或排队中 */
  isBusy(modelId: number): boolean;
  /** 正在进行的检测目前收到的输出 */
  getLive(resultId: number): LiveOutput | undefined;
}

/** 没有调度器时（或测试里）用的空状态 */
export const IDLE_RUNTIME: RuntimeView = {
  isBusy: () => false,
  getLive: () => undefined,
};

/** 服务停止 / 重启打断检测时记下的错误信息；前台的"上一次结果"会跳过这种记录 */
export const STOPPED_MESSAGE = "服务已停止，检测中断";
export const RESTART_MESSAGE = "服务重启，检测中断";

export const DEFAULT_SETTINGS: Readonly<Settings> = {
  siteTitle: "模型智商检测",
  siteDescription: "定时向各家大模型发出同一组检测题，原样展示它们的回答。",
  retentionPerCheck: 20,
  maxConcurrency: 2,
};

const SETTING_KEYS: Record<keyof Settings, string> = {
  siteTitle: "site_title",
  siteDescription: "site_description",
  retentionPerCheck: "retention_per_check",
  maxConcurrency: "max_concurrency",
};

/* ------------------------------------------------------------------ */
/* 内部记录类型                                                         */
/* ------------------------------------------------------------------ */

export interface ChannelRecord {
  id: number;
  name: string;
  endpointType: EndpointType;
  baseUrl: string;
  apiKey: string;
  extraHeaders: Record<string, string>;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface PromptRecord {
  id: number;
  title: string;
  content: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

export interface ModelRecord {
  id: number;
  channelId: number;
  model: string;
  displayName: string;
  stream: boolean;
  timeoutSeconds: number;
  intervalMinutes: number;
  maxTokens: number | null;
  temperature: number | null;
  enabled: boolean;
  sortOrder: number;
  lastRunAt: string | null;
  createdAt: string;
  updatedAt: string;
}

/** 新建渠道时的数据（apiKey 已经确定） */
export type ChannelCreateData = Omit<ChannelInput, "apiKey"> & {
  apiKey: string;
};

/** 调度器跑一轮需要的全部配置 */
export interface RunConfig {
  model: ModelRecord;
  channel: ChannelRecord;
  /** 分配给模型且启用的提示词，按排序值、id */
  prompts: PromptRecord[];
}

/** 调度器判断是否到期用的模型信息 */
export interface DueCandidate {
  id: number;
  intervalMinutes: number;
  lastRunAt: string | null;
}

export interface NewResult {
  modelId: number;
  promptId: number;
  promptSnapshot: string;
  stream: boolean;
  startedAt: string;
  trigger: ResultTrigger;
}

export interface FinishedResult {
  status: Exclude<ResultStatus, "running">;
  output: string;
  reasoning: string;
  error: string | null;
  finishedAt: string;
  durationMs: number | null;
  firstTokenMs: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  finishReason: string | null;
}

export interface AdminResultsFilter {
  modelId?: number;
  promptId?: number;
  status?: ResultStatus;
  page: number;
  pageSize: number;
}

/* ------------------------------------------------------------------ */
/* 数据库行                                                             */
/* ------------------------------------------------------------------ */

interface ChannelRow {
  id: number;
  name: string;
  endpoint_type: string;
  base_url: string;
  api_key: string;
  extra_headers: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface PromptRow {
  id: number;
  title: string;
  content: string;
  enabled: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
}

interface ModelRow {
  id: number;
  channel_id: number;
  model: string;
  display_name: string;
  stream: number;
  timeout_seconds: number;
  interval_minutes: number;
  max_tokens: number | null;
  temperature: number | null;
  enabled: number;
  sort_order: number;
  last_run_at: string | null;
  created_at: string;
  updated_at: string;
}

interface ResultRow {
  id: number;
  model_id: number;
  prompt_id: number;
  prompt_snapshot: string;
  status: string;
  stream: number;
  output: string;
  reasoning: string;
  error: string | null;
  started_at: string;
  finished_at: string | null;
  duration_ms: number | null;
  first_token_ms: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  finish_reason: string | null;
  trigger: string;
}

/* ------------------------------------------------------------------ */
/* 转换                                                                 */
/* ------------------------------------------------------------------ */

function parseHeaders(json: string): Record<string, string> {
  try {
    const value: unknown = JSON.parse(json);
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, string> = {};
    for (const [key, item] of Object.entries(value)) {
      if (typeof item === "string") out[key] = item;
    }
    return out;
  } catch {
    return {};
  }
}

function toChannel(row: ChannelRow): ChannelRecord {
  return {
    id: row.id,
    name: row.name,
    endpointType: row.endpoint_type as EndpointType,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    extraHeaders: parseHeaders(row.extra_headers),
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toPrompt(row: PromptRow): PromptRecord {
  return {
    id: row.id,
    title: row.title,
    content: row.content,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toModel(row: ModelRow): ModelRecord {
  return {
    id: row.id,
    channelId: row.channel_id,
    model: row.model,
    displayName: row.display_name,
    stream: row.stream === 1,
    timeoutSeconds: row.timeout_seconds,
    intervalMinutes: row.interval_minutes,
    maxTokens: row.max_tokens,
    temperature: row.temperature,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toResultDetail(row: ResultRow, live?: LiveOutput): ResultDetail {
  const status = row.status as ResultStatus;
  const useLive = status === "running" && live !== undefined;
  return {
    id: row.id,
    modelId: row.model_id,
    promptId: row.prompt_id,
    promptSnapshot: row.prompt_snapshot,
    status,
    stream: row.stream === 1,
    output: useLive ? live.output : row.output,
    reasoning: useLive ? live.reasoning : row.reasoning,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: row.duration_ms,
    firstTokenMs: row.first_token_ms,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    finishReason: row.finish_reason,
    trigger: row.trigger as ResultTrigger,
  };
}

/** 打码规则：≤ 8 位显示 "••••"，否则 "前 4 位…后 4 位"；没有密钥是空串 */
export function maskApiKey(key: string): string {
  if (!key) return "";
  if (key.length <= 8) return "••••";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** 下一轮预计开始的时间；从没跑过、或者当前不会被调度时为 null */
export function computeNextRunAt(
  lastRunAt: string | null,
  intervalMinutes: number,
  schedulable: boolean,
): string | null {
  if (!lastRunAt || !schedulable) return null;
  const last = Date.parse(lastRunAt);
  if (Number.isNaN(last)) return null;
  return new Date(last + intervalMinutes * 60_000).toISOString();
}

function bool(value: boolean): number {
  return value ? 1 : 0;
}

function placeholders(count: number): string {
  return new Array(count).fill("?").join(", ");
}

/* ------------------------------------------------------------------ */
/* Repo                                                                 */
/* ------------------------------------------------------------------ */

export class Repo {
  readonly db: DatabaseSync;
  readonly #statements = new Map<string, StatementSync>();

  constructor(db: DatabaseSync) {
    this.db = db;
  }

  #stmt(sql: string): StatementSync {
    let stmt = this.#statements.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.#statements.set(sql, stmt);
    }
    return stmt;
  }

  #all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.#stmt(sql).all(...params) as unknown as T[];
  }

  #get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.#stmt(sql).get(...params) as unknown as T | undefined;
  }

  #run(sql: string, ...params: SQLInputValue[]) {
    const result = this.#stmt(sql).run(...params);
    return {
      changes: Number(result.changes),
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  }

  /* ------------------------------ 设置 ------------------------------ */

  getSettings(): Settings {
    const rows = this.#all<{ key: string; value: string }>(
      "SELECT key, value FROM settings",
    );
    const map = new Map(rows.map((row) => [row.key, row.value]));
    const intSetting = (key: keyof Settings, min: number, max: number) => {
      const raw = map.get(SETTING_KEYS[key]);
      const value = raw === undefined ? NaN : Number(raw);
      return Number.isInteger(value) && value >= min && value <= max
        ? value
        : (DEFAULT_SETTINGS[key] as number);
    };
    return {
      siteTitle: map.get(SETTING_KEYS.siteTitle) || DEFAULT_SETTINGS.siteTitle,
      siteDescription:
        map.get(SETTING_KEYS.siteDescription) ??
        DEFAULT_SETTINGS.siteDescription,
      retentionPerCheck: intSetting("retentionPerCheck", 1, 1000),
      maxConcurrency: intSetting("maxConcurrency", 1, 20),
    };
  }

  updateSettings(patch: Partial<Settings>): Settings {
    transaction(this.db, () => {
      for (const key of Object.keys(SETTING_KEYS) as (keyof Settings)[]) {
        const value = patch[key];
        if (value === undefined) continue;
        this.#run(
          "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
          SETTING_KEYS[key],
          String(value),
        );
      }
    });
    return this.getSettings();
  }

  /* ------------------------------ 渠道 ------------------------------ */

  getChannel(id: number): ChannelRecord | undefined {
    const row = this.#get<ChannelRow>(
      "SELECT * FROM channels WHERE id = ?",
      id,
    );
    return row ? toChannel(row) : undefined;
  }

  listAdminChannels(): AdminChannel[] {
    const rows = this.#all<ChannelRow & { model_count: number }>(
      `SELECT c.*, (SELECT COUNT(*) FROM models m WHERE m.channel_id = c.id) AS model_count
       FROM channels c ORDER BY c.sort_order, c.id`,
    );
    return rows.map((row) =>
      this.#toAdminChannel(toChannel(row), row.model_count),
    );
  }

  getAdminChannel(id: number): AdminChannel | undefined {
    const channel = this.getChannel(id);
    if (!channel) return undefined;
    const count = this.#get<{ n: number }>(
      "SELECT COUNT(*) AS n FROM models WHERE channel_id = ?",
      id,
    );
    return this.#toAdminChannel(channel, count?.n ?? 0);
  }

  #toAdminChannel(channel: ChannelRecord, modelCount: number): AdminChannel {
    return {
      id: channel.id,
      name: channel.name,
      endpointType: channel.endpointType,
      baseUrl: channel.baseUrl,
      hasApiKey: channel.apiKey !== "",
      apiKeyMasked: maskApiKey(channel.apiKey),
      extraHeaders: channel.extraHeaders,
      enabled: channel.enabled,
      sortOrder: channel.sortOrder,
      modelCount,
      createdAt: channel.createdAt,
      updatedAt: channel.updatedAt,
    };
  }

  createChannel(
    data: ChannelCreateData,
    now = new Date().toISOString(),
  ): number {
    const result = this.#run(
      `INSERT INTO channels (name, endpoint_type, base_url, api_key, extra_headers, enabled, sort_order, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      data.name,
      data.endpointType,
      data.baseUrl,
      data.apiKey,
      JSON.stringify(data.extraHeaders),
      bool(data.enabled),
      data.sortOrder,
      now,
      now,
    );
    return result.lastInsertRowid;
  }

  /**
   * 修改渠道。apiKey：undefined 或 "" 保留原值，null 清空，其余替换。
   * 渠道不存在时返回 false。
   */
  updateChannel(
    id: number,
    data: ChannelInput,
    now = new Date().toISOString(),
  ): boolean {
    const existing = this.getChannel(id);
    if (!existing) return false;
    const apiKey =
      data.apiKey === undefined || data.apiKey === ""
        ? existing.apiKey
        : data.apiKey === null
          ? ""
          : data.apiKey;
    this.#run(
      `UPDATE channels SET name = ?, endpoint_type = ?, base_url = ?, api_key = ?, extra_headers = ?,
         enabled = ?, sort_order = ?, updated_at = ? WHERE id = ?`,
      data.name,
      data.endpointType,
      data.baseUrl,
      apiKey,
      JSON.stringify(data.extraHeaders),
      bool(data.enabled),
      data.sortOrder,
      now,
      id,
    );
    return true;
  }

  /** 级联删除渠道下的模型、分配关系和记录 */
  deleteChannel(id: number): boolean {
    return this.#run("DELETE FROM channels WHERE id = ?", id).changes > 0;
  }

  listModelIdsByChannel(channelId: number): number[] {
    return this.#all<{ id: number }>(
      "SELECT id FROM models WHERE channel_id = ?",
      channelId,
    ).map((row) => row.id);
  }

  /* ----------------------------- 提示词 ----------------------------- */

  getPrompt(id: number): PromptRecord | undefined {
    const row = this.#get<PromptRow>("SELECT * FROM prompts WHERE id = ?", id);
    return row ? toPrompt(row) : undefined;
  }

  listAdminPrompts(): AdminPrompt[] {
    const rows = this.#all<PromptRow>(
      "SELECT * FROM prompts ORDER BY sort_order, id",
    );
    const assignments = this.#all<{ model_id: number; prompt_id: number }>(
      "SELECT model_id, prompt_id FROM model_prompts ORDER BY model_id",
    );
    const byPrompt = new Map<number, number[]>();
    for (const item of assignments) {
      const list = byPrompt.get(item.prompt_id);
      if (list) list.push(item.model_id);
      else byPrompt.set(item.prompt_id, [item.model_id]);
    }
    return rows.map((row) => ({
      ...this.#toAdminPromptBase(toPrompt(row)),
      modelIds: byPrompt.get(row.id) ?? [],
    }));
  }

  getAdminPrompt(id: number): AdminPrompt | undefined {
    const prompt = this.getPrompt(id);
    if (!prompt) return undefined;
    const modelIds = this.#all<{ model_id: number }>(
      "SELECT model_id FROM model_prompts WHERE prompt_id = ? ORDER BY model_id",
      id,
    ).map((row) => row.model_id);
    return { ...this.#toAdminPromptBase(prompt), modelIds };
  }

  #toAdminPromptBase(prompt: PromptRecord): Omit<AdminPrompt, "modelIds"> {
    return {
      id: prompt.id,
      title: prompt.title,
      content: prompt.content,
      enabled: prompt.enabled,
      sortOrder: prompt.sortOrder,
      createdAt: prompt.createdAt,
      updatedAt: prompt.updatedAt,
    };
  }

  createPrompt(data: PromptInput, now = new Date().toISOString()): number {
    return transaction(this.db, () => {
      const id = this.#run(
        `INSERT INTO prompts (title, content, enabled, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        data.title,
        data.content,
        bool(data.enabled),
        data.sortOrder,
        now,
        now,
      ).lastInsertRowid;
      if (data.modelIds) this.#replacePromptModels(id, data.modelIds);
      return id;
    });
  }

  /** modelIds 传了就整个替换分配关系；提示词不存在时返回 false */
  updatePrompt(
    id: number,
    data: PromptInput,
    now = new Date().toISOString(),
  ): boolean {
    return transaction(this.db, () => {
      const changed = this.#run(
        "UPDATE prompts SET title = ?, content = ?, enabled = ?, sort_order = ?, updated_at = ? WHERE id = ?",
        data.title,
        data.content,
        bool(data.enabled),
        data.sortOrder,
        now,
        id,
      ).changes;
      if (changed === 0) return false;
      if (data.modelIds) this.#replacePromptModels(id, data.modelIds);
      return true;
    });
  }

  #replacePromptModels(promptId: number, modelIds: number[]): void {
    this.#run("DELETE FROM model_prompts WHERE prompt_id = ?", promptId);
    for (const modelId of new Set(modelIds)) {
      this.#run(
        "INSERT INTO model_prompts (model_id, prompt_id) VALUES (?, ?)",
        modelId,
        promptId,
      );
    }
  }

  deletePrompt(id: number): boolean {
    return this.#run("DELETE FROM prompts WHERE id = ?", id).changes > 0;
  }

  /** 返回 ids 里在库中不存在的模型 id */
  missingModelIds(ids: number[]): number[] {
    return this.#missingIds("models", ids);
  }

  /** 返回 ids 里在库中不存在的提示词 id */
  missingPromptIds(ids: number[]): number[] {
    return this.#missingIds("prompts", ids);
  }

  #missingIds(table: "models" | "prompts", ids: number[]): number[] {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    // 动态 IN 列表不进语句缓存，免得缓存无限增长
    const found = new Set(
      (
        this.db
          .prepare(
            `SELECT id FROM ${table} WHERE id IN (${placeholders(unique.length)})`,
          )
          .all(...unique) as unknown as { id: number }[]
      ).map((row) => row.id),
    );
    return unique.filter((id) => !found.has(id));
  }

  /* ------------------------------ 模型 ------------------------------ */

  getModel(id: number): ModelRecord | undefined {
    const row = this.#get<ModelRow>("SELECT * FROM models WHERE id = ?", id);
    return row ? toModel(row) : undefined;
  }

  listAdminModels(runtime: RuntimeView = IDLE_RUNTIME): AdminModel[] {
    const rows = this.#all<
      ModelRow & { channel_name: string; channel_enabled: number }
    >(
      `SELECT m.*, c.name AS channel_name, c.enabled AS channel_enabled
       FROM models m JOIN channels c ON c.id = m.channel_id
       ORDER BY c.sort_order, c.id, m.sort_order, m.id`,
    );
    const assignments = this.#all<{
      model_id: number;
      prompt_id: number;
      enabled: number;
    }>(
      `SELECT mp.model_id, mp.prompt_id, p.enabled FROM model_prompts mp
       JOIN prompts p ON p.id = mp.prompt_id ORDER BY p.sort_order, p.id`,
    );
    const lastStatuses = this.#all<{ model_id: number; status: string }>(
      `SELECT r.model_id, r.status FROM results r
       JOIN (SELECT MAX(id) AS id FROM results GROUP BY model_id) x ON x.id = r.id`,
    );
    const promptsByModel = new Map<
      number,
      { ids: number[]; enabled: number }
    >();
    for (const item of assignments) {
      let entry = promptsByModel.get(item.model_id);
      if (!entry) {
        entry = { ids: [], enabled: 0 };
        promptsByModel.set(item.model_id, entry);
      }
      entry.ids.push(item.prompt_id);
      if (item.enabled === 1) entry.enabled++;
    }
    const statusByModel = new Map(
      lastStatuses.map((row) => [row.model_id, row.status as ResultStatus]),
    );
    return rows.map((row) => {
      const model = toModel(row);
      const prompts = promptsByModel.get(model.id);
      const schedulable =
        model.enabled &&
        row.channel_enabled === 1 &&
        (prompts?.enabled ?? 0) > 0;
      return {
        id: model.id,
        channelId: model.channelId,
        channelName: row.channel_name,
        model: model.model,
        displayName: model.displayName,
        stream: model.stream,
        timeoutSeconds: model.timeoutSeconds,
        intervalMinutes: model.intervalMinutes,
        maxTokens: model.maxTokens,
        temperature: model.temperature,
        enabled: model.enabled,
        sortOrder: model.sortOrder,
        promptIds: prompts?.ids ?? [],
        lastRunAt: model.lastRunAt,
        nextRunAt: computeNextRunAt(
          model.lastRunAt,
          model.intervalMinutes,
          schedulable,
        ),
        running: runtime.isBusy(model.id),
        lastStatus: statusByModel.get(model.id) ?? null,
        createdAt: model.createdAt,
        updatedAt: model.updatedAt,
      };
    });
  }

  getAdminModel(
    id: number,
    runtime: RuntimeView = IDLE_RUNTIME,
  ): AdminModel | undefined {
    // 数据量很小，复用列表的组装逻辑
    return this.listAdminModels(runtime).find((model) => model.id === id);
  }

  createModel(data: ModelInput, now = new Date().toISOString()): number {
    return transaction(this.db, () => {
      const id = this.#run(
        `INSERT INTO models (channel_id, model, display_name, stream, timeout_seconds, interval_minutes,
           max_tokens, temperature, enabled, sort_order, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        data.channelId,
        data.model,
        data.displayName,
        bool(data.stream),
        data.timeoutSeconds,
        data.intervalMinutes,
        data.maxTokens,
        data.temperature,
        bool(data.enabled),
        data.sortOrder,
        now,
        now,
      ).lastInsertRowid;
      this.#replaceModelPrompts(id, data.promptIds);
      return id;
    });
  }

  updateModel(
    id: number,
    data: ModelInput,
    now = new Date().toISOString(),
  ): boolean {
    return transaction(this.db, () => {
      const changed = this.#run(
        `UPDATE models SET channel_id = ?, model = ?, display_name = ?, stream = ?, timeout_seconds = ?,
           interval_minutes = ?, max_tokens = ?, temperature = ?, enabled = ?, sort_order = ?, updated_at = ?
         WHERE id = ?`,
        data.channelId,
        data.model,
        data.displayName,
        bool(data.stream),
        data.timeoutSeconds,
        data.intervalMinutes,
        data.maxTokens,
        data.temperature,
        bool(data.enabled),
        data.sortOrder,
        now,
        id,
      ).changes;
      if (changed === 0) return false;
      this.#replaceModelPrompts(id, data.promptIds);
      return true;
    });
  }

  #replaceModelPrompts(modelId: number, promptIds: number[]): void {
    this.#run("DELETE FROM model_prompts WHERE model_id = ?", modelId);
    for (const promptId of new Set(promptIds)) {
      this.#run(
        "INSERT INTO model_prompts (model_id, prompt_id) VALUES (?, ?)",
        modelId,
        promptId,
      );
    }
  }

  deleteModel(id: number): boolean {
    return this.#run("DELETE FROM models WHERE id = ?", id).changes > 0;
  }

  /** iso 为 null 表示清空，模型在下一次检查时就到期 */
  setLastRunAt(modelId: number, iso: string | null): void {
    this.#run("UPDATE models SET last_run_at = ? WHERE id = ?", iso, modelId);
  }

  /** 启用、渠道启用、并且至少分配了一条启用提示词的模型（是否到期由调度器判断） */
  listDueCandidates(): DueCandidate[] {
    return this.#all<{
      id: number;
      interval_minutes: number;
      last_run_at: string | null;
    }>(
      `SELECT m.id, m.interval_minutes, m.last_run_at FROM models m
       JOIN channels c ON c.id = m.channel_id
       WHERE m.enabled = 1 AND c.enabled = 1
         AND EXISTS (SELECT 1 FROM model_prompts mp JOIN prompts p ON p.id = mp.prompt_id
                     WHERE mp.model_id = m.id AND p.enabled = 1)
       ORDER BY m.last_run_at IS NOT NULL, m.last_run_at, m.id`,
    ).map((row) => ({
      id: row.id,
      intervalMinutes: row.interval_minutes,
      lastRunAt: row.last_run_at,
    }));
  }

  /** 分配给模型且启用的提示词，按排序值、id */
  listEnabledPromptsOfModel(modelId: number): PromptRecord[] {
    return this.#all<PromptRow>(
      `SELECT p.* FROM model_prompts mp JOIN prompts p ON p.id = mp.prompt_id
       WHERE mp.model_id = ? AND p.enabled = 1 ORDER BY p.sort_order, p.id`,
      modelId,
    ).map(toPrompt);
  }

  getRunConfig(modelId: number): RunConfig | undefined {
    const model = this.getModel(modelId);
    if (!model) return undefined;
    const channel = this.getChannel(model.channelId);
    if (!channel) return undefined;
    return { model, channel, prompts: this.listEnabledPromptsOfModel(modelId) };
  }

  /**
   * 前台能不能看到这个"模型 × 提示词"的记录：模型、渠道、提示词都启用，
   * 并且提示词仍分配给这个模型（和看板的条件一致）
   */
  isCheckVisible(modelId: number, promptId: number): boolean {
    return (
      this.#get(
        `SELECT 1 AS ok FROM model_prompts mp
         JOIN models m ON m.id = mp.model_id
         JOIN channels c ON c.id = m.channel_id
         JOIN prompts p ON p.id = mp.prompt_id
         WHERE mp.model_id = ? AND mp.prompt_id = ?
           AND m.enabled = 1 AND c.enabled = 1 AND p.enabled = 1`,
        modelId,
        promptId,
      ) !== undefined
    );
  }

  /* ------------------------------ 记录 ------------------------------ */

  insertRunningResult(data: NewResult): number {
    return this.#run(
      `INSERT INTO results (model_id, prompt_id, prompt_snapshot, status, stream, started_at, trigger)
       VALUES (?, ?, ?, 'running', ?, ?, ?)`,
      data.modelId,
      data.promptId,
      data.promptSnapshot,
      bool(data.stream),
      data.startedAt,
      data.trigger,
    ).lastInsertRowid;
  }

  finishResult(id: number, data: FinishedResult): void {
    this.#run(
      `UPDATE results SET status = ?, output = ?, reasoning = ?, error = ?, finished_at = ?, duration_ms = ?,
         first_token_ms = ?, input_tokens = ?, output_tokens = ?, finish_reason = ?
       WHERE id = ?`,
      data.status,
      data.output,
      data.reasoning,
      data.error,
      data.finishedAt,
      data.durationMs,
      data.firstTokenMs,
      data.inputTokens,
      data.outputTokens,
      data.finishReason,
      id,
    );
  }

  /** 同一个"模型 × 提示词"只保留最近 keep 条已结束的记录；返回删掉的条数 */
  pruneResults(modelId: number, promptId: number, keep: number): number {
    return this.#run(
      `DELETE FROM results WHERE model_id = ? AND prompt_id = ? AND status != 'running'
         AND id NOT IN (SELECT id FROM results WHERE model_id = ? AND prompt_id = ? AND status != 'running'
                        ORDER BY id DESC LIMIT ?)`,
      modelId,
      promptId,
      modelId,
      promptId,
      keep,
    ).changes;
  }

  /** 对所有"模型 × 提示词"执行保留规则（改小了保留条数时用） */
  pruneAllResults(keep: number): number {
    return this.#run(
      `DELETE FROM results WHERE status != 'running' AND id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY model_id, prompt_id ORDER BY id DESC) AS rn
           FROM results WHERE status != 'running'
         ) WHERE rn > ?
       )`,
      keep,
    ).changes;
  }

  /**
   * 把库里残留的 running 记录改成 error（服务启动时用）；返回改了几条。
   * 这些模型的上次检测时间一并清空，启动后第一次检查就重新检测，不用等满一个间隔。
   */
  recoverStaleRunning(message: string, now = new Date().toISOString()): number {
    return transaction(this.db, () => {
      this.#run(
        `UPDATE models SET last_run_at = NULL
         WHERE id IN (SELECT DISTINCT model_id FROM results WHERE status = 'running')`,
      );
      return this.#run(
        "UPDATE results SET status = 'error', error = ?, finished_at = ? WHERE status = 'running'",
        message,
        now,
      ).changes;
    });
  }

  getResult(
    id: number,
    runtime: RuntimeView = IDLE_RUNTIME,
  ): ResultDetail | undefined {
    const row = this.#get<ResultRow>("SELECT * FROM results WHERE id = ?", id);
    return row ? toResultDetail(row, runtime.getLive(row.id)) : undefined;
  }

  /** 某个"模型 × 提示词"的记录，按 id 倒序；传了 before 就只要比它更早（id 更小）的 */
  listHistory(
    modelId: number,
    promptId: number,
    limit: number,
    before?: number,
  ): ResultSummary[] {
    return this.#all<{
      id: number;
      status: string;
      started_at: string;
      finished_at: string | null;
      duration_ms: number | null;
      trigger: string;
    }>(
      `SELECT id, status, started_at, finished_at, duration_ms, trigger FROM results
       WHERE model_id = ? AND prompt_id = ? AND id < ? ORDER BY id DESC LIMIT ?`,
      modelId,
      promptId,
      before ?? Number.MAX_SAFE_INTEGER,
      limit,
    ).map((row) => ({
      id: row.id,
      status: row.status as ResultStatus,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      trigger: row.trigger as ResultTrigger,
    }));
  }

  listAdminResults(filter: AdminResultsFilter): AdminResultsResponse {
    const where: string[] = [];
    const params: SQLInputValue[] = [];
    if (filter.modelId !== undefined) {
      where.push("r.model_id = ?");
      params.push(filter.modelId);
    }
    if (filter.promptId !== undefined) {
      where.push("r.prompt_id = ?");
      params.push(filter.promptId);
    }
    if (filter.status !== undefined) {
      where.push("r.status = ?");
      params.push(filter.status);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total =
      this.#get<{ n: number }>(
        `SELECT COUNT(*) AS n FROM results r ${whereSql}`,
        ...params,
      )?.n ?? 0;
    const rows = this.#all<
      ResultRow & {
        channel_name: string;
        model_name: string;
        display_name: string;
        prompt_title: string;
      }
    >(
      `SELECT r.id, r.model_id, r.prompt_id, r.status, r.started_at, r.finished_at, r.duration_ms, r.trigger,
              r.first_token_ms, r.input_tokens, r.output_tokens, r.error,
              c.name AS channel_name, m.model AS model_name, m.display_name, p.title AS prompt_title
       FROM results r
       JOIN models m ON m.id = r.model_id
       JOIN channels c ON c.id = m.channel_id
       JOIN prompts p ON p.id = r.prompt_id
       ${whereSql}
       ORDER BY r.id DESC LIMIT ? OFFSET ?`,
      ...params,
      filter.pageSize,
      (filter.page - 1) * filter.pageSize,
    );
    const items: AdminResultRow[] = rows.map((row) => ({
      id: row.id,
      status: row.status as ResultStatus,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      durationMs: row.duration_ms,
      trigger: row.trigger as ResultTrigger,
      modelId: row.model_id,
      promptId: row.prompt_id,
      channelName: row.channel_name,
      modelLabel: row.display_name || row.model_name,
      promptTitle: row.prompt_title,
      firstTokenMs: row.first_token_ms,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      error: row.error,
    }));
    return { items, total, page: filter.page, pageSize: filter.pageSize };
  }

  /** 删除一条记录；正在检测中的不能删 */
  deleteResult(id: number): "deleted" | "running" | "missing" {
    const row = this.#get<{ status: string }>(
      "SELECT status FROM results WHERE id = ?",
      id,
    );
    if (!row) return "missing";
    if (row.status === "running") return "running";
    this.#run("DELETE FROM results WHERE id = ?", id);
    return "deleted";
  }

  /** 清空记录（跳过 running 的）；传 modelId 只清这个模型的。返回删掉的条数 */
  clearResults(modelId?: number): number {
    if (modelId === undefined) {
      return this.#run("DELETE FROM results WHERE status != 'running'").changes;
    }
    return this.#run(
      "DELETE FROM results WHERE model_id = ? AND status != 'running'",
      modelId,
    ).changes;
  }

  /* ------------------------------ 前台 ------------------------------ */

  getBoard(
    runtime: RuntimeView = IDLE_RUNTIME,
    now = new Date(),
  ): BoardResponse {
    const settings = this.getSettings();
    const channelRows = this.#all<
      Pick<ChannelRow, "id" | "name" | "endpoint_type">
    >(
      "SELECT id, name, endpoint_type FROM channels WHERE enabled = 1 ORDER BY sort_order, id",
    );
    const modelRows = this.#all<ModelRow>(
      `SELECT m.* FROM models m JOIN channels c ON c.id = m.channel_id
       WHERE m.enabled = 1 AND c.enabled = 1 ORDER BY m.sort_order, m.id`,
    );
    const checkRows = this.#all<{
      model_id: number;
      id: number;
      title: string;
      content: string;
    }>(
      `SELECT mp.model_id, p.id, p.title, p.content FROM model_prompts mp
       JOIN prompts p ON p.id = mp.prompt_id
       JOIN models m ON m.id = mp.model_id
       JOIN channels c ON c.id = m.channel_id
       WHERE p.enabled = 1 AND m.enabled = 1 AND c.enabled = 1
       ORDER BY p.sort_order, p.id`,
    );
    // 每个"模型 × 提示词"最新的一条（只取当前仍然分配着的组合）
    const latestRows = this.#all<ResultRow>(
      `SELECT r.* FROM results r
       JOIN (SELECT MAX(id) AS id FROM results GROUP BY model_id, prompt_id) x ON x.id = r.id
       JOIN model_prompts mp ON mp.model_id = r.model_id AND mp.prompt_id = r.prompt_id`,
    );
    const latestByPair = new Map<string, ResultRow>();
    for (const row of latestRows)
      latestByPair.set(`${row.model_id}:${row.prompt_id}`, row);

    const checksByModel = new Map<number, BoardCheck[]>();
    for (const row of checkRows) {
      const latest = latestByPair.get(`${row.model_id}:${row.id}`);
      let previous: ResultDetail | null = null;
      if (latest?.status === "running") {
        // 优先取没被服务停止 / 重启打断的那条，免得重测时挡住上一次的正常结果
        const prev = this.#get<ResultRow>(
          `SELECT * FROM results WHERE model_id = ? AND prompt_id = ? AND status != 'running'
           ORDER BY (status = 'error' AND error IN (?, ?)), id DESC LIMIT 1`,
          row.model_id,
          row.id,
          STOPPED_MESSAGE,
          RESTART_MESSAGE,
        );
        previous = prev ? toResultDetail(prev) : null;
      }
      const check: BoardCheck = {
        prompt: { id: row.id, title: row.title, content: row.content },
        latest: latest
          ? toResultDetail(latest, runtime.getLive(latest.id))
          : null,
        previous,
      };
      const list = checksByModel.get(row.model_id);
      if (list) list.push(check);
      else checksByModel.set(row.model_id, [check]);
    }

    const modelsByChannel = new Map<number, BoardModel[]>();
    for (const row of modelRows) {
      const model = toModel(row);
      const checks = checksByModel.get(model.id) ?? [];
      const boardModel: BoardModel = {
        id: model.id,
        model: model.model,
        displayName: model.displayName || model.model,
        stream: model.stream,
        timeoutSeconds: model.timeoutSeconds,
        intervalMinutes: model.intervalMinutes,
        lastRunAt: model.lastRunAt,
        nextRunAt: computeNextRunAt(
          model.lastRunAt,
          model.intervalMinutes,
          checks.length > 0,
        ),
        running: runtime.isBusy(model.id),
        checks,
      };
      const list = modelsByChannel.get(model.channelId);
      if (list) list.push(boardModel);
      else modelsByChannel.set(model.channelId, [boardModel]);
    }

    const channels: BoardChannel[] = channelRows.map((row) => ({
      id: row.id,
      name: row.name,
      endpointType: row.endpoint_type as EndpointType,
      models: modelsByChannel.get(row.id) ?? [],
    }));

    return {
      site: {
        title: settings.siteTitle,
        description: settings.siteDescription,
      },
      generatedAt: now.toISOString(),
      channels,
    };
  }
}
