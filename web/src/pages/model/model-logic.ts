/**
 * 模型详情页的纯逻辑：从看板数据里找到模型、读地址栏参数、拼接分页的历史记录。
 * 不碰 DOM 和 React，单独测试。
 */
import type {
  BoardChannel,
  BoardModel,
  BoardResponse,
  HistoryResponse,
  ResultDetail,
  ResultSummary,
} from "../../../../shared/types.ts";
import { formatDuration } from "../../lib/format";

/** 地址里的 id（路径段或查询参数）：正整数才算，其余一律当作没有 */
export function parseId(value: string | null | undefined): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  const id = Number(value);
  return id > 0 ? id : null;
}

/** 在看板数据里找模型和它所在的渠道；停用或删掉了就找不到 */
export function findModel(
  board: BoardResponse,
  modelId: number,
): { channel: BoardChannel; model: BoardModel } | null {
  for (const channel of board.channels) {
    const model = channel.models.find((item) => item.id === modelId);
    if (model) return { channel, model };
  }
  return null;
}

/** 某一次检测在详情页里的地址 */
export function resultPath(
  modelId: number,
  promptId: number,
  resultId: number,
): string {
  return `/models/${modelId}?prompt=${promptId}&result=${resultId}`;
}

/**
 * 看的是不是最新一次：没指定哪一次，或者指定的正好是最新那次。
 * 是的话直接用看板里的数据，检测中的流式输出也跟着实时走
 */
export function followsLatest(
  selectedId: number | null,
  latest: Pick<ResultDetail, "id"> | null,
): boolean {
  return selectedId === null || selectedId === latest?.id;
}

/** 列表里的一行，标题下那行小字：耗时、手动 */
export function runDescription(
  item: Pick<ResultSummary, "status" | "durationMs" | "trigger">,
): string {
  const parts: string[] = [];
  if (item.status === "running") parts.push("进行中");
  else if (item.durationMs !== null)
    parts.push(`耗时 ${formatDuration(item.durationMs)}`);
  if (item.trigger === "manual") parts.push("手动");
  return parts.join(" · ") || "—";
}

/** 已经拿到的历史记录：按 id 倒序 */
export interface HistoryList {
  items: ResultSummary[];
  /** 后面还有更早的、没拿过来的记录 */
  hasMore: boolean;
}

/** 一页拿多少条 */
export const HISTORY_PAGE_SIZE = 30;
/** 接口一次最多给多少条 */
export const HISTORY_MAX_LIMIT = 100;

/**
 * 有新结果、或者检测刚结束时重新拉列表，一次拉多少条：至少一页，已经加载了更多的就照原样多拉一些
 * （接口一次最多 100 条）。拉回来的直接换掉旧列表：旧列表里可能有已经被保留条数挤掉的记录，
 * 页面在后台放久了也可能和新的一页接不上，拼起来反而会多出不存在的、或者漏掉中间的
 */
export function refreshLimit(loaded: number): number {
  return Math.min(Math.max(HISTORY_PAGE_SIZE, loaded), HISTORY_MAX_LIMIT);
}

/**
 * "加载更多"拿到的更早一页（请求时用的是 before）接在后面。请求在路上时列表刷新过、
 * 最早的一条已经不是 before 了，这一页就不要了：接上去可能漏掉中间的记录，再点一次就好
 */
export function appendPage(
  current: HistoryList,
  page: HistoryResponse,
  before: number,
): HistoryList {
  if (!current.hasMore || current.items.at(-1)?.id !== before) return current;
  return {
    items: [...current.items, ...page.items.filter((item) => item.id < before)],
    hasMore: page.hasMore,
  };
}
