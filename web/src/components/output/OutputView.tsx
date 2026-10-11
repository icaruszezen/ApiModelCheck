import { cn, Spinner } from "@endfield-ui/react";
import { useMemo } from "react";
import { parseOutput, type OutputSegment } from "../../../../shared/output-parse.ts";
import { formatNumber } from "../../lib/format";
import { CodeBlock } from "./CodeBlock";
import { CopyButton } from "./CopyButton";
import { HtmlPreview } from "./HtmlPreview";
import { ReasoningBlock } from "./ReasoningBlock";
import { countChars } from "./srcdoc";

export interface OutputViewProps {
  /** 模型的正文输出（可能夹着 HTML 网页） */
  output: string;
  /** 上游单独返回的思考过程；正文开头的 <think>…</think> 也会被归到这里显示 */
  reasoning?: string;
  /** 还在生成中（流式的部分输出）：没写完的 HTML 先显示源码，写完了才渲染 */
  running?: boolean;
  /** 输出为空时显示的文字，默认"（没有输出）" */
  emptyText?: string;
  className?: string;
}

/**
 * 展示一次检测的模型输出：文字原样显示（不渲染 Markdown），代码块等宽显示，
 * HTML 网页放进沙箱 iframe 的小方框里。模型的文字一律作为文本节点输出，不当 HTML 插进页面。
 */
export function OutputView({
  output,
  reasoning = "",
  running = false,
  emptyText = "（没有输出）",
  className,
}: OutputViewProps) {
  const parsed = useMemo(() => parseOutput(output, { running }), [output, running]);
  const charCount = useMemo(() => countChars(output), [output]);
  const allReasoning = [reasoning.trim(), parsed.reasoning].filter(Boolean).join("\n\n");
  const segments = parsed.segments;
  const hasBody = segments.length > 0;
  const thinking = running && !hasBody && (allReasoning !== "" || parsed.reasoningOpen);
  const showReasoning = allReasoning !== "" || thinking;

  if (!hasBody && !showReasoning) {
    return running ? (
      <p className={cn("flex items-center gap-2 text-sm text-ink-secondary", className)}>
        <Spinner size="sm" label={null} />
        等待模型输出…
      </p>
    ) : (
      <p className={cn("text-sm text-ink-tertiary", className)}>{emptyText}</p>
    );
  }

  const htmlCount = segments.filter((segment) => segment.kind === "html").length;
  let htmlIndex = 0;

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      {output.trim() !== "" && (
        <div className="flex items-center justify-between gap-3">
          <span className="font-tech text-xs text-ink-tertiary tabular-nums">
            {formatNumber(charCount)} 字
            {htmlCount > 0 && ` · ${htmlCount} 个网页`}
          </span>
          <CopyButton text={output} label="复制原文" />
        </div>
      )}

      {showReasoning && <ReasoningBlock text={allReasoning} thinking={thinking} />}

      {segments.map((segment, position) => {
        const key = `${position}-${segment.kind}`;
        if (segment.kind === "html") {
          htmlIndex += 1;
          return (
            <HtmlPreview
              key={key}
              html={segment.html}
              source={segment.source}
              complete={segment.complete}
              running={running}
              index={htmlCount > 1 ? htmlIndex : undefined}
            />
          );
        }
        return <SegmentView key={key} segment={segment} running={running} />;
      })}

      {!hasBody && !thinking && <p className="text-sm text-ink-tertiary">{emptyText}</p>}

      {running && hasBody && (
        <p className="flex items-center gap-2 text-xs text-ink-tertiary">
          <Spinner size="sm" label={null} />
          正在生成…
        </p>
      )}
    </div>
  );
}

function SegmentView({
  segment,
  running,
}: {
  segment: Exclude<OutputSegment, { kind: "html" }>;
  running: boolean;
}) {
  if (segment.kind === "code") {
    return (
      <CodeBlock code={segment.code} lang={segment.lang} complete={segment.complete} running={running} />
    );
  }
  return <div className="break-words whitespace-pre-wrap text-ink">{segment.text}</div>;
}
