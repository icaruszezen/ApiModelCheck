/**
 * 后台"检测记录"页：按模型、提示词、状态筛选每一次检测，展开一行看提示词和模型输出。
 * 筛选条件和页码都在地址栏里（模型页的"查看记录"链到 ?modelId=…）。
 */
import {
  Button,
  DropdownMenu,
  DropdownMenuItem,
  EmptyState,
  Field,
  IconButton,
  Pagination,
  Segment,
  SegmentedControl,
  Select,
  Spinner,
  Table,
  TableBody,
  TableCell,
  TableExpander,
  TableHead,
  TableHeaderCell,
  TableRow,
  Tag,
  Tooltip,
  useToast,
} from "@endfield-ui/react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import type { AdminResultRow } from "../../../../shared/types.ts";
import { adminApi } from "../../api/client";
import { RefreshIcon, TrashIcon } from "../../components/icons";
import { StatusTag } from "../../components/output/StatusTag";
import { formatDateTime, formatDuration, formatNumber } from "../../lib/format";
import { useAsync } from "../../lib/use-async";
import { useMediaQuery, useNow, usePolling } from "./model-hooks";
import { modelLabel } from "./model-list";
import { ResultDetailView } from "./result-detail";
import {
  RESULTS_PAGE_SIZE,
  STATUS_FILTER_OPTIONS,
  isResultStatus,
  pageCountOf,
  parseResultsQuery,
  resultsQueryToParams,
  shouldScrollToTableTop,
  tokensText,
  withFilter,
  type ResultsQuery,
} from "./result-query";
import {
  AdminPage,
  ConfirmDialog,
  errorMessage,
  STICKY_END_CELL,
  STICKY_END_HEAD,
  stickyEndHeadRef,
} from "./ui";

const RUNNING_POLL = 5_000;
const COLUMN_COUNT = 9;

type ClearScope = "model" | "all";

export function ResultsPage() {
  const toast = useToast();
  const [searchParams, setSearchParams] = useSearchParams();
  const query = useMemo(() => parseResultsQuery(searchParams), [searchParams]);
  const setQuery = (next: ResultsQuery) =>
    setSearchParams(resultsQueryToParams(next), { replace: true });

  const models = useAsync(() => adminApi.models(), []);
  const prompts = useAsync(() => adminApi.prompts(), []);
  // 记下每份数据是按哪组条件取的：换了条件、新数据还没回来时，旧的表格先变淡
  const queryKey = resultsQueryToParams(query).toString();
  const results = useAsync(async () => {
    const key = queryKey;
    const response = await adminApi.results({
      modelId: query.modelId,
      promptId: query.promptId,
      status: query.status,
      page: query.page,
      pageSize: RESULTS_PAGE_SIZE,
    });
    return { key, response };
  }, [queryKey]);

  const [expanded, setExpanded] = useState<ReadonlySet<number>>(new Set());
  const [deleteTarget, setDeleteTarget] = useState<AdminResultRow | null>(null);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [clearScope, setClearScope] = useState<ClearScope>("all");
  const [clearOpen, setClearOpen] = useState(false);
  const tableTopRef = useRef<HTMLDivElement>(null);

  const data = results.data?.response;
  const stale = results.data !== undefined && results.data.key !== queryKey;
  const rows = data?.items ?? [];
  const pageCount = pageCountOf(
    data?.total ?? 0,
    data?.pageSize ?? RESULTS_PAGE_SIZE,
  );
  const hasRunning = rows.some((row) => row.status === "running");
  usePolling(results.reload, hasRunning ? RUNNING_POLL : null);
  // 手机上：操作列已经钉在右边，时间列再冻结就只剩一条缝看中间的列；状态筛选也换成下拉
  const wide = useMediaQuery("(min-width: 40rem)");

  // 删光了最后一页（或者地址里的页码太大）：退到实际的最后一页。
  // 只看按当前条件取回的数据，否则新一页还没回来时会反复跳
  useEffect(() => {
    if (
      data &&
      !stale &&
      data.items.length === 0 &&
      data.total > 0 &&
      query.page > 1
    ) {
      setSearchParams(
        resultsQueryToParams({
          ...query,
          page: pageCountOf(data.total, data.pageSize),
        }),
        { replace: true },
      );
    }
  }, [data, stale, query, setSearchParams]);

  const modelItems = useMemo(() => {
    const items = [
      { value: "all", label: "全部模型" },
      ...(models.data ?? []).map((model) => ({
        value: String(model.id),
        label: `${model.channelName} / ${modelLabel(model)}`,
      })),
    ];
    // 地址里带的模型不在列表里（已删除，或列表还没载入）也要能显示出来
    if (
      query.modelId !== undefined &&
      !items.some((item) => item.value === String(query.modelId))
    ) {
      items.push({
        value: String(query.modelId),
        label: models.data
          ? `已删除的模型 #${query.modelId}`
          : `模型 #${query.modelId}`,
      });
    }
    return items;
  }, [models.data, query.modelId]);

  const promptItems = useMemo(() => {
    const items = [
      { value: "all", label: "全部提示词" },
      ...(prompts.data ?? []).map((prompt) => ({
        value: String(prompt.id),
        label: prompt.enabled ? prompt.title : `${prompt.title}（已停用）`,
      })),
    ];
    if (
      query.promptId !== undefined &&
      !items.some((item) => item.value === String(query.promptId))
    ) {
      items.push({
        value: String(query.promptId),
        label: prompts.data
          ? `已删除的提示词 #${query.promptId}`
          : `提示词 #${query.promptId}`,
      });
    }
    return items;
  }, [prompts.data, query.promptId]);

  const currentModel = models.data?.find((model) => model.id === query.modelId);
  const currentModelName = currentModel
    ? modelLabel(currentModel)
    : query.modelId !== undefined
      ? `模型 #${query.modelId}`
      : "";
  const filtering =
    query.modelId !== undefined ||
    query.promptId !== undefined ||
    query.status !== undefined;

  const setStatus = (value: string) =>
    setQuery(
      withFilter(query, {
        status: isResultStatus(value) ? value : undefined,
      }),
    );

  const goToPage = (page: number) => {
    setQuery({ ...query, page });
    const top = tableTopRef.current;
    if (!top) return;
    // 滚回去时停在哪由 scroll-margin-top 决定（顶栏的高度也算在里面），判断看不看得见也用它
    const margin = Number.parseFloat(getComputedStyle(top).scrollMarginTop);
    if (
      shouldScrollToTableTop(
        top.getBoundingClientRect().top,
        Number.isFinite(margin) ? margin : 0,
      )
    ) {
      top.scrollIntoView({ block: "start" });
    }
  };

  const setExpandedRow = (id: number, open: boolean) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (open) next.add(id);
      else next.delete(id);
      return next;
    });

  const confirmDelete = async () => {
    if (!deleteTarget) return;
    try {
      await adminApi.deleteResult(deleteTarget.id);
    } catch (error) {
      toast({ message: errorMessage(error), tone: "danger" });
      throw error;
    }
    setExpandedRow(deleteTarget.id, false);
    toast({ message: "已删除这条记录", tone: "success" });
    void results.reload();
  };

  const confirmClear = async () => {
    const modelId = clearScope === "model" ? query.modelId : undefined;
    let deleted: number;
    try {
      ({ deleted } = await adminApi.clearResults(modelId));
    } catch (error) {
      toast({ message: errorMessage(error), tone: "danger" });
      throw error;
    }
    toast({ message: `已删除 ${deleted} 条记录`, tone: "success" });
    setExpanded(new Set());
    if (query.page !== 1) setQuery({ ...query, page: 1 });
    else void results.reload();
  };

  const openClear = (scope: ClearScope) => {
    setClearScope(scope);
    setClearOpen(true);
  };

  let content;
  if (!data) {
    content = results.error ? (
      <EmptyState
        title="检测记录没有载入"
        description={errorMessage(results.error)}
        action={
          <Button variant="light" onClick={() => void results.reload()}>
            重试
          </Button>
        }
      />
    ) : (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-ink-secondary">
        <Spinner size="sm" label={null} />
        正在载入检测记录…
      </div>
    );
  } else {
    content = (
      <>
        <Table
          label="检测记录"
          stickyFirstColumn={wide}
          aria-busy={stale || undefined}
          className={
            stale ? "opacity-60 transition-opacity" : "transition-opacity"
          }
        >
          <TableHead>
            <TableRow>
              <TableHeaderCell>时间</TableHeaderCell>
              <TableHeaderCell>渠道 / 模型</TableHeaderCell>
              <TableHeaderCell>提示词</TableHeaderCell>
              <TableHeaderCell>状态</TableHeaderCell>
              <TableHeaderCell numeric>耗时</TableHeaderCell>
              <TableHeaderCell numeric>首字</TableHeaderCell>
              <TableHeaderCell numeric>Tokens（入 / 出）</TableHeaderCell>
              <TableHeaderCell>触发</TableHeaderCell>
              <TableHeaderCell
                align="end"
                className={STICKY_END_HEAD}
                ref={stickyEndHeadRef}
              >
                操作
              </TableHeaderCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.length === 0 && (
              <TableRow>
                <TableCell
                  colSpan={COLUMN_COUNT}
                  className="py-6 whitespace-normal"
                >
                  {filtering ? (
                    <EmptyState
                      bordered={false}
                      title="没有符合条件的记录"
                      description="换一个模型、提示词或状态，或者清掉筛选条件。"
                      action={
                        <Button
                          variant="light"
                          onClick={() => setQuery({ page: 1 })}
                        >
                          清除筛选
                        </Button>
                      }
                    />
                  ) : (
                    <EmptyState
                      bordered={false}
                      title="还没有检测记录"
                      description="模型检测过之后，每一次的提示词、输出和耗时都会记在这里。"
                    />
                  )}
                </TableCell>
              </TableRow>
            )}
            {rows.map((row) => (
              <ResultRow
                key={row.id}
                row={row}
                expanded={expanded.has(row.id)}
                onExpandedChange={(open) => setExpandedRow(row.id, open)}
                onRerun={() => void results.reload()}
                onDelete={() => {
                  setDeleteTarget(row);
                  setDeleteOpen(true);
                }}
              />
            ))}
          </TableBody>
        </Table>
        {pageCount > 1 && (
          <Pagination
            page={Math.min(query.page, pageCount)}
            pageCount={pageCount}
            onPageChange={goToPage}
            jump={pageCount > 10}
          />
        )}
      </>
    );
  }

  return (
    <AdminPage
      title="检测记录"
      meta="// RESULTS"
      description="每一次检测的提示词、模型输出、耗时与 tokens。展开一行查看完整内容。"
      actions={
        <DropdownMenu
          align="end"
          trigger={
            <Button variant="light" iconStart={<TrashIcon size={16} />}>
              清空记录
            </Button>
          }
        >
          {query.modelId !== undefined && (
            <DropdownMenuItem onClick={() => openClear("model")}>
              清空当前模型的记录
            </DropdownMenuItem>
          )}
          <DropdownMenuItem tone="danger" onClick={() => openClear("all")}>
            清空全部记录
          </DropdownMenuItem>
        </DropdownMenu>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end gap-x-4 gap-y-3 bg-surface-sunken p-4">
          <Field label="模型" className="w-full sm:w-64">
            <Select
              variant="outline"
              items={modelItems}
              value={
                query.modelId === undefined ? "all" : String(query.modelId)
              }
              onValueChange={(value) =>
                setQuery(
                  withFilter(query, {
                    modelId: value === "all" ? undefined : Number(value),
                  }),
                )
              }
            />
          </Field>
          <Field label="提示词" className="w-full sm:w-56">
            <Select
              variant="outline"
              items={promptItems}
              value={
                query.promptId === undefined ? "all" : String(query.promptId)
              }
              onValueChange={(value) =>
                setQuery(
                  withFilter(query, {
                    promptId: value === "all" ? undefined : Number(value),
                  }),
                )
              }
            />
          </Field>
          <Field label="状态" className={wide ? "max-w-full" : "w-full"}>
            {/* 五段在手机上放不下（"检测中"会被截成"检…"）：窄屏换成下拉 */}
            {wide ? (
              <SegmentedControl
                variant="outline"
                value={query.status ?? "all"}
                onValueChange={setStatus}
              >
                {STATUS_FILTER_OPTIONS.map((option) => (
                  <Segment key={option.value} value={option.value}>
                    {option.label}
                  </Segment>
                ))}
              </SegmentedControl>
            ) : (
              <Select
                variant="outline"
                items={STATUS_FILTER_OPTIONS}
                value={query.status ?? "all"}
                onValueChange={setStatus}
              />
            )}
          </Field>
        </div>

        {/* 窄于 1280px 时页面顶上吸着 56px 的顶栏：翻页滚回来时停在它下面 */}
        <div
          ref={tableTopRef}
          className="flex scroll-mt-18 flex-wrap items-center justify-between gap-x-4 gap-y-1 xl:scroll-mt-4"
        >
          <p
            role="status"
            className="flex min-h-5 flex-wrap items-center gap-x-2 text-sm text-ink-secondary"
          >
            {data && (
              <span>
                共 {formatNumber(data.total)} 条记录
                {pageCount > 1 &&
                  `，第 ${Math.min(query.page, pageCount)} / ${pageCount} 页`}
                {hasRunning && "，有检测正在进行，每 5 秒自动刷新"}
              </span>
            )}
            {stale && <Spinner size="sm" label={null} />}
            {results.error && data && (
              <span className="text-danger">
                刷新失败：{errorMessage(results.error)}
              </span>
            )}
          </p>
          <Tooltip content="刷新">
            <IconButton
              size="sm"
              aria-label="刷新检测记录"
              disabled={results.loading}
              onClick={() => void results.reload()}
            >
              <RefreshIcon size={16} />
            </IconButton>
          </Tooltip>
        </div>

        {content}
      </div>

      <ConfirmDialog
        open={deleteOpen}
        onOpenChange={setDeleteOpen}
        title="删除这条检测记录？"
        description={
          deleteTarget
            ? `${deleteTarget.modelLabel} ·「${deleteTarget.promptTitle}」· ${formatDateTime(deleteTarget.startedAt)}。删除后无法恢复。`
            : undefined
        }
        confirmLabel="删除"
        onConfirm={confirmDelete}
      />
      <ConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={
          clearScope === "model"
            ? `清空「${currentModelName}」的检测记录？`
            : "清空全部检测记录？"
        }
        description={
          clearScope === "model"
            ? "这个模型已经结束的检测记录都会删除，正在进行的不受影响。删除后无法恢复，前台也看不到了。"
            : "所有模型已经结束的检测记录都会删除，正在进行的不受影响。删除后无法恢复，前台也看不到了。"
        }
        confirmLabel={clearScope === "model" ? "清空" : "全部清空"}
        onConfirm={confirmClear}
      />
    </AdminPage>
  );
}

interface ResultRowProps {
  row: AdminResultRow;
  expanded: boolean;
  onExpandedChange: (open: boolean) => void;
  /** 在明细里点了"重新检测这一条"、已经排上之后 */
  onRerun: () => void;
  onDelete: () => void;
}

function ResultRow({
  row,
  expanded,
  onExpandedChange,
  onRerun,
  onDelete,
}: ResultRowProps) {
  const running = row.status === "running";
  const time = formatDateTime(row.startedAt);

  return (
    <TableRow
      detail={<ResultDetailView row={row} onRerun={onRerun} />}
      expanded={expanded}
      onExpandedChange={onExpandedChange}
    >
      <TableCell rowHeader className="font-normal">
        <span className="flex items-center gap-2">
          <TableExpander aria-label={`${time} 这次检测的明细`} />
          <time dateTime={row.startedAt} className="font-tech tabular-nums">
            {time}
          </time>
        </span>
      </TableCell>
      <TableCell className="whitespace-normal">
        <div className="flex max-w-56 min-w-32 flex-col">
          <span
            className="truncate text-xs text-ink-secondary"
            title={row.channelName}
          >
            {row.channelName}
          </span>
          <span className="wrap-anywhere">{row.modelLabel}</span>
        </div>
      </TableCell>
      <TableCell>
        <span className="block max-w-48 truncate" title={row.promptTitle}>
          {row.promptTitle}
        </span>
      </TableCell>
      <TableCell>
        <span title={row.error ?? undefined}>
          <StatusTag status={row.status} />
        </span>
      </TableCell>
      <TableCell numeric>
        {running ? (
          <Elapsed since={row.startedAt} />
        ) : (
          formatDuration(row.durationMs)
        )}
      </TableCell>
      <TableCell numeric>{formatDuration(row.firstTokenMs)}</TableCell>
      <TableCell numeric>
        {tokensText(row.inputTokens, row.outputTokens, formatNumber)}
      </TableCell>
      <TableCell>
        {row.trigger === "manual" ? (
          <Tag size="sm" variant="outline">
            手动
          </Tag>
        ) : (
          <span className="text-ink-secondary">定时</span>
        )}
      </TableCell>
      <TableCell align="end" className={STICKY_END_CELL}>
        {running ? (
          <IconButton size="sm" aria-label="检测中的记录不能删除" disabled>
            <TrashIcon size={16} />
          </IconButton>
        ) : (
          <Tooltip content="删除">
            <IconButton
              size="sm"
              aria-label={`删除 ${time} 的记录`}
              onClick={onDelete}
            >
              <TrashIcon size={16} />
            </IconButton>
          </Tooltip>
        )}
      </TableCell>
    </TableRow>
  );
}

/** 检测中的记录：已经进行了多久，每秒走一次（只有这一格跟着刷新） */
function Elapsed({ since }: { since: string }) {
  const now = useNow(1_000);
  const start = new Date(since).getTime();
  return (
    <span className="text-ink-secondary" title="已进行">
      {Number.isNaN(start) ? "—" : formatDuration(Math.max(0, now - start))}
    </span>
  );
}
