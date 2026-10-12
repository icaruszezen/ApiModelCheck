/**
 * 检测记录展开后的明细：提示词快照、错误、模型输出，以及"重新检测这一条"。
 * 展开时才挂载，所以这里才去取完整记录；还在检测中的记录自己定时刷新，能看到生成过程。
 */
import { Alert, Button, cn, Spinner, useToast } from "@endfield-ui/react";
import { useEffect, useState, type ReactNode } from "react";
import type { AdminResultRow } from "../../../../shared/types.ts";
import { adminApi } from "../../api/client";
import { PlayIcon } from "../../components/icons";
import { OutputView } from "../../components/output/OutputView";
import { formatDateTime } from "../../lib/format";
import { useAsync } from "../../lib/use-async";
import { usePolling } from "./model-hooks";
import { runToast } from "./model-list";
import { isLongText } from "./result-query";
import { errorMessage } from "./ui";

const RUNNING_POLL = 3_000;

export function ResultDetailView({
  row,
  onRerun,
}: {
  row: AdminResultRow;
  /** 重新检测已经排上之后（列表好刷新，新的那条记录出现在最上面） */
  onRerun?: () => void;
}) {
  const toast = useToast();
  const [rerunning, setRerunning] = useState(false);
  const detail = useAsync(() => adminApi.result(row.id), [row.id]);
  const result = detail.data;
  const running = (result?.status ?? row.status) === "running";
  usePolling(detail.reload, running ? RUNNING_POLL : null);

  // 列表那边已经看到这条结束了，而明细还停在检测中：立刻补一次，不等下一轮
  const { reload } = detail;
  const stale = result !== undefined && result.status !== row.status;
  useEffect(() => {
    if (stale) void reload();
  }, [stale, reload, row.finishedAt]);

  if (!result) {
    return detail.error ? (
      <Alert
        tone="danger"
        title="明细没有载入"
        action={
          <Button
            variant="text"
            size="sm"
            iconEnd={null}
            onClick={() => void detail.reload()}
          >
            重试
          </Button>
        }
      >
        {errorMessage(detail.error)}
      </Alert>
    ) : (
      <p className="flex items-center gap-2 py-2 text-ink-secondary">
        <Spinner size="sm" label={null} />
        正在载入明细…
      </p>
    );
  }

  const isRunning = result.status === "running";

  // 只把这条提示词再发给这个模型一次；提示词已经不分配给它了、停用了，服务端会说明
  const rerun = async () => {
    setRerunning(true);
    try {
      const { queued } = await adminApi.runModel(row.modelId, {
        promptId: row.promptId,
      });
      toast(runToast(queued));
      if (queued) onRerun?.();
    } catch (error) {
      toast({ message: errorMessage(error), tone: "danger" });
    } finally {
      setRerunning(false);
    }
  };

  return (
    <div className="flex max-w-4xl min-w-0 flex-col gap-5 py-1">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2">
        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-xs text-ink-secondary">
          <Meta label="记录">
            <span className="font-tech tabular-nums">#{result.id}</span>
          </Meta>
          <Meta label="请求方式">{result.stream ? "流式" : "非流式"}</Meta>
          <Meta label="开始">
            <span className="font-tech tabular-nums">
              {formatDateTime(result.startedAt)}
            </span>
          </Meta>
          {result.finishedAt && (
            <Meta label="结束">
              <span className="font-tech tabular-nums">
                {formatDateTime(result.finishedAt)}
              </span>
            </Meta>
          )}
          {result.finishReason && (
            <Meta label="结束原因">
              <span className="font-mono">{result.finishReason}</span>
            </Meta>
          )}
          {detail.error && (
            <span className="text-danger">
              刷新失败：{errorMessage(detail.error)}
            </span>
          )}
        </dl>
        {!isRunning && (
          <Button
            variant="light"
            size="sm"
            iconStart={<PlayIcon size={14} />}
            loading={rerunning}
            onClick={() => void rerun()}
          >
            重新检测这一条
          </Button>
        )}
      </div>

      <DetailSection title="提示词">
        <PromptSnapshot text={result.promptSnapshot} />
      </DetailSection>

      {result.error && (
        <Alert
          tone={result.status === "timeout" ? "warning" : "danger"}
          title={result.status === "timeout" ? "检测超时" : "检测失败"}
        >
          <span className="whitespace-pre-wrap">{result.error}</span>
        </Alert>
      )}

      <DetailSection
        title={
          isRunning ? (
            <span className="inline-flex items-center gap-2">
              模型输出
              <span className="inline-flex items-center gap-1.5 text-xs font-normal text-ink-secondary">
                <Spinner size="sm" label={null} />
                {result.stream
                  ? "生成中，自动刷新"
                  : "非流式请求，生成完才有输出"}
              </span>
            </span>
          ) : (
            "模型输出"
          )
        }
      >
        <OutputView
          output={result.output}
          reasoning={result.reasoning}
          running={isRunning}
        />
      </DetailSection>
    </div>
  );
}

function Meta({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline gap-1.5">
      <dt>{label}</dt>
      <dd className="text-ink">{children}</dd>
    </div>
  );
}

function DetailSection({
  title,
  children,
}: {
  title: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="flex min-w-0 flex-col gap-2">
      <h4 className="text-sm font-bold text-ink">{title}</h4>
      {children}
    </section>
  );
}

/** 提示词原样显示；长的默认收起，底部渐隐 */
function PromptSnapshot({ text }: { text: string }) {
  const long = isLongText(text);
  const [open, setOpen] = useState(false);
  const collapsed = long && !open;

  return (
    <div className="flex flex-col items-start gap-1">
      <div
        className={cn(
          "relative w-full border border-line bg-surface px-3 py-2",
          collapsed && "max-h-36 overflow-hidden",
        )}
      >
        <p className="text-sm whitespace-pre-wrap wrap-anywhere text-ink">
          {text}
        </p>
        {collapsed && (
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-surface to-transparent"
          />
        )}
      </div>
      {long && (
        <Button
          variant="text"
          size="sm"
          iconEnd={null}
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          {open ? "收起" : "展开全部"}
        </Button>
      )}
    </div>
  );
}
