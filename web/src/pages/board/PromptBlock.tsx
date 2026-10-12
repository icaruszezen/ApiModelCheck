import { Button, ChevronDown, cn } from "@endfield-ui/react";
import { useId, useLayoutEffect, useRef, useState } from "react";

export interface PromptBlockProps {
  /** 现在配置的提示词 */
  content: string;
  /** 正在看的这次结果用的是旧版提示词时，传当时的内容（见 changedSnapshot）；否则 null */
  snapshot: string | null;
  /** 只有一条检测题、没有页签时，把题目标题写在这里 */
  title?: string;
  /** 紧凑版（前台卡片里用）：收起时只留 3 行 */
  compact?: boolean;
}

/** 提示词原样显示；超过 6 行（紧凑版 3 行）默认收起，可以展开 */
export function PromptBlock({
  content,
  snapshot,
  title,
  compact = false,
}: PromptBlockProps) {
  const [showCurrent, setShowCurrent] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);
  const textRef = useRef<HTMLDivElement>(null);
  const textId = useId();

  const outdated = snapshot !== null;
  const text = outdated && !showCurrent ? snapshot : content;

  // 收起时量一下有没有被截断：按实际折行算，比数换行符准（长段落在窄卡片里也会超过行数）
  useLayoutEffect(() => {
    const node = textRef.current;
    if (!node || expanded) return;
    const measure = () =>
      setOverflowing(node.scrollHeight > node.clientHeight + 1);
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(node);
    return () => observer.disconnect();
  }, [text, expanded]);

  return (
    <section className="flex min-w-0 flex-col gap-2">
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
        <h4 className="font-tech text-xs text-ink-secondary">
          <span aria-hidden="true">{"// "}</span>
          提示词
        </h4>
        {title && (
          <p className="min-w-0 text-sm font-medium wrap-anywhere">{title}</p>
        )}
      </div>

      {outdated && (
        <p className="text-xs text-ink-secondary">
          {showCurrent
            ? "这是现在的题目；下面的结果用的是修改前的版本。"
            : "这次检测用的是修改前的题目，下次检测会用新版本。"}
          <button
            type="button"
            onClick={() => setShowCurrent((value) => !value)}
            className="ml-1 text-ink underline underline-offset-2 hover:text-ink-secondary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            {showCurrent ? "看检测时的版本" : "看现在的版本"}
          </button>
        </p>
      )}

      <div className="border-l-2 border-line-strong bg-surface-sunken px-3 py-2.5">
        <div
          ref={textRef}
          id={textId}
          className={cn(
            "text-sm leading-relaxed break-words whitespace-pre-wrap text-ink",
            !expanded && (compact ? "line-clamp-3" : "line-clamp-6"),
          )}
        >
          {text}
        </div>
        {(overflowing || expanded) && (
          <Button
            variant="text"
            size="sm"
            className="mt-2"
            aria-expanded={expanded}
            aria-controls={textId}
            onClick={() => setExpanded((value) => !value)}
            iconEnd={
              <ChevronDown
                size={14}
                className={cn(
                  "transition-transform duration-(--duration-fast) ease-standard",
                  expanded && "rotate-180",
                )}
              />
            }
          >
            {expanded ? "收起" : "展开全部"}
          </Button>
        )}
      </div>
    </section>
  );
}
