import {
  Alert,
  Button,
  EmptyState,
  List,
  ListRow,
  PageHeader,
  PageHeaderBack,
  Panel,
  PanelHeader,
  Skeleton,
  Spinner,
  Tab,
  TabList,
  TabPanel,
  Tabs,
  Tag,
  TagPair,
} from "@endfield-ui/react";
import { useEffect, useState, type ReactNode } from "react";
import { Link, useParams, useSearchParams } from "react-router";
import { ENDPOINT_META } from "../../../../shared/endpoints.ts";
import type {
  BoardChannel,
  BoardCheck,
  BoardModel,
  ResultDetail,
} from "../../../../shared/types.ts";
import { ApiRequestError, publicApi } from "../../api/client";
import { StatusTag } from "../../components/output/StatusTag";
import {
  formatDateTime,
  formatInterval,
  formatShortDateTime,
} from "../../lib/format";
import {
  STATUS_LABEL,
  changedSnapshot,
  checkMark,
  describeNextRun,
  elapsedText,
  latestVersion,
  modelAnchor,
  modelHeading,
  modelPath,
  nextRunText,
  pickTab,
  resolveCheckDisplay,
  runningCheck,
} from "../board/board-logic";
import { useNow } from "../board/now";
import { PromptBlock } from "../board/PromptBlock";
import {
  PublicShell,
  RetryButton,
  useDocumentTitle,
} from "../board/PublicShell";
import { LatestResult, ResultBody } from "../board/ResultBody";
import { StatusMark } from "../board/StatusMark";
import { useBoard } from "../board/use-board";
import { NotFoundPage } from "../NotFoundPage";
import {
  findModel,
  followsLatest,
  parseId,
  resultPath,
  runDescription,
} from "./model-logic";
import { useHistory, type HistoryFeed } from "./use-history";

/** 模型详情页（/models/:id）：一个模型各条检测题的全部历史记录 */
export function ModelPage() {
  const modelId = parseId(useParams().id);
  if (modelId === null) return <NotFoundPage />;
  // 换了模型就整页重来，上一个模型的页签、历史不带过去
  return <ModelPageContent key={modelId} modelId={modelId} />;
}

function ModelPageContent({ modelId }: { modelId: number }) {
  const feed = useBoard();
  const { data, error } = feed;
  const found = data ? findModel(data, modelId) : null;
  useDocumentTitle(
    found && data
      ? `${modelHeading(found.model).title} · ${data.site.title}`
      : data?.site.title,
  );

  let content: ReactNode;
  if (found) {
    content = <ModelView channel={found.channel} model={found.model} />;
  } else if (data) {
    content = (
      <EmptyState
        className="mt-6"
        title="找不到这个模型"
        description="它可能已经被管理员停用或删除了。"
        action={<Button render={<Link to="/" />}>回到检测页</Button>}
      />
    );
  } else if (error) {
    content = (
      <EmptyState
        className="mt-6"
        title="检测数据没能加载"
        description={
          <>
            {error.message}
            <span className="mt-1 block">页面会在后台自动重试。</span>
          </>
        }
        action={<RetryButton refresh={feed.refresh} />}
      />
    );
  } else {
    content = <ModelSkeleton />;
  }

  return <PublicShell feed={feed}>{content}</PublicShell>;
}

function ModelView({
  channel,
  model,
}: {
  channel: BoardChannel;
  model: BoardModel;
}) {
  const [params, setParams] = useSearchParams();
  const active = pickTab(model.checks, params.get("prompt"));
  const selectedId = parseId(params.get("result"));
  const { title, modelId } = modelHeading(model);
  const endpoint =
    ENDPOINT_META[channel.endpointType]?.short ?? channel.endpointType;

  let body: ReactNode;
  if (model.checks.length === 0) {
    body = (
      <EmptyState
        icon={null}
        title="这个模型还没有分配检测题"
        description="管理员分配检测题之后，检测记录会显示在这里。"
      />
    );
  } else if (model.checks.length === 1) {
    const check = model.checks[0]!;
    body = (
      <CheckHistory
        key={check.prompt.id}
        model={model}
        check={check}
        single
        selectedId={selectedId}
      />
    );
  } else {
    body = (
      <Tabs
        value={active ?? ""}
        // 换题时不带着上一道题选中的那一次；用 replace，后退键直接回到检测页
        onValueChange={(value) => setParams({ prompt: value }, { replace: true })}
        variant="block"
      >
        <TabList aria-label="检测题" className="border-b border-line">
          {model.checks.map((check) => {
            const mark = checkMark(check);
            return (
              <Tab key={check.prompt.id} value={String(check.prompt.id)}>
                <span className="inline-flex items-center gap-2">
                  <StatusMark status={mark} />
                  <span className="max-w-48 truncate" title={check.prompt.title}>
                    {check.prompt.title}
                  </span>
                  <span className="sr-only">
                    （{mark ? STATUS_LABEL[mark] : "还没有检测"}）
                  </span>
                </span>
              </Tab>
            );
          })}
        </TabList>
        {model.checks.map((check) => (
          <TabPanel
            key={check.prompt.id}
            value={String(check.prompt.id)}
            className="pt-6"
          >
            <CheckHistory
              model={model}
              check={check}
              single={false}
              selectedId={String(check.prompt.id) === active ? selectedId : null}
            />
          </TabPanel>
        ))}
      </Tabs>
    );
  }

  return (
    <>
      <PageHeader
        back={
          // 回到首页时直接滚到这个模型的卡片
          <PageHeaderBack
            aria-label="返回检测页"
            render={<Link to={`/#${modelAnchor(model.id)}`} />}
          />
        }
        meta={`// ${channel.name} · ${endpoint}`}
        title={<span className="wrap-anywhere">{title}</span>}
        description={
          modelId ? (
            <span className="font-mono wrap-anywhere">{modelId}</span>
          ) : undefined
        }
      >
        <div className="mt-2 flex flex-wrap items-center gap-x-6 gap-y-3">
          <div className="flex flex-wrap gap-2">
            <TagPair name="模式" value={model.stream ? "流式" : "非流式"} />
            <TagPair
              name="间隔"
              value={`每 ${formatInterval(model.intervalMinutes)}`}
            />
            <TagPair name="超时" value={`${model.timeoutSeconds} 秒`} />
          </div>
          <ScheduleLine model={model} />
        </div>
      </PageHeader>
      <div className="mt-10">{body}</div>
    </>
  );
}

/** 页头里的一行：检测中，或者下次什么时候检测。跟着时钟走 */
function ScheduleLine({ model }: { model: BoardModel }) {
  const now = useNow();
  const info = describeNextRun(model, now);
  if (info.state === "running") {
    const current = runningCheck(model);
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm">
        <Tag variant="accent" className="gap-2">
          <Spinner size="sm" label={null} />
          检测中
        </Tag>
        <span className="text-ink-secondary">
          {current?.latest ? (
            <>
              {model.checks.length > 1 && `「${current.prompt.title}」· `}
              <span className="font-tech tabular-nums">
                已进行 {elapsedText(current.latest.startedAt, now)}
              </span>
            </>
          ) : (
            "排队等待中"
          )}
        </span>
      </p>
    );
  }
  const at = "at" in info ? info.at : null;
  return (
    <p className="text-sm">
      <span className="text-ink-secondary">下次检测：</span>
      <span className="font-medium">{nextRunText(info)}</span>
      {at && (
        <time
          dateTime={at}
          title={formatDateTime(at)}
          className="ml-2 font-tech text-xs text-ink-tertiary tabular-nums"
        >
          {formatShortDateTime(at)}
        </time>
      )}
    </p>
  );
}

interface CheckHistoryProps {
  model: BoardModel;
  check: BoardCheck;
  /** 模型只有这一条检测题（没有页签）：题目标题写在提示词上面 */
  single: boolean;
  /** 地址栏里选中的那一次；没选是 null，看最新一次 */
  selectedId: number | null;
}

/** 一条检测题：提示词，左边是历次检测的列表，右边是选中的那一次 */
function CheckHistory({ model, check, single, selectedId }: CheckHistoryProps) {
  const latest = check.latest;
  const version = latestVersion(latest);
  const history = useHistory(model.id, check.prompt.id, version);
  const following = followsLatest(selectedId, latest);
  const picked = usePickedResult(
    following ? null : selectedId,
    version,
    model,
    check,
  );
  const display = resolveCheckDisplay(check);
  // 提示词跟着正在看的那次结果走：管理员改过题时，显示当时用的版本
  const shown = following
    ? display.kind === "never"
      ? null
      : display.result
    : picked.kind === "ready"
      ? picked.result
      : null;

  return (
    <div className="flex min-w-0 flex-col gap-6">
      <PromptBlock
        content={check.prompt.content}
        snapshot={changedSnapshot(check.prompt.content, shown)}
        title={single ? check.prompt.title : undefined}
      />
      <div className="grid min-w-0 grid-cols-1 items-start gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]">
        <HistoryPanel
          history={history}
          model={model}
          check={check}
          highlighted={following ? (latest?.id ?? null) : selectedId}
        />
        <section className="flex min-w-0 flex-col gap-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <h3 className="font-tech text-xs text-ink-secondary">
              <span aria-hidden="true">{"// "}</span>
              {following ? "最新结果" : "历史结果"}
            </h3>
            {!following && (
              <Button
                variant="text"
                size="sm"
                render={
                  <Link to={modelPath(model.id, check.prompt.id)} replace />
                }
              >
                回到最新
              </Button>
            )}
          </div>
          {following ? (
            <LatestResult model={model} display={display} />
          ) : (
            <PickedResultView picked={picked} />
          )}
        </section>
      </div>
    </div>
  );
}

function HistoryPanel({
  history,
  model,
  check,
  highlighted,
}: {
  history: HistoryFeed;
  model: BoardModel;
  check: BoardCheck;
  highlighted: number | null;
}) {
  const { list, error } = history;
  const latestId = check.latest?.id ?? null;

  let content: ReactNode;
  if (list === null && error) {
    content = (
      <div className="flex flex-col items-start gap-2 px-4 py-4 text-sm">
        <p className="text-ink-secondary">检测记录没能载入：{error}</p>
        <Button size="sm" onClick={history.retry}>
          重试
        </Button>
      </div>
    );
  } else if (list === null) {
    content = (
      <div aria-busy="true" className="flex flex-col gap-2 px-4 py-3">
        <span className="sr-only">正在载入检测记录</span>
        {Array.from({ length: 5 }, (_, index) => (
          <Skeleton key={index} className="h-10" />
        ))}
      </div>
    );
  } else if (list.items.length === 0) {
    content = (
      <p className="px-4 py-6 text-sm text-ink-secondary">还没有检测记录。</p>
    );
  } else {
    content = (
      <>
        <List aria-label="历次检测">
          {list.items.map((item) => {
            const isLatest = item.id === latestId;
            return (
              <ListRow
                key={item.id}
                size="sm"
                selected={item.id === highlighted}
                render={
                  <Link
                    to={
                      isLatest
                        ? modelPath(model.id, check.prompt.id)
                        : resultPath(model.id, check.prompt.id, item.id)
                    }
                    replace
                  />
                }
                description={runDescription(item)}
                end={<StatusTag status={item.status} />}
              >
                <span className="font-tech tabular-nums">
                  {formatDateTime(item.startedAt)}
                </span>
                {isLatest && (
                  <span className="ml-2 text-xs font-normal text-ink-tertiary">
                    最新
                  </span>
                )}
              </ListRow>
            );
          })}
        </List>
        {list.hasMore && (
          <div className="flex flex-col items-start gap-1 border-t border-line px-4 py-3">
            <Button
              variant="text"
              size="sm"
              loading={history.loadingMore}
              onClick={history.loadMore}
            >
              加载更早的记录
            </Button>
            {history.moreError && (
              <p className="text-xs text-danger">{history.moreError}</p>
            )}
          </div>
        )}
      </>
    );
  }

  return (
    <Panel className="flex min-w-0 flex-col lg:sticky lg:top-20">
      <PanelHeader
        variant="line"
        extra={
          list && list.items.length > 0 ? (
            <span className="font-tech text-xs text-ink-tertiary tabular-nums">
              {list.hasMore ? `最近 ${list.items.length} 次` : `共 ${list.items.length} 次`}
            </span>
          ) : undefined
        }
      >
        检测记录
      </PanelHeader>
      {/* 手机上列表不能太长，把结果挤到很下面；宽屏上吸顶，跟着页面的高度走 */}
      <div className="max-h-72 overflow-y-auto lg:max-h-[calc(100dvh-10rem)] lg:overscroll-contain">
        {content}
      </div>
    </Panel>
  );
}

type PickedResult =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "ready"; result: ResultDetail }
  | { kind: "gone" }
  | { kind: "error"; message: string; retry: () => void };

/**
 * 地址栏里选中的那一次（不是最新的那次时）。不属于这个模型、这道题的记录当作不存在：
 * 改地址里的 id 也看不到别的题的结果。
 * 这道题有了新结果、或者检测刚结束（version 变了）时再确认一遍它还在：
 * 被保留条数挤掉、或者被管理员清空之后，不能还显示着
 */
function usePickedResult(
  id: number | null,
  version: string | null,
  model: BoardModel,
  check: BoardCheck,
): PickedResult {
  const [loaded, setLoaded] = useState<{
    id: number;
    outcome: Exclude<PickedResult, { kind: "idle" | "loading" }>;
  } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const modelId = model.id;
  const promptId = check.prompt.id;

  useEffect(() => {
    if (id === null) return;
    let cancelled = false;
    const settle = (outcome: Exclude<PickedResult, { kind: "idle" | "loading" }>) => {
      if (cancelled) return;
      setLoaded((prev) =>
        // 再确认时只是没问成：照旧显示已经拿到的那次
        outcome.kind === "error" && prev?.id === id && prev.outcome.kind === "ready"
          ? prev
          : { id, outcome },
      );
    };
    publicApi.result(id).then(
      (result) =>
        settle(
          result.modelId === modelId && result.promptId === promptId
            ? { kind: "ready", result }
            : { kind: "gone" },
        ),
      (error: unknown) =>
        settle(
          error instanceof ApiRequestError && error.status === 404
            ? { kind: "gone" }
            : {
                kind: "error",
                message:
                  error instanceof Error && error.message
                    ? error.message
                    : "载入失败，请稍后重试。",
                retry: () => setAttempt((value) => value + 1),
              },
        ),
    );
    return () => {
      cancelled = true;
    };
  }, [id, version, attempt, modelId, promptId]);

  if (id === null) return { kind: "idle" };
  // 换了一次、还没拿到时显示载入中；同一次再确认的请求在路上时照旧显示已经拿到的
  return loaded?.id === id ? loaded.outcome : { kind: "loading" };
}

function PickedResultView({ picked }: { picked: PickedResult }) {
  switch (picked.kind) {
    case "idle":
      return null;
    case "loading":
      return (
        <div aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">正在载入这次的结果</span>
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-60" />
        </div>
      );
    case "gone":
      return (
        <Alert tone="warning" title="这次检测的记录已经不在了">
          可能是超过了保留条数被自动清理，或者被管理员删除了。
        </Alert>
      );
    case "error":
      return (
        <Alert
          tone="danger"
          title="这次的结果没能载入"
          action={
            <Button
              variant="text"
              size="sm"
              iconEnd={null}
              onClick={picked.retry}
            >
              重试
            </Button>
          }
        >
          {picked.message}
        </Alert>
      );
    case "ready":
      return <ResultBody result={picked.result} />;
  }
}

/** 首次加载时的骨架：页头、页签、左边列表右边结果 */
function ModelSkeleton() {
  return (
    <div aria-busy="true" className="flex flex-col gap-10">
      <span role="status" className="sr-only">
        正在加载模型的检测记录
      </span>
      <div className="flex flex-col gap-3">
        <Skeleton className="h-3 w-40" />
        <Skeleton className="h-10 w-72 max-w-full" />
        <Skeleton className="h-4 w-48" />
        <Skeleton className="mt-2 h-7 w-96 max-w-full" />
      </div>
      <Skeleton className="h-10" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[18rem_minmax(0,1fr)] xl:grid-cols-[20rem_minmax(0,1fr)]">
        <Skeleton className="h-80" />
        <Skeleton className="h-96" />
      </div>
    </div>
  );
}
