import { cn, Spinner } from "@endfield-ui/react";
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  /**
   * 紧凑版（前台卡片里用）：网页的小方框矮一些，正文放进一个限高、可以滚动的区域，
   * 生成中自动跟到最新的内容。字数和"复制原文"那一行不画，复制按钮由卡片放在结果的信息行右边
   */
  compact?: boolean;
  className?: string;
}

/** 紧凑版网页小方框的高度 */
const COMPACT_HTML_HEIGHT = 260;

/**
 * 展示一次检测的模型输出：文字原样显示（不渲染 Markdown），代码块等宽显示，
 * HTML 网页放进沙箱 iframe 的小方框里。模型的文字一律作为文本节点输出，不当 HTML 插进页面。
 */
export function OutputView({
  output,
  reasoning = "",
  running = false,
  emptyText = "（没有输出）",
  compact = false,
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
        <Spinner size="sm" label={null} className={compact ? "size-2.5" : undefined} />
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
      {output.trim() !== "" && !compact && (
        <div className="flex items-center justify-between gap-3">
          <span className="font-tech text-xs text-ink-tertiary tabular-nums">
            {formatNumber(charCount)} 字
            {htmlCount > 0 && ` · ${htmlCount} 个网页`}
          </span>
          <CopyButton text={output} label="复制原文" />
        </div>
      )}

      {showReasoning && (
        <ReasoningBlock text={allReasoning} thinking={thinking} compact={compact} />
      )}

      {hasBody && (
        <BodyArea compact={compact} running={running} output={output}>
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
                  height={compact ? COMPACT_HTML_HEIGHT : undefined}
                  compact={compact}
                />
              );
            }
            return (
              <SegmentView key={key} segment={segment} running={running} compact={compact} />
            );
          })}
        </BodyArea>
      )}

      {!hasBody && !thinking && <p className="text-sm text-ink-tertiary">{emptyText}</p>}

      {running && hasBody && (
        <p className="flex items-center gap-2 text-xs text-ink-tertiary">
          <Spinner size="sm" label={null} className={compact ? "size-2.5" : undefined} />
          正在生成…
        </p>
      )}
    </div>
  );
}

/**
 * 正文各段。紧凑版限高、可以滚动，下面还有内容时底边淡出；生成中只要滚动条停在底部，
 * 就跟着新内容往下走，往上翻看时不打扰
 */
function BodyArea({
  compact,
  running,
  output,
  children,
}: {
  compact: boolean;
  running: boolean;
  output: string;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  // 下面还有没露出来的内容：画一道淡出，提示可以往下滚
  const [more, setMore] = useState(false);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!compact || !running || !node || !stick.current) return;
    node.scrollTop = node.scrollHeight;
  }, [compact, running, output]);

  useLayoutEffect(() => {
    const node = ref.current;
    if (!compact || !node) return;
    const measure = () =>
      setMore(node.scrollTop + node.clientHeight < node.scrollHeight - 2);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    if (innerRef.current) observer.observe(innerRef.current);
    return () => observer.disconnect();
  }, [compact]);

  if (!compact) return <>{children}</>;
  return (
    <div className="relative min-w-0">
      <div
        ref={ref}
        tabIndex={0}
        role="region"
        aria-label="模型输出"
        onScroll={(event) => {
          const node = event.currentTarget;
          stick.current = node.scrollTop + node.clientHeight >= node.scrollHeight - 24;
          setMore(node.scrollTop + node.clientHeight < node.scrollHeight - 2);
        }}
        // 一行几张时限高 23rem，同一排不被某一张撑得太高，又放得下网页小方框加一两行开场白；
        // 手机上一行一张，可以高一些
        className="max-h-[26rem] min-w-0 overflow-y-auto overscroll-contain text-base leading-relaxed focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus md:max-h-[23rem]"
      >
        <div ref={innerRef} className="grid min-w-0 grid-cols-[minmax(0,1fr)] content-start gap-3">
          {children}
        </div>
      </div>
      {/* 卡片的底色往上淡：盖在滚动区域的底边上，不挡点击和滚动 */}
      <div
        aria-hidden="true"
        className={cn(
          "pointer-events-none absolute inset-x-0 bottom-0 h-12 bg-linear-to-t from-surface-raised to-transparent",
          "transition-opacity duration-(--duration-fast) ease-standard",
          more ? "opacity-100" : "opacity-0",
        )}
      />
    </div>
  );
}

function SegmentView({
  segment,
  running,
  compact,
}: {
  segment: Exclude<OutputSegment, { kind: "html" }>;
  running: boolean;
  compact: boolean;
}) {
  if (segment.kind === "code") {
    return (
      <CodeBlock
        code={segment.code}
        lang={segment.lang}
        complete={segment.complete}
        running={running}
        compact={compact}
      />
    );
  }
  return <div className="break-words whitespace-pre-wrap text-ink">{segment.text}</div>;
}
