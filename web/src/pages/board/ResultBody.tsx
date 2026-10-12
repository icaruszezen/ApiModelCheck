import { Alert, EmptyState, Spinner, Tag } from "@endfield-ui/react";
import type {
  BoardModel,
  ResultDetail,
} from "../../../../shared/types.ts";
import { OutputView } from "../../components/output/OutputView";
import { StatusTag } from "../../components/output/StatusTag";
import { formatShortDateTime } from "../../lib/format";
import {
  describeNextRun,
  elapsedText,
  hasOutput,
  nextRunText,
  resultMeta,
  type CheckDisplay,
  type MetaItem,
} from "./board-logic";
import { useNow } from "./now";

export interface LatestResultProps {
  model: BoardModel;
  /** resolveCheckDisplay 算出的此刻该显示什么 */
  display: CheckDisplay;
  compact?: boolean;
}

/**
 * 一条检测题的最近一次：检测中的流式输出实时显示；非流式检测中先说明一下，
 * 下面照旧显示上一次的；从没检测过时说下次什么时候检测
 */
export function LatestResult({
  model,
  display,
  compact = false,
}: LatestResultProps) {
  switch (display.kind) {
    case "never":
      return <NeverChecked model={model} />;
    case "rerun":
      return (
        <>
          <RerunNotice
            startedAt={display.running.startedAt}
            hasPrevious={display.result !== null}
          />
          {display.result && (
            <ResultBody result={display.result} compact={compact} />
          )}
        </>
      );
    case "live":
    case "done":
      return <ResultBody result={display.result} compact={compact} />;
  }
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

export interface ResultBodyProps {
  result: ResultDetail;
  /** 紧凑版（前台卡片里用），见 OutputView 的 compact */
  compact?: boolean;
}

/** 一次检测的完整展示：信息行、错误、输出 */
export function ResultBody({ result, compact = false }: ResultBodyProps) {
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
          compact={compact}
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
