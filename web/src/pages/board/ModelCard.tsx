import { ArrowCorner, Button, cn, Panel, Spinner, Tag } from "@endfield-ui/react";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import type { BoardCheck, BoardModel } from "../../../../shared/types.ts";
import {
  formatDateTime,
  formatInterval,
  formatShortDateTime,
} from "../../lib/format";
import {
  STATUS_LABEL,
  checkMark,
  describeNextRun,
  elapsedText,
  modelAnchor,
  modelHeading,
  modelPath,
  modelProblems,
  nextRunText,
  pickTab,
  runningCheck,
} from "./board-logic";
import { CheckView } from "./CheckView";
import { META_CLIP, META_ITEM, META_ROW } from "./meta-line";
import { useNow } from "./now";
import { PromptTabs, TAB_ROWS, tabClass } from "./PromptTabs";
import { StatusMark } from "./StatusMark";

/**
 * 一个模型一张卡，从上到下：模型名（出问题时右边标出几道题失败、超时）、一行淡色的设置，
 * 检测题的页签，一问一答（题目、结果信息行、回答），底部是下次检测和历史记录。
 * 同一排的卡片拉成一样高，底部那一行对齐
 */
export function ModelCard({ model }: { model: BoardModel }) {
  const { title, modelId } = modelHeading(model);
  const [tab, setTab] = useState<string | null>(null);
  const active = pickTab(model.checks, tab);
  const [firstCheck] = model.checks;
  const activeCheck =
    model.checks.find((check) => String(check.prompt.id) === active) ??
    firstCheck;
  // 按提示词区分实例：换了一道题，展开之类的状态不带过去
  const checkView = (check: BoardCheck) => (
    <CheckView key={check.prompt.id} model={model} check={check} />
  );

  let body: ReactNode;
  if (!firstCheck) {
    body = (
      <p className="px-5 py-10 text-center text-sm text-ink-secondary">
        这个模型还没有分配检测题。
      </p>
    );
  } else if (model.checks.length === 1) {
    // 只有一道题：没有页签，题目标题照选中的页签画在同一个位置
    body = (
      <>
        <div className={cn(TAB_ROWS, "mx-5")}>
          <p className={cn(tabClass(true), "max-w-full")}>
            <CheckLabel check={firstCheck} />
          </p>
        </div>
        <div className="px-5 pt-4 pb-5">{checkView(firstCheck)}</div>
      </>
    );
  } else {
    body = (
      <PromptTabs
        value={active ?? ""}
        onValueChange={setTab}
        label="检测题"
        listClassName="mx-5"
        panelClassName="px-5 pt-4 pb-5"
        items={model.checks.map((check) => ({
          value: String(check.prompt.id),
          tab: <CheckLabel check={check} />,
          panel: checkView(check),
        }))}
      />
    );
  }

  return (
    <Panel
      id={modelAnchor(model.id)}
      // 卡片宽度跟着一行几张走，里面按卡片自己的宽度排（容器查询），不按屏幕宽度
      className="@container flex min-w-0 scroll-mt-20 flex-col"
    >
      <header className="flex flex-col gap-1 px-5 pt-4 pb-3">
        <div className="flex items-start justify-between gap-3">
          <h3 className="min-w-0">
            <Link
              to={modelPath(model.id)}
              title="查看这个模型的详情和历史记录"
              className="group text-lg leading-tight font-bold wrap-anywhere underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
            >
              {title}
              <ArrowCorner
                size={14}
                className="ml-1.5 inline-block align-baseline text-ink-tertiary transition-transform duration-(--duration-fast) ease-standard group-hover:translate-x-0.5 group-hover:translate-y-0.5 group-hover:text-ink"
              />
            </Link>
          </h3>
          <ModelProblems model={model} />
        </div>
        <div className={META_CLIP}>
          <dl className={cn(META_ROW, "text-xs leading-5 text-ink-secondary")}>
            {modelId && (
              <div className={cn(META_ITEM, "min-w-0")}>
                <dt className="sr-only">模型 ID</dt>
                <dd className="font-tech wrap-anywhere">{modelId}</dd>
              </div>
            )}
            <div className={META_ITEM}>
              <dt className="sr-only">模式</dt>
              <dd>{model.stream ? "流式" : "非流式"}</dd>
            </div>
            <div className={META_ITEM}>
              <dt className="sr-only">间隔</dt>
              <dd>{`每 ${formatInterval(model.intervalMinutes)}`}</dd>
            </div>
            <div className={cn(META_ITEM, "flex gap-1")}>
              <dt>超时</dt>
              <dd>{`${model.timeoutSeconds} 秒`}</dd>
            </div>
          </dl>
        </div>
      </header>
      {body}
      <footer className="mx-5 mt-auto flex min-h-12 items-center justify-between gap-4 border-t border-line py-2">
        <ModelSchedule model={model} />
        {activeCheck?.latest && (
          <Button
            variant="text"
            size="sm"
            className="shrink-0"
            render={<Link to={modelPath(model.id, activeCheck.prompt.id)} />}
            aria-label={`查看「${activeCheck.prompt.title}」的历史记录`}
          >
            历史记录
          </Button>
        )}
      </footer>
    </Panel>
  );
}

/**
 * 页签上的一道题：标题，前面是状态记号。成功不画记号（只说明接口按时答完了，不代表答对），
 * 记号只标检测中、超时、失败和还没有检测的题
 */
function CheckLabel({ check }: { check: BoardCheck }) {
  const status = checkMark(check);
  return (
    <>
      {status !== "success" && <StatusMark status={status} compact />}
      <span className="min-w-0 truncate" title={check.prompt.title}>
        {check.prompt.title}
      </span>
      <span className="sr-only">
        （{status ? STATUS_LABEL[status] : "还没有检测"}）
      </span>
    </>
  );
}

/** 标题右边：最近一次有几道题失败、超时。都没出问题时什么都不写 */
function ModelProblems({ model }: { model: BoardModel }) {
  const { error, timeout } = modelProblems(model);
  if (error === 0 && timeout === 0) return null;
  return (
    <p className="mt-0.5 flex shrink-0 flex-wrap justify-end gap-x-3 text-xs font-medium">
      {error > 0 && (
        <span className="inline-flex items-center gap-1.5 text-danger">
          <StatusMark status="error" />
          {error} 道失败
        </span>
      )}
      {timeout > 0 && (
        <span className="inline-flex items-center gap-1.5 text-warning">
          <StatusMark status="timeout" />
          {timeout} 道超时
        </span>
      )}
    </p>
  );
}

/** 卡片底部：检测中，或者下次什么时候检测。跟着时钟走 */
function ModelSchedule({ model }: { model: BoardModel }) {
  const now = useNow();
  const info = describeNextRun(model, now);

  if (info.state === "running") {
    const current = runningCheck(model);
    return (
      <p className="flex min-w-0 items-center gap-2 text-xs text-ink-secondary">
        <Tag variant="accent" size="sm" className="shrink-0 gap-1.5">
          <Spinner size="sm" label={null} className="size-2.5" />
          检测中
        </Tag>
        <span className="min-w-0 truncate">
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
  // 窄卡片（手机）上只写多久以后，具体时间悬停看，底部始终是一行
  return (
    <p className="min-w-0 text-xs text-ink-secondary">
      下次检测：
      <span
        className="text-ink"
        title={at ? formatDateTime(at) : undefined}
      >
        {nextRunText(info)}
      </span>
      {at && (
        <span className="hidden @sm:inline">
          <span aria-hidden="true" className="mx-1.5 text-ink-disabled">
            ·
          </span>
          <time dateTime={at} className="font-tech tabular-nums">
            {formatShortDateTime(at)}
          </time>
        </span>
      )}
    </p>
  );
}
