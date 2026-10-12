/**
 * 前台检测页和模型详情页共用的纯逻辑：刷新节奏、统计数字、每条检测题此刻该显示什么。
 * 不碰 DOM 和 React，单独测试。
 */
import type {
  BoardCheck,
  BoardModel,
  BoardResponse,
  ResultDetail,
  ResultStatus,
} from "../../../../shared/types.ts";
import {
  formatDateTime,
  formatDuration,
  formatNumber,
  formatRelative,
} from "../../lib/format";

/* ------------------------------------------------------------------ */
/* 刷新节奏                                                            */
/* ------------------------------------------------------------------ */

/** 平时的刷新间隔 */
export const POLL_IDLE_MS = 30_000;
/** 有检测在进行时的刷新间隔：要能跟上流式输出 */
export const POLL_ACTIVE_MS = 3_000;
/** 一份数据都还没拿到时，失败后重试的起步间隔 */
export const POLL_RETRY_MS = 5_000;
/** 连续失败时退避的上限 */
export const POLL_MAX_BACKOFF_MS = 60_000;

/**
 * 定时检测的时间过了这么久还没开始，就不再为它快刷新：调度器卡住或者停了的时候，
 * 不至于一直 3 秒拉一次
 */
export const POLL_DUE_GRACE_MS = 120_000;
/** 到点之后再等这么一点才去拉：调度器到点才排上，一到点就拉多半还看不到它开始 */
const POLL_DUE_LEAD_MS = 2_000;

/** 有没有任何模型在检测（含排队）或任何一条记录还在进行 */
export function isBoardActive(board: BoardResponse | undefined): boolean {
  if (!board) return false;
  return board.channels.some((channel) =>
    channel.models.some(
      (model) =>
        model.running ||
        model.checks.some((check) => check.latest?.status === "running"),
    ),
  );
}

/**
 * 没有检测在进行时等多久：快到哪个模型的下次检测时间了，就在到点后不久拉一次；
 * 已经到点、还没开始的，按检测中的间隔拉，好赶上它开始。到点太久还没开始的不算。
 * now 是按服务器时钟校正过的当前时间。
 */
function idlePollDelay(board: BoardResponse, now: number): number {
  let delay = POLL_IDLE_MS;
  for (const channel of board.channels) {
    for (const model of channel.models) {
      if (model.checks.length === 0 || !model.nextRunAt) continue;
      const wait = Date.parse(model.nextRunAt) - now;
      if (Number.isNaN(wait) || wait < -POLL_DUE_GRACE_MS) continue;
      delay = Math.min(
        delay,
        Math.max(POLL_ACTIVE_MS, wait + POLL_DUE_LEAD_MS),
      );
    }
  }
  return delay;
}

/**
 * 下一次刷新等多久。连续失败时按 2 的幂退避（不低于正常间隔、不超过上限），
 * 免得服务器挂了的时候每 3 秒打一次。now 是按服务器时钟校正过的当前时间。
 */
export function nextPollDelay(
  board: BoardResponse | undefined,
  failures: number,
  now: number,
): number {
  const base =
    board === undefined
      ? POLL_RETRY_MS
      : isBoardActive(board)
        ? POLL_ACTIVE_MS
        : idlePollDelay(board, now);
  if (!(failures > 0)) return base;
  return Math.max(base, Math.min(base * 2 ** failures, POLL_MAX_BACKOFF_MS));
}

/**
 * 服务器时钟比浏览器快多少毫秒。"下次检测：3 分钟后"这类相对时间按服务器的时钟算，
 * 访客电脑的时间不准也不会显示成负数。一秒以内的差多半是网络延迟，不纠正。
 */
export function clockOffset(serverIso: string, receivedAt: number): number {
  const server = Date.parse(serverIso);
  if (!Number.isFinite(server) || !Number.isFinite(receivedAt)) return 0;
  const diff = server - receivedAt;
  return Math.abs(diff) < 1_000 ? 0 : diff;
}

/* ------------------------------------------------------------------ */
/* 统计                                                                */
/* ------------------------------------------------------------------ */

export interface BoardStats {
  channels: number;
  models: number;
  /** 所有模型分到的检测题，按提示词去重 */
  prompts: number;
  /** 正在检测（含排队）的模型数 */
  running: number;
  /** 最近一次检测开始的时间；一次都没有时是 null */
  lastCheckAt: string | null;
}

/** 两个 ISO 时间里较晚的那个；解析不了的当作不存在 */
function laterIso(
  a: string | null,
  b: string | null | undefined,
): string | null {
  if (!b) return a;
  const tb = Date.parse(b);
  if (Number.isNaN(tb)) return a;
  if (!a) return b;
  return tb > Date.parse(a) ? b : a;
}

export function computeBoardStats(board: BoardResponse): BoardStats {
  let models = 0;
  let running = 0;
  let lastCheckAt: string | null = null;
  const prompts = new Set<number>();
  for (const channel of board.channels) {
    for (const model of channel.models) {
      models += 1;
      if (model.running) running += 1;
      lastCheckAt = laterIso(lastCheckAt, model.lastRunAt);
      for (const check of model.checks) {
        prompts.add(check.prompt.id);
        lastCheckAt = laterIso(lastCheckAt, check.latest?.startedAt);
      }
    }
  }
  return {
    channels: board.channels.length,
    models,
    prompts: prompts.size,
    running,
    lastCheckAt,
  };
}

/**
 * 把相对时间拆成"数字 + 单位"，给统计块用：
 * "3 分钟前" → { value: "3", unit: "分钟前" }；"刚刚" → { value: "刚刚", unit: null }。
 */
export function relativeParts(
  iso: string | null | undefined,
  now: number,
): { value: string; unit: string | null } {
  const text = formatRelative(iso, now);
  const match = /^(\d+) (.+)$/.exec(text);
  return match
    ? { value: match[1]!, unit: match[2]! }
    : { value: text, unit: null };
}

/* ------------------------------------------------------------------ */
/* 模型卡                                                              */
/* ------------------------------------------------------------------ */

export const STATUS_LABEL: Record<ResultStatus, string> = {
  running: "检测中",
  success: "成功",
  error: "失败",
  timeout: "超时",
};

/** 卡片标题：显示名；和模型 ID 不同时另给出模型 ID */
export function modelHeading(
  model: Pick<BoardModel, "model" | "displayName">,
): {
  title: string;
  modelId: string | null;
} {
  const id = model.model.trim();
  const name = model.displayName.trim();
  if (!name || name === id) return { title: id || model.model, modelId: null };
  return { title: name, modelId: id };
}

export type NextRunInfo =
  /** 这一轮正在进行或排队 */
  | { state: "running" }
  /** 没有分到可检测的提示词，不会检测 */
  | { state: "idle" }
  /** 还没检测过，等调度器排上 */
  | { state: "pending" }
  /** 时间已到（或不到一分钟），等调度器排上 */
  | { state: "due"; at: string }
  | { state: "scheduled"; at: string; relative: string };

/** 不到这个时间就说"即将开始"：调度器每 15 秒才看一次，精确到秒反而像出了错 */
const DUE_WITHIN_MS = 45_000;

export function describeNextRun(
  model: Pick<BoardModel, "running" | "nextRunAt" | "checks">,
  now: number,
): NextRunInfo {
  if (model.running) return { state: "running" };
  if (model.checks.length === 0) return { state: "idle" };
  if (!model.nextRunAt) return { state: "pending" };
  const at = Date.parse(model.nextRunAt);
  if (Number.isNaN(at)) return { state: "pending" };
  if (at - now <= DUE_WITHIN_MS) return { state: "due", at: model.nextRunAt };
  return {
    state: "scheduled",
    at: model.nextRunAt,
    relative: formatRelative(model.nextRunAt, now),
  };
}

/** "下次检测："后面的那几个字 */
export function nextRunText(info: NextRunInfo): string {
  switch (info.state) {
    case "running":
      return "检测中";
    case "idle":
      return "没有检测题";
    case "pending":
      return "等待首次检测";
    case "due":
      return "即将开始";
    case "scheduled":
      return info.relative;
  }
}

/**
 * 这一轮里正在检测的那条题；模型标着在跑却一条都没在进行时（还在排队）是 null。
 * 同一个模型的题是依次检测的，所以至多一条。
 */
export function runningCheck(
  model: Pick<BoardModel, "checks">,
): BoardCheck | null {
  for (const check of model.checks) {
    if (check.latest?.status === "running") return check;
  }
  return null;
}

/** 页签上的状态记号：最近一条记录的状态，从没检测过是 null */
export function checkMark(check: BoardCheck): ResultStatus | null {
  return check.latest?.status ?? null;
}

/** 当前选中的页签还在就保留，否则回到第一条（检测题被删掉或停用之后） */
export function pickTab(
  checks: readonly BoardCheck[],
  current: string | null,
): string | null {
  if (
    current !== null &&
    checks.some((check) => String(check.prompt.id) === current)
  ) {
    return current;
  }
  const first = checks[0];
  return first ? String(first.prompt.id) : null;
}

/* ------------------------------------------------------------------ */
/* 一条检测题                                                          */
/* ------------------------------------------------------------------ */

export type CheckDisplay =
  /** 从没检测过 */
  | { kind: "never" }
  /** 流式检测进行中：显示实时输出 */
  | { kind: "live"; result: ResultDetail }
  /** 非流式检测进行中：拿不到中间结果，先显示上一次的（可能没有） */
  | { kind: "rerun"; running: ResultDetail; result: ResultDetail | null }
  /** 已经结束的最近一次 */
  | { kind: "done"; result: ResultDetail };

export function resolveCheckDisplay(
  check: Pick<BoardCheck, "latest" | "previous">,
): CheckDisplay {
  const { latest, previous } = check;
  if (!latest) return { kind: "never" };
  if (latest.status !== "running") return { kind: "done", result: latest };
  // 用这条记录自己的 stream：检测中途改了模型设置，从下一轮才生效
  if (latest.stream) return { kind: "live", result: latest };
  return { kind: "rerun", running: latest, result: previous };
}

export interface MetaItem {
  key: string;
  label: string;
  value: string;
}

/** 检测信息行（时间、耗时、首字延迟、tokens、结束原因）。检测中的耗时由调用方按时钟另算 */
export function resultMeta(result: ResultDetail): MetaItem[] {
  const items: MetaItem[] = [
    {
      key: "startedAt",
      label: "检测时间",
      value: formatDateTime(result.startedAt),
    },
  ];
  if (result.status !== "running" && result.durationMs !== null) {
    items.push({
      key: "duration",
      label: "耗时",
      value: formatDuration(result.durationMs),
    });
  }
  if (result.stream && result.firstTokenMs !== null) {
    items.push({
      key: "firstToken",
      label: "首字延迟",
      value: formatDuration(result.firstTokenMs),
    });
  }
  if (result.inputTokens !== null || result.outputTokens !== null) {
    items.push({
      key: "tokens",
      label: "输入 / 输出 tokens",
      value: `${formatNumber(result.inputTokens)} / ${formatNumber(result.outputTokens)}`,
    });
  }
  const finish = result.finishReason?.trim();
  if (finish) items.push({ key: "finish", label: "结束原因", value: finish });
  return items;
}

/** 从开始到现在过了多久，"12.3 秒" */
export function elapsedText(startedAt: string, now: number): string {
  const start = Date.parse(startedAt);
  if (Number.isNaN(start)) return "—";
  return formatDuration(Math.max(0, now - start));
}

/** 有没有可以展示的输出（正文或思考过程） */
export function hasOutput(
  result: Pick<ResultDetail, "output" | "reasoning">,
): boolean {
  return result.output.trim() !== "" || result.reasoning.trim() !== "";
}

/**
 * 这次结果用的提示词和现在配置的不一样时（管理员改过题），返回当时的版本；一样就是 null。
 * 只差首尾空白不算改过。
 */
export function changedSnapshot(
  current: string,
  result: Pick<ResultDetail, "promptSnapshot"> | null | undefined,
): string | null {
  if (!result) return null;
  return result.promptSnapshot.trim() === current.trim()
    ? null
    : result.promptSnapshot;
}

/**
 * 最近一次记录的"版本"：id + 状态。变了说明有新结果，或者检测刚结束
 * （保留条数满了的时候，旧记录就在这一刻被删掉）。从没检测过是 null
 */
export function latestVersion(
  latest: Pick<ResultDetail, "id" | "status"> | null | undefined,
): string | null {
  return latest ? `${latest.id}:${latest.status}` : null;
}

/* ------------------------------------------------------------------ */
/* 模型详情页                                                          */
/* ------------------------------------------------------------------ */

/** 模型详情页的地址；带上提示词就直接打开那道题 */
export function modelPath(modelId: number, promptId?: number): string {
  return promptId === undefined
    ? `/models/${modelId}`
    : `/models/${modelId}?prompt=${promptId}`;
}

/* ------------------------------------------------------------------ */
/* 页内目录                                                            */
/* ------------------------------------------------------------------ */

export const channelAnchor = (id: number) => `channel-${id}`;
export const modelAnchor = (id: number) => `model-${id}`;

export interface TocEntry {
  href: string;
  label: string;
  level: 1 | 2;
}

/** 目录：渠道一级，渠道下的模型二级 */
export function tocEntries(board: BoardResponse): TocEntry[] {
  const entries: TocEntry[] = [];
  for (const channel of board.channels) {
    entries.push({
      href: `#${channelAnchor(channel.id)}`,
      label: channel.name,
      level: 1,
    });
    for (const model of channel.models) {
      entries.push({
        href: `#${modelAnchor(model.id)}`,
        label: modelHeading(model).title,
        level: 2,
      });
    }
  }
  return entries;
}

/** 本地时间的"时:分:秒"，顶栏的"更新于"用 */
export function formatClock(ms: number): string {
  const date = new Date(ms);
  if (Number.isNaN(date.getTime())) return "—";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}
