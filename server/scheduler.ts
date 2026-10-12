/**
 * 调度与检测：定时找出到期的模型放进队列，按 max_concurrency 并发执行；
 * 同一个模型的各条提示词依次检测，免得触发上游限流。
 */
import type { CompletionRequest, CompletionResult } from "./providers/types.ts";
import { ProviderError } from "./providers/types.ts";
import { runCompletion } from "./providers/index.ts";
import type { ResultTrigger } from "../shared/types.ts";
import { LiveOutputs, type LiveOutput } from "./live.ts";
import {
  STOPPED_MESSAGE,
  type ChannelRecord,
  type FinishedResult,
  type ModelRecord,
  type PromptRecord,
  type Repo,
  type RuntimeView,
} from "./repo.ts";

export type CompleteFn = (
  request: CompletionRequest,
) => Promise<CompletionResult>;

export interface SchedulerLogger {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
}

export interface SchedulerOptions {
  repo: Repo;
  /** 发一次生成请求；默认是真正的 providers 实现，测试时注入假的 */
  complete?: CompleteFn;
  now?: () => Date;
  /** 多久检查一次是否有到期的模型，默认 15 秒 */
  tickMs?: number;
  logger?: SchedulerLogger;
}

export interface TriggerResult {
  queued: boolean;
}

export interface Scheduler extends RuntimeView {
  /** 立即检查一次，然后按 tickMs 定时检查 */
  start(): void;
  /** 检查一次到期的模型并放进队列 */
  tick(): void;
  /** 管理员"立即检测"：没在跑就排到队首；promptId 只检测这一条 */
  trigger(modelId: number, promptId?: number): TriggerResult;
  /** 模型被删除：中止它正在进行的检测，并移出队列 */
  cancelModel(modelId: number): void;
  /** 提示词被删除：中止正在检测它的请求（这一轮的其余提示词照常进行） */
  cancelPrompt(promptId: number): void;
  /** 队列为空且没有在跑的检测时 resolve */
  idle(): Promise<void>;
  /**
   * 停止定时器、清空队列、中止所有进行中的检测并记为 error，等它们都写完库；
   * 被打断的模型清空上次检测时间，下次启动后马上重测
   */
  stop(): Promise<void>;
}

/** HTTP 路由需要的那部分调度器能力 */
export type SchedulerControl = Pick<
  Scheduler,
  "trigger" | "cancelModel" | "cancelPrompt" | "isBusy" | "getLive"
>;

export { RESTART_MESSAGE, STOPPED_MESSAGE } from "./repo.ts";

interface QueuedJob {
  modelId: number;
  promptId?: number;
  trigger: ResultTrigger;
}

type AbortCause = "timeout" | "stopped" | "deleted";

interface ActiveCheck {
  promptId: number;
  resultId: number;
  controller: AbortController;
  cause: AbortCause | null;
}

interface RunningJob {
  modelId: number;
  /** 模型被删除或服务停止后，这一轮不再继续 */
  cancelled: AbortCause | null;
  current: ActiveCheck | null;
  done: Promise<void>;
}

const MAX_TIMER_MS = 2_147_483_647;

/** 基础地址路径里常见的、不算机密的段（小写）；v1、v1beta 这类版本号另外判断 */
const GENERIC_PATH_SEGMENTS = new Set([
  "api",
  "openai",
  "anthropic",
  "gemini",
  "google-ai-studio",
  "chat",
  "completions",
  "responses",
  "messages",
  "models",
  "compatible-mode",
  "openapi",
  "paas",
  "beta",
  "coding",
  "inference",
  "deployments",
  "proxy",
]);
const VERSION_SEGMENT = /^v\d+(?:(?:alpha|beta)\d*)?$/i;

/**
 * 把错误信息里的机密替换成 ***，免得在前台泄露：密钥、额外请求头的值，以及基础地址本身和
 * 它的主机名、用户名密码、查询串、路径里不常见的段（中转站常把账号、令牌放在路径或 ?key= 里）。
 */
export function scrubSecrets(
  text: string,
  channel: Pick<ChannelRecord, "apiKey" | "baseUrl" | "extraHeaders">,
): string {
  // length 只用来排序，source 是正则
  const patterns: { length: number; source: string }[] = [];
  const add = (secret: string, source = escapeRegExp(secret)) => {
    if (secret) patterns.push({ length: secret.length, source });
  };
  if (channel.apiKey.length >= 6) add(channel.apiKey);
  for (const value of Object.values(channel.extraHeaders)) {
    if (value.length >= 6) add(value);
  }
  const raw = channel.baseUrl.trim();
  let url: URL | null = null;
  try {
    url = raw ? new URL(raw) : null;
  } catch {
    // 地址不合法就没有可替换的
  }
  if (url) {
    add(raw.replace(/\/+$/, ""));
    add(url.href.replace(/\/+$/, ""));
    const host = url.hostname.replace(/^\[|\]$/g, "");
    if (host) add(host, hostPattern(host));
    for (const part of [url.username, url.password]) {
      for (const value of new Set([part, safeDecode(part)])) {
        if (value.length >= 3) add(value, tokenPattern(value));
      }
    }
    if (url.search.length > 1) {
      add(url.search);
      for (const pair of url.search.slice(1).split("&")) {
        // 没有 = 的整段也算值
        const value = pair.slice(pair.indexOf("=") + 1);
        const decoded = safeDecode(value.replace(/\+/g, " "));
        for (const v of new Set([value, decoded])) {
          if (v.length >= 6) add(v, tokenPattern(v));
        }
      }
    }
    for (const segment of url.pathname.split("/")) {
      for (const value of new Set([segment, safeDecode(segment)])) {
        if (value.length < 3 || isGenericSegment(value)) continue;
        add(value, tokenPattern(value));
      }
    }
  }
  // 先替换长的，免得短的是长的一部分时留下残片
  patterns.sort((a, b) => b.length - a.length);
  let out = text;
  for (const { source } of patterns) {
    out = out.replace(new RegExp(source, "gi"), "***");
  }
  return out;
}

function isGenericSegment(segment: string): boolean {
  return (
    GENERIC_PATH_SEGMENTS.has(segment.toLowerCase()) ||
    VERSION_SEGMENT.test(segment)
  );
}

/** 长的按子串替换；短的只替换前后不挨着字母数字的完整片段，免得把普通单词改坏 */
function tokenPattern(token: string): string {
  const escaped = escapeRegExp(token);
  return token.length >= 8 ? escaped : `(?<![\\w-])${escaped}(?![\\w-])`;
}

function hostPattern(host: string): string {
  const escaped = escapeRegExp(host);
  if (/[.:]/.test(host)) return `(?<![\\w-])${escaped}(?![\\w-])`;
  // 不带点的主机名（如 docker 里的服务名 api）常和普通单词重合，只替换地址里的：
  // 跟在 // 或 @ 后面，或者后面紧跟 :端口 或 /
  return `(?<=//|@)${escaped}(?![\\w-]|\\.[\\w-])|(?<![\\w.-])${escaped}(?=:\\d|/)`;
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function errorText(err: unknown): string {
  if (err instanceof ProviderError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  return `出错了：${message}`;
}

/**
 * 等 promise，但 signal 中止时立刻以中止原因拒绝——上游实现万一没响应 signal，调度器也不会卡住。
 */
function raceAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    promise.catch(() => {});
    return Promise.reject(signal.reason);
  }
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (err: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
}

const consoleLogger: SchedulerLogger = {
  info: (message) => console.log(`[scheduler] ${message}`),
  warn: (message) => console.warn(`[scheduler] ${message}`),
  error: (message, err) => console.error(`[scheduler] ${message}`, err ?? ""),
};

export function createScheduler(options: SchedulerOptions): Scheduler {
  const { repo } = options;
  const complete = options.complete ?? runCompletion;
  const now = options.now ?? (() => new Date());
  const tickMs = options.tickMs ?? 15_000;
  const logger = options.logger ?? consoleLogger;

  const live = new LiveOutputs();
  const queue: QueuedJob[] = [];
  const running = new Map<number, RunningJob>();
  let timer: ReturnType<typeof setInterval> | null = null;
  let stopped = false;
  let idleWaiters: (() => void)[] = [];

  function isBusy(modelId: number): boolean {
    return running.has(modelId) || queue.some((job) => job.modelId === modelId);
  }

  function notifyIdle(): void {
    if (queue.length > 0 || running.size > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  function maxConcurrency(): number {
    try {
      return repo.getSettings().maxConcurrency;
    } catch {
      return 1;
    }
  }

  function pump(): void {
    if (stopped) {
      notifyIdle();
      return;
    }
    const limit = maxConcurrency();
    while (running.size < limit && queue.length > 0) {
      const job = queue.shift()!;
      // 队列里同一个模型最多一项，但防御一下：已经在跑就丢掉
      if (running.has(job.modelId)) continue;
      startJob(job);
    }
    notifyIdle();
  }

  function startJob(job: QueuedJob): void {
    const state: RunningJob = {
      modelId: job.modelId,
      cancelled: null,
      current: null,
      done: Promise.resolve(),
    };
    running.set(job.modelId, state);
    state.done = runRound(job, state)
      .catch((err: unknown) => {
        logger.error(`模型 #${job.modelId} 的检测出现意外错误`, err);
      })
      .finally(() => {
        running.delete(job.modelId);
        pump();
      });
  }

  async function runRound(job: QueuedJob, state: RunningJob): Promise<void> {
    // 每轮开始时重新读配置：检测进行中改了配置，从下一轮生效
    const config = repo.getRunConfig(job.modelId);
    if (!config) return;
    const { model, channel } = config;
    // 排队期间被停用的模型不再定时检测；管理员手动触发的照常执行
    if (job.trigger === "schedule" && (!model.enabled || !channel.enabled))
      return;
    let prompts = config.prompts;
    if (job.promptId !== undefined) {
      prompts = prompts.filter((prompt) => prompt.id === job.promptId);
    }
    if (prompts.length === 0) return;

    repo.setLastRunAt(model.id, now().toISOString());

    for (const prompt of prompts) {
      if (state.cancelled) break;
      // 提示词在这一轮中途被删了：跳过（插入记录会违反外键）
      if (!repo.getPrompt(prompt.id)) continue;
      await runCheck(job, state, config.channel, model, prompt);
    }
  }

  async function runCheck(
    job: QueuedJob,
    state: RunningJob,
    channel: ChannelRecord,
    model: ModelRecord,
    prompt: PromptRecord,
  ): Promise<void> {
    const startedAt = now();
    const resultId = repo.insertRunningResult({
      modelId: model.id,
      promptId: prompt.id,
      promptSnapshot: prompt.content,
      stream: model.stream,
      startedAt: startedAt.toISOString(),
      trigger: job.trigger,
    });
    live.start(resultId);

    const controller = new AbortController();
    const check: ActiveCheck = {
      promptId: prompt.id,
      resultId,
      controller,
      cause: null,
    };
    state.current = check;

    const timeout = setTimeout(
      () => {
        if (check.cause) return;
        check.cause = "timeout";
        controller.abort(new Error("timeout"));
      },
      Math.min(model.timeoutSeconds * 1000, MAX_TIMER_MS),
    );

    let firstTokenMs: number | null = null;
    const onDelta = (delta: { output?: string; reasoning?: string }) => {
      // 中止后迟到的增量不再计入
      if (controller.signal.aborted) return;
      if (firstTokenMs === null && (delta.output || delta.reasoning)) {
        firstTokenMs = Math.max(0, now().getTime() - startedAt.getTime());
      }
      live.append(resultId, delta);
    };

    let finished: FinishedResult;
    try {
      const result = await raceAbort(
        complete({
          endpointType: channel.endpointType,
          baseUrl: channel.baseUrl,
          apiKey: channel.apiKey,
          extraHeaders: channel.extraHeaders,
          model: model.model,
          prompt: prompt.content,
          stream: model.stream,
          maxTokens: model.maxTokens,
          temperature: model.temperature,
          signal: controller.signal,
          onDelta,
        }),
        controller.signal,
      );
      const finishedAt = now();
      finished = {
        status: "success",
        output: result.output,
        reasoning: result.reasoning,
        error: null,
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        firstTokenMs,
        inputTokens: result.inputTokens,
        outputTokens: result.outputTokens,
        finishReason: result.finishReason,
      };
    } catch (err) {
      const finishedAt = now();
      const partial = live.get(resultId) ?? { output: "", reasoning: "" };
      const cause = check.cause;
      let status: FinishedResult["status"] = "error";
      let message: string;
      if (cause === "timeout") {
        status = "timeout";
        message = `超过 ${model.timeoutSeconds} 秒没有完成`;
      } else if (cause === "stopped") {
        message = STOPPED_MESSAGE;
      } else if (cause === "deleted") {
        message = "检测已取消";
      } else {
        message = errorText(err);
      }
      finished = {
        status,
        output: partial.output,
        reasoning: partial.reasoning,
        error: scrubSecrets(message, channel),
        finishedAt: finishedAt.toISOString(),
        durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
        firstTokenMs,
        inputTokens: null,
        outputTokens: null,
        finishReason: null,
      };
    } finally {
      clearTimeout(timeout);
      state.current = null;
    }

    try {
      // 记录可能已随模型 / 提示词一起被删掉，这时 UPDATE 不影响任何行
      repo.finishResult(resultId, finished);
      if (finished.status !== "success" && check.cause !== "deleted") {
        logger.warn(
          `模型 ${model.model}（#${model.id}）× 提示词 #${prompt.id}：${finished.error ?? finished.status}`,
        );
      }
      repo.pruneResults(
        model.id,
        prompt.id,
        repo.getSettings().retentionPerCheck,
      );
    } finally {
      live.delete(resultId);
    }
  }

  function tick(): void {
    if (stopped) return;
    let candidates;
    try {
      candidates = repo.listDueCandidates();
    } catch (err) {
      logger.error("读取待检测模型失败", err);
      return;
    }
    const nowMs = now().getTime();
    for (const candidate of candidates) {
      if (isBusy(candidate.id)) continue;
      if (candidate.lastRunAt !== null) {
        const last = Date.parse(candidate.lastRunAt);
        if (
          !Number.isNaN(last) &&
          nowMs < last + candidate.intervalMinutes * 60_000
        ) {
          continue;
        }
      }
      queue.push({ modelId: candidate.id, trigger: "schedule" });
    }
    pump();
  }

  function trigger(modelId: number, promptId?: number): TriggerResult {
    if (stopped || isBusy(modelId)) return { queued: false };
    const job: QueuedJob = { modelId, trigger: "manual" };
    if (promptId !== undefined) job.promptId = promptId;
    queue.unshift(job);
    pump();
    return { queued: true };
  }

  function abortJob(state: RunningJob, cause: AbortCause): void {
    if (!state.cancelled) state.cancelled = cause;
    const current = state.current;
    if (current && !current.cause) {
      current.cause = cause;
      current.controller.abort(new Error(cause));
    }
  }

  function removeQueued(modelId: number): void {
    for (let i = queue.length - 1; i >= 0; i--) {
      if (queue[i]!.modelId === modelId) queue.splice(i, 1);
    }
  }

  function cancelModel(modelId: number): void {
    removeQueued(modelId);
    const state = running.get(modelId);
    if (state) abortJob(state, "deleted");
    notifyIdle();
  }

  function cancelPrompt(promptId: number): void {
    for (const state of running.values()) {
      const current = state.current;
      if (current && current.promptId === promptId && !current.cause) {
        current.cause = "deleted";
        current.controller.abort(new Error("deleted"));
      }
    }
  }

  function start(): void {
    if (stopped || timer) return;
    tick();
    timer = setInterval(tick, tickMs);
    // 定时器不阻止进程退出：进程的存活由 HTTP 服务决定
    timer.unref?.();
  }

  function idle(): Promise<void> {
    if (queue.length === 0 && running.size === 0) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  async function stop(): Promise<void> {
    stopped = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    queue.length = 0;
    const pending: Promise<void>[] = [];
    // 因为停止而没跑完这一轮的模型
    const interrupted: number[] = [];
    for (const state of running.values()) {
      if (!state.cancelled) interrupted.push(state.modelId);
      abortJob(state, "stopped");
      pending.push(state.done);
    }
    await Promise.all(pending);
    // 清空它们的上次检测时间：下次启动后第一次检查就重新检测，不用等满一个间隔
    for (const modelId of interrupted) {
      try {
        repo.setLastRunAt(modelId, null);
      } catch (err) {
        logger.error(`清空模型 #${modelId} 的上次检测时间失败`, err);
      }
    }
    notifyIdle();
  }

  return {
    start,
    tick,
    trigger,
    cancelModel,
    cancelPrompt,
    idle,
    stop,
    isBusy,
    getLive: (resultId: number): LiveOutput | undefined => live.get(resultId),
  };
}
