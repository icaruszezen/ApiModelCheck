import {
  Alert,
  cn,
  EmptyState,
  Spinner,
  StatusDanger,
  StatusWarning,
  Tag,
} from "@endfield-ui/react";
import type { ReactNode } from "react";
import { NORMAL_FINISH_REASONS } from "../../../../shared/endpoints.ts";
import type {
  BoardModel,
  ResultDetail,
  ResultStatus,
} from "../../../../shared/types.ts";
import { CopyButton } from "../../components/output/CopyButton";
import { OutputView } from "../../components/output/OutputView";
import { StatusTag } from "../../components/output/StatusTag";
import {
  formatDateTime,
  formatRelative,
  formatShortDateTime,
} from "../../lib/format";
import {
  STATUS_LABEL,
  describeNextRun,
  elapsedText,
  hasOutput,
  nextRunText,
  resultMeta,
  type CheckDisplay,
  type MetaItem,
} from "./board-logic";
import { META_CLIP, META_ITEM, META_ROW } from "./meta-line";
import { useNow } from "./now";
import { StatusMark } from "./StatusMark";

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
      return <NeverChecked model={model} compact={compact} />;
    case "rerun":
      return (
        <>
          <RerunNotice
            startedAt={display.running.startedAt}
            hasPrevious={display.result !== null}
            compact={compact}
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

/**
 * 从没检测过。紧凑版（卡片里）不画虚线框和小标题，只是两行淡色的字：
 * 卡片自己的标题是 h3，这里再出一个 h3 层级就乱了
 */
function NeverChecked({
  model,
  compact = false,
}: {
  model: BoardModel;
  compact?: boolean;
}) {
  const now = useNow();
  let title: string;
  let description: ReactNode;
  if (model.running) {
    title = "本轮检测进行中";
    description = "轮到这道题时开始，结果会自动出现在这里。";
  } else {
    const info = describeNextRun(model, now);
    const at = "at" in info ? info.at : null;
    title = "还没有检测结果";
    description =
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
      );
  }

  if (compact) {
    return (
      <div className="flex flex-col gap-1 py-4">
        <p className="flex items-center gap-2 text-sm font-medium">
          {model.running && <Spinner size="sm" label={null} className="size-2.5" />}
          {title}
        </p>
        <p className="text-xs text-ink-secondary">{description}</p>
      </div>
    );
  }
  return (
    <EmptyState
      className="py-8"
      icon={model.running ? <Spinner label={null} /> : null}
      title={title}
      description={description}
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
  if (compact) {
    return (
      <div className="flex min-w-0 flex-col gap-2.5">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="flex min-w-0 items-start gap-2">
            <div className="min-w-0 flex-1">
              <CompactMeta result={result} />
            </div>
            {/* 复制紧挨着回答；按钮比这行字高，上下收进去，不把这一行撑高 */}
            {result.output.trim() !== "" && (
              <CopyButton
                text={result.output}
                label="复制回答原文"
                className="-my-1.5 shrink-0 bg-transparent text-ink-tertiary hover:bg-ink/5 hover:text-ink"
              />
            )}
          </div>
          {(result.status === "error" || result.status === "timeout") && (
            <CompactNotice result={result} partial={partial} />
          )}
        </div>
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
function ElapsedEntry({
  startedAt,
  compact = false,
}: {
  startedAt: string;
  compact?: boolean;
}) {
  const now = useNow();
  const value = elapsedText(startedAt, now);
  return compact ? (
    <CompactEntry label="已进行">{value}</CompactEntry>
  ) : (
    <MetaEntry label="已进行" value={value} />
  );
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

/* ------------------------------------------------------------------ */
/* 紧凑版（首页卡片）                                                  */
/* ------------------------------------------------------------------ */

/** 状态词的字色：成功只说明答完了，用中性色；颜色留给检测中、超时和失败 */
const STATUS_TONE: Record<ResultStatus, string> = {
  running: "text-accent-ink",
  success: "text-ink-secondary",
  timeout: "text-warning",
  error: "text-danger",
};

function CompactEntry({
  label,
  srLabel,
  suffix,
  children,
}: {
  /** 看得见的短标签；不给就只给读屏 */
  label?: string;
  /** 给读屏的完整标签，默认同 label */
  srLabel?: string;
  /** 值后面的单位，只是给眼睛看的 */
  suffix?: string;
  children: ReactNode;
}) {
  const full = srLabel ?? label ?? "";
  return (
    <div className={cn("flex min-w-0 items-baseline gap-1", META_ITEM)}>
      <dt className={cn("shrink-0", !label && "sr-only")}>
        {label && full !== label ? (
          <>
            <span aria-hidden="true">{label}</span>
            <span className="sr-only">{full}</span>
          </>
        ) : (
          full
        )}
      </dt>
      <dd className="min-w-0 font-tech text-ink wrap-anywhere tabular-nums">
        {children}
        {suffix && (
          <span aria-hidden="true" className="ml-1 font-sans">
            {suffix}
          </span>
        )}
      </dd>
    </div>
  );
}

/**
 * 卡片里结果的信息行：状态、多久以前检测的、耗时、首字延迟、tokens 排成一行，顺序固定，
 * 同一排卡片里同一项落在差不多的位置。正常答完（stop、end_turn 之类）时不写结束原因
 */
function CompactMeta({ result }: { result: ResultDetail }) {
  const [first, ...rest] = resultMeta(result);
  return (
    <div className={META_CLIP}>
      <dl className={cn(META_ROW, "gap-y-0.5 text-xs leading-5 text-ink-secondary")}>
        <div
          data-status={result.status}
          className={cn(
            "flex items-center gap-1.5 font-medium",
            META_ITEM,
            STATUS_TONE[result.status],
          )}
        >
          <dt className="sr-only">状态</dt>
          <dd className="flex items-center gap-1.5">
            {/* 成功只写字，不画记号：记号和颜色留给检测中、超时和失败 */}
            {result.status !== "success" && (
              <StatusMark status={result.status} compact />
            )}
            {STATUS_LABEL[result.status]}
          </dd>
        </div>
        {result.trigger === "manual" && (
          <div className={cn("flex items-center", META_ITEM)}>
            <dt className="sr-only">触发方式</dt>
            <dd>
              <Tag variant="outline" size="sm">
                手动
              </Tag>
            </dd>
          </div>
        )}
        {first && (
          <CompactEntry srLabel={first.label}>
            <RelativeTime iso={result.startedAt} />
          </CompactEntry>
        )}
        {result.status === "running" && (
          <ElapsedEntry startedAt={result.startedAt} compact />
        )}
        {rest.map((item) => {
          switch (item.key) {
            case "firstToken":
              return (
                <CompactEntry key={item.key} label="首字" srLabel={item.label}>
                  {item.value}
                </CompactEntry>
              );
            case "tokens":
              return (
                <CompactEntry key={item.key} srLabel={item.label} suffix="tokens">
                  {item.value}
                </CompactEntry>
              );
            case "finish":
              return NORMAL_FINISH_REASONS.has(item.value) ? null : (
                <CompactEntry key={item.key} label={item.label}>
                  {item.value}
                </CompactEntry>
              );
            default:
              return (
                <CompactEntry key={item.key} label={item.label}>
                  {item.value}
                </CompactEntry>
              );
          }
        })}
      </dl>
    </div>
  );
}

/** 多久以前，悬停给出具体时间。跟着时钟走 */
function RelativeTime({ iso }: { iso: string }) {
  const now = useNow();
  return (
    <time dateTime={iso} title={formatDateTime(iso)}>
      {formatRelative(iso, now)}
    </time>
  );
}

/** 句末没有标点时补一个句号，好接上后面那句 */
function sentence(text: string): string {
  return /[。．.！!？?…]$/.test(text) ? text : `${text}。`;
}

/**
 * 失败、超时的原因，用对应的颜色和图标。收到了部分输出时是回答上面的一行小字；
 * 什么都没收到时回答的位置画一个虚线框说明，免得看起来像一个很短的回答
 */
function CompactNotice({
  result,
  partial,
}: {
  result: ResultDetail;
  partial: boolean;
}) {
  const failed = result.status === "error";
  const Icon = failed ? StatusDanger : StatusWarning;
  const tone = failed ? "text-danger" : "text-warning";
  const reason =
    result.error?.trim() ||
    (failed ? "上游没有给出错误信息。" : "没有在规定的时间内完成。");

  if (!partial) {
    return (
      <div
        role="alert"
        className="mt-1 flex min-w-0 gap-2.5 border border-dashed border-line-strong px-4 py-4"
      >
        <Icon size={16} aria-hidden="true" className={cn("mt-0.5 shrink-0", tone)} />
        <div className="flex min-w-0 flex-col gap-1">
          <p className={cn("text-sm font-medium", tone)}>
            {failed ? "检测失败" : "检测超时"}
          </p>
          <p className="max-h-60 overflow-y-auto text-sm leading-relaxed break-words whitespace-pre-wrap text-ink-secondary">
            {reason}
          </p>
        </div>
      </div>
    );
  }
  return (
    <p
      role="alert"
      className="flex min-w-0 gap-1.5 text-xs leading-relaxed"
    >
      <Icon size={14} aria-hidden="true" className={cn("mt-0.5 shrink-0", tone)} />
      <span className="max-h-28 min-w-0 overflow-y-auto break-words">
        <span className="sr-only">{failed ? "检测失败：" : "检测超时："}</span>
        <span className={tone}>{sentence(reason)}</span>
        <span className="text-ink-secondary">
          {failed ? "下面是出错前收到的部分输出。" : "下面是超时前收到的部分输出。"}
        </span>
      </span>
    </p>
  );
}

/** 非流式请求进行中：拿不到中间结果，说明一下，下面照旧显示上一次的 */
function RerunNotice({
  startedAt,
  hasPrevious,
  compact = false,
}: {
  startedAt: string;
  hasPrevious: boolean;
  compact?: boolean;
}) {
  const now = useNow();
  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-sm",
        compact ? "pb-1" : "bg-surface-sunken px-3 py-2.5",
      )}
    >
      <Spinner size="sm" label={null} className={compact ? "size-2.5" : undefined} />
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
