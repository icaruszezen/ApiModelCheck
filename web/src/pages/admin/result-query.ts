/**
 * 检测记录页的筛选条件与地址栏参数互转，以及几个显示用的小函数。
 * 筛选条件放在地址栏里：模型页可以直接链到 /admin/results?modelId=…，刷新也不丢。
 */
import type { ResultStatus } from "../../../../shared/types.ts";

export const RESULTS_PAGE_SIZE = 20;

export const RESULT_STATUSES: readonly ResultStatus[] = [
  "success",
  "error",
  "timeout",
  "running",
];

/** 状态筛选的选项，"all" 表示不限 */
export const STATUS_FILTER_OPTIONS: readonly {
  value: ResultStatus | "all";
  label: string;
}[] = [
  { value: "all", label: "全部" },
  { value: "success", label: "成功" },
  { value: "error", label: "失败" },
  { value: "timeout", label: "超时" },
  { value: "running", label: "检测中" },
];

export interface ResultsQuery {
  modelId?: number;
  promptId?: number;
  status?: ResultStatus;
  /** 从 1 起 */
  page: number;
}

export function isResultStatus(value: unknown): value is ResultStatus {
  return (
    typeof value === "string" &&
    (RESULT_STATUSES as readonly string[]).includes(value)
  );
}

function positiveInt(value: string | null): number | undefined {
  if (value === null || !/^\d+$/.test(value.trim())) return undefined;
  const number = Number(value.trim());
  return Number.isSafeInteger(number) && number > 0 ? number : undefined;
}

/** 解析地址栏参数；不认识或不合法的值当作没传 */
export function parseResultsQuery(params: URLSearchParams): ResultsQuery {
  const status = params.get("status");
  return {
    modelId: positiveInt(params.get("modelId")),
    promptId: positiveInt(params.get("promptId")),
    status: isResultStatus(status) ? status : undefined,
    page: positiveInt(params.get("page")) ?? 1,
  };
}

/** 转回地址栏参数；第 1 页不写 page */
export function resultsQueryToParams(query: ResultsQuery): URLSearchParams {
  const params = new URLSearchParams();
  if (query.modelId !== undefined) params.set("modelId", String(query.modelId));
  if (query.promptId !== undefined) {
    params.set("promptId", String(query.promptId));
  }
  if (query.status !== undefined) params.set("status", query.status);
  if (query.page > 1) params.set("page", String(query.page));
  return params;
}

/** 改筛选条件：页码回到第 1 页 */
export function withFilter(
  query: ResultsQuery,
  patch: Partial<Omit<ResultsQuery, "page">>,
): ResultsQuery {
  return { ...query, ...patch, page: 1 };
}

export function pageCountOf(total: number, pageSize: number): number {
  if (!Number.isFinite(total) || total <= 0 || pageSize <= 0) return 1;
  return Math.ceil(total / pageSize);
}

/** "1,234 / 567"；两项都没有时 "—" */
export function tokensText(
  input: number | null,
  output: number | null,
  format: (value: number | null) => string,
): string {
  if (input === null && output === null) return "—";
  return `${format(input)} / ${format(output)}`;
}

/** 提示词超过这么多行或这么多字时默认收起 */
export function isLongText(
  text: string,
  maxLines = 6,
  maxChars = 400,
): boolean {
  if (text.length > maxChars) return true;
  let lines = 1;
  for (const char of text) {
    if (char === "\n" && ++lines > maxLines) return true;
  }
  return false;
}

/**
 * 翻页后要不要把表格上面那一行（记录数、刷新按钮）滚回来：它的上缘已经高过
 * scroll-margin-top（窄于 1280px 时那里压着吸顶的顶栏），就是看不见或被顶栏挡住了
 */
export function shouldScrollToTableTop(
  top: number,
  scrollMarginTop: number,
): boolean {
  return top < scrollMarginTop;
}
