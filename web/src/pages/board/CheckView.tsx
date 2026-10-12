import {
  Alert,
  Button,
  EmptyState,
  Skeleton,
  Spinner,
  Tag,
} from "@endfield-ui/react";
import { useEffect, type ReactNode } from "react";
import type {
  BoardCheck,
  BoardModel,
  ResultDetail,
} from "../../../../shared/types.ts";
import { ApiRequestError, publicApi } from "../../api/client";
import { OutputView } from "../../components/output/OutputView";
import { StatusTag } from "../../components/output/StatusTag";
import { formatDateTime, formatShortDateTime } from "../../lib/format";
import {
  changedSnapshot,
  describeNextRun,
  elapsedText,
  hasOutput,
  latestVersion,
  nextRunText,
  pickAfterRecheck,
  resolveCheckDisplay,
  resultMeta,
  shouldRecheckPick,
  toSummary,
  type MetaItem,
  type Picked,
  type RecheckOutcome,
} from "./board-logic";
import { HistoryPicker } from "./HistoryPicker";
import { useNow } from "./now";
import { PromptBlock } from "./PromptBlock";

function errorText(error: unknown): string {
  return error instanceof Error && error.message
    ? error.message
    : "载入失败，请稍后重试。";
}

export interface CheckViewProps {
  model: BoardModel;
  check: BoardCheck;
  /** 模型只有这一条检测题（没有页签）：题目标题写在提示词上面 */
  single: boolean;
  /**
   * 在"历史"里选中的那一次；看的是最新结果时是 null。由模型卡替各条题保管：
   * 切到别的页签再切回来时选择还在，已经载入的结果也不用再拉一遍
   */
  picked: Picked | null;
  onPickedChange: (picked: Picked | null) => void;
}

/** 一条检测题：提示词、检测信息、错误、输出，以及历史结果 */
export function CheckView({
  model,
  check,
  single,
  picked,
  onPickedChange: setPicked,
}: CheckViewProps) {
  const latest = check.latest;
  const version = latestVersion(latest);
  const display = resolveCheckDisplay(check);

  useEffect(() => {
    if (picked?.state !== "loading") return;
    const { id, seenLatest } = picked;
    let cancelled = false;
    publicApi.result(id).then(
      (result) => {
        if (!cancelled) setPicked({ id, seenLatest, state: "ready", result });
      },
      (error: unknown) => {
        if (!cancelled)
          setPicked({
            id,
            seenLatest,
            state: "error",
            message: errorText(error),
          });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [picked]);

  // 最近一次换了（或者刚结束）时，确认选中的那次还在：清空记录后紧接着又检测了一次、
  // 或者旧记录被保留条数挤掉时，它已经被删了，不能还停在上面。
  // 只在版本变了、而且选着历史时才问一次，刷新本身不会带出请求
  useEffect(() => {
    if (!picked || version === null || !shouldRecheckPick(picked, version))
      return;
    const current = picked;
    let cancelled = false;
    const settle = (outcome: RecheckOutcome) => {
      if (cancelled) return;
      const next = pickAfterRecheck(current, version, outcome);
      if (next !== current) setPicked(next);
    };
    publicApi.result(current.id).then(
      (result) => settle({ kind: "found", result }),
      (error: unknown) =>
        settle(
          error instanceof ApiRequestError && error.status === 404
            ? { kind: "gone" }
            : { kind: "failed" },
        ),
    );
    return () => {
      cancelled = true;
    };
  }, [picked, version]);

  const pick = (id: number | null) => {
    if (id === null || id === latest?.id) setPicked(null);
    else if (picked?.id !== id)
      setPicked({ id, seenLatest: version, state: "loading" });
  };

  // 提示词跟着正在看的那次结果走：管理员改过题时，显示当时用的版本
  const shown: ResultDetail | null = picked
    ? picked.state === "ready"
      ? picked.result
      : null
    : display.kind === "never"
      ? null
      : display.result;

  let body: ReactNode = null;
  if (picked) {
    if (picked.state === "loading") {
      body = (
        <div aria-busy="true" className="flex flex-col gap-3">
          <span className="sr-only">正在载入这次的结果</span>
          <Skeleton className="h-5 w-2/3" />
          <Skeleton className="h-40" />
        </div>
      );
    } else if (picked.state === "error") {
      body = (
        <Alert
          tone="danger"
          title="这次的结果没能载入"
          action={
            <Button
              variant="text"
              size="sm"
              iconEnd={null}
              onClick={() =>
                setPicked({
                  id: picked.id,
                  seenLatest: version,
                  state: "loading",
                })
              }
            >
              重试
            </Button>
          }
        >
          {picked.message}
        </Alert>
      );
    } else {
      body = (
        <>
          <Alert tone="info">
            正在查看 {formatDateTime(picked.result.startedAt)}{" "}
            的历史结果，不是最近一次。
          </Alert>
          <ResultBody result={picked.result} />
        </>
      );
    }
  } else {
    switch (display.kind) {
      case "never":
        body = <NeverChecked model={model} />;
        break;
      case "rerun":
        body = (
          <>
            <RerunNotice
              startedAt={display.running.startedAt}
              hasPrevious={display.result !== null}
            />
            {display.result && <ResultBody result={display.result} />}
          </>
        );
        break;
      case "live":
      case "done":
        body = <ResultBody result={display.result} />;
        break;
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-4 p-3">
      <PromptBlock
        content={check.prompt.content}
        snapshot={changedSnapshot(check.prompt.content, shown)}
        title={single ? check.prompt.title : undefined}
        compact
      />
      <section className="flex min-w-0 flex-col gap-3">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
          <h4 className="font-tech text-xs text-ink-secondary">
            <span aria-hidden="true">{"// "}</span>
            生成结果
          </h4>
          {latest && (
            <HistoryPicker
              modelId={model.id}
              promptId={check.prompt.id}
              latestId={latest.id}
              latestKey={version ?? ""}
              selectedId={picked?.id ?? null}
              selected={
                picked?.state === "ready" ? toSummary(picked.result) : null
              }
              onPick={pick}
            />
          )}
        </div>
        {body}
      </section>
    </div>
  );
}

/** 一次检测的完整展示：信息行、错误、输出 */
function ResultBody({ result }: { result: ResultDetail }) {
  const running = result.status === "running";
  const partial = hasOutput(result);
  // 失败且什么都没收到时，"（没有输出）"的空框只是重复错误信息，不画
  const showOutput = result.status === "success" || running || partial;
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <ResultMeta result={result} />
      {result.status === "error" && (
        <Alert tone="danger" title="检测失败">
          {result.error || "上游没有给出错误信息。"}
          {partial && (
            <span className="mt-0.5 block">下面是出错前收到的部分输出。</span>
          )}
        </Alert>
      )}
      {result.status === "timeout" && (
        <Alert tone="warning" title="检测超时">
          {result.error || "没有在规定的时间内完成。"}
          {partial && (
            <span className="mt-0.5 block">下面是超时前收到的部分输出。</span>
          )}
        </Alert>
      )}
      {showOutput && (
        <OutputView
          output={result.output}
          reasoning={result.reasoning}
          running={running}
          compact
        />
      )}
    </div>
  );
}

function MetaEntry({ label, value }: Pick<MetaItem, "label" | "value">) {
  return (
    <div className="flex min-w-0 items-baseline gap-1.5">
      <dt className="shrink-0 text-ink-tertiary">{label}</dt>
      <dd className="min-w-0 font-tech text-ink wrap-anywhere tabular-nums">
        {value}
      </dd>
    </div>
  );
}

/** 检测中的那条：已经进行了多久，跟着时钟走 */
function ElapsedEntry({ startedAt }: { startedAt: string }) {
  const now = useNow();
  return <MetaEntry label="已进行" value={elapsedText(startedAt, now)} />;
}

function ResultMeta({ result }: { result: ResultDetail }) {
  const [first, ...rest] = resultMeta(result);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="flex items-center gap-1.5">
        <StatusTag status={result.status} />
        {result.trigger === "manual" && (
          <Tag variant="outline" size="sm">
            手动
          </Tag>
        )}
      </div>
      <dl className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1 text-xs">
        {first && <MetaEntry label={first.label} value={first.value} />}
        {result.status === "running" && (
          <ElapsedEntry startedAt={result.startedAt} />
        )}
        {rest.map((item) => (
          <MetaEntry key={item.key} label={item.label} value={item.value} />
        ))}
      </dl>
    </div>
  );
}

/** 非流式请求进行中：拿不到中间结果，说明一下，下面照旧显示上一次的 */
function RerunNotice({
  startedAt,
  hasPrevious,
}: {
  startedAt: string;
  hasPrevious: boolean;
}) {
  const now = useNow();
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 bg-surface-sunken px-3 py-2.5 text-sm">
      <Spinner size="sm" label={null} />
      <span className="font-medium">
        {hasPrevious ? "正在重新检测…" : "正在检测…"}
      </span>
      <span className="font-tech text-xs text-ink-tertiary tabular-nums">
        已进行 {elapsedText(startedAt, now)}
      </span>
      <span className="text-xs text-ink-secondary">
        {hasPrevious
          ? "非流式请求，完成后才有结果；下面是上一次的结果。"
          : "非流式请求，完成后一次性显示结果。"}
      </span>
    </div>
  );
}

/** 从没检测过 */
function NeverChecked({ model }: { model: BoardModel }) {
  const now = useNow();
  if (model.running) {
    return (
      <EmptyState
        className="py-8"
        icon={<Spinner label={null} />}
        title="本轮检测进行中"
        description="轮到这道题时开始，结果会自动出现在这里。"
      />
    );
  }
  const info = describeNextRun(model, now);
  const at = "at" in info ? info.at : null;
  return (
    <EmptyState
      className="py-8"
      icon={null}
      title="还没有检测结果"
      description={
        info.state === "pending" ? (
          "等待首次检测，结果会自动出现在这里。"
        ) : (
          <>
            下次检测：{nextRunText(info)}
            {at && (
              <span className="font-tech tabular-nums">
                （{formatShortDateTime(at)}）
              </span>
            )}
          </>
        )
      }
    />
  );
}
