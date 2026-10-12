import { Accordion, AccordionItem, ChevronDown, cn, Spinner } from "@endfield-ui/react";
import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { formatNumber } from "../../lib/format";
import { countChars } from "./srcdoc";

export interface ReasoningBlockProps {
  /** 思考过程的全文 */
  text: string;
  /** 还在思考中（生成中且还没有正文）：展开并显示加载状态 */
  thinking?: boolean;
  /** 紧凑版（前台卡片里）：不画折叠面板的上下两条线，只留一行小字的开关（点按区域照常 32px 高） */
  compact?: boolean;
  className?: string;
}

const ITEM = "reasoning";

/**
 * 思考过程的折叠块：平时收起；正在思考时自动展开，开始出正文后自动收起。
 * 用户自己点过之后就不再自动开合。
 */
export function ReasoningBlock({
  text,
  thinking = false,
  compact = false,
  className,
}: ReasoningBlockProps) {
  const [open, setOpen] = useState(thinking);
  const panelId = useId();
  const touched = useRef(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  useEffect(() => {
    if (!touched.current) setOpen(thinking);
  }, [thinking]);

  // 思考过程不断变长时跟着滚到底；用户往上翻了就不跟
  useLayoutEffect(() => {
    const node = scrollRef.current;
    if (node && thinking && pinnedToBottom.current) node.scrollTop = node.scrollHeight;
  }, [text, thinking, open]);

  const count = formatNumber(countChars(text));

  const scroller = (className: string) => (
    <div
      ref={scrollRef}
      tabIndex={0}
      aria-label="思考过程"
      onScroll={(event) => {
        const node = event.currentTarget;
        pinnedToBottom.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
      }}
      className={cn(
        "overflow-y-auto break-words whitespace-pre-wrap text-ink-secondary",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus",
        className,
      )}
    >
      {text || (thinking ? "正在思考…" : "")}
    </div>
  );

  if (compact) {
    return (
      <div className={cn("min-w-0", className)}>
        <h4 className="text-xs">
          <button
            type="button"
            aria-expanded={open}
            aria-controls={panelId}
            onClick={() => {
              touched.current = true;
              setOpen((value) => !value);
            }}
            className="group inline-flex min-h-8 items-center gap-1.5 text-ink-tertiary transition-colors duration-(--duration-fast) ease-standard hover:text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
          >
            <span className="font-medium text-ink-secondary group-hover:text-ink">思考过程</span>
            {thinking ? (
              <>
                <Spinner size="sm" label={null} className="size-2.5" />
                <span>思考中 · {count} 字</span>
              </>
            ) : (
              <span className="font-tech tabular-nums">· {count} 字</span>
            )}
            <ChevronDown
              size={12}
              className={cn(
                "transition-transform duration-(--duration-fast) ease-standard",
                open && "rotate-180",
              )}
            />
          </button>
        </h4>
        <div id={panelId} hidden={!open}>
          {open && scroller("mt-2 max-h-48 border-l border-line pl-3 text-xs leading-relaxed")}
        </div>
      </div>
    );
  }

  return (
    <Accordion
      size="sm"
      level={4}
      className={className}
      value={open ? [ITEM] : []}
      onValueChange={(value) => {
        touched.current = true;
        setOpen(value.includes(ITEM));
      }}
    >
      <AccordionItem
        value={ITEM}
        title="思考过程"
        extra={
          thinking ? (
            <>
              <Spinner size="sm" label={null} />
              <span>思考中 · {count} 字</span>
            </>
          ) : (
            <span className="font-tech tabular-nums">{count} 字</span>
          )
        }
      >
        {scroller("max-h-80 text-sm")}
      </AccordionItem>
    </Accordion>
  );
}
